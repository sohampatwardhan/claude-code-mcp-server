import { spawn } from "node:child_process";
import { open, unlink } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { cleanTerminalText } from "./parse.js";

/** Claude Code stores per-folder workspace trust here, not under `~/.claude/`. */
export function claudeJsonPath(home: string = homedir()): string {
  return join(home, ".claude.json");
}

export class TrustFileError extends Error {
  override name = "TrustFileError";
}

/**
 * True when Claude Code's workspace-trust dialog is on screen.
 * The task title line (`Created cloud session: …`) is ignored so a
 * description that happens to contain the question is not treated as the dialog.
 */
export function isTrustPrompt(output: string): boolean {
  const text = cleanTerminalText(output);
  const body = text
    .split("\n")
    .filter((line) => !/^\s*Created cloud session:/.test(line))
    .join("\n");
  return /Do you trust (?:the files in )?this folder\?/.test(body);
}

/**
 * Directory Claude Code keys workspace trust on: the main git checkout when
 * `cwd` is inside a repository or worktree, otherwise `cwd` itself.
 */
export async function resolveTrustProjectPath(cwd: string): Promise<string> {
  const toplevel = await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (toplevel === null || !isAbsolute(toplevel)) return resolve(cwd);
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common !== null && basename(common) === ".git") {
    const main = dirname(common);
    if (isAbsolute(main)) return main;
  }
  return toplevel;
}

const LOCK_STALE_MS = 5_000;
const LOCK_ATTEMPTS = 50;
const LOCK_WAIT_MS = 20;
const WRITE_ATTEMPTS = 5;

/**
 * Set `projects[projectPath].hasTrustDialogAccepted` to true.
 *
 * Holds `file.lock` (exclusive create, stale after 5 s) so two of these
 * servers do not interleave. Inside the lock the file is read again
 * immediately before the atomic rename, and the rename is skipped when that
 * read already has the trust flag. A change between the two reads retries
 * against the new contents. Claude Code does not take this lock, so a save
 * that lands after the second read can still overwrite the flag.
 */
export async function ensureWorkspaceTrusted(file: string, projectPath: string): Promise<{ wrote: boolean }> {
  const lockPath = `${file}.lock`;
  await acquireLock(lockPath);
  try {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const outcome = commitTrust(file, projectPath);
      if (outcome !== "stale") return { wrote: outcome === "wrote" };
    }
    throw new TrustFileError(`${file} changed repeatedly while updating workspace trust`);
  } finally {
    await unlink(lockPath).catch(() => {
      // the lock was already removed
    });
  }
}

type WriteOutcome = "wrote" | "unchanged" | "stale";

function commitTrust(file: string, projectPath: string): WriteOutcome {
  const first = readClaudeJson(file);
  if (hasTrust(first.data, file, projectPath)) return "unchanged";

  const next = withTrust(first.data, file, projectPath);
  const tmp = join(dirname(file), `.claude.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: first.mode });
    const latest = readFileIfExists(file);
    if (latest !== first.text) return "stale";
    renameSync(tmp, file);
    return "wrote";
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // renamed into place, or never created
    }
  }
}

function withTrust(data: Record<string, unknown>, file: string, projectPath: string): Record<string, unknown> {
  const projectsRaw = data.projects;
  if (projectsRaw !== undefined && !isRecord(projectsRaw)) {
    throw new TrustFileError(`${file} projects field is not an object; not modifying it`);
  }
  const projects: Record<string, unknown> = isRecord(projectsRaw) ? { ...projectsRaw } : {};
  const entry = projects[projectPath];
  if (entry !== undefined && !isRecord(entry)) {
    throw new TrustFileError(`${file} projects[${JSON.stringify(projectPath)}] is not an object; not modifying it`);
  }
  const current: Record<string, unknown> = isRecord(entry) ? entry : {};
  projects[projectPath] = { ...current, hasTrustDialogAccepted: true };
  return { ...data, projects };
}

function hasTrust(data: Record<string, unknown>, file: string, projectPath: string): boolean {
  const projectsRaw = data.projects;
  if (projectsRaw === undefined) return false;
  if (!isRecord(projectsRaw)) {
    throw new TrustFileError(`${file} projects field is not an object; not modifying it`);
  }
  const entry = projectsRaw[projectPath];
  if (entry === undefined) return false;
  if (!isRecord(entry)) {
    throw new TrustFileError(`${file} projects[${JSON.stringify(projectPath)}] is not an object; not modifying it`);
  }
  return entry.hasTrustDialogAccepted === true;
}

function readClaudeJson(file: string): { text: string | null; data: Record<string, unknown>; mode: number } {
  const text = readFileIfExists(file);
  if (text === null) return { text: null, data: {}, mode: 0o600 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TrustFileError(`${file} is not valid JSON; not modifying it`);
  }
  if (!isRecord(parsed)) throw new TrustFileError(`${file} is not a JSON object; not modifying it`);
  return { text, data: parsed, mode: statSync(file).mode & 0o777 };
}

function readFileIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch {
        // the holder removed the lock; try again
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
    }
  }
  throw new TrustFileError(`timed out locking ${lockPath}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let out = "";
    let settled = false;
    const child = spawn("git", ["-C", cwd, ...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 5_000);
    timer.unref();
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      const line = out.trim();
      finish(code === 0 && line !== "" ? line : null);
    });
  });
}
