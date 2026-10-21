// Starts the built server over stdio, exactly as an MCP client would, with
// CLAUDE_BIN pointed at a fake CLI so no real sessions are created.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const argvLog = join(tmp, `argv-${logCounter++}.jsonl`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_")) env[k] = v;
  }
  Object.assign(env, { CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_ARGV_LOG: argvLog }, extraEnv);

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
  return { client, argvCalls, close: () => client.close() };
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
    const { client, argvCalls, close } = await connect();
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
      assert.deepEqual(argvCalls(), [["--cloud=Fix the flaky test"]]);
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
});
