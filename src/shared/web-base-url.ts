/**
 * The SPA's base URL at the origin root, and the placeholder that stands in for
 * it in the document.
 *
 * `index.html` ships `<base href="__MOUSEHOLE_BASE_URL__" />` (see
 * `src/frontend/index.html`), so every relative URL in the document — the
 * bundle's own `./assets/...` references included — resolves against the base
 * the document declares, not against the path the request arrived on. The Bun
 * server fills it in when it serves the shell (see createApp), using
 * `WEB_BASE_URL` when no URL prefix is configured and `<prefix>/web/` when one
 * is; the Vite dev server fills it in with `WEB_BASE_URL` (vite.config.ts).
 *
 * `WEB_BASE_URL` is therefore the default base — the one that holds at the
 * origin root — not a constant the server bakes in. The value is written by the
 * server per request rather than at build time so the UI answers a deep link
 * like `/web/settings` (or `/mousehole/web/settings`) with assets that still
 * resolve, and so frontend code can derive API URLs from the document's
 * declared base instead of hardcoding absolute paths.
 */
export const WEB_BASE_URL = "/web/";

export const WEB_BASE_URL_PLACEHOLDER = "__MOUSEHOLE_BASE_URL__";
