// Starts the built server with the Streamable HTTP transport, exactly as a
// remote MCP client would reach it, with CLAUDE_BIN pointed at the fake CLI.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(root, "dist/src/index.js");
const fakeClaude = join(root, "test/fixtures/fake-claude.mjs");
chmodSync(fakeClaude, 0o755);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "claude-mcp-http-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const TOKEN = "test-token-0123456789abcdef0123456789abcdef";
let counter = 0;

interface Started {
  proc: ChildProcess;
  url: string;
  stderr: () => string;
  argvCalls: () => string[][];
  metaCalls: () => { pid: number; args: string[] }[];
  stop: () => Promise<void>;
}

function readLines<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

/** Start the server on a free loopback port and wait for its listening line. */
async function start(extraEnv: Record<string, string> = {}): Promise<Started> {
  const id = counter++;
  const argvLog = join(tmp, `argv-${id}.jsonl`);
  const metaLog = join(tmp, `meta-${id}.jsonl`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAUDE_")) env[k] = v;
  Object.assign(
    env,
    {
      CLAUDE_BIN: fakeClaude,
      CLAUDE_MCP_HTTP_PORT: "0",
      CLAUDE_MCP_TOKEN: TOKEN,
      CLAUDE_MCP_REPO_CACHE: join(tmp, `cache-${id}`),
      FAKE_CLAUDE_ARGV_LOG: argvLog,
      FAKE_CLAUDE_META_LOG: metaLog,
    },
    extraEnv,
  );
  // stdin is closed from the start, as under launchd: the HTTP server must keep running.
  const proc = spawn(process.execPath, [serverEntry], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const url = await new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 10_000);
    const check = () => {
      const match = /listening on (http:\/\/\S+)/.exec(stderr);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    };
    proc.stderr?.on("data", check);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${stderr}`));
    });
  });
  return {
    proc,
    url,
    stderr: () => stderr,
    argvCalls: () => readLines<string[]>(argvLog),
    metaCalls: () => readLines<{ pid: number; args: string[] }>(metaLog),
    stop: () =>
      new Promise((resolvePromise) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolvePromise();
        proc.once("exit", () => resolvePromise());
        proc.kill("SIGTERM");
      }),
  };
}

/** A raw HTTP request, so headers the SDK client would normally set can be wrong on purpose. */
function raw(
  url: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        method: options.method ?? "POST",
        path: options.path ?? target.pathname,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body ?? "");
  });
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

async function connectClient(url: string, token = TOKEN): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

describe("Streamable HTTP transport", () => {
  it("binds loopback, logs the URL but never the token, and keeps running with stdin closed", async () => {
    const server = await start();
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.equal(server.stderr().includes(TOKEN), false);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      assert.equal(server.proc.exitCode, null, "closing stdin does not stop the HTTP server");
      const client = await connectClient(server.url);
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === "claude_create_cloud_session"));
      const auth = (await client.callTool({ name: "claude_auth_status", arguments: {} })) as CallToolResult;
      assert.notEqual(auth.isError, true);
      assert.equal((auth.structuredContent as { loggedIn: boolean }).loggedIn, true);
      await client.close();
    } finally {
      await server.stop();
    }
  });

  it("answers 401 before any MCP handling when the token is missing or wrong", async () => {
    const server = await start();
    try {
      const attempts: Record<string, string>[] = [
        {},
        { authorization: `Bearer ${TOKEN}x` },
        { authorization: `Basic ${TOKEN}` },
        { authorization: "Bearer" },
      ];
      for (const headers of attempts) {
        const res = await raw(server.url, { headers, body: initialize });
        assert.equal(res.status, 401, JSON.stringify(headers));
        assert.match(String(res.headers["www-authenticate"]), /^Bearer /);
        assert.equal(res.body.includes(TOKEN), false);
      }
      await assert.rejects(() => connectClient(server.url, `${TOKEN}-wrong`));
      assert.deepEqual(server.argvCalls(), [], "no CLI process started");
    } finally {
      await server.stop();
    }
  });

  it("rejects a Host or Origin that isn't allowed (DNS rebinding), even with the right token", async () => {
    const server = await start({ CLAUDE_MCP_HTTP_ALLOWED_HOSTS: "mymac.tail1234.ts.net" });
    try {
      const auth = { authorization: `Bearer ${TOKEN}` };
      const badHost = await raw(server.url, { headers: { ...auth, host: "attacker.example" }, body: initialize });
      assert.equal(badHost.status, 403);
      const badOrigin = await raw(server.url, { headers: { ...auth, origin: "https://attacker.example" }, body: initialize });
      assert.equal(badOrigin.status, 403);
      const tailnet = await raw(server.url, { headers: { ...auth, host: "mymac.tail1234.ts.net:443" }, body: initialize });
      assert.equal(tailnet.status, 200, "an allowed host passes with any port");
      const loopbackOrigin = await raw(server.url, { headers: { ...auth, origin: "http://localhost:3000" }, body: initialize });
      assert.equal(loopbackOrigin.status, 200);
    } finally {
      await server.stop();
    }
  });

  it("answers only POST /mcp, and refuses oversized or malformed bodies", async () => {
    const server = await start();
    try {
      const auth = { authorization: `Bearer ${TOKEN}` };
      assert.equal((await raw(server.url, { headers: auth, path: "/other", body: initialize })).status, 404);
      const get = await raw(server.url, { headers: auth, method: "GET" });
      assert.equal(get.status, 405);
      assert.equal(get.headers.allow, "POST");
      assert.equal((await raw(server.url, { headers: auth, method: "DELETE" })).status, 405);
      assert.equal((await raw(server.url, { headers: auth, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
      assert.equal((await raw(server.url, { headers: auth, body: "{not json" })).status, 400);
    } finally {
      await server.stop();
    }
  });

  it("shares jobs across requests and connections: a create started on one client is read on another", async () => {
    const server = await start({ FAKE_CLAUDE_CREATE_DELAY_MS: "2500" });
    try {
      const first = await connectClient(server.url);
      const created = (await first.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "over http" },
      })) as CallToolResult;
      const jobId = (created.structuredContent as { job_id: string; status: string }).job_id;
      assert.notEqual((created.structuredContent as { status: string }).status, "done");
      await first.close();

      const second = await connectClient(server.url);
      let status = "";
      const deadline = Date.now() + 15_000;
      while (status !== "done") {
        assert.ok(Date.now() < deadline, "job did not finish");
        const read = (await second.callTool({ name: "claude_get_session", arguments: { session: jobId } })) as CallToolResult;
        assert.notEqual(read.isError, true);
        status = (read.structuredContent as { job: { status: string } }).job.status;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      await second.close();
    } finally {
      await server.stop();
    }
  });

  it("stops every child it started when it gets SIGTERM", async () => {
    const server = await start({ FAKE_CLAUDE_MODE: "hang" });
    try {
      const client = await connectClient(server.url);
      await client.callTool({ name: "claude_create_cloud_session", arguments: { description: "hangs" } });
      await waitFor(() => server.metaCalls().some((meta) => meta.args[0] === "--cloud=hangs"), 5_000, "the fake CLI");
      const pid = server.metaCalls().find((meta) => meta.args[0] === "--cloud=hangs")?.pid ?? 0;
      assert.ok(alive(pid));
      await client.close().catch(() => undefined);
      await server.stop();
      assert.equal(server.proc.exitCode ?? 128 + 15, 128 + 15);
      await waitFor(() => !alive(pid), 8_000, "claude --cloud to exit");
    } finally {
      await server.stop();
    }
  });

  it("refuses to start without CLAUDE_MCP_TOKEN", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLAUDE_")) env[k] = v;
    Object.assign(env, { CLAUDE_BIN: fakeClaude, CLAUDE_MCP_HTTP_PORT: "0" });
    const proc = spawn(process.execPath, [serverEntry], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolvePromise) => proc.once("exit", (exitCode) => resolvePromise(exitCode)));
    assert.equal(code, 2);
    assert.match(stderr, /CLAUDE_MCP_TOKEN/);
    assert.doesNotMatch(stderr, /listening on/);
  });
});
