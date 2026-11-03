/**
 * Server configuration, read once from the environment at startup.
 * Invalid values are rejected up front so tool calls never run with a
 * half-valid configuration.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { LocalRootError, parseLocalRoots } from "./local.js";
import { defaultRepoCache, parseAllowlist, type AllowEntry } from "./repos.js";

export const DEFAULT_TIMEOUT_MS = 300_000;

/** Environment ids are opaque tokens such as `ccpool_...`. */
export const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Shortest `CLAUDE_MCP_TOKEN` accepted. */
export const MIN_TOKEN_LENGTH = 32;

/** Hostnames every HTTP server accepts in the Host header: loopback only. */
export const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

/** Streamable HTTP listener settings, present only when `CLAUDE_MCP_HTTP_PORT` is set. */
export interface HttpConfig {
  /** Address to bind. `127.0.0.1` unless `CLAUDE_MCP_HTTP_HOST` says otherwise. */
  host: string;
  /** Port to bind; 0 lets the OS pick one (used by tests). */
  port: number;
  /** Bearer token every request must carry. Never logged or echoed. */
  token: string;
  /**
   * Hostnames (port-agnostic, as the URL API parses the Host header) a request
   * may name: loopback, the bind host, and `CLAUDE_MCP_HTTP_ALLOWED_HOSTS`.
   */
  allowedHosts: string[];
}

export interface Config {
  /** Path or name of the `claude` binary. */
  claudeBin: string;
  /** Default cloud environment id, used when a call omits `environment_id`. */
  defaultEnvironmentId: string | null;
  /** Hard timeout for each spawned CLI process. */
  timeoutMs: number;
  /** Default idle-output timeout for `claude --cloud` on create, or null when off. */
  idleTimeoutMs: number | null;
  /**
   * When true, accept Claude Code's workspace-trust dialog for the process
   * working directory (the main git checkout when that directory is a
   * repository or worktree). Off by default.
   */
  trustCwd: boolean;
  /** Python 3 interpreter used to allocate the pty for `claude --cloud`. */
  pythonBin: string;
  /**
   * Directory the CLI runs in when a call omits `repo`. `claude --cloud`
   * packages this tree, and workspace trust is keyed from it.
   */
  cwd: string;
  /**
   * Absolute directories a create call may select. github.com owner/name
   * entries are accepted here for compatibility and are not required: any
   * github.com repository may be cloned into `repoCache`.
   */
  repos: AllowEntry[];
  /** Directory that holds checkouts of GitHub repositories named by a call. */
  repoCache: string;
  /**
   * Real paths of the directories `claude_run_local` may run in (and their
   * subdirectories). Empty by default, which refuses every local run.
   */
  localRoots: string[];
  /**
   * When true, a local run may pre-approve `Bash` or use `auto` mode, either
   * of which runs shell commands without asking. Off by default.
   */
  localAllowShell: boolean;
  /**
   * Refuse new creates and local runs when the plan's session or weekly
   * usage is at or above this percent. Null (the default) skips the check.
   */
  usageStopPercent: number | null;
  /** Streamable HTTP transport, or null for stdio (the default). */
  http: HttpConfig | null;
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

  const timeoutMs = parseMilliseconds("CLAUDE_MCP_TIMEOUT_MS", env.CLAUDE_MCP_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = parseMilliseconds("CLAUDE_MCP_IDLE_TIMEOUT_MS", env.CLAUDE_MCP_IDLE_TIMEOUT_MS);

  const trustCwd = parseBooleanFlag("CLAUDE_MCP_TRUST_CWD", env.CLAUDE_MCP_TRUST_CWD);
  const localAllowShell = parseBooleanFlag("CLAUDE_MCP_LOCAL_ALLOW_SHELL", env.CLAUDE_MCP_LOCAL_ALLOW_SHELL);
  const usageStopPercent = parsePercent("CLAUDE_MCP_USAGE_STOP_PERCENT", env.CLAUDE_MCP_USAGE_STOP_PERCENT);
  const pythonBin = (env.CLAUDE_MCP_PYTHON ?? "").trim() || "python3";
  const cwd = resolveCwd(env.CLAUDE_MCP_CWD);
  let repos: AllowEntry[];
  try {
    repos = parseAllowlist(env.CLAUDE_MCP_REPOS);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  const repoCache = resolveRepoCache(env.CLAUDE_MCP_REPO_CACHE);
  let localRoots: string[];
  try {
    localRoots = parseLocalRoots(env.CLAUDE_MCP_LOCAL_ROOTS);
  } catch (err) {
    if (err instanceof LocalRootError) throw new ConfigError(err.message);
    throw err;
  }

  return {
    claudeBin,
    defaultEnvironmentId: rawEnvId === "" ? null : rawEnvId,
    timeoutMs,
    idleTimeoutMs,
    trustCwd,
    pythonBin,
    cwd,
    repos,
    repoCache,
    localRoots,
    localAllowShell,
    usageStopPercent,
    http: parseHttp(env),
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

/** Unset or blank uses `~/.claude-mcp/repos`. An existing path must be a directory. */
function resolveRepoCache(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  const cache = trimmed === "" ? defaultRepoCache() : resolve(trimmed);
  if (!existsSync(cache)) return cache;
  let info;
  try {
    info = statSync(cache);
  } catch {
    throw new ConfigError(`CLAUDE_MCP_REPO_CACHE does not exist: ${JSON.stringify(cache)}`);
  }
  if (!info.isDirectory()) {
    throw new ConfigError(`CLAUDE_MCP_REPO_CACHE is not a directory: ${JSON.stringify(cache)}`);
  }
  return cache;
}

/** Unset or blank is null. A set value must be a positive integer number of milliseconds. */
function parseMilliseconds(name: string, raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ConfigError(`${name} must be a positive integer (milliseconds), got ${JSON.stringify(raw)}`);
  }
  return Number(value);
}

/** Unset or blank is null. A set value must be an integer from 1 to 100. */
function parsePercent(name: string, raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) {
    throw new ConfigError(`${name} must be an integer from 1 to 100, got ${JSON.stringify(raw)}`);
  }
  return Number(value);
}

/**
 * HTTP is off unless `CLAUDE_MCP_HTTP_PORT` is set. Then `CLAUDE_MCP_TOKEN` is
 * required, so the listener never starts without authentication. Messages
 * never include the token.
 */
function parseHttp(env: NodeJS.ProcessEnv): HttpConfig | null {
  const rawPort = (env.CLAUDE_MCP_HTTP_PORT ?? "").trim();
  if (rawPort === "") return null;
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(rawPort) || Number(rawPort) > 65_535) {
    throw new ConfigError(`CLAUDE_MCP_HTTP_PORT must be a port number from 0 to 65535, got ${JSON.stringify(rawPort)}`);
  }
  const token = env.CLAUDE_MCP_TOKEN ?? "";
  if (token === "") {
    throw new ConfigError("CLAUDE_MCP_HTTP_PORT is set but CLAUDE_MCP_TOKEN is not; the HTTP transport refuses to start without a token");
  }
  if (token.length < MIN_TOKEN_LENGTH || token.length > 1_024 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new ConfigError(
      `CLAUDE_MCP_TOKEN must be ${MIN_TOKEN_LENGTH} to 1024 printable characters with no whitespace (for example \`openssl rand -hex 32\`)`,
    );
  }
  const host = (env.CLAUDE_MCP_HTTP_HOST ?? "").trim() || "127.0.0.1";
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) {
    throw new ConfigError(`CLAUDE_MCP_HTTP_HOST must be an IP address or hostname, got ${JSON.stringify(host)}`);
  }
  const allowed = new Set<string>(LOOPBACK_HOSTNAMES);
  const bind = hostnameOf(host);
  if (bind !== "0.0.0.0" && bind !== "[::]") allowed.add(bind);
  for (const part of (env.CLAUDE_MCP_HTTP_ALLOWED_HOSTS ?? "").split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry === "") continue;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])$/.test(entry)) {
      throw new ConfigError(`CLAUDE_MCP_HTTP_ALLOWED_HOSTS entries must be hostnames without a port or scheme, got ${JSON.stringify(entry)}`);
    }
    allowed.add(entry);
  }
  return { host, port: Number(rawPort), token, allowedHosts: [...allowed] };
}

/** The bind address as the URL API reports a Host header's hostname (IPv6 in brackets). */
function hostnameOf(host: string): string {
  return host.includes(":") ? `[${host.toLowerCase()}]` : host.toLowerCase();
}

/** Empty means false. `1` / `true` / `yes` (any case) mean true. */
function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "0" || value === "false" || value === "no") return false;
  if (value === "1" || value === "true" || value === "yes") return true;
  throw new ConfigError(`${name} must be 1, true, yes, 0, false, or no, got ${JSON.stringify(raw)}`);
}
