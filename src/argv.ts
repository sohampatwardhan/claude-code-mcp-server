/**
 * Deterministic argv construction. Each tool maps to exactly one fixed argv
 * shape; values are always attached with `=` (or placed after `--`) so a value
 * that starts with `-` can never be parsed by the CLI as a flag.
 */

export function createSessionArgv(description: string, environmentId: string | null): string[] {
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
