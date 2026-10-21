/**
 * Per-call repository selection.
 *
 * `claude --cloud <description>` has no repository argument. It packages the
 * git checkout it is started in: the cloud VM clones that directory's GitHub
 * remote at the current branch, or uploads the local tree when the remote
 * cannot be cloned. Callers name an allowlisted directory or a github.com
 * `owner/name`. GitHub entries are cloned into a cache this server owns.
 */

import { spawn } from "node:child_process";
import { mkdir, open, rm, unlink } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** One path segment of a GitHub owner or repository name. */
export const GITHUB_SLUG_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const GITHUB_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const GITHUB_URL =
  /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\.git)?\/?$/;

/**
 * Shape accepted for `repo` before the allowlist check: an absolute path, an
 * `owner/name` slug, or a `https://github.com/owner/name` URL.
 */
export const REPO_ARG_PATTERN =
  /^(?:\/[^\0\n\r]+|[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\.git)?\/?)$/;

const REMOTE_BRANCH = /^origin\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/;

export interface GithubRepo {
  kind: "github";
  slug: string;
  owner: string;
  name: string;
}

export interface PathRepo {
  kind: "path";
  /** Canonical directory path. */
  path: string;
}

export type AllowEntry = GithubRepo | PathRepo;

export interface CreateDirectory {
  /** Directory the CLI runs in. */
  cwd: string;
  /** Normalized repository from the call, or null when the default directory is used. */
  repo: string | null;
}

/** The caller named a repository that is malformed or not on the allowlist. */
export class RepoNotAllowedError extends Error {
  override name = "RepoNotAllowedError";
}

/** Cloning or updating an allowlisted GitHub repository failed. */
export class RepoPrepareError extends Error {
  override name = "RepoPrepareError";
}

export function defaultRepoCache(home: string = homedir()): string {
  return resolve(home, ".claude-mcp", "repos");
}

export function githubCloneUrl(owner: string, name: string): string {
  if (!isSlugPart(owner) || !isSlugPart(name)) {
    throw new RepoPrepareError(`invalid GitHub repository ${JSON.stringify(`${owner}/${name}`)}`);
  }
  return `https://github.com/${owner}/${name}.git`;
}

/** Cache directory for one allowlisted GitHub repository. Stays inside `cacheRoot`. */
export function githubCacheDir(cacheRoot: string, owner: string, name: string): string {
  if (!isSlugPart(owner) || !isSlugPart(name)) {
    throw new RepoPrepareError(`invalid GitHub repository ${JSON.stringify(`${owner}/${name}`)}`);
  }
  const root = resolve(cacheRoot);
  const dest = resolve(root, owner, name);
  const rel = relative(root, dest);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new RepoPrepareError("cache path escaped the repository cache");
  }
  return dest;
}

/**
 * Parse `CLAUDE_MCP_REPOS`. Entries are comma-separated absolute directories
 * or github.com `owner/name` repositories (a `https://github.com/owner/name`
 * URL is accepted and stored as the slug). Relative paths, other hosts, and
 * missing directories are rejected.
 */
export function parseAllowlist(raw: string | undefined): AllowEntry[] {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return [];
  const entries: AllowEntry[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const parsed = parseAllowEntry(entry);
    const key = parsed.kind === "github" ? `github:${parsed.slug}` : `path:${parsed.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(parsed);
  }
  return entries;
}

/**
 * Directory for one create call. An omitted `requested` uses `defaultCwd`
 * and does not consult the allowlist. A set value must match an allowlist
 * entry. GitHub entries are cloned or fast-forwarded in `cacheRoot`.
 */
export async function resolveCreateDirectory(options: {
  requested: string | undefined;
  defaultCwd: string;
  allowlist: readonly AllowEntry[];
  cacheRoot: string;
  timeoutMs: number;
}): Promise<CreateDirectory> {
  if (options.requested === undefined) return { cwd: options.defaultCwd, repo: null };
  const classified = classifyRepoArg(options.requested);
  if (classified === null) {
    throw new RepoNotAllowedError(
      `Repository ${JSON.stringify(options.requested)} must be an allowlisted absolute directory, a github.com owner/name, or a https://github.com/owner/name URL.`,
    );
  }
  if (classified.kind === "github") {
    if (!options.allowlist.some((entry) => entry.kind === "github" && entry.slug === classified.slug)) {
      throw new RepoNotAllowedError(
        `Repository ${JSON.stringify(classified.slug)} is not on CLAUDE_MCP_REPOS.`,
      );
    }
    const cwd = await prepareGithubRepo(options.cacheRoot, classified.owner, classified.name, options.timeoutMs);
    return { cwd, repo: classified.slug };
  }
  const real = canonicalDirectory(classified.path);
  if (!options.allowlist.some((entry) => entry.kind === "path" && entry.path === real)) {
    throw new RepoNotAllowedError(`Repository ${JSON.stringify(real)} is not on CLAUDE_MCP_REPOS.`);
  }
  return { cwd: real, repo: real };
}

/** Clone or update `owner/name` inside the cache and return the checkout path. */
export async function prepareGithubRepo(
  cacheRoot: string,
  owner: string,
  name: string,
  timeoutMs: number,
): Promise<string> {
  const dest = githubCacheDir(cacheRoot, owner, name);
  await mkdir(dirname(dest), { recursive: true });
  await withLock(`${dest}.lock`, timeoutMs, () =>
    syncCachedCheckout(dest, githubCloneUrl(owner, name), timeoutMs),
  );
  return dest;
}

/**
 * Make `dest` a clean checkout of `originUrl` at that remote's default branch.
 * An existing checkout with a different origin is left untouched.
 */
export async function syncCachedCheckout(dest: string, originUrl: string, timeoutMs: number): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (!existsSync(dest)) {
    await cloneInto(dest, originUrl, timeoutMs);
  } else {
    const info = statSync(dest);
    if (!info.isDirectory()) throw new RepoPrepareError(`${JSON.stringify(dest)} exists and is not a directory`);
    const worktree = await runGit(["rev-parse", "--is-inside-work-tree"], dest, timeoutMs);
    if (worktree.code !== 0) {
      await rm(dest, { recursive: true, force: true });
      await cloneInto(dest, originUrl, timeoutMs);
    } else {
      await assertOrigin(dest, originUrl, timeoutMs);
    }
  }
  await assertOrigin(dest, originUrl, timeoutMs);
  const fetched = await runGit(["fetch", "--prune", "origin"], dest, timeoutMs);
  if (fetched.code !== 0) throw new RepoPrepareError(gitDetail("git fetch", fetched));
  const setHead = await runGit(["remote", "set-head", "origin", "-a"], dest, timeoutMs);
  if (setHead.code !== 0) throw new RepoPrepareError(gitDetail("git remote set-head", setHead));
  const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dest, timeoutMs);
  if (head.code !== 0) throw new RepoPrepareError(gitDetail("git symbolic-ref", head));
  const remoteBranch = head.stdout.trim();
  const branch = remoteBranchName(remoteBranch);
  const checkout = await runGit(["checkout", "-f", "-B", branch, remoteBranch], dest, timeoutMs);
  if (checkout.code !== 0) throw new RepoPrepareError(gitDetail("git checkout", checkout));
  const cleaned = await runGit(["clean", "-fd"], dest, timeoutMs);
  if (cleaned.code !== 0) throw new RepoPrepareError(gitDetail("git clean", cleaned));
}

function parseAllowEntry(entry: string): AllowEntry {
  const github = parseGithubSlug(entry);
  if (github !== null) return github;
  if (entry.includes("://") || entry.startsWith("git@")) {
    throw new Error(
      `CLAUDE_MCP_REPOS entry must be a github.com owner/name or an absolute directory, got ${JSON.stringify(entry)}`,
    );
  }
  if (!isAbsolute(entry)) {
    throw new Error(
      `CLAUDE_MCP_REPOS entry must be an absolute directory or a github.com owner/name, got ${JSON.stringify(entry)}`,
    );
  }
  return { kind: "path", path: canonicalDirectory(entry, "CLAUDE_MCP_REPOS") };
}

function parseGithubSlug(raw: string): GithubRepo | null {
  const text = raw.trim();
  if (text.includes("\\") || text.includes("@")) return null;
  if (GITHUB_SLUG.test(text)) {
    const slash = text.indexOf("/");
    return githubRepo(text.slice(0, slash), text.slice(slash + 1));
  }
  const url = GITHUB_URL.exec(text);
  if (url === null) return null;
  return githubRepo(url[1], url[2]);
}

/** GitHub repository names are not stored with the `.git` suffix callers paste from clone URLs. */
function githubRepo(owner: string | undefined, rawName: string | undefined): GithubRepo | null {
  const name = rawName?.endsWith(".git") ? rawName.slice(0, -".git".length) : rawName;
  if (owner === undefined || name === undefined || !isSlugPart(owner) || !isSlugPart(name)) return null;
  return { kind: "github", slug: `${owner}/${name}`, owner, name };
}

function classifyRepoArg(raw: string): GithubRepo | { kind: "path"; path: string } | null {
  const text = raw.trim();
  if (text === "") return null;
  const github = parseGithubSlug(text);
  if (github !== null) return github;
  if (isAbsolute(text)) return { kind: "path", path: resolve(text) };
  return null;
}

function canonicalDirectory(path: string, label = "Repository path"): string {
  const resolved = resolve(path);
  let info;
  try {
    info = statSync(resolved);
  } catch {
    throw new RepoNotAllowedError(`${label} does not exist: ${JSON.stringify(resolved)}`);
  }
  if (!info.isDirectory()) {
    throw new RepoNotAllowedError(`${label} is not a directory: ${JSON.stringify(resolved)}`);
  }
  try {
    return realpathSync(resolved);
  } catch {
    throw new RepoNotAllowedError(`${label} does not exist: ${JSON.stringify(resolved)}`);
  }
}

function isSlugPart(part: string): boolean {
  return GITHUB_SLUG_PART.test(part) && !part.includes("..");
}

function remoteBranchName(remoteBranch: string): string {
  const match = REMOTE_BRANCH.exec(remoteBranch);
  const branch = match?.[1];
  if (branch === undefined || branch.includes("..") || branch.endsWith("/") || branch.startsWith("-")) {
    throw new RepoPrepareError(`refusing unexpected default branch ${JSON.stringify(remoteBranch)}`);
  }
  return branch;
}

async function cloneInto(dest: string, originUrl: string, timeoutMs: number): Promise<void> {
  const result = await runGit(["clone", originUrl, dest], dirname(dest), timeoutMs);
  if (result.code !== 0) {
    await rm(dest, { recursive: true, force: true });
    throw new RepoPrepareError(gitDetail("git clone", result));
  }
}

async function assertOrigin(dest: string, originUrl: string, timeoutMs: number): Promise<void> {
  const remote = await runGit(["remote", "get-url", "origin"], dest, timeoutMs);
  if (remote.code !== 0) throw new RepoPrepareError(gitDetail("git remote get-url", remote));
  const actual = normalizeGitUrl(remote.stdout.trim());
  const expected = normalizeGitUrl(originUrl);
  if (actual !== expected) {
    throw new RepoPrepareError(
      `cache at ${JSON.stringify(dest)} has origin ${JSON.stringify(remote.stdout.trim())}, expected ${JSON.stringify(originUrl)}; left it unchanged`,
    );
  }
}

function normalizeGitUrl(url: string): string {
  return url.trim().replace(/\.git$/, "").replace(/\/$/, "");
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runGit(args: string[], cwd: string | undefined, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timedOut = false;
    const stdout = { text: "" };
    const stderr = { text: "" };
    const child = spawn("git", args, {
      shell: false,
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const cap = (buf: { text: string }, chunk: Buffer) => {
      if (buf.text.length < 8_000) buf.text += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => cap(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => cap(stderr, chunk));
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    };
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        fail(new RepoPrepareError("git was not found on PATH; it is required to prepare an allowlisted GitHub repository"));
      } else {
        fail(new RepoPrepareError(`failed to start git: ${err.message}`));
      }
    });
    child.once("close", (code) => {
      finish({ code: timedOut ? null : code, stdout: stdout.text, stderr: stderr.text, timedOut });
    });
  });
}

function gitDetail(what: string, result: GitResult): string {
  const text = (result.stderr || result.stdout).trim().slice(0, 500);
  const how = result.timedOut ? "timed out" : `exited ${result.code}`;
  return text === "" ? `${what} ${how}` : `${what} ${how}: ${text}`;
}

const LOCK_WAIT_MS = 50;

async function withLock<T>(lockPath: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  await acquireLock(lockPath, timeoutMs);
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {
      // the lock was already removed
    });
  }
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<void> {
  const staleMs = timeoutMs + 10_000;
  const attempts = Math.max(1, Math.ceil(staleMs / LOCK_WAIT_MS));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          await unlink(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
    }
  }
  throw new RepoPrepareError(`timed out locking ${lockPath}`);
}
