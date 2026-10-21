import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authStatusArgv, createSessionArgv, sendFollowupArgv } from "../src/argv.js";
import { ConfigError, DEFAULT_TIMEOUT_MS, loadConfig } from "../src/config.js";

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
    assert.deepEqual(loadConfig({}), { claudeBin: "claude", defaultEnvironmentId: null, timeoutMs: DEFAULT_TIMEOUT_MS });
  });

  it("reads env overrides", () => {
    assert.deepEqual(
      loadConfig({ CLAUDE_BIN: "/opt/claude", CLAUDE_CLOUD_ENVIRONMENT_ID: "ccpool_x1", CLAUDE_MCP_TIMEOUT_MS: "1500" }),
      { claudeBin: "/opt/claude", defaultEnvironmentId: "ccpool_x1", timeoutMs: 1500 },
    );
  });

  it("rejects invalid timeout and environment values", () => {
    for (const t of ["0", "-5", "1.5", "abc", "10s"]) {
      assert.throws(() => loadConfig({ CLAUDE_MCP_TIMEOUT_MS: t }), ConfigError, t);
    }
    assert.throws(() => loadConfig({ CLAUDE_CLOUD_ENVIRONMENT_ID: "--rm" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_CLOUD_ENVIRONMENT_ID: "a b" }), ConfigError);
  });
});
