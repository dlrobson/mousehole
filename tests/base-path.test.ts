import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseSetCookie } from "set-cookie-parser";

import { createApp, type WebMount } from "../src/backend/app.ts";
import { buildConfig } from "../src/backend/config.ts";
import { createAppContext } from "../src/backend/context.ts";
import type { FetchLike } from "../src/backend/external-api/fetch.ts";
import { SESSION_COOKIE_NAME } from "../src/backend/session.ts";
import type { State } from "../src/backend/state/serde.ts";
import type { StateStore } from "../src/backend/state/store.ts";
import type { ErrorResponseBody } from "../src/shared/error-response.ts";
import { json } from "./lib/helpers.ts";

// Tests must never touch the real network or disk.
const rejectExternalFetch: FetchLike = () =>
  Promise.reject(new Error("unexpected external fetch in test"));

const memoryStateStore: StateStore = (() => {
  let state: State | undefined;
  return {
    readIfExists: () => Promise.resolve(state),
    write: (next) => {
      state = next;
      return Promise.resolve();
    },
  };
})();

function makeApp(
  env: NodeJS.ProcessEnv,
  webMount?: WebMount,
): ReturnType<typeof createApp> {
  const config = buildConfig({
    MOUSEHOLE_AUTH_PASSWORD: "s3cr3t",
    MOUSEHOLE_UPDATE_INTERVAL_SECONDS: "3600",
    ...env,
  });
  const ctx = createAppContext(config, {
    fetchImpl: rejectExternalFetch,
    stateFile: memoryStateStore,
  });
  return createApp(ctx, webMount);
}

async function sessionCookie(
  app: ReturnType<typeof createApp>,
  loginPath: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await app.request(loginPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password: "s3cr3t" }),
  });
  if (response.status !== 200) {
    throw new Error(`Login failed with ${response.status}`);
  }
  const cookie = parseSetCookie(response.headers.getSetCookie()).find(
    (candidate) => candidate.name === SESSION_COOKIE_NAME,
  );
  if (!cookie) throw new Error("Login response missing session cookie");
  return `${SESSION_COOKIE_NAME}=${cookie.value}`;
}

describe("MOUSEHOLE_BASE_PATH=/mousehole", () => {
  const app = makeApp({ MOUSEHOLE_BASE_PATH: "/mousehole" });

  test("serves the health endpoint under the base path", async () => {
    const response = await app.request("/mousehole/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lastMamContactResult: "pending",
    });
  });

  test("serves nothing outside the base path", async () => {
    for (const outsidePath of ["/health", "/state", "/web/", "/events"]) {
      const response = await app.request(outsidePath);
      expect(response.status).toBe(404);
    }
  });

  test.each([
    { accept: "text/html", location: "/mousehole/web" },
    { accept: "application/json", location: "/mousehole/health" },
    { accept: undefined, location: "/mousehole/web" },
  ])(
    "the base path root redirects (Accept: $accept) to $location",
    async ({ accept, location }) => {
      const response = await app.request(
        "/mousehole",
        accept ? { headers: { Accept: accept } } : {},
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(location);
    },
  );

  test("a trailing slash on the base root redirects too", async () => {
    const response = await app.request("/mousehole/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mousehole/web");
  });

  test("the API requires auth under the base path", async () => {
    const unauthenticated = await app.request("/mousehole/state");
    expect(unauthenticated.status).toBe(401);

    const cookie = await sessionCookie(app, "/mousehole/login");
    const authenticated = await app.request("/mousehole/state", {
      headers: { Cookie: cookie },
    });
    expect(authenticated.status).toBe(200);
  });

  test("the session cookie is scoped to the base path", async () => {
    const response = await app.request("/mousehole/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "s3cr3t" }),
    });

    const cookie = parseSetCookie(response.headers.getSetCookie()).find(
      (candidate) => candidate.name === SESSION_COOKIE_NAME,
    );
    expect(cookie?.path).toBe("/mousehole");
  });

  test("logout clears the base-path-scoped cookie", async () => {
    const response = await app.request("/mousehole/logout", {
      method: "POST",
    });
    const cleared = parseSetCookie(response.headers.getSetCookie()).find(
      (candidate) => candidate.name === SESSION_COOKIE_NAME,
    );
    expect(cleared?.path).toBe("/mousehole");
  });

  test("the SSE stream opens under the base path", async () => {
    const cookie = await sessionCookie(app, "/mousehole/login");
    const response = await app.request("/mousehole/events", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();
  });
});

describe("static UI under a base path", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "mousehole-web-"));
    mkdirSync(path.join(root, "assets"));
    writeFileSync(
      path.join(root, "index.html"),
      '<!doctype html><script type="module" src="./assets/app.js"></script>',
    );
    writeFileSync(path.join(root, "assets", "app.js"), "// bundle");
    app = makeApp(
      { MOUSEHOLE_BASE_PATH: "/mousehole" },
      {
        mode: "serve-static",
        root,
      },
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("serves the SPA at <base>/web/", async () => {
    const response = await app.request("/mousehole/web/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("./assets/app.js");
  });

  test("redirects the slash-less <base>/web to <base>/web/", async () => {
    const response = await app.request("/mousehole/web");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mousehole/web/");
  });

  test("serves relative assets under the base path", async () => {
    const response = await app.request("/mousehole/web/assets/app.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("bundle");
  });
});

describe("dev web mount (Vite proxy)", () => {
  const app = makeApp(
    { MOUSEHOLE_BASE_PATH: "/mousehole" },
    { mode: "vite-dev-server-proxy", target: "http://localhost:1" },
  );

  test("redirects the slash-less <base>/web before reaching Vite", async () => {
    const response = await app.request("/mousehole/web");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mousehole/web/");
  });
});

describe("X-Forwarded-Prefix (MOUSEHOLE_BASE_PATH unset)", () => {
  const app = makeApp({});

  test("the root redirect honours a stripping proxy's prefix", async () => {
    const response = await app.request("/", {
      headers: { "X-Forwarded-Prefix": "/mousehole" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mousehole/web");
  });

  test("the JSON redirect honours the prefix too", async () => {
    const response = await app.request("/", {
      headers: {
        "X-Forwarded-Prefix": "/mousehole",
        Accept: "application/json",
      },
    });
    expect(response.headers.get("location")).toBe("/mousehole/health");
  });

  test("the session cookie is scoped to the forwarded prefix", async () => {
    const response = await app.request("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Prefix": "/mousehole",
      },
      body: JSON.stringify({ password: "s3cr3t" }),
    });
    const cookie = parseSetCookie(response.headers.getSetCookie()).find(
      (candidate) => candidate.name === SESSION_COOKIE_NAME,
    );
    expect(cookie?.path).toBe("/mousehole");
  });

  test("an invalid prefix is ignored rather than reflected", async () => {
    const response = await app.request("/", {
      headers: { "X-Forwarded-Prefix": "https://evil.example" },
    });
    expect(response.headers.get("location")).toBe("/web");
  });

  test("a configured base path wins over the header", async () => {
    const configured = makeApp({ MOUSEHOLE_BASE_PATH: "/mousehole" });
    const response = await configured.request("/mousehole", {
      headers: { "X-Forwarded-Prefix": "/other" },
    });
    expect(response.headers.get("location")).toBe("/mousehole/web");
  });
});

// The base path must never creep into the security allowlists: they stay
// host-only (scheme + host + optional port, no path). A rule that carries a path
// is invalid and matches nothing.
describe("base path does not affect the Host/Origin allowlists", () => {
  test("an allowlisted host passes under the base path", async () => {
    const app = makeApp({
      MOUSEHOLE_BASE_PATH: "/mousehole",
      MOUSEHOLE_ALLOWED_HOSTS: "example.com",
    });

    // The host check passed (the 401 is the auth challenge behind it).
    const response = await app.request("http://example.com/mousehole/state");
    expect(response.status).toBe(401);
  });

  test("a host rule carrying a path never matches", async () => {
    const app = makeApp({
      MOUSEHOLE_BASE_PATH: "/mousehole",
      MOUSEHOLE_ALLOWED_HOSTS: "example.com/mousehole",
    });

    const response = await app.request("http://example.com/mousehole/state");
    expect(response.status).toBe(403);
    const body = await json<ErrorResponseBody>(response);
    expect(body.type).toBe("host-not-allowed");
  });

  test("a disallowed host is rejected under the base path", async () => {
    const app = makeApp({
      MOUSEHOLE_BASE_PATH: "/mousehole",
      MOUSEHOLE_ALLOWED_HOSTS: "example.com",
    });

    const response = await app.request("http://evil.example/mousehole/state");
    expect(response.status).toBe(403);
  });
});
