import { Hono, type Context } from "hono";
import { accepts } from "hono/accepts";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { proxy } from "hono/proxy";

import { normalizeBasePath } from "#backend/base-path.ts";
import type { AppContext } from "#backend/context.ts";
import { toErrorResponseArgs } from "#backend/error.ts";
import { handlePutCookie } from "#backend/handlers/cookie.ts";
import { handleGetHealth } from "#backend/handlers/health.ts";
import { handlePostLogin } from "#backend/handlers/login.ts";
import { handleGetState } from "#backend/handlers/state.ts";
import { handlePostUpdate } from "#backend/handlers/updates.ts";
import {
  hostAllowed,
  originAllowed,
  requireAuth,
  requireJsonBody,
} from "#backend/http-boundary.ts";
import { logger } from "#backend/logger.ts";
import { extractSessionId } from "#backend/session.ts";

const healthEndpointPath = "/health";

const maxJsonRequestBodyBytes = 8 * 1024;

/**
 * How the web UI is served under `<base>/web`. Dev reverse-proxies to the Vite
 * dev server (single origin: no CORS, no cookie config, dev URL == prod URL);
 * prod serves the `vite build` output. Tests omit it to mount nothing.
 */
export type WebMount =
  | { mode: "vite-dev-server-proxy"; target: string }
  | { mode: "serve-static"; root: string };

/**
 * Pure assembly of the HTTP app: routes + middleware over a Hono instance.
 * Binding a listener, background tasks, and signal handling live in server.ts.
 *
 * @param ctx - the app's config and stateful services (see context.ts).
 * @param webMount - how to serve the frontend under /web, if at all.
 */
export function createApp(ctx: AppContext, webMount?: WebMount): Hono {
  // The boundary middlewares, bound once to this context's config. Each route
  // below lists its requirements varargs-style in host → auth → origin → json
  // order; the first failing check logs and responds (see http-boundary.ts).
  const host = hostAllowed(ctx.config.allowedHosts);
  const auth = requireAuth(ctx.config.auth, ctx.sessions.isSessionValid);
  const origin = originAllowed(ctx.config.allowedOrigins);

  // Everything is mounted under this prefix: "" (the default) keeps the app at
  // the origin root exactly as before, while "/mousehole" nests every route
  // under it. A stripping reverse proxy needs no prefix here at all.
  const basePath = ctx.config.basePath;
  const at = (path: string): string =>
    path === "/" ? basePath || "/" : `${basePath}${path}`;

  // The prefix to put in replies (redirects, cookie scope). Config wins; when
  // MOUSEHOLE_BASE_PATH is unset, a stripping proxy may advertise the prefix it
  // removed via X-Forwarded-Prefix. It's validated as a path prefix, so it can
  // never become an open redirect, and a client can only ever scope its own
  // cookie with it.
  const replyBasePath = (c: Context): string => {
    if (basePath) return basePath;
    const forwarded = c.req.header("x-forwarded-prefix");
    return forwarded === undefined ? "" : (normalizeBasePath(forwarded) ?? "");
  };

  const app = new Hono();

  app.use(async (c, next) => {
    await next();
    logger.debug(`${c.req.method} ${c.req.path} → ${c.res.status}`);
  });

  app.use(
    bodyLimit({
      maxSize: maxJsonRequestBodyBytes,
      onError: (c) =>
        c.json(
          {
            type: "payload-too-large",
            message: `Request body must not exceed ${maxJsonRequestBodyBytes} bytes.`,
          },
          413,
        ),
    }),
  );

  app.onError((error, c) => {
    const { body, status } = toErrorResponseArgs(error);
    return c.json(body, status);
  });

  app.notFound((c) => c.json({ type: "not-found", message: "Not Found" }, 404));

  const rootHandler = (c: Context) => {
    const mediaType = accepts(c, {
      header: "Accept",
      supports: ["text/html", "application/json"],
      default: "text/html",
    });
    const prefix = replyBasePath(c);
    return c.redirect(
      mediaType === "text/html"
        ? `${prefix}/web/`
        : `${prefix}${healthEndpointPath}`,
    );
  };

  app.get(at("/"), rootHandler);
  // A trailing slash on the base root is common hand-typed input; treat it the
  // same as the base root itself.
  if (basePath) app.get(`${basePath}/`, rootHandler);

  app.post(at("/login"), host, origin, requireJsonBody, async (c) => {
    const result = await handlePostLogin(
      c.req.raw,
      ctx.config.auth,
      ctx.sessions,
    );
    if (!result.ok) {
      return c.json({ ok: false, message: result.message }, result.status);
    }
    ctx.sessions.applyCookie(c, result.sessionId, replyBasePath(c) || "/");
    return c.json({ ok: true });
  });

  app.post(at("/logout"), host, origin, (c) => {
    ctx.sessions.deleteRequestSession(c.req.raw);
    // The cookie may have been set under a different reply prefix than this
    // request carries (before MOUSEHOLE_BASE_PATH was introduced, or before a
    // proxy started sending X-Forwarded-Prefix), and a browser only drops a
    // cookie whose Path matches. Clear every path it could be scoped to.
    const path = replyBasePath(c) || "/";
    ctx.sessions.clearCookie(c, path);
    if (path !== "/") ctx.sessions.clearCookie(c, "/");
    return c.json({ ok: true });
  });

  app.post(at("/updates"), host, auth, origin, async (c) =>
    c.json(await handlePostUpdate(ctx)),
  );

  app.get(at("/state"), host, auth, async (c) =>
    c.json(await handleGetState(ctx)),
  );

  app.put(at("/cookie"), host, auth, origin, requireJsonBody, async (c) =>
    c.json(await handlePutCookie(ctx, c.req.raw)),
  );

  app.get(at(healthEndpointPath), async (c) =>
    c.json(await handleGetHealth(ctx)),
  );

  app.get(at("/events"), host, auth, origin, (c) => {
    const sessionId = extractSessionId(c.req.raw) ?? "";
    let unregister: (() => void) | undefined;
    const stream = new ReadableStream<string>({
      start(controller) {
        unregister = ctx.sse.register({ sessionId, controller });
      },
      cancel() {
        unregister?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // The web UI. Not protected: the login page itself needs these assets. The
  // Vite build uses relative asset URLs (see vite.config.ts), so a slash-less
  // /web would resolve them one directory too high; redirect to the directory
  // form (which is what Vite's own dev server does). Registered before the
  // /web/* mount so the wildcard doesn't answer it first.
  if (webMount) {
    app.get(at("/web"), (c) => c.redirect(`${replyBasePath(c)}/web/`));

    if (webMount.mode === "vite-dev-server-proxy") {
      const proxyToVite = async (c: Context) => {
        const { pathname, search } = new URL(c.req.url);
        // The backend route carries the configured prefix; Vite always serves
        // the UI from its /web/ base.
        const path = pathname.slice(basePath.length);
        try {
          return await proxy(`${webMount.target}${path}${search}`, {
            headers: c.req.header(),
          });
        } catch {
          return c.text(
            `The Vite dev server isn't reachable at ${webMount.target}.\n` +
              "Start it with `bun dev:web`, or run both processes with `bun dev`.",
            502,
          );
        }
      };
      app.get(at("/web/*"), proxyToVite);
    } else {
      app.use(
        at("/web/*"),
        serveStatic({
          root: webMount.root,
          // The route carries the prefix; the files on disk do not.
          rewriteRequestPath: (requestPath) =>
            requestPath.slice(at("/web").length),
        }),
      );
      app.get(
        at("/web/"),
        serveStatic({ path: `${webMount.root}/index.html` }),
      );
    }
  }

  return app;
}
