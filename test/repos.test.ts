import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  RepoNotAllowedError,
  RepoPrepareError,
  classifyCreateRequest,
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
      { cwd: dir, repo: null, baseBranch: null, github: null },
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
    assert.equal(selected.baseBranch, null);
    assert.equal(selected.github, null);

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
  });

  it("clones a github.com slug that is not on the allowlist and checks out base_branch", async () => {
    const origin = join(tmp, "acme-widgets.git");
    const work = join(tmp, "acme-widgets-src");
    mkdirSync(work, { recursive: true });
    git(["init", "-b", "main", work]);
    writeFileSync(join(work, "README"), "main\n");
    git(["add", "README"], work);
    git(["commit", "-m", "main"], work);
    git(["checkout", "-b", "develop"], work);
    writeFileSync(join(work, "README"), "develop\n");
    git(["commit", "-am", "develop"], work);
    git(["clone", "--bare", work, origin]);
    const cache = join(tmp, "any-github");
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const gitconfig = join(tmp, "gitconfig-acme");
    writeFileSync(gitconfig, `[url "${origin}"]\n\tinsteadOf = https://github.com/acme/widgets.git\n`);
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const selected = await resolveCreateDirectory({
        requested: "https://github.com/acme/widgets.git",
        baseBranch: "develop",
        defaultCwd: dir,
        allowlist: [],
        cacheRoot: cache,
        timeoutMs: 20_000,
      });
      assert.equal(selected.repo, "acme/widgets");
      assert.equal(selected.baseBranch, "develop");
      assert.equal(selected.github?.slug, "acme/widgets");
      assert.equal(readFileSync(join(selected.cwd, "README"), "utf8"), "develop\n");
      const stored = execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd: selected.cwd,
        encoding: "utf8",
      }).trim();
      assert.equal(stored, "https://github.com/acme/widgets.git");
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    }
  });

  it("refuses base_branch for a local directory without checking out a branch", () => {
    assert.throws(
      () =>
        classifyCreateRequest({
          requested: dir,
          baseBranch: "develop",
          defaultCwd: dir,
          allowlist: parseAllowlist(dir),
        }),
      RepoPrepareError,
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

    assert.equal(await syncCachedCheckout(dest, origin, 20_000), "main");
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

  it("rejects a missing base branch and leaves the checkout on its current branch", async () => {
    const work = join(tmp, "base-src");
    const origin = join(tmp, "base.git");
    const dest = join(tmp, "base-cache");
    mkdirSync(work);
    git(["init", "-b", "main", work]);
    writeFileSync(join(work, "README"), "base\n");
    git(["add", "README"], work);
    git(["commit", "-m", "base"], work);
    git(["clone", "--bare", work, origin]);
    await syncCachedCheckout(dest, origin, 20_000);
    await assert.rejects(
      () => syncCachedCheckout(dest, origin, 20_000, "feature/missing"),
      (err: unknown) => err instanceof RepoPrepareError && err.message.includes("feature/missing"),
    );
    assert.equal(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dest, encoding: "utf8" }).trim(),
      "main",
    );
    await assert.rejects(() => syncCachedCheckout(dest, origin, 20_000, "a/../../b"), RepoPrepareError);
  });
});
