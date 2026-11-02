/**
 * Directory checks for `claude_run_local`.
 *
 * A local run happens in an existing checkout on this machine, so it may only
 * start inside a root listed in `CLAUDE_MCP_LOCAL_ROOTS`. Roots and the
 * requested directory are compared after `realpath`, so a symlink can't lead
 * out of a root, and macOS `/var` and `/private/var` spellings agree. Print
 * mode skips Claude Code's workspace-trust dialog: listing a root trusts
 * every checkout under it.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Shape accepted for a local run's `cwd`: an absolute path with no NUL or newline. */
export const LOCAL_CWD_PATTERN = /^\/[^\0\n\r]*$/;

/** A root list entry is malformed, missing, or not a directory. */
export class LocalRootError extends Error {
  override name = "LocalRootError";
}

/** The requested directory is missing, not a directory, or outside every root. */
export class LocalPathError extends Error {
  override name = "LocalPathError";
}

/**
 * Parse `CLAUDE_MCP_LOCAL_ROOTS`: comma-separated absolute directories that
 * exist. Each is stored in its real path form. Empty or unset means no roots,
 * and local runs are refused.
 */
export function parseLocalRoots(raw: string | undefined): string[] {
  const roots: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    if (!isAbsolute(entry)) {
      throw new LocalRootError(`CLAUDE_MCP_LOCAL_ROOTS entry must be an absolute directory, got ${JSON.stringify(entry)}`);
    }
    const real = realDirectory(entry);
    if (real === null) {
      throw new LocalRootError(`CLAUDE_MCP_LOCAL_ROOTS entry is not an existing directory: ${JSON.stringify(entry)}`);
    }
    if (real === sep) throw new LocalRootError("CLAUDE_MCP_LOCAL_ROOTS must not include the filesystem root");
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

/** Real path of `requested` when it is a directory inside one of `roots` (or a root itself). */
export function resolveLocalCwd(requested: string, roots: readonly string[]): string {
  if (!isAbsolute(requested)) throw new LocalPathError(`cwd must be an absolute directory, got ${JSON.stringify(requested)}`);
  const real = realDirectory(requested);
  if (real === null) throw new LocalPathError(`cwd is not an existing directory: ${JSON.stringify(requested)}`);
  if (!roots.some((root) => isInside(root, real))) {
    throw new LocalPathError(
      `cwd ${JSON.stringify(real)} is not inside a CLAUDE_MCP_LOCAL_ROOTS directory (paths are compared after resolving symlinks).`,
    );
  }
  return real;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realDirectory(path: string): string | null {
  try {
    const real = realpathSync(resolve(path));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
