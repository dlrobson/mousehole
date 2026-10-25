/**
 * Placeholder for the SPA's public base URL, resolved where the HTML is served.
 *
 * `index.html` ships `<base href="__MOUSEHOLE_BASE_URL__" />` (see
 * `src/frontend/index.html`), so every relative URL in the document — the
 * bundle's own `./assets/...` references included — resolves against the prefix
 * the page was actually served under instead of against the request path. The
 * Vite dev server fills it in with its own `/web/` base (vite.config.ts); the
 * Bun server fills it in per request with `<prefix>/web/` (see createApp), so a
 * deep link like `<prefix>/web/settings` still finds its assets, and a
 * prefix-stripping reverse proxy needs no configuration at all.
 */
export const WEB_BASE_URL_PLACEHOLDER = "__MOUSEHOLE_BASE_URL__";
