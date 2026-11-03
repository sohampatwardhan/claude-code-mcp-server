/**
 * Deterministic argv construction. Each tool maps to exactly one fixed argv
 * shape; values are always attached with `=` (or placed after `--`) so a value
 * that starts with `-` can never be parsed by the CLI as a flag.
 *
 * Create and follow-up start with `--cloud=`. `teleportArgv` is the one
 * exception: print-mode `--teleport=<session>` is how the CLI checks out the
 * branch a cloud session pushed. It carries no prompt and is not a `--cloud=`
 * argv. `assertCloud` still guards create and follow-up. `localRunArgv` is the
 * only local Claude Code run: print mode, guarded by `assertLocal`.
 */

const TELEPORT_SESSION = /^(?:session|cse)_[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function createSessionArgv(description: string, environmentId: string | null): string[] {
  // `--cloud=<description>` is the create form for Anthropic-hosted and
  // self-hosted sessions. It requires a terminal; the pty runner supplies one.
  // The headless alternative `claude -p <task> --environment=<ccpool>` is not
  // used: it only targets self-hosted pools, and dropping `--cloud=` would let
  // an older CLI start a local session.
  const argv = [`--cloud=${description}`];
  if (environmentId !== null) argv.push(`--environment=${environmentId}`);
  return assertCloud(argv);
}

export function sendFollowupArgv(session: string, message: string): string[] {
  return assertCloud([`--cloud=${session}`, "-p", "--", message]);
}

export function authStatusArgv(): string[] {
  return ["auth", "status"];
}

/**
 * Print-mode teleport. `--debug-file` is how Claude Code 2.1.300 records
 * `Branch after checkout: '<name>'`; without `--debug` that line is dropped
 * and stdout can be empty. The debug file path is chosen by the server.
 */
export function teleportArgv(sessionId: string, debugFile: string): string[] {
  if (!TELEPORT_SESSION.test(sessionId)) {
    throw new Error("internal error: teleport session id is not a session id");
  }
  if (!debugFile.startsWith("/") || debugFile.includes("\n") || debugFile.includes("\0")) {
    throw new Error("internal error: teleport debug file must be an absolute path");
  }
  const argv = [`--teleport=${sessionId}`, "--debug", `--debug-file=${debugFile}`];
  const teleport = argv[0];
  const debugFlag = argv[1];
  const debugFileArg = argv[2];
  if (
    argv.length !== 3 ||
    teleport === undefined ||
    !teleport.startsWith("--teleport=") ||
    debugFlag !== "--debug" ||
    debugFileArg === undefined ||
    !debugFileArg.startsWith("--debug-file=")
  ) {
    throw new Error("internal error: teleport argv drifted");
  }
  return argv;
}

/** Local Claude Code session ids are UUIDs. */
export const LOCAL_SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A model alias (`opus`, `sonnet[1m]`) or full model name (`claude-opus-5-5`). */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\[[0-9a-z]{1,10}\])?$/;

/**
 * Permission modes a local run may use. `bypassPermissions` (the same as
 * `--dangerously-skip-permissions`) is never offered. `dontAsk` denies any
 * call that would prompt, which is what an unattended print-mode run needs.
 */
export const LOCAL_PERMISSION_MODES = ["dontAsk", "acceptEdits", "plan", "auto"] as const;
export type LocalPermissionMode = (typeof LOCAL_PERMISSION_MODES)[number];

/** Built-in tools a local run may pre-approve with `--allowedTools`. No patterns, no MCP tools. */
export const LOCAL_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
] as const;
export type LocalAllowedTool = (typeof LOCAL_ALLOWED_TOOLS)[number];

export interface LocalRunOptions {
  prompt: string;
  permissionMode: LocalPermissionMode;
  model: string | null;
  maxTurns: number | null;
  allowedTools: readonly LocalAllowedTool[];
  resume: string | null;
  /**
   * Run in Claude Code's restricted mode with no MCP servers: no tools that
   * run commands or code, no WebFetch, no user or project settings files
   * (so no checkout hooks, allow rules or `.mcp.json`), file tools confined
   * to the working directory, and writes to settings and git files refused.
   * Set whenever the operator has not allowed shell access.
   */
  restricted: boolean;
}

/**
 * Print-mode `claude -p` for `claude_run_local`, the one tool that runs
 * Claude Code locally. The permission mode is always explicit, so a settings
 * file's `defaultMode` can't turn a run into `bypassPermissions`.
 */
export function localRunArgv(options: LocalRunOptions): string[] {
  const { prompt, permissionMode, model, maxTurns, allowedTools, resume, restricted } = options;
  if (!(LOCAL_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new Error("internal error: local permission mode is not allowed");
  }
  if (model !== null && !MODEL_PATTERN.test(model)) throw new Error("internal error: model does not match its pattern");
  if (maxTurns !== null && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new Error("internal error: max turns must be a positive integer");
  }
  if (allowedTools.some((tool) => !(LOCAL_ALLOWED_TOOLS as readonly string[]).includes(tool))) {
    throw new Error("internal error: allowed tool is not on the fixed list");
  }
  if (resume !== null && !LOCAL_SESSION_ID_PATTERN.test(resume)) {
    throw new Error("internal error: resume is not a session id");
  }
  const argv = ["-p"];
  if (restricted) argv.push("--restricted", "--strict-mcp-config");
  argv.push("--output-format=stream-json", "--verbose", `--permission-mode=${permissionMode}`);
  if (model !== null) argv.push(`--model=${model}`);
  if (maxTurns !== null) argv.push(`--max-turns=${maxTurns}`);
  if (allowedTools.length > 0) argv.push(`--allowedTools=${[...new Set(allowedTools)].join(",")}`);
  if (resume !== null) argv.push(`--resume=${resume}`);
  argv.push("--", prompt);
  return assertLocal(argv);
}

/**
 * Print-mode `/usage` for `claude_usage`. `/usage` is a local command: the
 * CLI reads the plan's usage and runs no model turn, so this costs nothing.
 * Restricted, with no MCP servers, so no hooks or settings run either.
 */
export function usageArgv(): string[] {
  return assertLocal(["-p", "--restricted", "--strict-mcp-config", "--output-format=stream-json", "--verbose", "--", "/usage"]);
}

/**
 * Invariant: a local run is print mode and never a cloud, teleport, or
 * permission-skipping invocation. Everything before `--` is a flag this
 * module built.
 */
function assertLocal(argv: string[]): string[] {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  if (
    argv[0] !== "-p" ||
    end !== argv.length - 2 ||
    flags.some(
      (arg) =>
        arg.startsWith("--cloud") ||
        arg.startsWith("--teleport") ||
        arg.startsWith("--dangerously") ||
        arg.includes("bypassPermissions"),
    )
  ) {
    throw new Error("internal error: local argv must be print mode with no --cloud, --teleport, or permission bypass");
  }
  return argv;
}

/**
 * Invariant: session tools only ever drive cloud sessions. If the leading
 * `--cloud=` flag were lost the CLI would start a local session instead, so
 * refuse to build such an argv at all.
 */
function assertCloud(argv: string[]): string[] {
  if (!argv[0]?.startsWith("--cloud=")) {
    throw new Error("internal error: session argv must start with --cloud=");
  }
  return argv;
}
