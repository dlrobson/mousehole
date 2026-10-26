import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseSetCookie } from "set-cookie-parser";

import { createApp, type WebMount } from "../src/backend/app.ts";
import {
  normalizeBasePath,
  resolveBasePath,
  webBaseFor,
} from "../src/backend/base-path.ts";
import { buildConfig } from "../src/backend/config.ts";
import { createAppContext } from "../src/backend/context.ts";
import { SESSION_COOKIE_NAME } from "../src/backend/session.ts";
import { WEB_BASE_URL_PLACEHOLDER } from "../src/shared/web-base-url.ts";
import {
  createInMemoryStateStore,
  rejectExternalFetch,
} from "./lib/helpers.ts";

type TestApp = ReturnType<typeof createApp>;

function makeApp(env: NodeJS.ProcessEnv, webMount?: WebMount): TestApp {
  const config = buildConfig({ MOUSEHOLE_AUTH_PASSWORD: "s3cr3t", ...env });
  const ctx = createAppContext(config, {
    fetchImpl: rejectExternalFetch,
    stateFile: createInMemoryStateStore(),
  });
  return createApp(ctx, webMount);
}

async function postLogin(
  app: TestApp,
  loginPath: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(loginPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password: "s3cr3t" }),
  });
}

function sessionCookiePath(response: Response): string | undefined {
  return parseSetCookie(response.headers.getSetCookie()).find(
    (cookie) => cookie.name === SESSION_COOKIE_NAME,
  )?.path;
}

async function login(
  app: TestApp,
  loginPath: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await postLogin(app, loginPath, headers);
  if (response.status !== 200) {
    throw new Error(`Login failed with ${response.status}`);
  }
  const cookie = parseSetCookie(response.headers.getSetCookie()).find(
    (candidate) => candidate.name === SESSION_COOKIE_NAME,
  );
  if (!cookie) throw new Error("login response missing session cookie");
  return `${SESSION_COOKIE_NAME}=${cookie.value}`;
}

describe("normalizeBasePath", () => {
  test.each<[string, string]>([
    ["", ""],
    ["/", ""],
    ["//", ""],
    ["mousehole", "/mousehole"],
    ["mousehole/", "/mousehole"],
    ["/mousehole", "/mousehole"],
    ["/mousehole/", "/mousehole"],
    ["/apps/mousehole", "/apps/mousehole"],
    ["  /mousehole/  ", "/mousehole"],
  ])("normalises %j to %j", (value, expected) => {
    expect(normalizeBasePath(value)).toBe(expected);
  });

  test.each([
    // would read as an authority, i.e. an off-site URL
    "//evil.example",
    "/a//b",
    // dot segments
    "/a/../b",
    "/a/./b",
    "/..",
    "/.",
    // whitespace, query, fragment, backslash, control characters
    "/a b",
    "/a\tb",
    "/a?b",
    "/a#b",
    String.raw`/a\b`,
    "/a\u0000b",
    // scheme-ish and characters a mount point never needs
    "https://evil.example",
    "http://evil.example/path",
    "a;b",
  ])("rejects %j", (value) => {
    expect(normalizeBasePath(value)).toBeUndefined();
  });
});

describe("resolveBasePath", () => {
  test("is the origin root when neither source is set", () => {
    expect(resolveBasePath("")).toBe("");
  });

  test("takes a validated X-Forwarded-Prefix when no prefix is configured", () => {
    expect(resolveBasePath("", "/mousehole")).toBe("/mousehole");
    expect(resolveBasePath("", "mousehole/")).toBe("/mousehole");
  });

  // A client can send the header itself, so a bad value must not fail the
  // request — it just means "at the root".
  test.each(["//evil.example", "/a/../b", "a;b", "https://evil.example"])(
    "discards the hostile header %j",
    (forwarded) => {
      expect(resolveBasePath("", forwarded)).toBe("");
    },
  );

  test("the configured prefix wins over any header", () => {
    expect(resolveBasePath("/mousehole", "/other")).toBe("/mousehole");
  });
});

describe("webBaseFor", () => {
  test("is the root base when no prefix is configured", () => {
    expect(webBaseFor("")).toBe("/web/");
  });

  test("nests under the prefix", () => {
    expect(webBaseFor("/mousehole")).toBe("/mousehole/web/");
    expect(webBaseFor("/apps/mousehole")).toBe("/apps/mousehole/web/");
  });
});

describe("MOUSEHOLE_BASE_PATH=/mousehole mounts the whole app", () => {
  const app = makeApp({ MOUSEHOLE_BASE_PATH: "/mousehole" });

  test("serves the health endpoint under the prefix", async () => {
    const response = await app.request("/mousehole/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lastMamContactResult: "pending" });
  });

  test("serves nothing outside the prefix", async () => {
    for (const outsidePath of ["/health", "/state", "/web/", "/events"]) {
      const response = await app.request(outsidePath);
      expect(response.status).toBe(404);
    }
  });

  test("redirects the prefix root, trailing slash or not", async () => {
    for (const rootPath of ["/mousehole", "/mousehole/"]) {
      const response = await app.request(rootPath);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/mousehole/web");
    }
  });

  test("the API is protected and reachable under the prefix", async () => {
    const unauthenticated = await app.request("/mousehole/state");
    expect(unauthenticated.status).toBe(401);

    const cookie = await login(app, "/mousehole/login");
    const authenticated = await app.request("/mousehole/state", {
      headers: { Cookie: cookie },
    });
    expect(authenticated.status).toBe(200);
  });

  test("the SSE stream opens under the prefix", async () => {
    const cookie = await login(app, "/mousehole/login");
    const response = await app.request("/mousehole/events", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();
  });

  test("scopes the session cookie to the prefix", async () => {
    const response = await postLogin(app, "/mousehole/login");
    expect(sessionCookiePath(response)).toBe("/mousehole");
  });

  test("clears the cookie with the same prefix", async () => {
    const response = await app.request("/mousehole/logout", { method: "POST" });
    expect(sessionCookiePath(response)).toBe("/mousehole");
  });

  test("the configured prefix wins over a forwarded one", async () => {
    const response = await app.request("/mousehole", {
      headers: { "x-forwarded-prefix": "/other" },
    });
    expect(response.headers.get("location")).toBe("/mousehole/web");
  });
});

describe("X-Forwarded-Prefix scopes replies when MOUSEHOLE_BASE_PATH is unset", () => {
  const app = makeApp({});

  test("scopes the session cookie to the forwarded prefix", async () => {
    const response = await postLogin(app, "/login", {
      "x-forwarded-prefix": "/mousehole",
    });
    expect(sessionCookiePath(response)).toBe("/mousehole");
  });

  test("clearing targets the same forwarded prefix", async () => {
    const response = await app.request("/logout", {
      method: "POST",
      headers: { "x-forwarded-prefix": "/mousehole" },
    });
    expect(sessionCookiePath(response)).toBe("/mousehole");
  });

  test("an invalid header is ignored, not reflected into the cookie", async () => {
    const response = await postLogin(app, "/login", {
      "x-forwarded-prefix": "//evil.example",
    });
    expect(sessionCookiePath(response)).toBe("/");
  });
});

describe("static UI under a prefix", () => {
  let root: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "mousehole-base-path-"));
    mkdirSync(path.join(root, "assets"));
    writeFileSync(
      path.join(root, "index.html"),
      `<!doctype html><base href="${WEB_BASE_URL_PLACEHOLDER}" />`,
    );
    writeFileSync(path.join(root, "assets", "app.js"), "// bundle");
    app = makeApp(
      { MOUSEHOLE_BASE_PATH: "/mousehole" },
      { mode: "serve-static", root },
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("serves assets with the prefix stripped before the /web segment", async () => {
    const response = await app.request("/mousehole/web/assets/app.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("bundle");
  });

  test("does not serve a file at the same path outside the prefix", async () => {
    const response = await app.request("/web/assets/app.js");
    expect(response.status).toBe(404);
  });

  // The static mount strips the prefix from the already-decoded path, so an
  // encoded traversal must still be rejected (Hono's serveStatic refuses dot
  // segments) rather than climb out of the dist root.
  test.each([
    "/mousehole/web/../index.html",
    "/mousehole/web/..%2f..%2fpackage.json",
    "/mousehole/web/%2e%2e/%2e%2e/package.json",
    "/mousehole/web/assets/..%2f..%2fpackage.json",
  ])("does not escape the dist root through %s", async (requestPath) => {
    const response = await app.request(requestPath);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("mousehole");
  });
});
