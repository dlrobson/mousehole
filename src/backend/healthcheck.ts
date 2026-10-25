import { buildConfig } from "#backend/config.ts";

/**
 * The Docker healthcheck's probe URL: the app's own `<base>/health`.
 *
 * Resolves the prefix through `buildConfig` so the probe cannot disagree with
 * how the server reads and normalizes `MOUSEHOLE_BASE_PATH`. The port is the
 * image's fixed listener port (5010); override the healthcheck when
 * `MOUSEHOLE_PORT` changes (see the README).
 */
export function healthcheckUrl(env: NodeJS.ProcessEnv): URL {
  const { basePath } = buildConfig(env);
  return new URL(`${basePath}/health`, "http://localhost:5010");
}
