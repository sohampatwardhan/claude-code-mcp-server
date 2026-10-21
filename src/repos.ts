/**
 * Repository selection for cloud sessions.
 *
 * `claude --cloud <description>` has no repository argument. It packages the
 * git checkout it is started in: the cloud VM clones that directory's GitHub
 * remote at the current branch. Callers name a github.com `owner/name` (any
 * repository the Claude GitHub app can access) or an allowlisted local
 * directory. GitHub repositories are cloned into a cache this server owns,
 * with `origin` set to `https://github.com/owner/name.git`.
 */

import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** One path segment of a GitHub owner or repository name. */
export const GITHUB_SLUG_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const GITHUB_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const GITHUB_URL =
  /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\.git)?\/?$/;

/**
 * Shape accepted for create `repo`: an absolute path, an `owner/name` slug,
 * or a `https://github.com/owner/name` URL. Tokens and other hosts are rejected.
 */
export const REPO_ARG_PATTERN =
  /^(?:\/[^\0\n\r]+|[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\.git)?\/?)$/;

/** github.com `owner/name` or `https://github.com/owner/name`, with no local path. */
export const GITHUB_REPO_ARG_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\.git)?\/?)$/;

/**
 * Branch names passed to `git checkout`. Rejects flag-like names, traversal,
 * and characters git treats specially in revisions.
 */
export const BASE_BRANCH_PATTERN =
  /^(?![-/])(?!HEAD$)(?!.*(?:\.\.|@\{|\/\/|\\|\s|~|\^|:|\?|\*|\[|\.lock$|\/$|\.$))[A-Za-z0-9._/-]{1,255}$/;

const REMOTE_BRANCH = /^origin\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/;

const SESSION_FILE_ID = /^(?:session|cse)_[A-Za-z0-9][A-Za-z0-9_-]*$/;

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
  /** Branch the GitHub cache was left on, or null for a local or default directory. */
  baseBranch: string | null;
  /** Set when the call named a github.com repository. */
  github: GithubRepo | null;
}

export type CreatePlan =
  | { kind: "default"; cwd: string }
  | { kind: "path"; cwd: string; repo: string }
  | { kind: "github"; github: GithubRepo; baseBranch: string | null };

/** The caller named a repository that is malformed or not on the allowlist. */
export class RepoNotAllowedError extends Error {
  override name = "RepoNotAllowedError";
}

/** Cloning or updating a GitHub repository failed. */
export class RepoPrepareError extends Error {
  override name = "RepoPrepareError";
}

/** `gh pr list` could not be run or did not return a usable pull request. */
export class PullRequestLookupError extends Error {
  override name = "PullRequestLookupError";
}

export interface SessionRecord {
  session_id: string;
  repo: string;
  owner: string;
  name: string;
  base_branch: string | null;
}

export interface PullRequest {
  number: number;
  url: string;
}

export function isSafeBranchName(branch: string): boolean {
  return BASE_BRANCH_PATTERN.test(branch);
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

/** Cache directory for one GitHub repository. Stays inside `cacheRoot`. */
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
 * missing directories are rejected. GitHub entries are not required for a
 * create call; any github.com slug may be cloned into the cache.
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

/** Parse a github.com slug or URL. Returns null for anything else, including local paths. */
export function parseGithubRepoArg(raw: string): GithubRepo | null {
  return parseGithubSlug(raw.trim());
}

/**
 * What a create call is asking for. Does not touch git. An omitted `requested`
 * uses `defaultCwd`. A github.com slug is always accepted. An absolute
 * directory must be on the allowlist. `baseBranch` is only valid for GitHub.
 */
export function classifyCreateRequest(options: {
  requested: string | undefined;
  baseBranch?: string | undefined;
  defaultCwd: string;
  allowlist: readonly AllowEntry[];
}): CreatePlan {
  const baseBranch = options.baseBranch ?? null;
  if (baseBranch !== null && !isSafeBranchName(baseBranch)) {
    throw new RepoPrepareError(`invalid base branch ${JSON.stringify(baseBranch)}`);
  }
  if (options.requested === undefined) {
    if (baseBranch !== null) {
      throw new RepoPrepareError(
        "base_branch applies only to a github.com repository. The default directory is used as it is.",
      );
    }
    return { kind: "default", cwd: options.defaultCwd };
  }
  const classified = classifyRepoArg(options.requested);
  if (classified === null) {
    throw new RepoNotAllowedError(
      `Repository ${JSON.stringify(options.requested)} must be an allowlisted absolute directory, a github.com owner/name, or a https://github.com/owner/name URL.`,
    );
  }
  if (classified.kind === "github") {
    return { kind: "github", github: classified, baseBranch };
  }
  if (baseBranch !== null) {
    throw new RepoPrepareError(
      "base_branch applies only to a github.com repository. An allowlisted local directory is used as it is.",
    );
  }
  const real = canonicalDirectory(classified.path);
  if (!options.allowlist.some((entry) => entry.kind === "path" && entry.path === real)) {
    throw new RepoNotAllowedError(`Repository ${JSON.stringify(real)} is not on CLAUDE_MCP_REPOS.`);
  }
  return { kind: "path", cwd: real, repo: real };
}

/**
 * Directory for one create call. GitHub repositories are cloned or updated
 * in `cacheRoot` even when they are absent from the allowlist.
 */
export async function resolveCreateDirectory(options: {
  requested: string | undefined;
  baseBranch?: string | undefined;
  defaultCwd: string;
  allowlist: readonly AllowEntry[];
  cacheRoot: string;
  timeoutMs: number;
}): Promise<CreateDirectory> {
  const plan = classifyCreateRequest(options);
  if (plan.kind === "github") {
    const prepared = await prepareGithubRepo(
      options.cacheRoot,
      plan.github.owner,
      plan.github.name,
      options.timeoutMs,
      plan.baseBranch,
    );
    return { cwd: prepared.cwd, repo: plan.github.slug, baseBranch: prepared.branch, github: plan.github };
  }
  if (plan.kind === "path") {
    return { cwd: plan.cwd, repo: plan.repo, baseBranch: null, github: null };
  }
  return { cwd: plan.cwd, repo: null, baseBranch: null, github: null };
}

/** Clone or update `owner/name` inside the cache and return the checkout. */
export async function prepareGithubRepo(
  cacheRoot: string,
  owner: string,
  name: string,
  timeoutMs: number,
  baseBranch: string | null,
): Promise<{ cwd: string; branch: string }> {
  return withPreparedGithubRepo(cacheRoot, owner, name, timeoutMs, baseBranch, async (cwd, branch) => ({
    cwd,
    branch,
  }));
}

/**
 * Hold the per-repo cache lock, make the checkout match `owner/name`, then
 * run `fn`. The lock covers `fn`, so a status read can teleport without a
 * concurrent reset of the same checkout.
 */
export async function withPreparedGithubRepo<T>(
  cacheRoot: string,
  owner: string,
  name: string,
  timeoutMs: number,
  baseBranch: string | null,
  fn: (cwd: string, branch: string) => Promise<T>,
): Promise<T> {
  const dest = githubCacheDir(cacheRoot, owner, name);
  await mkdir(dirname(dest), { recursive: true });
  const staleMs = timeoutMs * 8 + 60_000;
  return withLock(`${dest}.lock`, staleMs, async () => {
    const branch = await syncCachedCheckout(dest, githubCloneUrl(owner, name), timeoutMs, baseBranch);
    return fn(dest, branch);
  });
}

/**
 * Make `dest` a clean checkout of `originUrl` at `baseBranch`, or at the
 * remote's default branch when `baseBranch` is null. Returns the branch
 * checked out. An existing checkout with a different origin is left untouched.
 */
export async function syncCachedCheckout(
  dest: string,
  originUrl: string,
  timeoutMs: number,
  baseBranch: string | null = null,
): Promise<string> {
  if (baseBranch !== null && !isSafeBranchName(baseBranch)) {
    throw new RepoPrepareError(`invalid base branch ${JSON.stringify(baseBranch)}`);
  }
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
  const setUrl = await runGit(["remote", "set-url", "origin", originUrl], dest, timeoutMs);
  if (setUrl.code !== 0) throw new RepoPrepareError(gitDetail("git remote set-url", setUrl));
  const fetched = await runGit(["fetch", "--prune", "origin"], dest, timeoutMs);
  if (fetched.code !== 0) throw new RepoPrepareError(gitDetail("git fetch", fetched));
  const setHead = await runGit(["remote", "set-head", "origin", "-a"], dest, timeoutMs);
  if (setHead.code !== 0) throw new RepoPrepareError(gitDetail("git remote set-head", setHead));

  let branch: string;
  let remoteRef: string;
  if (baseBranch !== null) {
    remoteRef = `refs/remotes/origin/${baseBranch}`;
    const verify = await runGit(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`], dest, timeoutMs);
    if (verify.code !== 0) {
      throw new RepoPrepareError(`base branch ${JSON.stringify(baseBranch)} is not on origin`);
    }
    branch = baseBranch;
  } else {
    const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dest, timeoutMs);
    if (head.code !== 0) throw new RepoPrepareError(gitDetail("git symbolic-ref", head));
    remoteRef = head.stdout.trim();
    branch = remoteBranchName(remoteRef);
  }
  const checkout = await runGit(["checkout", "-f", "-B", branch, remoteRef], dest, timeoutMs);
  if (checkout.code !== 0) throw new RepoPrepareError(gitDetail("git checkout", checkout));
  const cleaned = await runGit(["clean", "-fd"], dest, timeoutMs);
  if (cleaned.code !== 0) throw new RepoPrepareError(gitDetail("git clean", cleaned));
  return branch;
}

/** Branch currently checked out, or null when HEAD is detached or unreadable. */
export async function readCheckedOutBranch(dest: string, timeoutMs: number): Promise<string | null> {
  const result = await runGit(["symbolic-ref", "--short", "HEAD"], dest, timeoutMs);
  if (result.code !== 0) return null;
  const branch = result.stdout.trim();
  return isSafeBranchName(branch) ? branch : null;
}

/**
 * Read-only `gh pr list` for the branch a cloud session pushed.
 * Returns null when the branch has no pull request. Throws when `gh` is
 * missing or its output cannot be used.
 */
export async function lookupPullRequest(
  owner: string,
  name: string,
  branch: string,
  timeoutMs: number,
  cwd: string,
): Promise<PullRequest | null> {
  if (!isSlugPart(owner) || !isSlugPart(name) || !isSafeBranchName(branch)) {
    throw new PullRequestLookupError("invalid repository or branch for pull request lookup");
  }
  const args = [
    "pr",
    "list",
    "--repo",
    `${owner}/${name}`,
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,url",
    "--limit",
    "1",
  ];
  const result = await runCommand("gh", args, cwd, timeoutMs, { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" });
  if (result.notFound) throw new PullRequestLookupError("gh was not found on PATH");
  if (result.code === null && !result.timedOut) {
    throw new PullRequestLookupError(`failed to start gh: ${result.stderr}`);
  }
  if (result.timedOut) throw new PullRequestLookupError("gh pr list timed out");
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 500);
    throw new PullRequestLookupError(detail === "" ? `gh pr list exited ${result.code}` : `gh pr list exited ${result.code}: ${detail}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new PullRequestLookupError("gh pr list did not print JSON");
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const first: unknown = value[0];
  if (typeof first !== "object" || first === null) throw new PullRequestLookupError("gh pr list JSON was not an object");
  const number = (first as { number?: unknown }).number;
  const url = (first as { url?: unknown }).url;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new PullRequestLookupError("gh pr list JSON has no pull request number");
  }
  if (typeof url !== "string" || !samePullRequest(url, owner, name, number)) {
    throw new PullRequestLookupError("gh pr list returned a pull request URL for a different repository");
  }
  return { number, url: `https://github.com/${owner}/${name}/pull/${number}` };
}

export async function writeSessionRecord(cacheRoot: string, record: SessionRecord): Promise<void> {
  if (!SESSION_FILE_ID.test(record.session_id) || record.repo !== `${record.owner}/${record.name}`) {
    throw new RepoPrepareError("invalid session record");
  }
  if (record.base_branch !== null && !isSafeBranchName(record.base_branch)) {
    throw new RepoPrepareError("invalid session record");
  }
  const dest = sessionFile(cacheRoot, record.session_id, ".json");
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await rename(tmp, dest);
}

export async function readSessionRecord(cacheRoot: string, sessionId: string): Promise<SessionRecord | null> {
  if (!SESSION_FILE_ID.test(sessionId)) return null;
  let raw: string;
  try {
    raw = await readFile(sessionFile(cacheRoot, sessionId, ".json"), "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<SessionRecord>;
  if (record.session_id !== sessionId || typeof record.owner !== "string" || typeof record.name !== "string") {
    return null;
  }
  if (!isSlugPart(record.owner) || !isSlugPart(record.name) || record.repo !== `${record.owner}/${record.name}`) {
    return null;
  }
  if (record.base_branch !== null && (typeof record.base_branch !== "string" || !isSafeBranchName(record.base_branch))) {
    return null;
  }
  return {
    session_id: sessionId,
    repo: record.repo,
    owner: record.owner,
    name: record.name,
    base_branch: record.base_branch ?? null,
  };
}

/** Debug log for one teleport, inside the cache and outside any checkout. */
export function teleportDebugPath(cacheRoot: string, sessionId: string): string {
  return sessionFile(cacheRoot, sessionId, ".teleport.log");
}

function sessionFile(cacheRoot: string, sessionId: string, suffix: string): string {
  if (!SESSION_FILE_ID.test(sessionId) || !suffix.startsWith(".")) {
    throw new RepoPrepareError("invalid session id");
  }
  const root = resolve(cacheRoot, "sessions");
  const dest = resolve(root, `${sessionId}${suffix}`);
  const rel = relative(root, dest);
  if (rel.startsWith("..") || isAbsolute(rel) || rel !== `${sessionId}${suffix}`) {
    throw new RepoPrepareError("session path escaped the cache");
  }
  return dest;
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
  if (branch === undefined || !isSafeBranchName(branch)) {
    throw new RepoPrepareError(`refusing unexpected default branch ${JSON.stringify(remoteBranch)}`);
  }
  return branch;
}

function samePullRequest(url: string, owner: string, name: string, number: number): boolean {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  const foundOwner = match?.[1];
  const foundName = match?.[2];
  const foundNumber = match?.[3];
  if (foundOwner === undefined || foundName === undefined || foundNumber === undefined) return false;
  return (
    foundOwner.toLowerCase() === owner.toLowerCase() &&
    foundName.toLowerCase() === name.toLowerCase() &&
    Number(foundNumber) === number
  );
}

async function cloneInto(dest: string, originUrl: string, timeoutMs: number): Promise<void> {
  const result = await runGit(["clone", "--no-recurse-submodules", "--", originUrl, dest], dirname(dest), timeoutMs);
  if (result.code !== 0) {
    await rm(dest, { recursive: true, force: true });
    throw new RepoPrepareError(gitDetail("git clone", result));
  }
}

async function assertOrigin(dest: string, originUrl: string, timeoutMs: number): Promise<void> {
  const remote = await runGit(["config", "--get", "remote.origin.url"], dest, timeoutMs);
  if (remote.code !== 0) throw new RepoPrepareError(gitDetail("git config remote.origin.url", remote));
  const actual = normalizeGitUrl(remote.stdout.trim());
  const expected = normalizeGitUrl(originUrl);
  if (actual !== expected) {
    throw new RepoPrepareError(
      `cache at ${JSON.stringify(dest)} has origin ${JSON.stringify(redactGitUrl(remote.stdout.trim()))}, expected ${JSON.stringify(originUrl)}; left it unchanged`,
    );
  }
}

function normalizeGitUrl(url: string): string {
  return redactGitUrl(url).replace(/\.git$/i, "").replace(/\/$/, "");
}

function redactGitUrl(url: string): string {
  return url.trim().replace(/^(https?:\/\/)[^/\s@]+@/i, "$1");
}

interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

function runGit(args: string[], cwd: string | undefined, timeoutMs: number): Promise<CmdResult> {
  return runCommand(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "fetch.recurseSubmodules=false", ...args],
    cwd,
    timeoutMs,
    { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
  ).then((result) => {
    if (result.notFound) {
      throw new RepoPrepareError("git was not found on PATH; it is required to prepare a GitHub repository");
    }
    if (result.code === null && !result.timedOut) {
      throw new RepoPrepareError(`failed to start git: ${result.stderr}`);
    }
    return result;
  });
}

function runCommand(
  bin: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  extraEnv: Record<string, string>,
): Promise<CmdResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    const stdout = { text: "" };
    const stderr = { text: "" };
    const child = spawn(bin, args, {
      shell: false,
      cwd,
      env: { ...process.env, ...extraEnv },
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
    const finish = (result: CmdResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };
    child.once("error", (err: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout: "",
        stderr: err.message,
        timedOut: false,
        notFound: err.code === "ENOENT",
      });
    });
    child.once("close", (code) => {
      finish({
        code: timedOut ? null : code,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        notFound: false,
      });
    });
  });
}

function gitDetail(what: string, result: CmdResult): string {
  const text = redactGitUrl((result.stderr || result.stdout).trim()).slice(0, 500);
  if (result.notFound) return `${what} failed: git was not found on PATH`;
  const how = result.timedOut ? "timed out" : `exited ${result.code}`;
  return text === "" ? `${what} ${how}` : `${what} ${how}: ${text}`;
}

const LOCK_WAIT_MS = 50;

async function withLock<T>(lockPath: string, staleMs: number, fn: () => Promise<T>): Promise<T> {
  await acquireLock(lockPath, staleMs);
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {
      // the lock was already removed
    });
  }
}

async function acquireLock(lockPath: string, staleMs: number): Promise<void> {
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
