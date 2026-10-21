import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { TrustFileError, ensureWorkspaceTrusted, isTrustPrompt, resolveTrustProjectPath } from "../src/trust.js";

const tmp = mkdtempSync(join(tmpdir(), "claude-mcp-trust-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("isTrustPrompt", () => {
  it("matches the long and short dialog questions", () => {
    assert.equal(isTrustPrompt("Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n"), true);
    assert.equal(isTrustPrompt("Do you trust this folder?\n"), true);
  });

  it("matches the question through ANSI colour and CR line endings", () => {
    assert.equal(isTrustPrompt("\u001b[1mDo you trust the files in this folder?\u001b[0m\r\n"), true);
  });

  it("ignores the question when it is only the created-session title", () => {
    assert.equal(
      isTrustPrompt("Created cloud session: Do you trust this folder?\nSession ID: session_01ABCDEFGH\n"),
      false,
    );
  });

  it("still matches a real dialog that follows a title line", () => {
    assert.equal(
      isTrustPrompt("Created cloud session: Do you trust this folder?\nDo you trust this folder?\n"),
      true,
    );
  });

  it("ignores unrelated output", () => {
    assert.equal(isTrustPrompt("Created cloud session: Fix the bug\nthis workspace has not been trusted\n"), false);
  });
});

describe("ensureWorkspaceTrusted", () => {
  it("creates ~/.claude.json and preserves other projects", () => {
    const file = join(tmp, "fresh.json");
    writeFileSync(
      file,
      JSON.stringify({ numStartups: 3, projects: { "/elsewhere": { hasTrustDialogAccepted: false, lastCost: 1 } } }) +
        "\n",
    );
    assert.deepEqual(ensureWorkspaceTrusted(file, "/repo"), { wrote: true });
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      numStartups: number;
      projects: Record<string, { hasTrustDialogAccepted?: boolean; lastCost?: number }>;
    };
    assert.equal(parsed.numStartups, 3);
    assert.equal(parsed.projects["/elsewhere"]?.hasTrustDialogAccepted, false);
    assert.equal(parsed.projects["/elsewhere"]?.lastCost, 1);
    assert.equal(parsed.projects["/repo"]?.hasTrustDialogAccepted, true);
  });

  it("does not rewrite a file that is already trusted", () => {
    const file = join(tmp, "already.json");
    const body = '{"projects":{"/repo":{"hasTrustDialogAccepted":true}}}\n';
    writeFileSync(file, body);
    assert.deepEqual(ensureWorkspaceTrusted(file, "/repo"), { wrote: false });
    assert.equal(readFileSync(file, "utf8"), body);
  });

  it("refuses to clobber a non-object file", () => {
    const file = join(tmp, "bad.json");
    writeFileSync(file, "[1, 2]\n");
    assert.throws(() => ensureWorkspaceTrusted(file, "/repo"), TrustFileError);
    assert.equal(readFileSync(file, "utf8"), "[1, 2]\n");
  });

  it("refuses to clobber a non-object project entry", () => {
    const file = join(tmp, "entry.json");
    writeFileSync(file, '{"projects":{"/repo":"nope"}}\n');
    assert.throws(() => ensureWorkspaceTrusted(file, "/repo"), TrustFileError);
    assert.equal(readFileSync(file, "utf8"), '{"projects":{"/repo":"nope"}}\n');
  });
});

describe("resolveTrustProjectPath", () => {
  it("uses the main checkout for a linked worktree", async () => {
    const main = join(tmp, "main");
    const work = join(tmp, "work");
    mkdirSync(main);
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: main });
    execFileSync("git", ["config", "user.name", "dev"], { cwd: main });
    writeFileSync(join(main, "f"), "x\n");
    execFileSync("git", ["add", "f"], { cwd: main });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: main });
    execFileSync("git", ["worktree", "add", "-q", work, "HEAD"], { cwd: main });

    assert.equal(await resolveTrustProjectPath(main), main);
    assert.equal(await resolveTrustProjectPath(work), main);
  });

  it("uses cwd when the directory is not a git checkout", async () => {
    const dir = join(tmp, "plain");
    mkdirSync(dir);
    assert.equal(await resolveTrustProjectPath(dir), dir);
  });
});
