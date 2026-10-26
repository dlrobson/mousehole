import { resolveApiUrl } from "../src/frontend/lib/api-url.ts";

describe("resolveApiUrl", () => {
  test("resolves to the origin root from the root mount", () => {
    expect(resolveApiUrl("https://host/web/", "state").toString()).toBe(
      "https://host/state",
    );
  });

  test("stays inside a configured prefix", () => {
    expect(resolveApiUrl("https://host/mousehole/web/", "state").pathname).toBe(
      "/mousehole/state",
    );
  });

  // The server always declares a base ending in "/web/", so a deep link's own
  // URL is one segment deeper than the mount. Resolving against it would put
  // the API call inside /web/ — the reason the base element is load-bearing.
  test("resolves from the declared base, not the document's own path", () => {
    expect(resolveApiUrl("https://host/mousehole/web/", "state").pathname).toBe(
      "/mousehole/state",
    );

    const deepDocumentUrl = "https://host/mousehole/web/settings/profile";
    expect(new URL("../state", deepDocumentUrl).pathname).toBe(
      "/mousehole/web/state",
    );
  });

  test("carries every endpoint one segment up from the mount", () => {
    for (const endpoint of [
      "login",
      "logout",
      "cookie",
      "updates",
      "events",
      "state",
    ]) {
      expect(
        resolveApiUrl("https://host/mousehole/web/", endpoint).pathname,
      ).toBe(`/mousehole/${endpoint}`);
    }
  });
});
