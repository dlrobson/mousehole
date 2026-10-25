import { readFileSync } from "node:fs";

import { Hono, type Context } from "hono";
import { accepts } from "hono/accepts";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { proxy } from "hono/proxy";

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
import {
  WEB_BASE_URL,
  WEB_BASE_URL_PLACEHOLDER,
} from "#shared/web-base-url.ts";

const healthEndpointPath = "/health";

const maxJsonRequestBodyBytes = 8 * 1024;

/**
 * Whether a path names a file rather than a page.
 *
 * A missing `.js` must 404: answering it with the HTML shell would hand the
 * browser a document that fails to parse as JavaScript or CSS.
 */
function looksLikeFile(pathname: string): boolean {
  return /\.[^/]+$/.test(pathname);
}

/**
 * How the web UI is served under /web. Dev reverse-proxies to the Vite dev
 * server (single origin: no CORS, no cookie config, dev URL == prod URL);
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

  app.get("/", (c) => {
    const mediaType = accepts(c, {
      header: "Accept",
      supports: ["text/html", "application/json"],
      default: "text/html",
    });
    return c.redirect(mediaType === "text/html" ? "/web" : healthEndpointPath);
  });

  app.post("/login", host, origin, requireJsonBody, async (c) => {
    const result = await handlePostLogin(
      c.req.raw,
      ctx.config.auth,
      ctx.sessions,
    );
    if (!result.ok) {
      return c.json({ ok: false, message: result.message }, result.status);
    }
    ctx.sessions.applyCookie(c, result.sessionId);
    return c.json({ ok: true });
  });

  app.post("/logout", host, origin, (c) => {
    ctx.sessions.deleteRequestSession(c.req.raw);
    ctx.sessions.clearCookie(c);
    return c.json({ ok: true });
  });

  app.post("/updates", host, auth, origin, async (c) =>
    c.json(await handlePostUpdate(ctx)),
  );

  app.get("/state", host, auth, async (c) => c.json(await handleGetState(ctx)));

  app.put("/cookie", host, auth, origin, requireJsonBody, async (c) =>
    c.json(await handlePutCookie(ctx, c.req.raw)),
  );

  app.get(healthEndpointPath, async (c) => c.json(await handleGetHealth(ctx)));

  app.get("/events", host, auth, origin, (c) => {
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

  // The web UI. Not protected: the login page itself needs these assets.
  if (webMount?.mode === "vite-dev-server-proxy") {
    const proxyToVite = async (c: Context) => {
      const { pathname, search } = new URL(c.req.url);
      // Vite serves the page at the trailing-slash base (/web/).
      const path = pathname === "/web" ? "/web/" : pathname;
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
    app.get("/web", proxyToVite);
    app.get("/web/*", proxyToVite);
  } else if (webMount?.mode === "serve-static") {
    // The shell is served from memory with its <base> filled in, rather than
    // handed over as a file: relative asset URLs then resolve against the base
    // the document declares, so a deep link (/web/settings) and the slash-less
    // /web both load the same bundle the directory form does.
    //
    // The base is the constant WEB_BASE_URL today. It is written here, not
    // baked in at build time, because that is the seam a URL prefix would widen
    // to a per-request value.
    const shellPath = `${webMount.root}/index.html`;
    const shellSource = readFileSync(shellPath, "utf8");
    // A document that lost the marker has no base to declare, so its relative
    // asset URLs resolve against the request path — a blank page whose only
    // server-side trace is the 200. Fail at assembly instead.
    if (!shellSource.includes(WEB_BASE_URL_PLACEHOLDER)) {
      throw new Error(
        `${shellPath} has no ${WEB_BASE_URL_PLACEHOLDER} marker, so the shell cannot declare its base. Rebuild it with \`bun run build\`.`,
      );
    }
    const shellHtml = shellSource.replaceAll(
      WEB_BASE_URL_PLACEHOLDER,
      WEB_BASE_URL,
    );
    const renderShell = (c: Context) => c.html(shellHtml);

    // Registered before the static mount, which would otherwise answer these
    // from the file on disk: a directory resolves to its own index.html, and
    // /web/index.html is the document itself, the one copy still carrying the
    // placeholder.
    app.get("/web", renderShell);
    app.get("/web/", renderShell);
    app.get("/web/index.html", renderShell);
    app.use(
      "/web/*",
      serveStatic({
        root: webMount.root,
        rewriteRequestPath: (requestPath) => requestPath.replace(/^\/web/, ""),
      }),
    );
    // serveStatic falls through when it finds no file, so whatever is left is
    // either a deep link into the app (answer with the shell) or a missing asset
    // (404 rather than HTML that fails to parse as JS or CSS).
    app.use("/web/*", async (c: Context, next) => {
      const isDeepLink =
        (c.req.method === "GET" || c.req.method === "HEAD") &&
        (c.req.header("accept")?.includes("text/html") ?? false) &&
        !looksLikeFile(c.req.path);
      return isDeepLink ? renderShell(c) : next();
    });
  }

  return app;
}
