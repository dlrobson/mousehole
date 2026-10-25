import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseSetCookie } from "set-cookie-parser";

import type { WebMount } from "../src/backend/app.ts";
import { SESSION_COOKIE_NAME } from "../src/backend/session.ts";
import type { ErrorResponseBody } from "../src/shared/error-response.ts";
import type { TestApp } from "./lib/helpers.ts";
import { json, login, makeTestContext } from "./lib/helpers.ts";

// An app under a given environment, optionally serving a web UI. Thin alias over
// the shared makeTestContext so each case below reads as one line.
function makeApp(env: NodeJS.ProcessEnv = {}, webMount?: WebMount): TestApp {
  return makeTestContext({ env, webMount }).app;
}

// The Paths a response expired the session cookie at (logout emits one per path
// it could have been set with).
function clearedCookiePaths(response: Response): (string | undefined)[] {
  return parseSetCookie(response.headers.getSetCookie())
    .filter((candidate) => candidate.name === SESSION_COOKIE_NAME)
    .map((candidate) => candidate.path);
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
    for (const outsidePath of ["/health", "/state", "/events"]) {
      const response = await app.request(outsidePath);
      expect(response.status).toBe(404);
    }

    // Not GET-only: a mutating endpoint outside the base path must miss too.
    const loginOutside = await app.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "s3cr3t" }),
    });
    expect(loginOutside.status).toBe(404);
  });

  test.each([
    { accept: "text/html", location: "/mousehole/web/" },
    { accept: "application/json", location: "/mousehole/health" },
    { accept: undefined, location: "/mousehole/web/" },
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
    expect(response.headers.get("location")).toBe("/mousehole/web/");
  });

  test("the API requires auth under the base path", async () => {
    const unauthenticated = await app.request("/mousehole/state");
    expect(unauthenticated.status).toBe(401);

    const cookie = await login(app, { path: "/mousehole/login" });
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

  test("logout clears the base-path-scoped cookie and a root-scoped survivor", async () => {
    // A cookie set before the base path existed (or before the proxy sent
    // X-Forwarded-Prefix) is scoped to "/" and only disappears if logout targets
    // that path too.
    const response = await app.request("/mousehole/logout", {
      method: "POST",
    });
    expect(clearedCookiePaths(response)).toEqual(["/mousehole", "/"]);
  });

  test("the SSE stream opens under the base path", async () => {
    const cookie = await login(app, { path: "/mousehole/login" });
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
  let app: TestApp;

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

  test("serves no UI outside the base path", async () => {
    for (const outsidePath of ["/web/", "/web/assets/app.js"]) {
      const response = await app.request(outsidePath);
      expect(response.status).toBe(404);
    }
  });
});

// The feature's core promise is that nothing is served outside the prefix, and a
// handler registered without at() breaks it silently. Pin the invariant over
// every route the app registers, with a UI mount so those routes are included.
describe("route mounting", () => {
  const app = makeApp(
    { MOUSEHOLE_BASE_PATH: "/mousehole" },
    { mode: "vite-dev-server-proxy", target: "http://localhost:1" },
  );

  test("mounts every route under the base path", () => {
    expect(app.routes.length).toBeGreaterThan(0);
    for (const route of app.routes) {
      // "/*" is where Hono lands whole-app middleware (logger, body limit);
      // Hono's own default middleware path "*" is merged with "/".
      if (route.path === "/*") continue;
      expect(route.path.startsWith("/mousehole")).toBe(true);
    }
  });
});

describe("dev web mount (Vite proxy)", () => {
  const app = makeApp(
    { MOUSEHOLE_BASE_PATH: "/mousehole" },
    { mode: "vite-dev-server-proxy", target: "http://localhost:1" },
  );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("redirects the slash-less <base>/web before reaching Vite", async () => {
    const response = await app.request("/mousehole/web");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mousehole/web/");
  });

  test("strips the base path before forwarding to the Vite dev server", async () => {
    const fetchSpy = vi.fn((_request: Request) =>
      Promise.resolve(new Response("// bundle")),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await app.request("/mousehole/web/assets/app.js");
    expect(response.status).toBe(200);

    // Vite serves the UI from its own /web/ base, so the configured prefix must
    // never reach it.
    const [forwarded] = fetchSpy.mock.calls[0] ?? [];
    expect(forwarded?.url).toBe("http://localhost:1/web/assets/app.js");
  });
});

describe("X-Forwarded-Prefix (MOUSEHOLE_BASE_PATH unset)", () => {
  const app = makeApp({});

  test("the root redirect honours a stripping proxy's prefix", async () => {
    const response = await app.request("/", {
      headers: { "X-Forwarded-Prefix": "/mousehole" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mousehole/web/");
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
    expect(response.headers.get("location")).toBe("/web/");
  });

  test("a configured base path wins over the header", async () => {
    const configured = makeApp({ MOUSEHOLE_BASE_PATH: "/mousehole" });
    const response = await configured.request("/mousehole", {
      headers: { "X-Forwarded-Prefix": "/other" },
    });
    expect(response.headers.get("location")).toBe("/mousehole/web/");
  });

  test("the slash-less /web redirect honours the prefix", async () => {
    // The redirect route only exists when a web UI is mounted, so this needs its
    // own app (the shared one above mounts nothing).
    const mounted = makeApp(
      {},
      { mode: "vite-dev-server-proxy", target: "http://localhost:1" },
    );
    const response = await mounted.request("/web", {
      headers: { "X-Forwarded-Prefix": "/mousehole" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mousehole/web/");
  });

  test("logout clears the forwarded prefix and a root-scoped survivor", async () => {
    const response = await app.request("/logout", {
      method: "POST",
      headers: { "X-Forwarded-Prefix": "/mousehole" },
    });
    expect(clearedCookiePaths(response)).toEqual(["/mousehole", "/"]);
  });

  test("logout at the origin root clears the root cookie once", async () => {
    const response = await app.request("/logout", { method: "POST" });
    expect(clearedCookiePaths(response)).toEqual(["/"]);
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
