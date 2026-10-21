import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { authStatusArgv, createSessionArgv, sendFollowupArgv } from "./argv.js";
import { ENVIRONMENT_ID_PATTERN, type Config } from "./config.js";
import {
  AuthParseError,
  SESSION_REF_PATTERN,
  parseAuthStatus,
  parseCreateOutput,
  parseFollowupOutput,
} from "./parse.js";
import { RunError, runCli, type RunResult, type Runner } from "./runner.js";

export const SERVER_NAME = "claude-code-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Below Linux's per-argument limit (MAX_ARG_STRLEN, 128 KiB). */
const MAX_TEXT_LENGTH = 100_000;

export const TOOL_NAMES = ["claude_create_cloud_session", "claude_send_followup", "claude_auth_status"] as const;

export type ErrorCode =
  | "CLI_NOT_FOUND"
  | "CLI_SPAWN_FAILED"
  | "CLI_TIMEOUT"
  | "CLI_EXIT_NONZERO"
  | "OUTPUT_PARSE_FAILED";

// ---- schemas -------------------------------------------------------------

const text = (what: string) =>
  z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .regex(/\S/, `${what} must contain a non-whitespace character`);

const createInput = z
  .object({
    description: text("description").describe("Task description for the new cloud session."),
    environment_id: z
      .string()
      .max(200)
      .regex(ENVIRONMENT_ID_PATTERN)
      .optional()
      .describe(
        "Cloud environment id (e.g. ccpool_...). Overrides CLAUDE_CLOUD_ENVIRONMENT_ID; omit to use that default.",
      ),
  })
  .strict();

const followupInput = z
  .object({
    session: z
      .string()
      .max(2_000)
      .regex(SESSION_REF_PATTERN)
      .describe("Target cloud session: a session id (session_... / cse_...) or a https://claude.ai/code/... URL."),
    message: text("message").describe("Message to queue into the session."),
  })
  .strict();

const authInput = z.object({}).strict();

const cliOutput = z
  .object({
    exit_code: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict()
  .describe("Raw CLI output, for diagnostics only.");

const createOutput = z
  .object({
    session_id: z.string().nullable(),
    session_url: z.string().nullable(),
    title: z.string().nullable(),
    parsed: z.boolean().describe("True when both session_id and session_url were parsed from CLI output."),
    environment_id: z.string().nullable(),
    args: z.array(z.string()),
    cli: cliOutput,
  })
  .strict();

const followupOutput = z
  .object({
    session: z.string(),
    session_id: z.string().nullable(),
    session_url: z.string().nullable(),
    sent: z.boolean().describe("True when the CLI confirmed the message was sent."),
    parsed: z.boolean().describe("True when both session_id and session_url were parsed from CLI output."),
    args: z.array(z.string()),
    cli: cliOutput,
  })
  .strict();

const authOutput = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().nullable(),
    email: z.string().nullable(),
    orgName: z.string().nullable(),
    subscriptionType: z.string().nullable(),
    cli: cliOutput,
  })
  .strict();

// ---- server --------------------------------------------------------------

export function createServer(config: Config, runner: Runner = runCli): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** Runs the CLI; returns the result on exit 0, otherwise a tool error. */
  async function run(args: string[]): Promise<RunResult | CallToolResult> {
    let result: RunResult;
    try {
      result = await runner(config.claudeBin, args, config.timeoutMs);
    } catch (err) {
      if (err instanceof RunError) return toolError(err.code, err.message, args);
      throw err;
    }
    if (result.timedOut) {
      return toolError("CLI_TIMEOUT", `claude timed out after ${config.timeoutMs} ms`, args, result);
    }
    if (result.exitCode !== 0) {
      const how = result.exitCode === null ? `was killed by ${result.signal}` : `exited with code ${result.exitCode}`;
      const detail = result.stderr.trim() || result.stdout.trim();
      return toolError("CLI_EXIT_NONZERO", `claude ${how}${detail ? `: ${detail}` : ""}`, args, result);
    }
    return result;
  }

  server.registerTool(
    "claude_create_cloud_session",
    {
      title: "Create Claude Code cloud session",
      description:
        "Create a new Claude Code cloud session via `claude --cloud`. Returns the parsed session_id and " +
        "session_url. If parsing fails, `parsed` is false and the raw CLI output is in `cli`.",
      inputSchema: createInput,
      outputSchema: createOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ description, environment_id }) => {
      const environmentId = environment_id ?? config.defaultEnvironmentId;
      const args = createSessionArgv(description, environmentId);
      const result = await run(args);
      if (!isRunResult(result)) return result;
      const parsed = parseCreateOutput(result.stdout);
      return ok({ ...parsed, environment_id: environmentId, args, cli: cli(result) });
    },
  );

  server.registerTool(
    "claude_send_followup",
    {
      title: "Send follow-up to Claude Code cloud session",
      description:
        "Queue a follow-up message into an existing Claude Code cloud session via " +
        "`claude --cloud <session> -p <message>`.",
      inputSchema: followupInput,
      outputSchema: followupOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ session, message }) => {
      const args = sendFollowupArgv(session, message);
      const result = await run(args);
      if (!isRunResult(result)) return result;
      const parsed = parseFollowupOutput(result.stdout);
      return ok({ session, ...parsed, args, cli: cli(result) });
    },
  );

  server.registerTool(
    "claude_auth_status",
    {
      title: "Claude Code auth status",
      description: "Report whether the local Claude Code CLI is signed in, via `claude auth status`.",
      inputSchema: authInput,
      outputSchema: authOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const args = authStatusArgv();
      const result = await run(args);
      if (!isRunResult(result)) return result;
      try {
        return ok({ ...parseAuthStatus(result.stdout), cli: cli(result) });
      } catch (err) {
        if (err instanceof AuthParseError) return toolError("OUTPUT_PARSE_FAILED", err.message, args, result);
        throw err;
      }
    },
  );

  return server;
}

// ---- result helpers ------------------------------------------------------

function isRunResult(value: RunResult | CallToolResult): value is RunResult {
  return "timedOut" in value;
}

function cli(result: RunResult) {
  return { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** Tool errors carry a JSON body with a stable shape: `{ error: { code, message, args, cli } }`. */
function toolError(code: ErrorCode, message: string, args: string[], result?: RunResult): CallToolResult {
  const body = { error: { code, message, args, cli: result ? cli(result) : null } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}
