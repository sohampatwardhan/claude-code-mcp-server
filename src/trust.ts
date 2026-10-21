import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { stripAnsi } from "./parse.js";

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
  const text = stripAnsi(output).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

/**
 * Set `projects[projectPath].hasTrustDialogAccepted` to true.
 * Leaves the file untouched when the flag is already true, and refuses to
 * rewrite a file that is not a JSON object. Other keys are preserved.
 */
export function ensureWorkspaceTrusted(file: string, projectPath: string): { wrote: boolean } {
  let data: Record<string, unknown> = {};
  let mode = 0o600;
  if (existsSync(file)) {
    mode = statSync(file).mode & 0o777;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new TrustFileError(`${file} is not valid JSON; not modifying it`);
    }
    if (!isRecord(parsed)) throw new TrustFileError(`${file} is not a JSON object; not modifying it`);
    data = parsed;
  }

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
  if (current.hasTrustDialogAccepted === true) return { wrote: false };

  projects[projectPath] = { ...current, hasTrustDialogAccepted: true };
  data.projects = projects;

  const tmp = join(dirname(file), `.claude.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the temp file was never created, or was already renamed
    }
    throw err;
  }
  return { wrote: true };
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
