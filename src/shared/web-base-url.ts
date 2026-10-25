/**
 * The SPA's public base URL, and the placeholder that stands in for it.
 *
 * `index.html` ships `<base href="__MOUSEHOLE_BASE_URL__" />` (see
 * `src/frontend/index.html`), so every relative URL in the document — the
 * bundle's own `./assets/...` references included — resolves against the base
 * the document declares, not against the path the request arrived on. The Bun
 * server fills it in when it serves the shell (see createApp); the Vite dev
 * server fills it in with `WEB_BASE_URL` (vite.config.ts).
 *
 * Today the base is the constant `WEB_BASE_URL`. Keeping it a value the server
 * writes rather than a value the build bakes in is what lets the UI answer a
 * deep link like `/web/settings` with assets that still resolve, and it is the
 * seam a URL prefix (or a reverse proxy's `X-Forwarded-Prefix`) would widen
 * later. Both the servers and the placeholder's substitution sites read the
 * value from here, so the base a document declares and the base its assets are
 * served under cannot drift apart.
 */
export const WEB_BASE_URL = "/web/";

export const WEB_BASE_URL_PLACEHOLDER = "__MOUSEHOLE_BASE_URL__";
