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

The base path also becomes the session cookie's `Path`, so the cookie is only
sent for Mousehole requests.

The only reason to set this is when your reverse proxy **does not** strip the
prefix. If your proxy strips it (see below), leave `MOUSEHOLE_BASE_PATH` unset.

## Reverse proxy examples

### Caddy (prefix kept)

```caddyfile
:8080 {
  handle /mousehole/* {
    reverse_proxy 127.0.0.1:5010
  }
}
```

Set `MOUSEHOLE_BASE_PATH=/mousehole`. Browse
`http://localhost:8080/mousehole/web/`.

### Caddy (prefix stripped)

```caddyfile
:8080 {
  handle_path /mousehole/* {
    reverse_proxy 127.0.0.1:5010
  }
}
```

Leave `MOUSEHOLE_BASE_PATH` unset (`handle_path` strips `/mousehole` before
forwarding, so the backend still sees the root paths it expects).

### nginx

```nginx
location /mousehole/ {
  proxy_pass http://127.0.0.1:5010/;  # trailing slash strips the prefix
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Prefix /mousehole;
}
```

The trailing slash on `proxy_pass` strips `/mousehole`, so leave
`MOUSEHOLE_BASE_PATH` unset.

## `X-Forwarded-Prefix`

When `MOUSEHOLE_BASE_PATH` is unset, Mousehole honours an
[`X-Forwarded-Prefix`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-Prefix)
request header for the two places the backend still needs to know the public
prefix:

- the redirect from the prefix root to `<prefix>/web` (or `<prefix>/health` for
  a JSON client), and
- the `Path` scoping of the session cookie.

This lets a prefix-stripping proxy produce correct redirects and cookies without
any extra configuration. The header is validated as a path prefix, so an invalid
or absolute value is ignored rather than reflected — it can never turn into an
open redirect. `MOUSEHOLE_BASE_PATH`, when set, always wins.

Most proxies add this header automatically; for Caddy's `handle_path` you can
set it explicitly if you want prefixed redirects:

```caddyfile
:8080 {
  handle_path /mousehole/* {
    reverse_proxy 127.0.0.1:5010 {
      header_up X-Forwarded-Prefix /mousehole
    }
  }
}
```

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

The image's built-in healthcheck reads `MOUSEHOLE_BASE_PATH` and probes
`<base>/health`, so it keeps working when you set the variable. If you set a
custom `MOUSEHOLE_PORT`, override the healthcheck as usual (see the
[README](/README.md#healthcheck)).
