import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  RepoNotAllowedError,
  RepoPrepareError,
  githubCacheDir,
  githubCloneUrl,
  parseAllowlist,
  resolveCreateDirectory,
  syncCachedCheckout,
} from "../src/repos.js";

const tmp = mkdtempSync(join(tmpdir(), "claude-mcp-repos-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_EMAIL: "dev@example.com", GIT_AUTHOR_NAME: "dev", GIT_COMMITTER_EMAIL: "dev@example.com", GIT_COMMITTER_NAME: "dev" },
  });
}

describe("parseAllowlist", () => {
  it("accepts absolute directories and github.com slugs, including URL form", () => {
    const dir = join(tmp, "allowed");
    mkdirSync(dir);
    assert.deepEqual(parseAllowlist(` ${dir}, sohampatwardhan/141-hillside-1b-hub, https://github.com/acme/widgets.git `), [
      { kind: "path", path: realpathSync(dir) },
      {
        kind: "github",
        slug: "sohampatwardhan/141-hillside-1b-hub",
        owner: "sohampatwardhan",
        name: "141-hillside-1b-hub",
      },
      { kind: "github", slug: "acme/widgets", owner: "acme", name: "widgets" },
    ]);
  });

  it("rejects relative paths, other hosts, and missing directories", () => {
    assert.throws(() => parseAllowlist("owner/../repo"), Error);
    assert.throws(() => parseAllowlist("https://gitlab.com/acme/widgets"), Error);
    assert.throws(() => parseAllowlist("https://user:token@github.com/acme/widgets"), Error);
    assert.throws(() => parseAllowlist(join(tmp, "missing")), Error);
    const file = join(tmp, "file");
    writeFileSync(file, "x");
    assert.throws(() => parseAllowlist(file), Error);
  });
});

describe("resolveCreateDirectory", () => {
  const dir = join(tmp, "checkout");
  mkdirSync(dir, { recursive: true });
  const allowlist = parseAllowlist(`${dir},acme/widgets`);

  it("keeps the default directory when repo is omitted", async () => {
    assert.deepEqual(
      await resolveCreateDirectory({
        requested: undefined,
        defaultCwd: dir,
        allowlist,
        cacheRoot: join(tmp, "cache"),
        timeoutMs: 5_000,
      }),
      { cwd: dir, repo: null },
    );
  });

  it("uses an allowlisted directory and rejects a child path or an unknown slug", async () => {
    const selected = await resolveCreateDirectory({
      requested: dir,
      defaultCwd: join(tmp, "other"),
      allowlist,
      cacheRoot: join(tmp, "cache"),
      timeoutMs: 5_000,
    });
    assert.equal(selected.cwd, realpathSync(dir));
    assert.equal(selected.repo, realpathSync(dir));

    const child = join(dir, "nested");
    mkdirSync(child);
    await assert.rejects(
      () =>
        resolveCreateDirectory({
          requested: child,
          defaultCwd: dir,
          allowlist,
          cacheRoot: join(tmp, "cache"),
          timeoutMs: 5_000,
        }),
      RepoNotAllowedError,
    );
    await assert.rejects(
      () =>
        resolveCreateDirectory({
          requested: "https://github.com/other/repo",
          defaultCwd: dir,
          allowlist,
          cacheRoot: join(tmp, "cache"),
          timeoutMs: 5_000,
        }),
      RepoNotAllowedError,
    );
    await assert.rejects(
      () =>
        resolveCreateDirectory({
          requested: "acme/widgets",
          defaultCwd: dir,
          allowlist: parseAllowlist(dir),
          cacheRoot: join(tmp, "unused-cache"),
          timeoutMs: 5_000,
        }),
      RepoNotAllowedError,
    );
  });

  it("normalizes a github.com URL to the allowlisted slug without cloning when the slug is absent", async () => {
    await assert.rejects(
      () =>
        resolveCreateDirectory({
          requested: "https://github.com/acme/widgets.git",
          defaultCwd: dir,
          allowlist: [],
          cacheRoot: join(tmp, "no-clone"),
          timeoutMs: 5_000,
        }),
      (err: unknown) => err instanceof RepoNotAllowedError && err.message.includes("acme/widgets"),
    );
  });
});

describe("github cache paths", () => {
  it("builds an https github.com URL inside the cache", () => {
    assert.equal(githubCloneUrl("acme", "widgets"), "https://github.com/acme/widgets.git");
    assert.equal(githubCacheDir("/cache", "acme", "widgets"), "/cache/acme/widgets");
    assert.throws(() => githubCacheDir("/cache", "..", "widgets"), RepoPrepareError);
    assert.throws(() => githubCloneUrl("acme", "a..b"), RepoPrepareError);
  });
});

describe("syncCachedCheckout", () => {
  it("clones a local origin, then resets the cache to the updated default branch", async () => {
    const work = join(tmp, "origin-work");
    const origin = join(tmp, "origin.git");
    const dest = join(tmp, "cache", "acme", "widgets");
    mkdirSync(work, { recursive: true });
    git(["init", "-b", "main", work]);
    writeFileSync(join(work, "README"), "one\n");
    git(["add", "README"], work);
    git(["commit", "-m", "one"], work);
    git(["clone", "--bare", work, origin]);
    git(["remote", "add", "origin", origin], work);

    await syncCachedCheckout(dest, origin, 20_000);
    assert.equal(readFileSync(join(dest, "README"), "utf8"), "one\n");

    writeFileSync(join(dest, "README"), "dirty\n");
    writeFileSync(join(dest, "untracked.txt"), "nope\n");
    writeFileSync(join(work, "README"), "two\n");
    git(["commit", "-am", "two"], work);
    git(["push", "origin", "main"], work);
    await syncCachedCheckout(dest, origin, 20_000);
    assert.equal(readFileSync(join(dest, "README"), "utf8"), "two\n");
    assert.throws(() => readFileSync(join(dest, "untracked.txt"), "utf8"));
  });

  it("leaves a checkout with a different origin unchanged", async () => {
    const first = join(tmp, "origin-a");
    const second = join(tmp, "origin-b.git");
    const dest = join(tmp, "mismatch");
    mkdirSync(first);
    git(["init", "-b", "main", first]);
    writeFileSync(join(first, "README"), "keep\n");
    git(["add", "README"], first);
    git(["commit", "-m", "keep"], first);
    await syncCachedCheckout(dest, first, 20_000);

    mkdirSync(join(tmp, "origin-b"));
    git(["init", "-b", "main", join(tmp, "origin-b")]);
    writeFileSync(join(tmp, "origin-b", "README"), "other\n");
    git(["add", "README"], join(tmp, "origin-b"));
    git(["commit", "-m", "other"], join(tmp, "origin-b"));
    git(["clone", "--bare", join(tmp, "origin-b"), second]);

    await assert.rejects(() => syncCachedCheckout(dest, second, 20_000), RepoPrepareError);
    assert.equal(readFileSync(join(dest, "README"), "utf8"), "keep\n");
  });
});
