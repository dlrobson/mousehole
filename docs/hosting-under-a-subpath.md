# Hosting Under a Subpath

By default Mousehole serves its web UI and API at the origin root
(`http://host:5010/web/`). If Mousehole shares a hostname with other apps behind
a reverse proxy, you'll want it reachable at a subpath such as
`https://host/mousehole/` instead.

There is one way to arrange that: keep the prefix in the request. The proxy
forwards `/mousehole/...` unchanged and you set
`MOUSEHOLE_BASE_PATH=/mousehole`.

The whole app moves together: UI at `<prefix>/web/`, API at
`<prefix>/{login,logout,updates,state,cookie,events,health}`, and `<prefix>`
redirects into the app.

## Setting `MOUSEHOLE_BASE_PATH`

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
dropped and a leading slash is added, so `mousehole/` and `/mousehole` name the
same prefix and surrounding spaces are ignored. A value that isn't a plain URL
path — one with a scheme or host, `//`, `.`/`..` segments, whitespace inside a
segment, `?`, `#`, or a backslash — stops Mousehole at startup with a message
naming `MOUSEHOLE_BASE_PATH`.

The session cookie's `Path` is set to the prefix, so the browser only sends the
session to Mousehole, not to the other apps on the hostname.

## Reverse proxy examples

Each example forwards the path unchanged, which is what
`MOUSEHOLE_BASE_PATH=/mousehole` expects. A proxy that strips the prefix before
forwarding will leave the app's own redirects and asset URLs pointing at the
prefix, so keep it instead of stripping it.

### nginx

No trailing slash on `proxy_pass`: that would strip `/mousehole`.

```nginx
location = /mousehole {
  return 302 /mousehole/;
}

location /mousehole/ {
  proxy_pass http://127.0.0.1:5010;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  # Server-Sent Events (GET /mousehole/events) stream until the client leaves.
  proxy_buffering off;
}
```

### Caddy

```caddyfile
:8080 {
  redir /mousehole /mousehole/
  handle /mousehole/* {
    reverse_proxy 127.0.0.1:5010 {
      # Server-Sent Events (GET /mousehole/events) stream until the client leaves.
      flush_interval -1
    }
  }
}
```

`handle_path` would strip the prefix, so use `handle` and browse
`http://localhost:8080/mousehole/web/`.

### Traefik

No `stripPrefix` middleware: the router's `PathPrefix` rule forwards the path
as-is.

```yaml
http:
  routers:
    mousehole:
      rule: PathPrefix(`/mousehole`)
      service: mousehole
  services:
    mousehole:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:5010"
```

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
behavior; the prefix only changes their `Path`.

## Docker healthcheck

The image's built-in healthcheck reads `MOUSEHOLE_BASE_PATH` at run time and
probes `<prefix>/health`, so it keeps working under a prefix. If you override
`MOUSEHOLE_PORT`, override the [healthcheck](/README.md#healthcheck) to match.

## Development

`bun dev` serves the UI through Vite at `/web/` and does not simulate a prefix,
so verify a prefixed deployment against a built image behind your proxy.
