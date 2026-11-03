import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { authStatusArgv, createSessionArgv, localRunArgv, sendFollowupArgv, teleportArgv, usageArgv } from "../src/argv.js";
import { ConfigError, DEFAULT_TIMEOUT_MS, loadConfig } from "../src/config.js";

// realpath: on macOS tmpdir() is under /var, a symlink to /private/var, and git and
// process.cwd() report the /private/var form.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "claude-mcp-config-")));
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

  it("builds print-mode teleport argv and rejects a non-session id", () => {
    assert.deepEqual(teleportArgv("session_01ABCDEFGH", "/tmp/claude-mcp/session_01ABCDEFGH.teleport.log"), [
      "--teleport=session_01ABCDEFGH",
      "--debug",
      "--debug-file=/tmp/claude-mcp/session_01ABCDEFGH.teleport.log",
    ]);
    assert.throws(() => teleportArgv("--help", "/tmp/x.log"));
    assert.throws(() => teleportArgv("session_01ABCDEFGH", "relative.log"));
    assert.throws(() => teleportArgv("https://claude.ai/code/session_01ABCDEFGH", "/tmp/x.log"));
  });
});

describe("local run argv", () => {
  const base = {
    prompt: "Fix the build",
    permissionMode: "dontAsk" as const,
    model: null,
    maxTurns: null,
    allowedTools: [],
    resume: null,
    restricted: false,
  };

  it("builds print-mode argv with a fixed flag order and the prompt after --", () => {
    assert.deepEqual(localRunArgv(base), [
      "-p",
      "--output-format=stream-json",
      "--verbose",
      "--permission-mode=dontAsk",
      "--",
      "Fix the build",
    ]);
    assert.deepEqual(
      localRunArgv({
        ...base,
        prompt: "--dangerously-skip-permissions",
        permissionMode: "acceptEdits",
        model: "sonnet[1m]",
        maxTurns: 12,
        allowedTools: ["Read", "Bash", "Read"],
        resume: "11111111-2222-4333-8444-555555555555",
      }),
      [
        "-p",
        "--output-format=stream-json",
        "--verbose",
        "--permission-mode=acceptEdits",
        "--model=sonnet[1m]",
        "--max-turns=12",
        "--allowedTools=Read,Bash",
        "--resume=11111111-2222-4333-8444-555555555555",
        "--",
        "--dangerously-skip-permissions",
      ],
    );
  });

  it("puts --restricted and --strict-mcp-config right after -p for a restricted run", () => {
    assert.deepEqual(localRunArgv({ ...base, restricted: true }), [
      "-p",
      "--restricted",
      "--strict-mcp-config",
      "--output-format=stream-json",
      "--verbose",
      "--permission-mode=dontAsk",
      "--",
      "Fix the build",
    ]);
  });

  it("builds the fixed restricted /usage argv", () => {
    assert.deepEqual(usageArgv(), [
      "-p",
      "--restricted",
      "--strict-mcp-config",
      "--output-format=stream-json",
      "--verbose",
      "--",
      "/usage",
    ]);
  });

  it("refuses bypass, unknown tools, a bad model or resume id, and a bad turn limit", () => {
    const bad = [
      { permissionMode: "bypassPermissions" },
      { permissionMode: "default" },
      { allowedTools: ["Bash(rm *)"] },
      { model: "--cloud=x" },
      { model: "opus extra" },
      { resume: "session_01ABCDEFGH" },
      { resume: "--cloud" },
      { maxTurns: 0 },
      { maxTurns: 1.5 },
    ];
    for (const override of bad) {
      assert.throws(() => localRunArgv({ ...base, ...override } as unknown as Parameters<typeof localRunArgv>[0]), /internal error/, JSON.stringify(override));
    }
  });
});

describe("loadConfig", () => {
  it("uses defaults", () => {
    assert.deepEqual(loadConfig({}), {
      claudeBin: "claude",
      defaultEnvironmentId: null,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: null,
      trustCwd: false,
      pythonBin: "python3",
      cwd: process.cwd(),
      repos: [],
      repoCache: resolve(homedir(), ".claude-mcp", "repos"),
      localRoots: [],
      localAllowShell: false,
      usageStopPercent: null,
      http: null,
    });
  });

  it("reads env overrides", () => {
    assert.deepEqual(
      loadConfig({
        CLAUDE_BIN: "/opt/claude",
        CLAUDE_CLOUD_ENVIRONMENT_ID: "ccpool_x1",
        CLAUDE_MCP_TIMEOUT_MS: "1500",
        CLAUDE_MCP_IDLE_TIMEOUT_MS: "90000",
        CLAUDE_MCP_TRUST_CWD: "yes",
        CLAUDE_MCP_PYTHON: "/usr/bin/python3",
        CLAUDE_MCP_CWD: tmp,
        CLAUDE_MCP_REPOS: `${tmp},acme/widgets`,
        CLAUDE_MCP_REPO_CACHE: join(tmp, "repo-cache"),
        CLAUDE_MCP_LOCAL_ROOTS: ` ${tmp} , ${tmp}/ `,
        CLAUDE_MCP_LOCAL_ALLOW_SHELL: "1",
        CLAUDE_MCP_USAGE_STOP_PERCENT: "90",
      }),
      {
        claudeBin: "/opt/claude",
        defaultEnvironmentId: "ccpool_x1",
        timeoutMs: 1500,
        idleTimeoutMs: 90_000,
        trustCwd: true,
        pythonBin: "/usr/bin/python3",
        cwd: resolve(tmp),
        repos: [
          { kind: "path", path: realpathSync(tmp) },
          { kind: "github", slug: "acme/widgets", owner: "acme", name: "widgets" },
        ],
        repoCache: resolve(tmp, "repo-cache"),
        localRoots: [realpathSync(tmp)],
        localAllowShell: true,
        usageStopPercent: 90,
        http: null,
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
      assert.throws(() => loadConfig({ CLAUDE_MCP_IDLE_TIMEOUT_MS: t }), ConfigError, t);
    }
    assert.throws(() => loadConfig({ CLAUDE_CLOUD_ENVIRONMENT_ID: "--rm" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_CLOUD_ENVIRONMENT_ID: "a b" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_MCP_TRUST_CWD: "maybe" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_MCP_REPOS: "./checkout" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_MCP_REPOS: "foo/bar/baz" }), ConfigError);
    assert.throws(() => loadConfig({ CLAUDE_MCP_REPOS: "https://gitlab.com/acme/widgets" }), ConfigError);
    const file = join(tmp, "cache-file");
    writeFileSync(file, "x");
    assert.throws(() => loadConfig({ CLAUDE_MCP_REPO_CACHE: file }), ConfigError);
  });

  it("rejects a relative, missing, file, or filesystem-root CLAUDE_MCP_LOCAL_ROOTS entry", () => {
    const file = join(tmp, "a-file");
    writeFileSync(file, "x");
    for (const raw of ["relative/dir", join(tmp, "missing"), file, "/"]) {
      assert.throws(() => loadConfig({ CLAUDE_MCP_LOCAL_ROOTS: raw }), ConfigError, raw);
    }
  });

  it("rejects a CLAUDE_MCP_USAGE_STOP_PERCENT outside 1-100 or not an integer", () => {
    for (const raw of ["0", "101", "9.5", "-5", "abc", "090"]) {
      assert.throws(() => loadConfig({ CLAUDE_MCP_USAGE_STOP_PERCENT: raw }), ConfigError, raw);
    }
    assert.equal(loadConfig({ CLAUDE_MCP_USAGE_STOP_PERCENT: " 100 " }).usageStopPercent, 100);
  });

  it("turns on HTTP only with CLAUDE_MCP_HTTP_PORT, and then requires a strong CLAUDE_MCP_TOKEN", () => {
    const token = "t".repeat(32);
    assert.equal(loadConfig({ CLAUDE_MCP_TOKEN: token }).http, null, "a token alone does not start HTTP");
    assert.deepEqual(loadConfig({ CLAUDE_MCP_HTTP_PORT: "8787", CLAUDE_MCP_TOKEN: token }).http, {
      host: "127.0.0.1",
      port: 8787,
      token,
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
    });
    assert.deepEqual(
      loadConfig({
        CLAUDE_MCP_HTTP_PORT: "0",
        CLAUDE_MCP_HTTP_HOST: "::1",
        CLAUDE_MCP_TOKEN: token,
        CLAUDE_MCP_HTTP_ALLOWED_HOSTS: " MyMac.tail1234.ts.net , [fd7a:115c:a1e0::1] ",
      }).http?.allowedHosts,
      ["localhost", "127.0.0.1", "[::1]", "mymac.tail1234.ts.net", "[fd7a:115c:a1e0::1]"],
    );
    assert.deepEqual(
      loadConfig({ CLAUDE_MCP_HTTP_PORT: "8787", CLAUDE_MCP_HTTP_HOST: "0.0.0.0", CLAUDE_MCP_TOKEN: token }).http?.allowedHosts,
      ["localhost", "127.0.0.1", "[::1]"],
      "a wildcard bind address is not an allowed Host",
    );
  });

  it("refuses HTTP without a token, with a weak token, or with a bad port, host or allowed host, never echoing the token", () => {
    const secret = "s3cr3t-value-that-must-not-leak";
    const cases: Record<string, string>[] = [
      { CLAUDE_MCP_HTTP_PORT: "8787" },
      { CLAUDE_MCP_HTTP_PORT: "8787", CLAUDE_MCP_TOKEN: secret },
      { CLAUDE_MCP_HTTP_PORT: "8787", CLAUDE_MCP_TOKEN: `${"x".repeat(32)} ${secret}` },
      { CLAUDE_MCP_HTTP_PORT: "65536", CLAUDE_MCP_TOKEN: "x".repeat(32) },
      { CLAUDE_MCP_HTTP_PORT: "08787", CLAUDE_MCP_TOKEN: "x".repeat(32) },
      { CLAUDE_MCP_HTTP_PORT: "8787", CLAUDE_MCP_TOKEN: "x".repeat(32), CLAUDE_MCP_HTTP_HOST: "http://host" },
      { CLAUDE_MCP_HTTP_PORT: "8787", CLAUDE_MCP_TOKEN: "x".repeat(32), CLAUDE_MCP_HTTP_ALLOWED_HOSTS: "evil.example:443" },
      { CLAUDE_MCP_HTTP_PORT: "8787", CLAUDE_MCP_TOKEN: "x".repeat(32), CLAUDE_MCP_HTTP_ALLOWED_HOSTS: "https://evil.example" },
    ];
    for (const env of cases) {
      assert.throws(
        () => loadConfig(env),
        (err: unknown) => err instanceof ConfigError && !err.message.includes(secret),
        JSON.stringify(Object.keys(env)),
      );
    }
  });

  it("treats an explicit false trust flag as off", () => {
    assert.equal(loadConfig({ CLAUDE_MCP_TRUST_CWD: "false" }).trustCwd, false);
    assert.equal(loadConfig({ CLAUDE_MCP_TRUST_CWD: "0" }).trustCwd, false);
  });
});
