/**
 * Deterministic argv construction. Each tool maps to exactly one fixed argv
 * shape; values are always attached with `=` (or placed after `--`) so a value
 * that starts with `-` can never be parsed by the CLI as a flag.
 *
 * Create and follow-up start with `--cloud=`. `teleportArgv` is the one
 * exception: print-mode `--teleport=<session>` is how the CLI checks out the
 * branch a cloud session pushed. It carries no prompt and is not a `--cloud=`
 * argv. `assertCloud` still guards create and follow-up.
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
