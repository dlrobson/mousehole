import { readFileSync } from "node:fs";
import path from "node:path";

import { WEB_BASE_URL_PLACEHOLDER } from "../src/shared/web-base-url.ts";
import viteConfig from "../vite.config.ts";

// The build's relative base is what lets the SPA's assets resolve under a
// configured MOUSEHOLE_BASE_PATH; the static-serve fixture hand-writes its own
// index.html, so nothing else notices if this reverts to an absolute base.
describe("vite build configuration", () => {
  test("builds with a relative base", () => {
    const config =
      typeof viteConfig === "function"
        ? viteConfig({ command: "build", mode: "production" })
        : viteConfig;

    expect(config.base).toBe("./");
  });

  // The shell's own `<base>` is what makes deep links resolve, and the server
  // can only fill it in if the source document carries the placeholder.
  test("ships the base URL placeholder in index.html", () => {
    const html = readFileSync(
      path.resolve(import.meta.dirname, "../src/frontend/index.html"),
      "utf8",
    );

    expect(html).toContain(`<base href="${WEB_BASE_URL_PLACEHOLDER}" />`);
  });
});
