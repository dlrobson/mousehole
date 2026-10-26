import { readFileSync } from "node:fs";

import { Hono, type Context } from "hono";
import { accepts } from "hono/accepts";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { proxy } from "hono/proxy";

import { resolveBasePath, webBaseFor } from "#backend/base-path.ts";
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
import { WEB_BASE_URL_PLACEHOLDER } from "#shared/web-base-url.ts";

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
  // They check the Host header and Origin value only — a URL prefix never
  // reaches them, and the allowlists stay host-only.
  const host = hostAllowed(ctx.config.allowedHosts);
  const auth = requireAuth(ctx.config.auth, ctx.sessions.isSessionValid);
  const origin = originAllowed(ctx.config.allowedOrigins);

  const app = new Hono();

  // Every route is mounted under the configured prefix; "" (the default) keeps
  // the app at the origin root. Routes are registered once at assembly, so this
  // is the only prefix routing sees: a prefix-stripping proxy already removed
  // its prefix and arrives at these root paths. Replies are what still need to
  // know the public prefix (see basePathFor).
  const configuredBasePath = ctx.config.basePath;

  // Prefix a route template with the mount. "/" maps to the bare prefix
  // (`/mousehole`), so the prefix without its trailing slash is a route too.
  const at = (path: string): string =>
    path === "/" ? configuredBasePath || "/" : `${configuredBasePath}${path}`;

  // The prefix to emit in replies: redirects, the shell's <base>, the cookie's
  // scope. The configured value wins; otherwise a prefix-stripping proxy may
  // advertise the prefix it removed in X-Forwarded-Prefix. That header is
  // untrusted — a client can send it itself — so it is validated as a path and
  // discarded when it fails. It is never a scheme or host, so it cannot become
  // an off-site redirect. Re-read per request because only that half varies.
  const basePathFor = (c: Context): string =>
    resolveBasePath(configuredBasePath, c.req.header("x-forwarded-prefix"));

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

  // `/` (or the bare prefix) sends a browser to the UI and anything else to
  // the health endpoint. Both targets carry the prefix of this deployment.
  const rootHandler = (c: Context) => {
    const mediaType = accepts(c, {
      header: "Accept",
      supports: ["text/html", "application/json"],
      default: "text/html",
    });
    const prefix = basePathFor(c);
    return c.redirect(
      mediaType === "text/html"
        ? `${prefix}/web`
        : `${prefix}${healthEndpointPath}`,
    );
  };
  app.get(at("/"), rootHandler);
  // The trailing-slash form of the prefix root is a common hand-typed URL.
  if (configuredBasePath) app.get(`${configuredBasePath}/`, rootHandler);

  app.post(at("/login"), host, origin, requireJsonBody, async (c) => {
    const result = await handlePostLogin(
      c.req.raw,
      ctx.config.auth,
      ctx.sessions,
    );
    if (!result.ok) {
      return c.json({ ok: false, message: result.message }, result.status);
    }
    // Scoped to the deployment, so it is only sent where the app lives.
    ctx.sessions.applyCookie(c, result.sessionId, basePathFor(c) || "/");
    return c.json({ ok: true });
  });

  app.post(at("/logout"), host, origin, (c) => {
    ctx.sessions.deleteRequestSession(c.req.raw);
    ctx.sessions.clearCookie(c, basePathFor(c) || "/");
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

  // The web UI. Not protected: the login page itself needs these assets.
  //
  // The slash-less /web redirects to the directory form, which is what the Vite
  // dev server already does: one canonical URL, and the document's relative
  // asset URLs resolve against the trailing-slash base. The shell routes below
  // and the deep-link fallback are what answer everything at or under /web/.
  if (webMount) {
    app.get(at("/web"), (c) => c.redirect(`${basePathFor(c)}/web/`));
  }

  if (webMount?.mode === "vite-dev-server-proxy") {
    const proxyToVite = async (c: Context) => {
      const { search } = new URL(c.req.url);
      // The backend route carries the configured prefix; Vite always serves the
      // UI from its own /web/ base. /web itself never reaches here: the
      // redirect above registers it first.
      const path = c.req.path.slice(configuredBasePath.length);
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
  } else if (webMount?.mode === "serve-static") {
    // The shell is served from memory with its <base> filled in, rather than
    // handed over as a file: relative asset URLs then resolve against the base
    // the document declares, so a deep link (/web/settings) loads the same
    // bundle the directory form does.
    const shellPath = `${webMount.root}/index.html`;
    const shellSource = readFileSync(shellPath, "utf8");
    // A document that lost the marker has no base to declare, so its relative
    // asset URLs resolve against the request path — a blank page whose only
    // server-side trace is the 200. Fail at assembly instead. That guard matters
    // more now that the value substituted varies per request: a markerless build
    // would silently serve base-less HTML under every prefix.
    if (!shellSource.includes(WEB_BASE_URL_PLACEHOLDER)) {
      throw new Error(
        `${shellPath} has no ${WEB_BASE_URL_PLACEHOLDER} marker, so the shell cannot declare its base. Rebuild it with \`bun run build\`.`,
      );
    }
    // The base is per request — the configured prefix, or the one a stripping
    // proxy advertises — so the substitution happens here, not once at
    // assembly. It is cheap string work on the cached source (read exactly
    // once), and the shell carries no long-lived cache header, so there is no
    // prefix-keyed cache to keep in sync.
    const renderShell = (c: Context) =>
      c.html(
        shellSource.replaceAll(
          WEB_BASE_URL_PLACEHOLDER,
          webBaseFor(basePathFor(c)),
        ),
      );

    // Registered before the static mount, which would otherwise answer these
    // from the file on disk: a directory resolves to its own index.html, and
    // /web/index.html is the document itself, the one copy still carrying the
    // placeholder.
    app.get(at("/web/"), renderShell);
    app.get(at("/web/index.html"), renderShell);
    app.use(
      at("/web/*"),
      serveStatic({
        root: webMount.root,
        rewriteRequestPath: (requestPath) => {
          // Strip the mount first, then the UI's own segment, in that order.
          // serveStatic rejects "."/".." segments, "//", and backslashes in
          // the decoded path before this runs, and a validated prefix carries
          // none of them, so the remainder cannot climb out of `root`.
          const withoutBase = configuredBasePath
            ? requestPath.slice(configuredBasePath.length)
            : requestPath;
          return withoutBase.replace(/^\/web/, "");
        },
      }),
    );
    // serveStatic falls through when it finds no file, so whatever is left is
    // either a deep link into the app (answer with the shell) or a missing asset
    // (404 rather than HTML that fails to parse as JS or CSS).
    app.use(at("/web/*"), async (c: Context, next) => {
      const isDeepLink =
        (c.req.method === "GET" || c.req.method === "HEAD") &&
        (c.req.header("accept")?.includes("text/html") ?? false) &&
        !looksLikeFile(c.req.path);
      return isDeepLink ? renderShell(c) : next();
    });
  }

  return app;
}
