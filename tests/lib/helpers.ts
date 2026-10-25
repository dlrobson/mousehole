// Shared helpers for the test suite.

import { parseSetCookie } from "set-cookie-parser";
import type { MockInstance } from "vitest";

import { createApp, type WebMount } from "../../src/backend/app.ts";
import { buildConfig } from "../../src/backend/config.ts";
import type { AppContext } from "../../src/backend/context.ts";
import { createAppContext } from "../../src/backend/context.ts";
import type { FetchLike } from "../../src/backend/external-api/fetch.ts";
import { SESSION_COOKIE_NAME } from "../../src/backend/session.ts";
import type { State } from "../../src/backend/state/serde.ts";
import type { StateStore } from "../../src/backend/state/store.ts";

export type TestApp = ReturnType<typeof createApp>;

// Read a response body as JSON, typed by the caller. Pass the real exported
// contract (PublicState, ErrorResponseBody, ...) as T so the tests stay honest
// if that contract changes.
export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// Tests must never touch the real network; contexts built without an explicit
// fetchImpl fail loudly if anything tries.
export const rejectExternalFetch: FetchLike = () =>
  Promise.reject(new Error("unexpected external fetch in test"));

// An in-memory StateStore for tests: no disk, so contexts stay hermetic and
// isolated. The real on-disk StateFileStore is exercised in store.test.ts.
export function createInMemoryStateStore(initial?: State): StateStore {
  let state = initial;
  return {
    readIfExists: () => Promise.resolve(state),
    write: (next) => {
      state = next;
      return Promise.resolve();
    },
  };
}

export type TestContextOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** How to serve the web UI, if at all. Mirrors server.ts's WebMount. */
  webMount?: WebMount;
};

export function makeTestContext(options: TestContextOptions = {}): {
  ctx: AppContext;
  app: TestApp;
  store: StateStore;
  writeSpy: MockInstance<StateStore["write"]>;
} {
  const config = buildConfig({
    MOUSEHOLE_AUTH_PASSWORD: "s3cr3t",
    MOUSEHOLE_UPDATE_INTERVAL_SECONDS: "3600",
    ...options.env,
  });
  const store = createInMemoryStateStore();
  // Spy on write so tests can assert what got persisted. restoreMocks
  // (vitest.config.ts) puts it back after each test.
  const writeSpy = vi.spyOn(store, "write");
  const ctx = createAppContext(config, {
    fetchImpl: options.fetchImpl ?? rejectExternalFetch,
    stateFile: store,
  });
  return { ctx, app: createApp(ctx, options.webMount), store, writeSpy };
}

// POST /login (or a prefixed variant) and hand back the raw response, for tests
// asserting on the rejection itself.
export async function postLogin(
  app: TestApp,
  body: Record<string, unknown> | string,
  options: { path?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return app.request(options.path ?? "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Log in and return a Cookie header value carrying the session. Takes the login
// path so callers can exercise a prefixed deployment.
export async function login(
  app: TestApp,
  options: {
    path?: string;
    password?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<string> {
  const response = await postLogin(
    app,
    { password: options.password ?? "s3cr3t" },
    options,
  );
  if (response.status !== 200) {
    throw new Error(`Login failed with ${response.status}`);
  }
  const cookie = parseSetCookie(response.headers.getSetCookie()).find(
    (candidate) => candidate.name === SESSION_COOKIE_NAME,
  );
  if (!cookie) throw new Error("Login response missing session cookie");
  return `${SESSION_COOKIE_NAME}=${cookie.value}`;
}
