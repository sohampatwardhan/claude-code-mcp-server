import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { LOCAL_CWD_PATTERN, LocalPathError, LocalRootError, parseLocalRoots, resolveLocalCwd } from "../src/local.js";

// Not realpath'd on purpose: on macOS tmpdir() is under /var, a symlink to
// /private/var, so `raw` and `real` spell the same directory two ways.
const raw = mkdtempSync(join(tmpdir(), "claude-mcp-local-"));
const real = realpathSync(raw);
after(() => rmSync(real, { recursive: true, force: true }));

const root = join(real, "root");
const inside = join(root, "repo", "src");
const outside = join(real, "outside");
const sibling = join(real, "root-other");
mkdirSync(inside, { recursive: true });
mkdirSync(outside);
mkdirSync(sibling);
writeFileSync(join(root, "file.txt"), "x");
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(root, "repo"), join(real, "link-in"));

describe("parseLocalRoots", () => {
  it("is empty when unset or blank", () => {
    assert.deepEqual(parseLocalRoots(undefined), []);
    assert.deepEqual(parseLocalRoots(" , "), []);
  });

  it("stores real paths and drops duplicates", () => {
    assert.deepEqual(parseLocalRoots(`${join(raw, "root")}, ${root}/ ,${outside}`), [root, outside]);
  });

  it("rejects relative, missing, file, and filesystem-root entries", () => {
    for (const entry of ["root", join(real, "missing"), join(root, "file.txt"), "/"]) {
      assert.throws(() => parseLocalRoots(entry), LocalRootError, entry);
    }
  });
});

describe("resolveLocalCwd", () => {
  const roots = parseLocalRoots(root);

  it("accepts the root itself and directories under it, returning the real path", () => {
    assert.equal(resolveLocalCwd(root, roots), root);
    assert.equal(resolveLocalCwd(inside, roots), inside);
    assert.equal(resolveLocalCwd(`${inside}/../src/.`, roots), inside);
  });

  it("treats /var and /private/var spellings as the same directory", () => {
    // A root given in the /var form still admits a cwd in the /private/var form, and the reverse.
    assert.equal(resolveLocalCwd(join(raw, "root", "repo"), parseLocalRoots(root)), join(root, "repo"));
    assert.equal(resolveLocalCwd(join(root, "repo"), parseLocalRoots(join(raw, "root"))), join(root, "repo"));
  });

  it("follows symlinks: one leading out of a root is refused, one leading in is allowed", () => {
    assert.throws(() => resolveLocalCwd(join(root, "escape"), roots), LocalPathError);
    assert.equal(resolveLocalCwd(join(real, "link-in"), roots), join(root, "repo"));
  });

  it("refuses a sibling that only shares a name prefix, a parent, a file, and a missing path", () => {
    for (const path of [sibling, real, join(root, "file.txt"), join(root, "missing"), `${root}/../outside`]) {
      assert.throws(() => resolveLocalCwd(path, roots), LocalPathError, path);
    }
  });

  it("refuses everything with no roots", () => {
    assert.throws(() => resolveLocalCwd(root, []), LocalPathError);
  });
});

describe("LOCAL_CWD_PATTERN", () => {
  it("accepts absolute paths and rejects relative ones, NUL, and newlines", () => {
    assert.ok(LOCAL_CWD_PATTERN.test("/Users/dev/GitRepos/app"));
    for (const value of ["relative", "~/repo", "/a\nb", "/a\0b", ""]) assert.equal(LOCAL_CWD_PATTERN.test(value), false, value);
  });
});
