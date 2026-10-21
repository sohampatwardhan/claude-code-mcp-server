/**
 * Server configuration, read once from the environment at startup.
 * Invalid values are rejected up front so tool calls never run with a
 * half-valid configuration.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";

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
  /**
   * When true, accept Claude Code's workspace-trust dialog for the process
   * working directory (the main git checkout when that directory is a
   * repository or worktree). Off by default.
   */
  trustCwd: boolean;
  /** Python 3 interpreter used to allocate the pty for `claude --cloud`. */
  pythonBin: string;
  /**
   * Directory the CLI runs in. `claude --cloud` packages this tree, and
   * workspace trust is keyed from it.
   */
  cwd: string;
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

  const trustCwd = parseBooleanFlag("CLAUDE_MCP_TRUST_CWD", env.CLAUDE_MCP_TRUST_CWD);
  const pythonBin = (env.CLAUDE_MCP_PYTHON ?? "").trim() || "python3";
  const cwd = resolveCwd(env.CLAUDE_MCP_CWD);

  return {
    claudeBin,
    defaultEnvironmentId: rawEnvId === "" ? null : rawEnvId,
    timeoutMs,
    trustCwd,
    pythonBin,
    cwd,
  };
}

/** Unset or blank uses `process.cwd()`. A set value must be an existing directory. */
function resolveCwd(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return process.cwd();
  const cwd = resolve(trimmed);
  let info;
  try {
    info = statSync(cwd);
  } catch {
    throw new ConfigError(`CLAUDE_MCP_CWD does not exist: ${JSON.stringify(cwd)}`);
  }
  if (!info.isDirectory()) {
    throw new ConfigError(`CLAUDE_MCP_CWD is not a directory: ${JSON.stringify(cwd)}`);
  }
  return cwd;
}

/** Empty means false. `1` / `true` / `yes` (any case) mean true. */
function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "0" || value === "false" || value === "no") return false;
  if (value === "1" || value === "true" || value === "yes") return true;
  throw new ConfigError(`${name} must be 1, true, yes, 0, false, or no, got ${JSON.stringify(raw)}`);
}
