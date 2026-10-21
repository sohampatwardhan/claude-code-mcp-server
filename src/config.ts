/**
 * Server configuration, read once from the environment at startup.
 * Invalid values are rejected up front so tool calls never run with a
 * half-valid configuration.
 */

export const DEFAULT_TIMEOUT_MS = 300_000;

/** Environment ids are opaque tokens such as `ccpool_...`. */
export const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface Config {
  /** Path or name of the `claude` binary. */
  claudeBin: string;
  /** Default cloud environment id, used when a call omits `environment_id`. */
  defaultEnvironmentId: string | null;
  /** Hard timeout for each spawned CLI process. */
  timeoutMs: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const claudeBin = (env.CLAUDE_BIN ?? "").trim() || "claude";

  const rawEnvId = (env.CLAUDE_CLOUD_ENVIRONMENT_ID ?? "").trim();
  if (rawEnvId !== "" && !ENVIRONMENT_ID_PATTERN.test(rawEnvId)) {
    throw new ConfigError(
      `CLAUDE_CLOUD_ENVIRONMENT_ID must match ${ENVIRONMENT_ID_PATTERN}, got ${JSON.stringify(rawEnvId)}`,
    );
  }

  const rawTimeout = (env.CLAUDE_MCP_TIMEOUT_MS ?? "").trim();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== "") {
    if (!/^[1-9][0-9]*$/.test(rawTimeout)) {
      throw new ConfigError(
        `CLAUDE_MCP_TIMEOUT_MS must be a positive integer (milliseconds), got ${JSON.stringify(rawTimeout)}`,
      );
    }
    timeoutMs = Number(rawTimeout);
  }

  return {
    claudeBin,
    defaultEnvironmentId: rawEnvId === "" ? null : rawEnvId,
    timeoutMs,
  };
}
