// Starts the built server over stdio, exactly as an MCP client would, with
// CLAUDE_BIN pointed at a fake CLI so no real sessions are created.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ISSUE_REPORTING } from "../src/server.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(root, "dist/src/index.js");
const fakeClaude = join(root, "test/fixtures/fake-claude.mjs");
const fakeGh = join(root, "test/fixtures/fake-gh.mjs");
chmodSync(fakeClaude, 0o755);
chmodSync(fakeGh, 0o755);

// realpath: on macOS tmpdir() is under /var, a symlink to /private/var, and git and
// process.cwd() report the /private/var form.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "claude-mcp-smoke-")));
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
  let stderrText = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  await client.connect(transport);
  // `auth status` calls are hidden by default: create and local runs make one as a sign-in
  // preflight, which would shift every index. allArgvCalls / allMetaCalls keep them.
  const isAuthStatus = (args: string[]) => args[0] === "auth" && args[1] === "status";
  const allArgvCalls = (): string[][] => {
    try {
      return readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  const argvCalls = (): string[][] => allArgvCalls().filter((args) => !isAuthStatus(args));
  type Meta = { args: string[]; cwd: string; pid: number; stdoutIsTTY: boolean; stdinIsTTY: boolean };
  const allMetaCalls = (): Meta[] => {
    try {
      return readFileSync(metaLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Meta);
    } catch {
      return [];
    }
  };
  const metaCalls = (): Meta[] => allMetaCalls().filter((meta) => !isAuthStatus(meta.args));
  const stdinBytes = (): Buffer => {
    try {
      return readFileSync(stdinLog);
    } catch {
      return Buffer.alloc(0);
    }
  };
  return {
    client,
    argvCalls,
    allArgvCalls,
    metaCalls,
    allMetaCalls,
    stdinBytes,
    serverPid: transport.pid,
    stderr: () => stderrText,
    close: () => client.close(),
  };
}

function git(args: string[], cwd?: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_AUTHOR_NAME: "dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "dev",
    },
  });
}

/** Local bare repo that `git clone https://github.com/owner/name.git` resolves to. */
function githubRewrite(name: string, owner: string, repo: string): { env: Record<string, string> } {
  const work = join(tmp, `${name}-src`);
  const bare = join(tmp, `${name}.git`);
  mkdirSync(work, { recursive: true });
  git(["init", "-b", "main", work]);
  writeFileSync(join(work, "README"), "main\n");
  git(["add", "README"], work);
  git(["commit", "-m", "main"], work);
  git(["checkout", "-b", "develop"], work);
  writeFileSync(join(work, "README"), "develop\n");
  git(["commit", "-am", "develop"], work);
  git(["clone", "--bare", work, bare]);
  // A file:// URL and allowFilter so the server's partial clone is honored, as it is on GitHub.
  git(["config", "uploadpack.allowFilter", "true"], bare);
  const gitconfig = join(tmp, `${name}.gitconfig`);
  writeFileSync(gitconfig, `[url "file://${bare}"]\n\tinsteadOf = https://github.com/${owner}/${repo}.git\n`);
  return { env: { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" } };
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
    return realpathSync(dir);
  }
}

const JOB_ID = /^job_[0-9a-f]{24}$/;

type Connected = Awaited<ReturnType<typeof connect>>;

/** Poll claude_get_session with a job id until `done(job)` holds or the call fails. */
async function pollJob(
  client: Connected["client"],
  jobId: string,
  done: (job: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<CallToolResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = (await client.callTool({ name: "claude_get_session", arguments: { session: jobId } })) as CallToolResult;
    if (result.isError === true) return result;
    const job = (result.structuredContent as { job: Record<string, unknown> }).job;
    if (done(job)) return result;
    assert.ok(Date.now() < deadline, `job ${jobId} did not reach the expected state; last ${JSON.stringify(job)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll claude_get_session for a claude_run_local job until `done` holds or the call errors. */
async function pollLocal(
  client: Connected["client"],
  jobId: string,
  done: (job: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<CallToolResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = (await client.callTool({ name: "claude_get_session", arguments: { session: jobId } })) as CallToolResult;
    if (result.isError === true) return result;
    const job = (result.structuredContent as { local_job: Record<string, unknown> }).local_job;
    if (done(job)) return result;
    assert.ok(Date.now() < deadline, `local job ${jobId} did not reach the expected state; last ${JSON.stringify(job)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function errorBody(result: CallToolResult): { error: { code: string; message: string } } {
  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return JSON.parse(first.text) as { error: { code: string; message: string } };
}

describe("stdio smoke test", () => {
  it("lists exactly the seven tools, each with a strict input schema", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        "claude_auth_status",
        "claude_cancel_session",
        "claude_create_cloud_session",
        "claude_get_session",
        "claude_run_local",
        "claude_send_followup",
        "claude_usage",
      ]);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, "object");
        assert.equal((tool.inputSchema as Record<string, unknown>).additionalProperties, false, tool.name);
        assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
      }
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      assert.deepEqual(byName.claude_create_cloud_session?.inputSchema.required, ["description"]);
      assert.deepEqual(byName.claude_get_session?.inputSchema.required, ["session"]);
      assert.deepEqual(byName.claude_cancel_session?.inputSchema.required, ["session"]);
      assert.match(byName.claude_cancel_session?.description ?? "", /does not stop a cloud session/);
      assert.deepEqual(byName.claude_send_followup?.inputSchema.required?.slice().sort(), ["message", "session"]);
      assert.deepEqual(byName.claude_auth_status?.inputSchema.properties, {});
      assert.deepEqual(byName.claude_run_local?.inputSchema.required?.slice().sort(), ["cwd", "prompt"]);
      assert.match(byName.claude_run_local?.description ?? "", /LOCAL_RUNS_DISABLED/);
      assert.match(client.getInstructions() ?? "", /claude_run_local/);
      assert.match(client.getInstructions() ?? "", /claude_usage/);
      assert.equal(byName.claude_usage?.annotations?.readOnlyHint, true);
      assert.match(client.getInstructions() ?? "", /can't push its branch to GitHub/);
      assert.match(client.getInstructions() ?? "", /git format-patch/);
      assert.match(client.getInstructions() ?? "", /claude_get_session/);
      assert.match(client.getInstructions() ?? "", /npm install -g @anthropic-ai\/claude-code/);
      assert.match(client.getInstructions() ?? "", /job_id/);
      assert.ok((client.getInstructions() ?? "").includes(ISSUE_REPORTING), "instructions carry the issue-reporting guidance");
      assert.match(ISSUE_REPORTING, /github\.com\/sohampatwardhan\/claude-code-mcp-server\/issues/);
      assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(`> ${ISSUE_REPORTING}`), "README block matches ISSUE_REPORTING");
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
      assert.equal(client.getServerVersion()?.version, pkg.version);
      assert.match(byName.claude_get_session?.description ?? "", /job id/);
      assert.doesNotMatch(client.getInstructions() ?? "", /no status tool/);
      assert.match(byName.claude_create_cloud_session?.description ?? "", /git format-patch/);
      assert.match(byName.claude_send_followup?.description ?? "", /git format-patch/);
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
      assert.equal(s.status, "done");
      assert.match(String(s.job_id), JOB_ID);
      assert.equal(typeof s.elapsed_ms, "number");
      assert.equal(s.environment_id, null);
      assert.equal(s.cwd, process.cwd());
      assert.equal(s.repo, null);
      assert.equal(s.base_branch, null);
      const cli = s.cli as { stdout: string; stderr: string };
      assert.equal(cli.stderr, "");
      assert.doesNotMatch(cli.stdout, /[\u0000-\u0008\u000e-\u001f]/);
      assert.match(cli.stdout, /^Created cloud session: Fix the flaky test\n/);
      assert.deepEqual(argvCalls(), [["--cloud=Fix the flaky test"]]);
      assert.equal(metaCalls()[0]?.stdoutIsTTY, true);
      assert.equal(metaCalls()[0]?.stdinIsTTY, true);
      assert.equal(metaCalls()[0]?.cwd, process.cwd());

      const read = (await client.callTool({
        name: "claude_get_session",
        arguments: { session: String(s.job_id) },
      })) as CallToolResult;
      assert.notEqual(read.isError, true);
      const body = read.structuredContent as { job: Record<string, unknown>; session_id: string; cli: null };
      assert.deepEqual(body.job, s);
      assert.equal(body.session_id, "session_01FakeSessionId0000000000");
      assert.equal(body.cli, null);
      assert.equal(argvCalls().length, 1, "reading a job runs nothing");
    } finally {
      await close();
    }
  });

  it("runs create on a pty and leaves follow-up and auth on pipes", async () => {
    const { client, allMetaCalls, argvCalls, close } = await connect();
    try {
      await client.callTool({ name: "claude_create_cloud_session", arguments: { description: "$(rm -rf /) `id`" } });
      await client.callTool({
        name: "claude_send_followup",
        arguments: { session: "session_01Target00000000", message: "next" },
      });
      await client.callTool({ name: "claude_auth_status", arguments: {} });
      // The sign-in preflight, create, follow-up, then the claude_auth_status call.
      const meta = allMetaCalls();
      assert.deepEqual(meta[0]?.args, ["auth", "status"]);
      assert.equal(meta[0]?.stdoutIsTTY, false);
      assert.equal(meta[1]?.stdoutIsTTY, true);
      assert.equal(meta[2]?.stdoutIsTTY, false);
      assert.deepEqual(meta[3]?.args, ["auth", "status"]);
      assert.equal(meta[3]?.stdoutIsTTY, false);
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
        { name: "claude_create_cloud_session", arguments: { description: "x", repo: "https://user:token@github.com/acme/widgets" } },
        { name: "claude_create_cloud_session", arguments: { description: "x", base_branch: "-rf" } },
        { name: "claude_create_cloud_session", arguments: { description: "x", base_branch: "a/../../b" } },
        { name: "claude_create_cloud_session", arguments: { description: "x", timeout_s: 0 } },
        { name: "claude_create_cloud_session", arguments: { description: "x", timeout_s: 1.5 } },
        { name: "claude_create_cloud_session", arguments: { description: "x", timeout_s: 86_401 } },
        { name: "claude_create_cloud_session", arguments: { description: "x", idle_timeout_s: 0 } },
        { name: "claude_cancel_session", arguments: {} },
        { name: "claude_cancel_session", arguments: { session: "--all" } },
        { name: "claude_get_session", arguments: {} },
        { name: "claude_get_session", arguments: { session: "session_01ABCDEFGH", repo: "/tmp" } },
        { name: "claude_get_session", arguments: { session: "job_xyz" } },
        { name: "claude_get_session", arguments: { session: "job_0123456789abcdef01234567 --help" } },
        { name: "claude_send_followup", arguments: { session: "--help", message: "hi" } },
        { name: "claude_send_followup", arguments: { session: "job_0123456789abcdef01234567", message: "hi" } },
        { name: "claude_send_followup", arguments: { session: "session_01ABCDEFGH" } },
        { name: "claude_auth_status", arguments: { verbose: true } },
        { name: "claude_usage", arguments: { refresh: "yes" } },
        { name: "claude_usage", arguments: { args: ["--model=opus"] } },
        { name: "claude_run_local", arguments: { cwd: "/tmp" } },
        { name: "claude_run_local", arguments: { cwd: "relative/dir", prompt: "x" } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", permission_mode: "bypassPermissions" } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", permission_mode: "default" } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", allowed_tools: ["Bash(rm *)"] } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", allowed_tools: ["mcp__github__create_pr"] } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", resume: "session_01ABCDEFGH" } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", model: "--dangerously-skip-permissions" } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", max_turns: 0 } },
        { name: "claude_run_local", arguments: { cwd: "/tmp", prompt: "x", flags: ["--dangerously-skip-permissions"] } },
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
      assert.match(body.error.message, /Unable to create cloud session: environment unavailable/);
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
      const result = (await client.callTool({
        name: "claude_send_followup",
        arguments: { session: "session_01FakeSessionId0000000000", message: "hangs" },
      })) as CallToolResult;
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
      assert.match(errorBody(result).error.message, /npm install -g @anthropic-ai\/claude-code/);
      assert.match(errorBody(result).error.message, /run `claude` once to sign in/);
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
      assert.match(errorBody(result).error.message, /npm install -g @anthropic-ai\/claude-code/);
    } finally {
      await close();
    }
  });

  it("tells the caller to sign in with claude when the CLI has no login", async () => {
    const { client, close } = await connect({ FAKE_CLAUDE_MODE: "signed_out" });
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        ["claude_create_cloud_session", { description: "x" }],
        ["claude_send_followup", { session: "session_01FakeSessionId0000000000", message: "hi" }],
        ["claude_auth_status", {}],
      ];
      for (const [name, args] of calls) {
        const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
        const body = errorBody(result);
        assert.equal(body.error.code, "CLI_NOT_SIGNED_IN", name);
        assert.match(body.error.message, /Sign in with `claude` first/, name);
        assert.match(body.error.message, /Claude GitHub app/, name);
      }
    } finally {
      await close();
    }
  });

  it("warns on stderr at startup when the claude binary is missing", async () => {
    const { client, close, stderr } = await connect({ CLAUDE_BIN: join(tmp, "missing-at-startup") });
    try {
      await client.listTools();
      assert.match(stderr(), /warning: Claude Code CLI not found: .*missing-at-startup/);
      assert.match(stderr(), /npm install -g @anthropic-ai\/claude-code/);
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
      const localBranch = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "nope", repo: work, base_branch: "develop" },
      })) as CallToolResult;
      assert.equal(errorBody(localBranch).error.code, "REPO_PREPARE_FAILED");
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
    const { client, allMetaCalls, close } = await connect({
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
      // claude_auth_status, the create's sign-in preflight, then claude --cloud.
      const meta = allMetaCalls();
      assert.deepEqual(meta.map((m) => m.args[0]), ["auth", "auth", "--cloud=from cwd env"]);
      for (const m of meta) assert.equal(m.cwd, work);
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

  it("clones any github.com repository and reports the session branch and pull request", async () => {
    const cache = join(tmp, "repo-cache");
    const rewrite = githubRewrite("widgets", "acme", "widgets");
    const session = "session_01FakeSessionId0000000000";
    const { client, argvCalls, metaCalls, close } = await connect({
      CLAUDE_MCP_REPO_CACHE: cache,
      ...rewrite.env,
      FAKE_TELEPORT_BRANCH: "claude/session-branch",
      FAKE_TELEPORT_PR_NUMBER: "17",
      FAKE_TELEPORT_PR_URL: "https://github.com/acme/widgets/pull/17",
    });
    try {
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "ship the widget", repo: "acme/widgets", base_branch: "develop" },
      })) as CallToolResult;
      assert.notEqual(created.isError, true);
      const createdBody = created.structuredContent as {
        cwd: string;
        repo: string;
        base_branch: string;
        session_id: string;
        cache: { cloned: boolean; duration_ms: number } | null;
      };
      assert.equal(createdBody.repo, "acme/widgets");
      assert.equal(createdBody.base_branch, "develop");
      assert.equal(createdBody.session_id, session);
      assert.equal(createdBody.cache?.cloned, true);
      assert.ok(Number.isInteger(createdBody.cache?.duration_ms) && createdBody.cache.duration_ms >= 0);
      assert.equal(readFileSync(join(createdBody.cwd, "README"), "utf8"), "develop\n");
      assert.equal(
        execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: createdBody.cwd, encoding: "utf8" }).trim(),
        "https://github.com/acme/widgets.git",
      );
      assert.equal(
        execFileSync("git", ["config", "--get", "remote.origin.partialclonefilter"], {
          cwd: createdBody.cwd,
          encoding: "utf8",
        }).trim(),
        "blob:none",
      );
      assert.equal(metaCalls()[0]?.cwd, createdBody.cwd);
      assert.deepEqual(argvCalls()[0], ["--cloud=ship the widget"]);
      const record = JSON.parse(readFileSync(join(cache, "sessions", `${session}.json`), "utf8")) as {
        repo: string;
        base_branch: string;
      };
      assert.equal(record.repo, "acme/widgets");
      assert.equal(record.base_branch, "develop");

      const status = (await client.callTool({
        name: "claude_get_session",
        arguments: { session },
      })) as CallToolResult;
      assert.notEqual(status.isError, true);
      const body = status.structuredContent as {
        repo: string;
        branch: string;
        base_branch: string;
        pr_number: number;
        pr_url: string;
        pr_source: string;
        pr_error: string | null;
        parsed: boolean;
        args: string[];
      };
      assert.equal(body.repo, "acme/widgets");
      assert.equal(body.branch, "claude/session-branch");
      assert.equal(body.base_branch, "develop");
      assert.equal(body.pr_number, 17);
      assert.equal(body.pr_url, "https://github.com/acme/widgets/pull/17");
      assert.equal(body.pr_source, "output");
      assert.equal(body.pr_error, null);
      assert.equal(body.parsed, true);
      assert.deepEqual(body.args, [
        `--teleport=${session}`,
        "--debug",
        `--debug-file=${join(cache, "sessions", `${session}.teleport.log`)}`,
      ]);
      assert.equal(metaCalls()[1]?.stdoutIsTTY, false);
      assert.equal(metaCalls()[1]?.cwd, createdBody.cwd);
      assert.equal(
        execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: createdBody.cwd, encoding: "utf8" }).trim(),
        "claude/session-branch",
      );

      // A second session on the same repository reuses the cache instead of recloning it.
      const marker = join(createdBody.cwd, ".git", "mcp-test-marker");
      writeFileSync(marker, "kept\n");
      const again = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "second session", repo: "acme/widgets" },
      })) as CallToolResult;
      assert.notEqual(again.isError, true);
      const againBody = again.structuredContent as {
        cwd: string;
        base_branch: string;
        cache: { cloned: boolean; duration_ms: number } | null;
      };
      assert.equal(againBody.cwd, createdBody.cwd);
      // The fixture's origin HEAD is develop, so that is the default branch.
      assert.equal(againBody.base_branch, "develop");
      assert.equal(againBody.cache?.cloned, false);
      assert.equal(readFileSync(marker, "utf8"), "kept\n");
      assert.equal(
        execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: againBody.cwd, encoding: "utf8" }).trim(),
        "develop",
      );
    } finally {
      await close();
    }
  });

  it("reads the pull request with gh when teleport does not print one", async () => {
    const cache = join(tmp, "repo-cache-gh");
    const rewrite = githubRewrite("widgets-gh", "acme", "widgets");
    const ghDir = join(tmp, "gh-bin");
    const ghLog = join(tmp, "gh-argv.jsonl");
    mkdirSync(ghDir);
    symlinkSync(fakeGh, join(ghDir, "gh"));
    const session = "session_01FakeSessionId0000000000";
    const { client, close } = await connect({
      CLAUDE_MCP_REPO_CACHE: cache,
      PATH: `${ghDir}:${process.env.PATH ?? ""}`,
      FAKE_TELEPORT_MODE: "silent",
      FAKE_TELEPORT_BRANCH: "claude/session-branch",
      FAKE_GH_ARGV_LOG: ghLog,
      FAKE_GH_REPO: "acme/widgets",
      FAKE_GH_BRANCH: "claude/session-branch",
      FAKE_GH_PR_NUMBER: "21",
      FAKE_GH_PR_URL: "https://github.com/acme/widgets/pull/21",
      ...rewrite.env,
    });
    try {
      const status = (await client.callTool({
        name: "claude_get_session",
        arguments: { session, repo: "https://github.com/acme/widgets.git" },
      })) as CallToolResult;
      assert.notEqual(status.isError, true);
      const body = status.structuredContent as {
        repo: string;
        branch: string;
        pr_number: number;
        pr_url: string;
        pr_source: string;
      };
      assert.equal(body.repo, "acme/widgets");
      assert.equal(body.branch, "claude/session-branch");
      assert.equal(body.pr_number, 21);
      assert.equal(body.pr_url, "https://github.com/acme/widgets/pull/21");
      assert.equal(body.pr_source, "gh");
      assert.deepEqual(JSON.parse(readFileSync(ghLog, "utf8")) as string[], [
        "pr",
        "list",
        "--repo",
        "acme/widgets",
        "--head",
        "claude/session-branch",
        "--state",
        "all",
        "--json",
        "number,url",
        "--limit",
        "1",
      ]);
    } finally {
      await close();
    }
  });

  it("reports a teleport failure without a branch and a session with no recorded repository", async () => {
    const cache = join(tmp, "repo-cache-fail");
    const rewrite = githubRewrite("widgets-fail", "acme", "widgets");
    const { client, argvCalls, close } = await connect({
      CLAUDE_MCP_REPO_CACHE: cache,
      FAKE_TELEPORT_MODE: "fail",
      ...rewrite.env,
    });
    try {
      const missing = (await client.callTool({
        name: "claude_get_session",
        arguments: { session: "session_01NoRecord00000000000" },
      })) as CallToolResult;
      assert.equal(errorBody(missing).error.code, "SESSION_REPO_UNKNOWN");

      const failed = (await client.callTool({
        name: "claude_get_session",
        arguments: { session: "session_01FakeSessionId0000000000", repo: "acme/widgets" },
      })) as CallToolResult;
      const body = errorBody(failed);
      assert.equal(body.error.code, "CLI_EXIT_NONZERO");
      assert.match(body.error.message, /Teleport in print mode failed/);
      const absent = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "missing branch", repo: "acme/widgets", base_branch: "feature/absent" },
      })) as CallToolResult;
      assert.equal(errorBody(absent).error.code, "REPO_PREPARE_FAILED");
      assert.match(errorBody(absent).error.message, /feature\/absent/);
      assert.deepEqual(argvCalls(), [["--teleport=session_01FakeSessionId0000000000", "--debug", `--debug-file=${join(cache, "sessions", "session_01FakeSessionId0000000000.teleport.log")}`]]);
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

  it("returns a job id for a slow create and reports progress until the session is done", async () => {
    const { client, argvCalls, close } = await connect({
      FAKE_CLAUDE_CREATE_DELAY_MS: "2500",
      FAKE_CLAUDE_CREATE_LINGER_MS: "1500",
    });
    try {
      const started = Date.now();
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "slow create" },
      })) as CallToolResult;
      const waited = Date.now() - started;
      assert.ok(waited < 4_000, `create returned after ${waited} ms`);
      assert.notEqual(created.isError, true);
      const pending = created.structuredContent as Record<string, unknown> & { cli: { exit_code: null } };
      assert.equal(pending.status, "starting");
      assert.match(String(pending.job_id), JOB_ID);
      assert.equal(pending.session_id, null);
      assert.equal(pending.parsed, false);
      assert.equal(pending.cli.exit_code, null);
      assert.deepEqual(pending.args, ["--cloud=slow create"]);

      const running = await pollJob(client, String(pending.job_id), (job) => job.status !== "starting");
      const runningJob = (running.structuredContent as { job: Record<string, unknown> & { cli: { stdout: string } } }).job;
      assert.equal(runningJob.status, "running");
      assert.equal(runningJob.session_id, "session_01FakeSessionId0000000000");
      assert.match(runningJob.cli.stdout, /Created cloud session: slow create/);
      assert.equal((running.structuredContent as { session_id: string }).session_id, "session_01FakeSessionId0000000000");

      const done = await pollJob(client, String(pending.job_id), (job) => job.status === "done");
      const doneJob = (done.structuredContent as { job: Record<string, unknown> & { cli: { exit_code: number } } }).job;
      assert.equal(doneJob.parsed, true);
      assert.equal(doneJob.title, "slow create");
      assert.equal(doneJob.cli.exit_code, 0);
      assert.ok(Number(doneJob.elapsed_ms) >= 3_500, `elapsed_ms ${String(doneJob.elapsed_ms)}`);
      assert.deepEqual(argvCalls(), [["--cloud=slow create"]]);
    } finally {
      await close();
    }
  });

  it("reports a create that fails after returning through the job", async () => {
    const { client, close } = await connect({ FAKE_CLAUDE_MODE: "hang", CLAUDE_MCP_TIMEOUT_MS: "2600" });
    try {
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "hangs" },
      })) as CallToolResult;
      assert.notEqual(created.isError, true);
      const pending = created.structuredContent as { job_id: string; status: string };
      assert.equal(pending.status, "starting");
      const failed = await pollJob(client, pending.job_id, () => false);
      assert.equal(errorBody(failed).error.code, "CLI_TIMEOUT");
    } finally {
      await close();
    }
  });

  it("reports an unknown job id as JOB_NOT_FOUND", async () => {
    const { client, argvCalls, close } = await connect();
    try {
      const result = (await client.callTool({
        name: "claude_get_session",
        arguments: { session: "job_0123456789abcdef01234567" },
      })) as CallToolResult;
      const body = errorBody(result);
      assert.equal(body.error.code, "JOB_NOT_FOUND");
      assert.match(body.error.message, /lost when the server restarts/);
      assert.deepEqual(argvCalls(), []);
    } finally {
      await close();
    }
  });
  it("cancels a hung create job and stops its processes", async () => {
    const { client, metaCalls, close } = await connect({ FAKE_CLAUDE_MODE: "hang" });
    try {
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "hangs forever" },
      })) as CallToolResult;
      const pending = created.structuredContent as { job_id: string; status: string };
      assert.equal(pending.status, "starting");
      await waitFor(() => metaCalls().length > 0, 5_000, "the fake CLI to start");
      const pid = metaCalls()[0]?.pid ?? 0;
      assert.ok(alive(pid));

      const started = Date.now();
      const cancel = (await client.callTool({
        name: "claude_cancel_session",
        arguments: { session: pending.job_id },
      })) as CallToolResult;
      assert.notEqual(cancel.isError, true);
      const body = cancel.structuredContent as { job: { status: string; job_id: string }; cancelled: boolean; stopped: boolean };
      assert.equal(body.cancelled, true);
      assert.equal(body.stopped, true);
      assert.equal(body.job.status, "cancelled");
      assert.equal(body.job.job_id, pending.job_id);
      assert.ok(Date.now() - started < 7_000);
      assert.equal(alive(pid), false, "claude --cloud should be gone");

      const read = (await client.callTool({
        name: "claude_get_session",
        arguments: { session: pending.job_id },
      })) as CallToolResult;
      assert.equal((read.structuredContent as { job: { status: string } }).job.status, "cancelled");
      const again = (await client.callTool({
        name: "claude_cancel_session",
        arguments: { session: pending.job_id },
      })) as CallToolResult;
      assert.equal((again.structuredContent as { cancelled: boolean }).cancelled, false);
    } finally {
      await close();
    }
  });

  it("cancels a job by the session id it printed, and leaves finished jobs alone", async () => {
    const { client, metaCalls, close } = await connect({
      FAKE_CLAUDE_CREATE_DELAY_MS: "2500",
      FAKE_CLAUDE_CREATE_LINGER_MS: "60000",
    });
    try {
      const unknown = (await client.callTool({
        name: "claude_cancel_session",
        arguments: { session: "session_01NothingRunning000000" },
      })) as CallToolResult;
      assert.equal(errorBody(unknown).error.code, "JOB_NOT_FOUND");
      assert.match(errorBody(unknown).error.message, /does not stop a cloud session/);

      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "lingers" },
      })) as CallToolResult;
      const jobId = (created.structuredContent as { job_id: string }).job_id;
      await pollJob(client, jobId, (job) => job.status === "running");
      const pid = metaCalls()[0]?.pid ?? 0;
      const cancel = (await client.callTool({
        name: "claude_cancel_session",
        arguments: { session: "https://claude.ai/code/session_01FakeSessionId0000000000" },
      })) as CallToolResult;
      const body = cancel.structuredContent as { job: { status: string; session_id: string }; cancelled: boolean };
      assert.equal(body.cancelled, true);
      assert.equal(body.job.status, "cancelled");
      assert.equal(body.job.session_id, "session_01FakeSessionId0000000000");
      assert.equal(alive(pid), false);
    } finally {
      await close();
    }

    const fast = await connect();
    try {
      const created = (await fast.client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "quick" },
      })) as CallToolResult;
      const done = created.structuredContent as { job_id: string; status: string };
      assert.equal(done.status, "done");
      const cancel = (await fast.client.callTool({
        name: "claude_cancel_session",
        arguments: { session: done.job_id },
      })) as CallToolResult;
      const body = cancel.structuredContent as { job: { status: string }; cancelled: boolean; stopped: boolean };
      assert.equal(body.cancelled, false);
      assert.equal(body.stopped, true);
      assert.equal(body.job.status, "done");
    } finally {
      await fast.close();
    }
  });

  it("stops a create that prints nothing for idle_timeout_s", async () => {
    const { client, close } = await connect({ FAKE_CLAUDE_MODE: "hang" });
    try {
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "silent", idle_timeout_s: 1 },
      })) as CallToolResult;
      const result =
        created.isError === true
          ? created
          : await pollJob(client, (created.structuredContent as { job_id: string }).job_id, () => false);
      const body = errorBody(result);
      assert.equal(body.error.code, "CLI_TIMEOUT");
      assert.match(body.error.message, /printed nothing for 1000 ms/);
    } finally {
      await close();
    }
  });

  it("stops a follow-up when the client cancels the request", async () => {
    const { client, metaCalls, close } = await connect({ FAKE_CLAUDE_MODE: "hang" });
    try {
      const controller = new AbortController();
      const call = client
        .callTool(
          { name: "claude_send_followup", arguments: { session: "session_01Target00000000", message: "hi" } },
          CallToolResultSchema,
          { signal: controller.signal },
        )
        .catch((err: unknown) => err);
      await waitFor(() => metaCalls().length > 0, 5_000, "the fake CLI to start");
      const pid = metaCalls()[0]?.pid ?? 0;
      controller.abort();
      await call;
      await waitFor(() => !alive(pid), 7_000, "the follow-up CLI to exit");
    } finally {
      await close();
    }
  });

  it("stops every child when the client closes stdin", async () => {
    const { client, metaCalls, close, serverPid } = await connect({ FAKE_CLAUDE_MODE: "hang" });
    await client.callTool({ name: "claude_create_cloud_session", arguments: { description: "left running" } });
    await waitFor(() => metaCalls().length > 0, 5_000, "the fake CLI to start");
    const pid = metaCalls()[0]?.pid ?? 0;
    assert.ok(alive(pid));
    await close();
    await waitFor(() => !alive(pid), 7_000, "claude --cloud to exit after the client closed");
    if (serverPid !== null && serverPid !== undefined) {
      await waitFor(() => !alive(serverPid), 7_000, "the server to exit");
    }
  });

  it("stops claude --cloud even when the server is killed outright", async () => {
    const { client, metaCalls, close, serverPid } = await connect({ FAKE_CLAUDE_MODE: "hang" });
    try {
      await client.callTool({ name: "claude_create_cloud_session", arguments: { description: "orphan" } });
      await waitFor(() => metaCalls().length > 0, 5_000, "the fake CLI to start");
      const pid = metaCalls()[0]?.pid ?? 0;
      assert.ok(serverPid);
      process.kill(serverPid, "SIGKILL");
      await waitFor(() => !alive(pid), 7_000, "the pty helper to stop claude after the server died");
    } finally {
      await close().catch(() => undefined);
    }
  });
});

describe("claude_run_local", () => {
  const localRoot = join(tmp, "local-root");
  const repo = join(localRoot, "app");
  const plain = join(localRoot, "plain");
  const outside = join(tmp, "local-outside");
  mkdirSync(repo, { recursive: true });
  mkdirSync(plain);
  mkdirSync(outside);
  symlinkSync(outside, join(localRoot, "escape"));
  git(["init", "-b", "main", repo]);
  writeFileSync(join(repo, "README"), "one\n");
  git(["add", "README"], repo);
  git(["commit", "-m", "one"], repo);
  const SESSION = "11111111-2222-4333-8444-555555555555";

  interface LocalJobBody {
    job_id: string;
    status: string;
    session_id: string | null;
    cwd: string;
    permission_mode: string;
    restricted: boolean;
    assistant_messages: number;
    parsed: boolean;
    subtype: string | null;
    is_error: boolean | null;
    result: string | null;
    num_turns: number | null;
    total_cost_usd: number | null;
    usage: Record<string, number | null> | null;
    permission_denials: string[];
    rate_limit: { status: string | null; resets_at: number | null; utilization: number | null; type: string | null } | null;
    errors: string[];
    files: { path: string; status: string | null; from: string | null; before: string | null }[] | null;
    args: string[];
    cli: { exit_code: number | null; stdout: string; stderr: string };
  }

  it("refuses every call when CLAUDE_MCP_LOCAL_ROOTS is unset, without spawning the CLI", async () => {
    const { client, argvCalls, close } = await connect();
    try {
      const result = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: repo, prompt: "hi" },
      })) as CallToolResult;
      assert.equal(errorBody(result).error.code, "LOCAL_RUNS_DISABLED");
      assert.deepEqual(argvCalls(), []);
    } finally {
      await close();
    }
  });

  it("refuses a directory outside the roots, including through a symlink", async () => {
    const { client, argvCalls, close } = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot });
    try {
      for (const cwd of [outside, join(localRoot, "escape"), join(localRoot, "missing"), `${localRoot}/../local-outside`]) {
        const result = (await client.callTool({ name: "claude_run_local", arguments: { cwd, prompt: "hi" } })) as CallToolResult;
        assert.equal(errorBody(result).error.code, "REPO_NOT_ALLOWED", cwd);
      }
      assert.deepEqual(argvCalls(), []);
    } finally {
      await close();
    }
  });

  it("runs in a checkout as a job, reports result, usage and changed files, then resumes the session", async () => {
    writeFileSync(join(repo, "README"), "dirty before the run\n");
    const { client, argvCalls, metaCalls, close } = await connect({
      CLAUDE_MCP_LOCAL_ROOTS: localRoot,
      FAKE_LOCAL_DELAY_MS: "2500",
      FAKE_LOCAL_WRITE: "new.txt",
    });
    try {
      const started = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: repo, prompt: "add a file", allowed_tools: ["Read", "Edit"], max_turns: 5, model: "sonnet" },
      })) as CallToolResult;
      assert.notEqual(started.isError, true);
      const pending = started.structuredContent as unknown as LocalJobBody;
      assert.match(pending.job_id, /^job_[0-9a-f]{24}$/);
      assert.equal(pending.status, "running");
      assert.equal(pending.session_id, SESSION);
      assert.equal(pending.files, null);
      assert.equal(pending.result, null);

      const read = await pollLocal(client, pending.job_id, (job) => job.status === "done");
      assert.notEqual(read.isError, true);
      const outer = read.structuredContent as { job: unknown; local_job: LocalJobBody; session_id: string };
      assert.equal(outer.job, null);
      assert.equal(outer.session_id, SESSION);
      const body = outer.local_job;
      assert.equal(body.cwd, repo);
      assert.equal(body.permission_mode, "dontAsk");
      assert.equal(body.restricted, true);
      assert.equal(body.parsed, true);
      assert.equal(body.subtype, "success");
      assert.equal(body.is_error, false);
      assert.equal(body.result, "Done: add a file");
      assert.equal(body.num_turns, 2);
      assert.equal(body.total_cost_usd, 0.0123);
      assert.deepEqual(body.usage, { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 });
      assert.deepEqual(body.permission_denials, ["Bash"]);
      assert.equal(body.rate_limit, null);
      assert.equal(body.assistant_messages, 1);
      assert.deepEqual(
        body.files?.slice().sort((a, b) => a.path.localeCompare(b.path)),
        [
          { path: "new.txt", status: "??", from: null, before: null },
          { path: "README", status: " M", from: null, before: " M" },
        ],
      );
      assert.equal(body.cli.exit_code, 0);
      assert.equal(body.cli.stdout, "", "the stream-json transcript is not returned");
      assert.deepEqual(argvCalls()[0], [
        "-p",
        "--restricted",
        "--strict-mcp-config",
        "--output-format=stream-json",
        "--verbose",
        "--permission-mode=dontAsk",
        "--model=sonnet",
        "--max-turns=5",
        "--allowedTools=Read,Edit",
        "--",
        "add a file",
      ]);
      assert.equal(metaCalls()[0]?.cwd, repo);
      assert.equal(metaCalls()[0]?.stdoutIsTTY, false);

      const resumed = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: repo, prompt: "keep going", resume: SESSION, permission_mode: "acceptEdits" },
      })) as CallToolResult;
      const next = await pollLocal(client, (resumed.structuredContent as { job_id: string }).job_id, (job) => job.status === "done");
      const nextBody = (next.structuredContent as { local_job: LocalJobBody }).local_job;
      assert.equal(nextBody.session_id, SESSION);
      assert.equal(nextBody.result, "Done: keep going");
      assert.deepEqual(argvCalls()[1], [
        "-p",
        "--restricted",
        "--strict-mcp-config",
        "--output-format=stream-json",
        "--verbose",
        "--permission-mode=acceptEdits",
        `--resume=${SESSION}`,
        "--",
        "keep going",
      ]);
    } finally {
      await close();
    }
  });

  it("refuses Bash and auto mode unless CLAUDE_MCP_LOCAL_ALLOW_SHELL is set", async () => {
    const shellCalls = [
      { cwd: plain, prompt: "x", allowed_tools: ["Read", "Bash"] },
      { cwd: plain, prompt: "x", permission_mode: "auto" },
    ];
    const off = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot });
    try {
      for (const args of shellCalls) {
        const result = (await off.client.callTool({ name: "claude_run_local", arguments: args })) as CallToolResult;
        assert.equal(errorBody(result).error.code, "LOCAL_SHELL_DISABLED", JSON.stringify(args));
      }
      assert.deepEqual(off.argvCalls(), []);
    } finally {
      await off.close();
    }
    const on = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot, CLAUDE_MCP_LOCAL_ALLOW_SHELL: "1" });
    try {
      for (const args of shellCalls) {
        const result = (await on.client.callTool({ name: "claude_run_local", arguments: args })) as CallToolResult;
        assert.notEqual(result.isError, true, JSON.stringify(args));
        await pollLocal(on.client, (result.structuredContent as { job_id: string }).job_id, (job) => job.status === "done");
      }
      assert.ok(on.argvCalls()[0]?.includes("--allowedTools=Read,Bash"));
      assert.ok(on.argvCalls()[1]?.includes("--permission-mode=auto"));
      for (const argv of on.argvCalls()) {
        assert.equal(argv.includes("--restricted"), false, "shell runs load settings normally");
        assert.equal(argv.includes("--strict-mcp-config"), false);
      }
    } finally {
      await on.close();
    }
  });

  it("returns an error result as data, and files null outside a git work tree", async () => {
    const { client, close } = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot, FAKE_LOCAL_MODE: "max_turns" });
    try {
      const result = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: plain, prompt: "too long", max_turns: 3 },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      const body = result.structuredContent as unknown as LocalJobBody;
      assert.equal(body.status, "done");
      assert.equal(body.is_error, true);
      assert.equal(body.subtype, "error_max_turns");
      assert.equal(body.result, null);
      assert.deepEqual(body.errors, ["Reached maximum number of turns (3)"]);
      assert.equal(body.session_id, SESSION);
      assert.equal(body.files, null);
      assert.equal(body.cli.exit_code, 1);
    } finally {
      await close();
    }
  });

  it("maps a run with no result line to CLI_EXIT_NONZERO, and a signed-out CLI to CLI_NOT_SIGNED_IN", async () => {
    const failed = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot, FAKE_LOCAL_MODE: "no_result" });
    try {
      const result = (await failed.client.callTool({
        name: "claude_run_local",
        arguments: { cwd: plain, prompt: "x" },
      })) as CallToolResult;
      const error = errorBody(result).error;
      assert.equal(error.code, "CLI_EXIT_NONZERO");
      assert.match(error.message, /something went wrong/);
    } finally {
      await failed.close();
    }
    const signedOut = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot, FAKE_CLAUDE_MODE: "signed_out" });
    try {
      const result = (await signedOut.client.callTool({
        name: "claude_run_local",
        arguments: { cwd: plain, prompt: "x" },
      })) as CallToolResult;
      assert.equal(errorBody(result).error.code, "CLI_NOT_SIGNED_IN");
    } finally {
      await signedOut.close();
    }
  });

  it("cancels a running local job and stops claude -p", async () => {
    const { client, metaCalls, close } = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot, FAKE_LOCAL_MODE: "hang" });
    try {
      const started = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: plain, prompt: "never ends" },
      })) as CallToolResult;
      const pending = started.structuredContent as unknown as LocalJobBody;
      assert.equal(pending.status, "running");
      assert.equal(pending.session_id, SESSION);
      const pid = metaCalls()[0]?.pid ?? 0;
      assert.ok(alive(pid));

      const cancel = (await client.callTool({
        name: "claude_cancel_session",
        arguments: { session: pending.job_id },
      })) as CallToolResult;
      assert.notEqual(cancel.isError, true);
      const body = cancel.structuredContent as { job: unknown; local_job: LocalJobBody; cancelled: boolean; stopped: boolean };
      assert.equal(body.job, null);
      assert.equal(body.cancelled, true);
      assert.equal(body.stopped, true);
      assert.equal(body.local_job.status, "cancelled");
      assert.equal(body.local_job.session_id, SESSION);
      assert.equal(alive(pid), false, "claude -p should be gone");

      const read = await pollLocal(client, pending.job_id, (job) => job.status === "cancelled");
      assert.equal((read.structuredContent as { local_job: LocalJobBody }).local_job.status, "cancelled");
    } finally {
      await close();
    }
  });
});

describe("trust prompt and sign-in preflight (#21, #22)", () => {
  it("refuses the Claude Code 2.1.316 trust dialog in seconds instead of waiting for the timeout", async () => {
    const { client, stdinBytes, close } = await connect({
      FAKE_CLAUDE_TRUST: "prompt",
      FAKE_CLAUDE_TRUST_LAYOUT: "2.1.316",
      CLAUDE_MCP_TIMEOUT_MS: "600000",
    });
    try {
      const started = Date.now();
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "untrusted folder" },
      })) as CallToolResult;
      const error = errorBody(result).error;
      assert.equal(error.code, "WORKSPACE_NOT_TRUSTED");
      assert.match(error.message, /CLAUDE_MCP_TRUST_CWD=1/);
      assert.ok(Date.now() - started < 10_000, "fails fast");
      assert.equal(stdinBytes().length, 0, "the dialog is not answered");
    } finally {
      await close();
    }
  });

  it("with CLAUDE_MCP_TRUST_CWD, moves to Yes before pressing Enter on the 2.1.316 dialog", async () => {
    const home = join(tmp, "home-trust-316");
    mkdirSync(home);
    const { client, stdinBytes, close } = await connect({
      HOME: home,
      CLAUDE_MCP_TRUST_CWD: "1",
      FAKE_CLAUDE_TRUST: "prompt",
      FAKE_CLAUDE_TRUST_LAYOUT: "2.1.316",
    });
    try {
      const result = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "trusted by keystroke" },
      })) as CallToolResult;
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.equal((result.structuredContent as { parsed: boolean }).parsed, true);
      assert.equal(stdinBytes().toString("utf8"), "\u001b[B\r", "down arrow, then Enter");
    } finally {
      await close();
    }
  });

  it("fails create and local runs with CLI_NOT_SIGNED_IN before starting them when auth status says signed out", async () => {
    const localRoot = join(tmp, "preflight-local");
    mkdirSync(localRoot, { recursive: true });
    const { client, allArgvCalls, close } = await connect({ FAKE_AUTH_STATUS: "out", CLAUDE_MCP_LOCAL_ROOTS: localRoot });
    try {
      const started = Date.now();
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "signed out" },
      })) as CallToolResult;
      const error = errorBody(created).error;
      assert.equal(error.code, "CLI_NOT_SIGNED_IN");
      assert.match(error.message, /loggedIn false \(auth method: claude\.ai\)/);
      assert.match(error.message, /claude auth login/);
      assert.ok(Date.now() - started < 5_000);
      const local = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: localRoot, prompt: "signed out" },
      })) as CallToolResult;
      assert.equal(errorBody(local).error.code, "CLI_NOT_SIGNED_IN");
      assert.deepEqual(allArgvCalls(), [
        ["auth", "status"],
        ["auth", "status"],
      ], "neither --cloud nor -p ran");
    } finally {
      await close();
    }
  });

  it("checks sign-in once a minute, and lets work go ahead when auth status can't be read", async () => {
    const ok = await connect();
    try {
      for (const description of ["first", "second"]) {
        const result = (await ok.client.callTool({ name: "claude_create_cloud_session", arguments: { description } })) as CallToolResult;
        assert.notEqual(result.isError, true);
      }
      assert.deepEqual(ok.allArgvCalls(), [["auth", "status"], ["--cloud=first"], ["--cloud=second"]]);
    } finally {
      await ok.close();
    }
    const garbled = await connect({ FAKE_AUTH_STATUS: "garbled" });
    try {
      const result = (await garbled.client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "auth unreadable" },
      })) as CallToolResult;
      assert.notEqual(result.isError, true);
      assert.deepEqual(garbled.argvCalls(), [["--cloud=auth unreadable"]]);
    } finally {
      await garbled.close();
    }
  });
});

describe("claude_usage", () => {
  const usageArgs = ["-p", "--restricted", "--strict-mcp-config", "--output-format=stream-json", "--verbose", "--", "/usage"];

  interface UsageBody {
    checked_at: string;
    cached: boolean;
    parsed: boolean;
    windows: { kind: string; percent: number; resets_at: string | null; scope: string | null; is_active: boolean }[] | null;
    extra_usage: { is_enabled: boolean } | null;
    stop_percent: number | null;
    blocked_by: { kind: string; percent: number } | null;
    args: string[];
    cli: { exit_code: number | null; stdout: string; stderr: string };
  }

  it("reads plan usage with the restricted /usage argv, reuses it for 60 s, and refreshes on request", async () => {
    const { client, argvCalls, metaCalls, close } = await connect({ CLAUDE_MCP_REPO_CACHE: join(tmp, "usage-cache") });
    try {
      const first = (await client.callTool({ name: "claude_usage", arguments: {} })) as CallToolResult;
      assert.notEqual(first.isError, true);
      const body = first.structuredContent as unknown as UsageBody;
      assert.equal(body.parsed, true);
      assert.equal(body.cached, false);
      assert.ok(!Number.isNaN(Date.parse(body.checked_at)));
      assert.deepEqual(
        body.windows?.map((w) => [w.kind, w.percent, w.scope, w.is_active]),
        [
          ["session", 68, null, true],
          ["weekly_all", 10, null, false],
          ["weekly_scoped", 99, "Cowork", false],
        ],
      );
      assert.equal(body.windows?.[0]?.resets_at, "2026-11-02T22:10:00.474794+00:00");
      assert.equal(body.extra_usage?.is_enabled, false);
      assert.equal(body.stop_percent, null);
      assert.equal(body.blocked_by, null);
      assert.equal(body.cli.stdout, "", "the report's text and activity summary are not returned");
      assert.deepEqual(argvCalls(), [usageArgs]);
      assert.equal(metaCalls()[0]?.cwd, join(tmp, "usage-cache"));

      const second = (await client.callTool({ name: "claude_usage", arguments: {} })) as CallToolResult;
      assert.equal((second.structuredContent as unknown as UsageBody).cached, true);
      assert.equal(argvCalls().length, 1, "a reading under 60 s old is reused");

      const refreshed = (await client.callTool({ name: "claude_usage", arguments: { refresh: true } })) as CallToolResult;
      assert.equal((refreshed.structuredContent as unknown as UsageBody).cached, false);
      assert.equal(argvCalls().length, 2);
    } finally {
      await close();
    }
  });

  it("reports windows null when the CLI can't read usage, and an error when /usage fails", async () => {
    const unread = await connect({ FAKE_USAGE_MODE: "null" });
    try {
      const body = ((await unread.client.callTool({ name: "claude_usage", arguments: {} })) as CallToolResult)
        .structuredContent as unknown as UsageBody;
      assert.equal(body.parsed, true);
      assert.equal(body.windows, null);
    } finally {
      await unread.close();
    }
    const failing = await connect({ FAKE_USAGE_MODE: "fail" });
    try {
      const result = (await failing.client.callTool({ name: "claude_usage", arguments: {} })) as CallToolResult;
      assert.equal(errorBody(result).error.code, "CLI_EXIT_NONZERO");
    } finally {
      await failing.close();
    }
  });

  it("with CLAUDE_MCP_USAGE_STOP_PERCENT, refuses create and local runs at the limit without starting them", async () => {
    const localRoot = join(tmp, "usage-local");
    mkdirSync(localRoot, { recursive: true });
    const { client, argvCalls, close } = await connect({
      CLAUDE_MCP_USAGE_STOP_PERCENT: "60",
      CLAUDE_MCP_LOCAL_ROOTS: localRoot,
    });
    try {
      const created = (await client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "over budget" },
      })) as CallToolResult;
      const error = errorBody(created).error;
      assert.equal(error.code, "USAGE_LIMIT_NEAR");
      assert.match(error.message, /68% of the session window/);
      assert.match(error.message, /2026-11-02T22:10:00/);
      const local = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: localRoot, prompt: "over budget" },
      })) as CallToolResult;
      assert.equal(errorBody(local).error.code, "USAGE_LIMIT_NEAR");
      assert.deepEqual(argvCalls(), [usageArgs], "only /usage ran, once, from the cache");
      const usage = (await client.callTool({ name: "claude_usage", arguments: {} })) as CallToolResult;
      const body = usage.structuredContent as unknown as UsageBody;
      assert.equal(body.stop_percent, 60);
      assert.equal(body.blocked_by?.kind, "session");
    } finally {
      await close();
    }
  });

  it("lets work through below the limit, ignores scoped windows, and fails open when usage can't be read", async () => {
    // Session 68% and weekly 10% are under 90; the scoped Cowork window at 99% only reports.
    const under = await connect({ CLAUDE_MCP_USAGE_STOP_PERCENT: "90" });
    try {
      const created = (await under.client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "within budget" },
      })) as CallToolResult;
      assert.notEqual(created.isError, true);
      assert.deepEqual(under.argvCalls()[1], ["--cloud=within budget"]);
    } finally {
      await under.close();
    }
    const unknown = await connect({ CLAUDE_MCP_USAGE_STOP_PERCENT: "50", FAKE_USAGE_MODE: "fail" });
    try {
      const created = (await unknown.client.callTool({
        name: "claude_create_cloud_session",
        arguments: { description: "usage unknown" },
      })) as CallToolResult;
      assert.notEqual(created.isError, true);
      assert.deepEqual(unknown.argvCalls()[1], ["--cloud=usage unknown"]);
    } finally {
      await unknown.close();
    }
  });

  it("surfaces a local run's rate-limit event on the job", async () => {
    const localRoot = join(tmp, "usage-rate");
    mkdirSync(localRoot, { recursive: true });
    const { client, close } = await connect({ CLAUDE_MCP_LOCAL_ROOTS: localRoot, FAKE_LOCAL_RATE_LIMIT: "allowed_warning" });
    try {
      const started = (await client.callTool({
        name: "claude_run_local",
        arguments: { cwd: localRoot, prompt: "near the limit" },
      })) as CallToolResult;
      const done = await pollLocal(client, (started.structuredContent as { job_id: string }).job_id, (job) => job.status === "done");
      const body = (done.structuredContent as { local_job: { rate_limit: unknown } }).local_job;
      assert.deepEqual(body.rate_limit, { status: "allowed_warning", resets_at: 1793743800, utilization: 0.91, type: null });
    } finally {
      await close();
    }
  });
});
