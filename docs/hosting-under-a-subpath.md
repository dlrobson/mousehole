# Hosting Under a Subpath

By default Mousehole serves its web UI and API at the origin root
(`http://host:5010/web/`). If you run Mousehole alongside other apps behind a
single hostname, you'll want it reachable at a subpath such as
`https://host/mousehole/` instead of colliding with whatever else is served at
the root.

Mousehole supports this with the `MOUSEHOLE_BASE_PATH` environment variable. The
frontend also resolves its own URLs at runtime, so it works behind a reverse
proxy that strips the prefix without rebuilding the image.

## Setting the base path

Set `MOUSEHOLE_BASE_PATH` to the path prefix, with a leading `/` and no trailing
slash:

```yaml
environment:
  MOUSEHOLE_BASE_PATH: "/mousehole"
```

With this set, everything moves under the prefix:

| Before                    | After                               |
| ------------------------- | ----------------------------------- |
| `http://host:5010/`       | `http://host:5010/mousehole`        |
| `http://host:5010/web/`   | `http://host:5010/mousehole/web/`   |
| `http://host:5010/health` | `http://host:5010/mousehole/health` |
| `http://host:5010/state`  | `http://host:5010/mousehole/state`  |

The prefix root redirects to `<prefix>/web/` (or to `<prefix>/health` for a
JSON client).

The base path also becomes the session cookie's `Path`, so the cookie is only
sent for Mousehole requests.

The only reason to set this is when your reverse proxy **does not** strip the
prefix. If your proxy strips it (see below), leave `MOUSEHOLE_BASE_PATH` unset.

> **Development:** the variable only affects the built UI. `bun dev` serves the
> Vite dev server from its own absolute `/web/` base, so leave
> `MOUSEHOLE_BASE_PATH` unset while developing; only `bun run build` produces a
> prefix-agnostic bundle.

## Reverse proxy examples

### Caddy (prefix kept)

```caddyfile
:8080 {
  # `handle /mousehole/*` matches only paths below the prefix, so include the
  # bare prefix too and let the app's own prefix-root redirect answer.
  @mousehole path /mousehole /mousehole/*
  handle @mousehole {
    reverse_proxy 127.0.0.1:5010
  }
}
```

Set `MOUSEHOLE_BASE_PATH=/mousehole`. Browse
`http://localhost:8080/mousehole/web/`.

### Caddy (prefix stripped)

```caddyfile
:8080 {
  # `handle_path`'s wildcard misses the bare prefix, so forward that one as /
  # and let the app's own prefix-root redirect answer.
  handle /mousehole {
    rewrite * /
    reverse_proxy 127.0.0.1:5010 {
      header_up X-Forwarded-Prefix /mousehole
    }
  }
  handle_path /mousehole/* {
    reverse_proxy 127.0.0.1:5010 {
      header_up X-Forwarded-Prefix /mousehole
    }
  }
}
```

Leave `MOUSEHOLE_BASE_PATH` unset (`handle_path` strips `/mousehole` before
forwarding, so the backend still sees the root paths it expects) and send the
prefix back with `header_up`: without it the backend has no way to know it is
served under a prefix, so its redirects and cookie scope are root-relative and
the browser leaves the prefix. See [`X-Forwarded-Prefix`](#x-forwarded-prefix)
below.

### nginx

```nginx
# `location /mousehole/` does not match the bare prefix, so forward that one as
# / and let the app's own prefix-root redirect answer.
location = /mousehole {
  proxy_pass http://127.0.0.1:5010/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Prefix /mousehole;
}

location /mousehole/ {
  proxy_pass http://127.0.0.1:5010/;  # trailing slash strips the prefix
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Prefix /mousehole;
  # /events is a Server-Sent Events stream, and nginx buffers proxied responses
  # by default: events are held back until the buffer fills, so the UI silently
  # stops live-updating.
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
}
```

The trailing slash on `proxy_pass` strips `/mousehole`, so leave
`MOUSEHOLE_BASE_PATH` unset.

## `X-Forwarded-Prefix`

When `MOUSEHOLE_BASE_PATH` is unset, Mousehole honours an
[`X-Forwarded-Prefix`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-Prefix)
request header for the two places the backend still needs to know the public
prefix:

- the redirect from the prefix root to `<prefix>/web/` (or `<prefix>/health`
  for a JSON client), and
- the `Path` scoping of the session cookie.

This lets a prefix-stripping proxy produce correct redirects and cookies without
setting `MOUSEHOLE_BASE_PATH`. The header is validated as a path prefix, so an
invalid or absolute value is ignored rather than reflected — it can never turn
into an open redirect. `MOUSEHOLE_BASE_PATH`, when set, always wins.

No mainstream proxy sends this header by default: nginx, Caddy, HAProxy, Traefik,
and Envoy all require it to be configured explicitly (all the examples above set
it). It is not part of the standard `Forwarded` header, so a proxy that sets only
`Forwarded` sends Mousehole nothing it reads.

Because the app trusts this header for `Location` values and for the session
cookie's `Path`, your proxy must **overwrite** it rather than pass a
client-supplied value through. `proxy_set_header` and `header_up` overwrite by
default; a header-copying setup that forwards the client's own
`X-Forwarded-Prefix` would let a client choose its prefix. The damage is bounded
— `normalizeBasePath` rejects anything that is not a plain path, so this is never
an open redirect, and a client can only scope its own cookie — but the header is
not trustworthy input unless your proxy sets it.

For Caddy's `handle_path`, see the
[Caddy (prefix stripped)](#caddy-prefix-stripped) example above; the extra
`handle /mousehole` block is what makes the bare prefix itself work.

## Security checks are unaffected

The [Host](/docs/security-guide.md#host-allowlist) and
[Origin](/docs/security-guide.md#origin-allowlist) allowlists stay host-only
(scheme + host + optional port, no path). The base path never participates in
either check, and there is no configuration that mixes them:

```yaml
environment:
  MOUSEHOLE_BASE_PATH: "/mousehole"
  MOUSEHOLE_ALLOWED_HOSTS: "mousehole.myhomelab.lan" # host only
  MOUSEHOLE_ALLOWED_ORIGINS: "https://mousehole.myhomelab.lan" # origin only
```

A `Host` or `Origin` value that includes the base path (e.g.
`mousehole.myhomelab.lan/mousehole`) is still invalid and matches nothing.

Cookies keep the same `HttpOnly` / `SameSite` / `Secure`(
[`MOUSEHOLE_HTTPS_ONLY_COOKIES`](/docs/security-guide.md#https-only-cookies))
behavior; only the `Path` changes.

## Docker healthcheck

The image's built-in healthcheck reads `MOUSEHOLE_BASE_PATH` through the app's
own config and probes `<base>/health`, so it keeps working when you set the
variable. If you set a custom `MOUSEHOLE_PORT`, override the healthcheck as
usual (see the [README](/README.md#healthcheck)).
