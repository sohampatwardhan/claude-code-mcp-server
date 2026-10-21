import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { authStatusArgv, createSessionArgv, sendFollowupArgv } from "../src/argv.js";
import { ConfigError, DEFAULT_TIMEOUT_MS, loadConfig } from "../src/config.js";

const tmp = mkdtempSync(join(tmpdir(), "claude-mcp-config-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("argv construction", () => {
  it("builds create argv with a fixed flag order", () => {
    assert.deepEqual(createSessionArgv("Fix the bug", null), ["--cloud=Fix the bug"]);
    assert.deepEqual(createSessionArgv("Fix the bug", "ccpool_abc"), ["--cloud=Fix the bug", "--environment=ccpool_abc"]);
  });

  it("keeps dash-prefixed values from being read as flags", () => {
    assert.deepEqual(createSessionArgv("--help", null), ["--cloud=--help"]);
    assert.deepEqual(sendFollowupArgv("session_01ABCDEFGH", "--version"), [
      "--cloud=session_01ABCDEFGH",
      "-p",
      "--",
      "--version",
    ]);
  });

  it("passes shell metacharacters through verbatim", () => {
    const desc = "$(rm -rf /); `id` && echo 'hi' \"there\"\nsecond line";
    assert.deepEqual(createSessionArgv(desc, null), [`--cloud=${desc}`]);
  });

  it("builds auth argv", () => {
    assert.deepEqual(authStatusArgv(), ["auth", "status"]);
  });
});

describe("loadConfig", () => {
  it("uses defaults", () => {
    assert.deepEqual(loadConfig({}), {
      claudeBin: "claude",
      defaultEnvironmentId: null,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      trustCwd: false,
      pythonBin: "python3",
      cwd: process.cwd(),
    });
  });

  it("reads env overrides", () => {
    assert.deepEqual(
      loadConfig({
        CLAUDE_BIN: "/opt/claude",
        CLAUDE_CLOUD_ENVIRONMENT_ID: "ccpool_x1",
        CLAUDE_MCP_TIMEOUT_MS: "1500",
        CLAUDE_MCP_TRUST_CWD: "yes",
        CLAUDE_MCP_PYTHON: "/usr/bin/python3",
        CLAUDE_MCP_CWD: tmp,
      }),
      {
        claudeBin: "/opt/claude",
        defaultEnvironmentId: "ccpool_x1",
        timeoutMs: 1500,
        trustCwd: true,
        pythonBin: "/usr/bin/python3",
        cwd: resolve(tmp),
      },
    );
  });

  it("resolves a relative CLAUDE_MCP_CWD and rejects a missing path or a file", () => {
    const dir = join(tmp, "rel");
    mkdirSync(dir);
    const saved = process.cwd();
    try {
      process.chdir(tmp);
      assert.equal(loadConfig({ CLAUDE_MCP_CWD: "rel" }).cwd, resolve(tmp, "rel"));
    } finally {
      process.chdir(saved);
    }
    assert.equal(loadConfig({ CLAUDE_MCP_CWD: "   " }).cwd, process.cwd());
    assert.throws(() => loadConfig({ CLAUDE_MCP_CWD: join(tmp, "missing") }), ConfigError);
    const file = join(tmp, "not-a-dir");
    writeFileSync(file, "x");
    assert.throws(() => loadConfig({ CLAUDE_MCP_CWD: file }), ConfigError);
  });

  it("rejects invalid timeout, environment, and trust-flag values", () => {
    for (const t of ["0", "-5", "1.5", "abc", "10s"]) {
      assert.throws(() => loadConfig({ CLAUDE_MCP_TIMEOUT_MS: t }), ConfigError, t);
    }
    assert.throws(() => loadConfig({ CLAUDE_CLOUD_ENVIRONMENT_ID: "--rm" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_CLOUD_ENVIRONMENT_ID: "a b" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_MCP_TRUST_CWD: "maybe" }), ConfigError);
  });

  it("treats an explicit false trust flag as off", () => {
    assert.equal(loadConfig({ CLAUDE_MCP_TRUST_CWD: "false" }).trustCwd, false);
    assert.equal(loadConfig({ CLAUDE_MCP_TRUST_CWD: "0" }).trustCwd, false);
  });
});
