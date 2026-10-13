/**
 * Backend endpoint URLs, resolved at runtime instead of hardcoded.
 *
 * The SPA is always served from `<prefix>/web/` (the backend mounts the UI
 * there), and the API lives one directory up at `<prefix>/<endpoint>`. Using
 * `document.baseURI` as the base keeps every request inside whatever prefix the
 * page was actually loaded under — the origin root, a configured
 * `MOUSEHOLE_BASE_PATH`, or a prefix a reverse proxy stripped before forwarding.
 */
export function apiUrl(endpoint: string): URL {
  return new URL(`../${endpoint}`, document.baseURI);
}
