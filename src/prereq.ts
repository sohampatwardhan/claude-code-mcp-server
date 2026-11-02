import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** npm package that provides the `claude` binary. */
export const CLI_PACKAGE = "@anthropic-ai/claude-code";
export const CLI_INSTALL_COMMAND = `npm install -g ${CLI_PACKAGE}`;

/** What a caller needs before any cloud session tool can work. */
export const CLI_SIGN_IN_HINT =
  "Sign in with `claude` first: run `claude` once in a terminal on this machine and complete the claude.ai login " +
  "(`claude auth status` should report \"loggedIn\": true). Cloud sessions need a claude.ai account with Claude Code " +
  "on the web and the Claude GitHub app installed on the repositories they use.";

export function cliNotFoundMessage(bin: string): string {
  return (
    `Claude Code CLI not found: ${bin}. Install it with \`${CLI_INSTALL_COMMAND}\`, then run \`claude\` once to sign in, ` +
    "or set CLAUDE_BIN to the path of an installed claude binary."
  );
}

export function signInMessage(detail: string): string {
  return `Claude Code CLI is not signed in${detail ? ` (${detail})` : ""}. ${CLI_SIGN_IN_HINT}`;
}

const SIGN_IN_PATTERNS: RegExp[] = [
  /\bnot (?:logged|signed) in\b/i,
  /\bplease (?:run )?\/login\b/i,
  /\brun `?claude (?:auth )?login`?/i,
  /\binvalid api key\b/i,
  /\boauth token (?:has )?expired\b/i,
  /\bauthentication (?:failed|required|error)\b/i,
  /\bmust be (?:logged|signed) in\b/i,
  /\b(?:log|sign) in (?:to|with) (?:your )?claude(?:\.ai)?\b/i,
  /"loggedIn"\s*:\s*false/,
];

/** True when CLI output reads like a missing or expired claude.ai login. */
export function isSignInError(text: string): boolean {
  return SIGN_IN_PATTERNS.some((re) => re.test(text));
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `bin` the way spawn would: a value with a path separator is a
 * file path (relative to `cwd`), anything else is looked up on PATH.
 * Returns the resolved path, or null when no executable file is found.
 */
export function findCli(bin: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    const path = isAbsolute(bin) ? bin : resolve(cwd, bin);
    return isExecutableFile(path) ? path : null;
  }
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}
