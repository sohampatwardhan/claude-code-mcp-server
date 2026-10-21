// Starts the built server over stdio, exactly as an MCP client would, with
// CLAUDE_BIN pointed at a fake CLI so no real sessions are created.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(root, "dist/src/index.js");
const fakeClaude = join(root, "test/fixtures/fake-claude.mjs");
chmodSync(fakeClaude, 0o755);

const tmp = mkdtempSync(join(tmpdir(), "claude-mcp-smoke-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let logCounter = 0;

async function connect(extraEnv: Record<string, string> = {}) {
  const id = logCounter++;
  const argvLog = join(tmp, `argv-${id}.jsonl`);
  const metaLog = join(tmp, `meta-${id}.jsonl`);
  const stdinLog = join(tmp, `stdin-${id}.bin`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_")) env[k] = v;
  }
  Object.assign(
    env,
    {
      CLAUDE_BIN: fakeClaude,
      FAKE_CLAUDE_ARGV_LOG: argvLog,
      FAKE_CLAUDE_META_LOG: metaLog,
      FAKE_CLAUDE_STDIN_LOG: stdinLog,
    },
    extraEnv,
  );

  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe" });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);
  const argvCalls = (): string[][] => {
    try {
      return readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  const metaCalls = (): { cwd: string; stdoutIsTTY: boolean; stdinIsTTY: boolean }[] => {
    try {
      return readFileSync(metaLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { cwd: string; stdoutIsTTY: boolean; stdinIsTTY: boolean });
    } catch {
      return [];
    }
  };
  const stdinBytes = (): Buffer => {
    try {
      return readFileSync(stdinLog);
    } catch {
      return Buffer.alloc(0);
    }
  };
  return { client, argvCalls, metaCalls, stdinBytes, close: () => client.close() };
}

function mkdirWork(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directory the server will mark trusted for `dir`: main checkout, else `dir`. */
function expectedTrustPath(dir: string = process.cwd()): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common.endsWith("/.git")) return common.slice(0, -"/.git".length);
    const toplevel = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return toplevel || dir;
  } catch {
    return dir;
  }
}

function errorBody(result: CallToolResult): { error: { code: string; message: string } } {
  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return JSON.parse(first.text) as { error: { code: string; message: string } };
}

describe("stdio smoke test", () => {
  it("lists exactly the three tools, each with a strict input schema", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        "claude_auth_status",
        "claude_create_cloud_session",
        "claude_send_followup",
      ]);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, "object");
        assert.equal((tool.inputSchema as Record<string, unknown>).additionalProperties, false, tool.name);
        assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
      }
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      assert.deepEqual(byName.claude_create_cloud_session?.inputSchema.required, ["description"]);
      assert.deepEqual(byName.claude_send_followup?.inputSchema.required?.slice().sort(), ["message", "session"]);
      assert.deepEqual(byName.claude_auth_status?.inputSchema.properties, {});
    } finally {
      await close();
    }
  });

  it("creates a cloud session and returns parsed fields", async () => {
    const { client, argvCalls, metaCalls, close } = await connect();
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "Fix the flaky test" },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      const s = result.structuredContent as Record<string, unknown>;
      assert.equal(s.session_id, "session_01FakeSessionId0000000000");
      assert.equal(s.session_url, "https://claude.ai/code/session_01FakeSessionId0000000000?from=cli&m=0");
      assert.equal(s.title, "Fix the flaky test");
      assert.equal(s.parsed, true);
      assert.equal(s.environment_id, null);
      assert.equal(s.cwd, process.cwd());
      assert.equal(s.repo, null);
      const cli = s.cli as { stdout: string; stderr: string };
      assert.equal(cli.stderr, "");
      assert.doesNotMatch(cli.stdout, /[\u0000-\u0008\u000e-\u001f]/);
      assert.match(cli.stdout, /^Created cloud session: Fix the flaky test\n/);
      assert.deepEqual(argvCalls(), [["--cloud=Fix the flaky test"]]);
      assert.equal(metaCalls()[0]?.stdoutIsTTY, true);
      assert.equal(metaCalls()[0]?.stdinIsTTY, true);
      assert.equal(metaCalls()[0]?.cwd, process.cwd());
    } finally {
      await close();
    }
  });

  it("runs create on a pty and leaves follow-up and auth on pipes", async () => {
    const { client, metaCalls, argvCalls, close } = await connect();
    try {
      await client.callTool({ name: "claude_create_cloud_session", arguments: { description: "$(rm -rf /) `id`" } });
      await client.callTool({
        name: "claude_send_followup",
        arguments: { session: "session_01Target00000000", message: "next" },
      });
      await client.callTool({ name: "claude_auth_status", arguments: {} });
      const meta = metaCalls();
      assert.equal(meta[0]?.stdoutIsTTY, true);
      assert.equal(meta[1]?.stdoutIsTTY, false);
      assert.equal(meta[2]?.stdoutIsTTY, false);
      assert.deepEqual(argvCalls()[0], ["--cloud=$(rm -rf /) `id`"]);
    } finally {
      await close();
    }
  });

  it("applies CLAUDE_CLOUD_ENVIRONMENT_ID by default and lets the call override it", async () => {
    const { client, argvCalls, close } = await connect({ CLAUDE_CLOUD_ENVIRONMENT_ID: "ccpool_default" });
    try {
      await client.callTool({ name: "claude_create_cloud_session", arguments: { description: "a" } });
      await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "b", environment_id: "ccpool_override" },
      });
      assert.deepEqual(argvCalls(), [
        ["--cloud=a", "--environment=ccpool_default"],
        ["--cloud=b", "--environment=ccpool_override"],
      ]);
    } finally {
      await close();
    }
  });

  it("sends a follow-up", async () => {
    const { client, argvCalls, close } = await connect();
    try {
      const result = (await client.callTool({
        name: "claude_send_followup",
        arguments: { session: "session_01Target00000000", message: "-- also update the docs" },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      const s = result.structuredContent as Record<string, unknown>;
      assert.equal(s.sent, true);
      assert.equal(s.session_id, "session_01Target00000000");
      const cli = s.cli as { stdout: string };
      assert.doesNotMatch(cli.stdout, /\u001b/);
      assert.match(cli.stdout, /^Sent to cloud session\.\n/);
      assert.deepEqual(argvCalls(), [["--cloud=session_01Target00000000", "-p", "--", "-- also update the docs"]]);
    } finally {
      await close();
    }
  });

  it("returns parsed auth status", async () => {
    const { client, close } = await connect();
    try {
      const result = (await client.callTool({ name: "claude_auth_status", arguments: {} })) as CallToolResult;
      const s = result.structuredContent as Record<string, unknown>;
      assert.equal(s.loggedIn, true);
      assert.equal(s.email, "dev@example.com");
      assert.equal(s.orgName, "Example Org");
      assert.equal(s.subscriptionType, "max");
    } finally {
      await close();
    }
  });

  it("rejects invalid input via schema validation without spawning the CLI", async () => {
    const { client, argvCalls, close } = await connect();
    try {
      const cases = [
        { name: "claude_create_cloud_session", arguments: {} },
        { name: "claude_create_cloud_session", arguments: { description: "x", extra: 1 } },
        { name: "claude_create_cloud_session", arguments: { description: "   " } },
        { name: "claude_create_cloud_session", arguments: { description: "x", environment_id: "--bad" } },
        { name: "claude_create_cloud_session", arguments: { description: "x", repo: "not a repo" } },
        { name: "claude_create_cloud_session", arguments: { description: "x", repo: "https://gitlab.com/acme/widgets" } },
        { name: "claude_send_followup", arguments: { session: "--help", message: "hi" } },
        { name: "claude_send_followup", arguments: { session: "session_01ABCDEFGH" } },
        { name: "claude_auth_status", arguments: { verbose: true } },
      ];
      for (const c of cases) {
        const result = (await client.callTool(c)) as CallToolResult;
        assert.equal(result.isError, true, JSON.stringify(c));
      }
      assert.deepEqual(argvCalls(), []);
    } finally {
      await close();
    }
  });

  it("surfaces non-zero exits as tool errors including stderr", async () => {
    const { client, close } = await connect({ FAKE_CLAUDE_MODE: "fail" });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "x" },
      })) as CallToolResult;
      const body = errorBody(result);
      assert.equal(body.error.code, "CLI_EXIT_NONZERO");
      assert.match(body.error.message, /Unable to create cloud session: not signed in/);
    } finally {
      await close();
    }
  });

  it("returns raw output with parsed=false when output is unrecognised", async () => {
    const { client, close } = await connect({ FAKE_CLAUDE_MODE: "garbled" });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "x" },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      const s = result.structuredContent as { parsed: boolean; session_id: null; cli: { stdout: string } };
      assert.equal(s.parsed, false);
      assert.equal(s.session_id, null);
      assert.equal(s.cli.stdout, "something unexpected happened\n");

      const auth = (await client.callTool({ name: "claude_auth_status", arguments: {} })) as CallToolResult;
      assert.equal(errorBody(auth).error.code, "OUTPUT_PARSE_FAILED");
    } finally {
      await close();
    }
  });

  it("enforces CLAUDE_MCP_TIMEOUT_MS", async () => {
    const { client, close } = await connect({ FAKE_CLAUDE_MODE: "hang", CLAUDE_MCP_TIMEOUT_MS: "300" });
    try {
      const result = (await client.callTool({ name: "claude_auth_status", arguments: {} })) as CallToolResult;
      assert.equal(errorBody(result).error.code, "CLI_TIMEOUT");
    } finally {
      await close();
    }
  });

  it("reports a missing binary", async () => {
    const { client, close } = await connect({ CLAUDE_BIN: join(tmp, "does-not-exist") });
    try {
      const result = (await client.callTool({ name: "claude_auth_status", arguments: {} })) as CallToolResult;
      assert.equal(errorBody(result).error.code, "CLI_NOT_FOUND");
    } finally {
      await close();
    }
  });

  it("reports a missing claude binary on the pty create path", async () => {
    const { client, close } = await connect({ CLAUDE_BIN: join(tmp, "does-not-exist") });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "x" },
      })) as CallToolResult;
      assert.equal(errorBody(result).error.code, "CLI_NOT_FOUND");
    } finally {
      await close();
    }
  });

  it("reports a missing python interpreter as PTY_UNAVAILABLE and still runs auth", async () => {
    const { client, close } = await connect({ CLAUDE_MCP_PYTHON: join(tmp, "no-python") });
    try {
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "x" },
      })) as CallToolResult;
      assert.equal(errorBody(created).error.code, "PTY_UNAVAILABLE");
      const auth = (await client.callTool({ name: "claude_auth_status", arguments: {} })) as CallToolResult;
      assert.notEqual(auth.isError, true);
    } finally {
      await close();
    }
  });

  it("runs create in an allowlisted directory and rejects anything off the list", async () => {
    const work = realpathSync(mkdirWork("allowed-repo"));
    const outsider = realpathSync(mkdirWork("outsider"));
    const { client, argvCalls, metaCalls, close } = await connect({
      CLAUDE_MCP_REPOS: work,
    });
    try {
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "in the allowlisted checkout", repo: work },
      })) as CallToolResult;
      assert.notEqual(created.isError, true);
      const s = created.structuredContent as { cwd: string; repo: string; title: string };
      assert.equal(s.cwd, work);
      assert.equal(s.repo, work);
      assert.equal(s.title, "in the allowlisted checkout");
      assert.equal(metaCalls()[0]?.cwd, work);

      const denied = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "nope", repo: outsider },
      })) as CallToolResult;
      assert.equal(errorBody(denied).error.code, "REPO_NOT_ALLOWED");
      const unknown = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "nope", repo: "sohampatwardhan/141-hillside-1b-hub" },
      })) as CallToolResult;
      assert.equal(errorBody(unknown).error.code, "REPO_NOT_ALLOWED");
      assert.deepEqual(argvCalls(), [["--cloud=in the allowlisted checkout"]]);
    } finally {
      await close();
    }
  });

  it("trusts the allowlisted directory the session is created from", async () => {
    const work = realpathSync(mkdirWork("trust-repo"));
    const home = join(tmp, "home-repo");
    mkdirSync(home);
    const { client, close } = await connect({
      HOME: home,
      CLAUDE_MCP_CWD: work,
      CLAUDE_MCP_REPOS: `${work},${process.cwd()}`,
      CLAUDE_MCP_TRUST_CWD: "1",
      FAKE_CLAUDE_TRUST: "file",
    });
    try {
      const other = realpathSync(process.cwd());
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "trust this repo", repo: other },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      const saved = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      const trusted = expectedTrustPath(other);
      assert.equal(saved.projects[trusted]?.hasTrustDialogAccepted, true);
      if (trusted !== expectedTrustPath(work)) assert.equal(saved.projects[expectedTrustPath(work)], undefined);
    } finally {
      await close();
    }
  });

  it("runs auth and create in CLAUDE_MCP_CWD and trusts that directory", async () => {
    const work = join(tmp, "work");
    const home = join(tmp, "home-cwd");
    mkdirSync(work);
    mkdirSync(home);
    const { client, metaCalls, close } = await connect({
      HOME: home,
      CLAUDE_MCP_CWD: work,
      CLAUDE_MCP_TRUST_CWD: "1",
      FAKE_CLAUDE_TRUST: "file",
    });
    try {
      const auth = (await client.callTool({ name: "claude_auth_status", arguments: {} })) as CallToolResult;
      assert.notEqual(auth.isError, true);
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "from cwd env" },
      })) as CallToolResult;
      assert.notEqual(created.isError, true);
      const s = created.structuredContent as { title: string; parsed: boolean; cli: { stdout: string } };
      assert.equal(s.parsed, true);
      assert.equal(s.title, "from cwd env");
      assert.doesNotMatch(s.cli.stdout, /[\u0000-\u0008\u000e-\u001f]/);
      const meta = metaCalls();
      assert.equal(meta[0]?.cwd, work);
      assert.equal(meta[1]?.cwd, work);
      const saved = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      const trusted = expectedTrustPath(work);
      assert.equal(saved.projects[trusted]?.hasTrustDialogAccepted, true);
      if (trusted !== expectedTrustPath()) assert.equal(saved.projects[expectedTrustPath()], undefined);
    } finally {
      await close();
    }
  });

  it("refuses the workspace-trust dialog unless CLAUDE_MCP_TRUST_CWD is set", async () => {
    const home = join(tmp, "home-refuse");
    mkdirSync(home);
    const { client, stdinBytes, close } = await connect({
      HOME: home,
      FAKE_CLAUDE_TRUST: "prompt",
      FAKE_CLAUDE_TRUST_QUESTION: "Do you trust this folder?",
    });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "x" },
      })) as CallToolResult;
      const body = errorBody(result);
      assert.equal(body.error.code, "WORKSPACE_NOT_TRUSTED");
      assert.match(body.error.message, /CLAUDE_MCP_TRUST_CWD/);
      assert.equal(stdinBytes().length, 0);
      assert.equal(existsSync(join(home, ".claude.json")), false);
    } finally {
      await close();
    }
  });

  it("with CLAUDE_MCP_TRUST_CWD, pre-trusts the checkout so the dialog is not shown", async () => {
    const home = join(tmp, "home-file");
    mkdirSync(home);
    const { client, stdinBytes, close } = await connect({
      HOME: home,
      CLAUDE_MCP_TRUST_CWD: "1",
      FAKE_CLAUDE_TRUST: "file",
    });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "trusted via file" },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      const s = result.structuredContent as { title: string; parsed: boolean };
      assert.equal(s.parsed, true);
      assert.equal(s.title, "trusted via file");
      assert.equal(stdinBytes().length, 0);
      const saved = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      assert.equal(saved.projects[expectedTrustPath()]?.hasTrustDialogAccepted, true);
    } finally {
      await close();
    }
  });

  it("with CLAUDE_MCP_TRUST_CWD, answers the dialog when it is still shown", async () => {
    const home = join(tmp, "home-key");
    mkdirSync(home);
    const { client, stdinBytes, close } = await connect({
      HOME: home,
      CLAUDE_MCP_TRUST_CWD: "true",
      FAKE_CLAUDE_TRUST: "prompt",
    });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "accepted on the pty" },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      const s = result.structuredContent as { parsed: boolean; title: string };
      assert.equal(s.parsed, true);
      assert.equal(s.title, "accepted on the pty");
      assert.ok(stdinBytes().length > 0, "expected an Enter keystroke on the trust dialog");
      const saved = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
        projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      assert.equal(saved.projects[expectedTrustPath()]?.hasTrustDialogAccepted, true);
    } finally {
      await close();
    }
  });

  it("enforces CLAUDE_MCP_TIMEOUT_MS on the pty create path", async () => {
    const { client, close } = await connect({ FAKE_CLAUDE_MODE: "hang", CLAUDE_MCP_TIMEOUT_MS: "800" });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "x" },
      })) as CallToolResult;
      assert.equal(errorBody(result).error.code, "CLI_TIMEOUT");
    } finally {
      await close();
    }
  });
});
