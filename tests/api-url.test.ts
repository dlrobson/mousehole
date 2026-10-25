import { apiUrl } from "#frontend/lib/api-url.ts";

// The SPA is served from <prefix>/web/, and the API lives one directory up.
function withBaseUri(baseURI: string): void {
  vi.stubGlobal("document", { baseURI });
}

afterEach(() => {
  // restoreMocks (vitest.config.ts) covers vi.spyOn, not stubbed globals.
  vi.unstubAllGlobals();
});

describe("apiUrl", () => {
  test("resolves one directory up from the SPA's own URL", () => {
    withBaseUri("http://host:5010/mousehole/web/");
    expect(apiUrl("state").pathname).toBe("/mousehole/state");
  });

  test("works at the origin root", () => {
    withBaseUri("http://host:5010/web/");
    expect(apiUrl("events").pathname).toBe("/events");
  });

  test("keeps the page's origin and drops the /web/ mount", () => {
    withBaseUri("http://host:5010/mousehole/web/");
    expect(apiUrl("login").href).toBe("http://host:5010/mousehole/login");
  });
});
