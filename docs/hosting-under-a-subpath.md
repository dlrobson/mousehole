# Hosting Under a Subpath

By default Mousehole serves its web UI and API at the origin root
(`http://host:5010/web/`). If Mousehole shares a hostname with other apps behind
a reverse proxy, you'll want it reachable at a subpath such as
`https://host/mousehole/` instead.

There are two ways to arrange that, and they are alternatives — pick one:

1. **Keep the prefix in the request.** The proxy forwards `/mousehole/...`
   unchanged and you set `MOUSEHOLE_BASE_PATH=/mousehole`.
2. **Strip the prefix before forwarding.** The proxy turns `/mousehole/...` into
   `/...` and forwards that; leave `MOUSEHOLE_BASE_PATH` unset. Mousehole reads
   the public prefix from `X-Forwarded-Prefix` when the proxy sends it (and
   otherwise assumes the origin root).

Either way the whole app moves together: UI at `<prefix>/web/`, API at
`<prefix>/{login,logout,updates,state,cookie,events,health}`, and `<prefix>`
redirects into the app.

## Option 1: keep the prefix (`MOUSEHOLE_BASE_PATH`)

Set `MOUSEHOLE_BASE_PATH` to the path prefix:

```yaml
environment:
  MOUSEHOLE_BASE_PATH: "/mousehole"
```

Then:

| Root deployment           | With `MOUSEHOLE_BASE_PATH=/mousehole` |
| ------------------------- | ------------------------------------- |
| `http://host:5010/`       | `http://host:5010/mousehole`          |
| `http://host:5010/web/`   | `http://host:5010/mousehole/web/`     |
| `http://host:5010/health` | `http://host:5010/mousehole/health`   |
| `http://host:5010/state`  | `http://host:5010/mousehole/state`    |

The value is normalised: surrounding whitespace and trailing slashes are
dropped and a leading slash is added, so `/mousehole`, `mousehole/` and
`/mousehole` are all the same prefix. A value that isn't a plain URL path —
one with a scheme or host, `//`, `.`/`..` segments, whitespace inside a
segment, `?`, `#`, or a backslash — stops Mousehole at startup with a message
naming `MOUSEHOLE_BASE_PATH`.

With no prefix set, Mousehole behaves exactly as it did before the option
existed.

The session cookie's `Path` becomes the prefix, so the browser only sends the
session to Mousehole, not to the other apps on the hostname.

## Option 2: strip the prefix (and `X-Forwarded-Prefix`)

A prefix-stripping proxy removes the prefix before forwarding, so Mousehole
still sees `/web/` and `/state` and needs no configuration. But redirects and
the UI's `<base>` have to point at the _public_ URL, or the browser would leave
the prefix. Mousehole reads that from the
[`X-Forwarded-Prefix`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-Prefix)
request header when `MOUSEHOLE_BASE_PATH` is unset.

The header is optional. Without it the app still serves; a redirect from
`http://host/mousehole` would land on `http://host/web` (outside the prefix), so
set it if your proxy doesn't.

`X-Forwarded-Prefix` is treated as hostile input, because any client can send
it:

- it goes through the same validator as `MOUSEHOLE_BASE_PATH`, and an invalid
  value is ignored rather than failing the request;
- it is only ever a path. There is no way for `//evil.example` or
  `https://evil.example` to end up in a redirect or a cookie scope, so it
  cannot produce an off-site redirect;
- `MOUSEHOLE_BASE_PATH`, when set, always wins over the header.

Since HTTP headers are not trustworthy without a proxy in front, this is only
meaningful behind a proxy that overwrites the header on the way in.

## Reverse proxy examples

### nginx (prefix stripped)

The trailing slash on `proxy_pass` strips `/mousehole`:

```nginx
location = /mousehole {
  return 302 /mousehole/;
}

location /mousehole/ {
  proxy_pass http://127.0.0.1:5010/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Prefix /mousehole;
  proxy_set_header X-Forwarded-Proto $scheme;
  # Server-Sent Events (GET /mousehole/events) stream until the client leaves.
  proxy_buffering off;
}
```

Leave `MOUSEHOLE_BASE_PATH` unset: nginx forwards the stripped path and
`X-Forwarded-Prefix` tells Mousehole what the browser saw.

### Caddy (prefix kept)

Caddy's `handle` forwards the path as-is, so configure the prefix:

```caddyfile
:8080 {
  handle /mousehole/* {
    reverse_proxy 127.0.0.1:5010 {
      # Server-Sent Events (GET /mousehole/events) stream until the client leaves.
      flush_interval -1
    }
  }
}
```

Set `MOUSEHOLE_BASE_PATH=/mousehole` and browse
`http://localhost:8080/mousehole/web/`.

To strip the prefix instead, use `handle_path`, leave the variable unset, and
add the header yourself (`handle_path` does not set it):

```caddyfile
:8080 {
  handle_path /mousehole/* {
    reverse_proxy 127.0.0.1:5010 {
      header_up X-Forwarded-Prefix /mousehole
      flush_interval -1
    }
  }
}
```

### Traefik (prefix stripped)

Traefik's `stripPrefix` middleware removes the prefix and sets
`X-Forwarded-Prefix` to it:

```yaml
http:
  routers:
    mousehole:
      rule: PathPrefix(`/mousehole`)
      middlewares: [mousehole-strip]
      service: mousehole
  middlewares:
    mousehole-strip:
      stripPrefix:
        prefixes: ["/mousehole"]
  services:
    mousehole:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:5010"
```

Leave `MOUSEHOLE_BASE_PATH` unset. To keep the prefix instead, drop the
middleware and set `MOUSEHOLE_BASE_PATH=/mousehole`.

## Security checks are unaffected

The [Host](/docs/security-guide.md#host-allowlist) and
[Origin](/docs/security-guide.md#origin-allowlist) allowlists stay host-only
(scheme + host + optional port, no path). A prefix never participates in either
check, and a host or origin rule that carries one is still invalid and matches
nothing:

```yaml
environment:
  MOUSEHOLE_BASE_PATH: "/mousehole"
  MOUSEHOLE_ALLOWED_HOSTS: "mousehole.myhomelab.lan" # host only
  MOUSEHOLE_ALLOWED_ORIGINS: "https://mousehole.myhomelab.lan" # origin only
```

Cookies keep the same `HttpOnly` / `SameSite` / `Secure`
([`MOUSEHOLE_HTTPS_ONLY_COOKIES`](/docs/security-guide.md#https-only-cookies))
behavior; only the `Path` changes.

## Docker healthcheck

The image's built-in healthcheck reads `MOUSEHOLE_BASE_PATH` at run time and
probes `<prefix>/health`, so it keeps working under a prefix. It does not read
`X-Forwarded-Prefix` (there is no proxy involved): with a prefix kept, set
`MOUSEHOLE_BASE_PATH`; with a prefix stripped, the container's own `/health` is
already the right URL. If you override `MOUSEHOLE_PORT`, override the
[healthcheck](/README.md#healthcheck) as before.

## Development

`bun dev` serves the UI through Vite at `/web/` and does not simulate a prefix,
so verify a prefixed deployment against a built image behind your proxy.
