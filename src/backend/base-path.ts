/**
 * Base-path (URL prefix) handling for reverse-proxy deployments.
 *
 * A base path is a URL path prefix such as "/mousehole". It must start with
 * "/", must not carry a trailing slash (normalized away), and must not smuggle
 * in a scheme, host, query, fragment, or ".." traversal. Both
 * `MOUSEHOLE_BASE_PATH` (operator config) and `X-Forwarded-Prefix`
 * (proxy-provided) are validated here.
 */

// URL-unreserved characters plus sub-delims: the pchar-ish set a proxy might
// legitimately use. Anything outside this (whitespace, "?", "#", "\", ":",
// "//", ...) is rejected so a prefix can never be read as an authority, query,
// or fragment. Two characters that look harmless are rejected deliberately:
//
// - "*", because Hono reads it as a route wildcard, so "/a*" would widen the
//   root route into a tail match; and
// - "%", because percent-encoding slips past the literal ".." check above
//   ("/%2e%2e/x") while browsers decode it back when resolving a Location.
const BASE_PATH_PATTERN =
  /^\/(?:[A-Za-z0-9._~!$&'()+,;=@-]+\/)*[A-Za-z0-9._~!$&'()+,;=@-]*$/;

/**
 * Validate and normalize a URL path prefix. Returns the canonical form (no
 * trailing slash; "" for the root) or undefined when `value` isn't a usable
 * path prefix.
 */
export function normalizeBasePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/") return "";
  if (trimmed.includes("..")) return undefined;

  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized === "") return "";
  return BASE_PATH_PATTERN.test(normalized) ? normalized : undefined;
}
