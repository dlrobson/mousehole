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
});
