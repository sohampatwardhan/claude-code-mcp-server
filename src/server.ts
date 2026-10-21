import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { authStatusArgv, createSessionArgv, sendFollowupArgv, teleportArgv } from "./argv.js";
import { ENVIRONMENT_ID_PATTERN, type Config } from "./config.js";
import { runCliPty, type PtyRunResult } from "./pty.js";
import {
  AuthParseError,
  SESSION_REF_PATTERN,
  cleanTerminalText,
  findSessionId,
  parseAuthStatus,
  parseCreateOutput,
  parseFollowupOutput,
  parseTeleportOutput,
} from "./parse.js";
import { RunError, runCli, type RunResult, type Runner } from "./runner.js";
import {
  BASE_BRANCH_PATTERN,
  GITHUB_REPO_ARG_PATTERN,
  REPO_ARG_PATTERN,
  PullRequestLookupError,
  RepoNotAllowedError,
  RepoPrepareError,
  classifyCreateRequest,
  lookupPullRequest,
  parseGithubRepoArg,
  readCheckedOutBranch,
  readSessionRecord,
  teleportDebugPath,
  withPreparedGithubRepo,
  writeSessionRecord,
  type GithubRepo,
} from "./repos.js";
import { claudeJsonPath, ensureWorkspaceTrusted, isTrustPrompt, resolveTrustProjectPath } from "./trust.js";

export const SERVER_NAME = "claude-code-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Below Linux's per-argument limit (MAX_ARG_STRLEN, 128 KiB). */
const MAX_TEXT_LENGTH = 100_000;

export const TOOL_NAMES = [
  "claude_create_cloud_session",
  "claude_send_followup",
  "claude_get_session",
  "claude_auth_status",
] as const;

export type ErrorCode =
  | "CLI_NOT_FOUND"
  | "CLI_SPAWN_FAILED"
  | "CLI_TIMEOUT"
  | "CLI_EXIT_NONZERO"
  | "OUTPUT_PARSE_FAILED"
  | "PTY_UNAVAILABLE"
  | "WORKSPACE_NOT_TRUSTED"
  | "REPO_NOT_ALLOWED"
  | "REPO_PREPARE_FAILED"
  | "SESSION_REPO_UNKNOWN";

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
    repo: z
      .string()
      .min(1)
      .max(4_096)
      .regex(REPO_ARG_PATTERN)
      .optional()
      .describe(
        "Repository this session packages. A github.com owner/name or https://github.com/owner/name URL (any repository the Claude GitHub app can access; cloned into CLAUDE_MCP_REPO_CACHE), or an absolute directory on CLAUDE_MCP_REPOS. Omit to use CLAUDE_MCP_CWD.",
      ),
    base_branch: z
      .string()
      .min(1)
      .max(255)
      .regex(BASE_BRANCH_PATTERN)
      .optional()
      .describe(
        "Branch the cloud VM should clone, for a github.com repo. The cache checkout is moved to this branch before claude --cloud. Omit to use the remote's default branch. Not applied to a local directory.",
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

const sessionInput = z
  .object({
    session: z
      .string()
      .max(2_000)
      .regex(SESSION_REF_PATTERN)
      .describe("Cloud session to read: a session id (session_... / cse_...) or a https://claude.ai/code/... URL."),
    repo: z
      .string()
      .min(1)
      .max(4_096)
      .regex(GITHUB_REPO_ARG_PATTERN)
      .optional()
      .describe(
        "github.com owner/name the session was started in. Omit when this server created the session with repo set; that repository is recorded in the cache.",
      ),
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
    .describe("CLI output with terminal control sequences removed.");

const createOutput = z
  .object({
    session_id: z.string().nullable(),
    session_url: z.string().nullable(),
    title: z.string().nullable(),
    parsed: z.boolean().describe("True when both session_id and session_url were parsed from CLI output."),
    environment_id: z.string().nullable(),
    cwd: z.string().describe("Directory the CLI ran in."),
    repo: z
      .string()
      .nullable()
      .describe("Normalized repository from the call, or null when the default directory was used."),
    base_branch: z
      .string()
      .nullable()
      .describe("Branch the GitHub cache checkout was on, or null when no GitHub repository was selected."),
    args: z.array(z.string()),
    cli: cliOutput,
  })
  .strict();

const sessionOutput = z
  .object({
    session_id: z.string(),
    repo: z.string().describe("github.com owner/name the status read used."),
    branch: z.string().nullable().describe("Branch the cloud session pushed, or null when none is checked out yet."),
    base_branch: z.string().nullable().describe("Branch the cache was reset to before teleport."),
    pr_number: z.number().int().nullable(),
    pr_url: z.string().nullable(),
    pr_source: z.enum(["output", "gh"]).nullable().describe("Where the pull request fields came from."),
    pr_error: z.string().nullable().describe("Set when gh could not look up a pull request. Null when there is no pull request."),
    parsed: z.boolean().describe("True when the pushed branch was identified."),
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
      result = await runner(config.claudeBin, args, config.timeoutMs, config.cwd);
    } catch (err) {
      if (err instanceof RunError) return toolError(err.code, err.message, args);
      throw err;
    }
    if (result.timedOut) {
      return toolError("CLI_TIMEOUT", `claude timed out after ${config.timeoutMs} ms`, args, result);
    }
    if (result.exitCode !== 0) {
      const how = result.exitCode === null ? `was killed by ${result.signal}` : `exited with code ${result.exitCode}`;
      const detail = outputDetail(result);
      return toolError("CLI_EXIT_NONZERO", `claude ${how}${detail ? `: ${detail}` : ""}`, args, result);
    }
    return result;
  }

  /**
   * `claude --cloud=<description>` exits immediately unless stdout is a
   * terminal. Run that argv on a pty. A workspace-trust dialog is refused
   * unless CLAUDE_MCP_TRUST_CWD is set, in which case Enter is sent once.
   */
  async function runCreate(args: string[], projectPath: string, cwd: string): Promise<PtyRunResult | CallToolResult> {
    let result: PtyRunResult;
    try {
      result = await runCliPty(config.claudeBin, args, config.timeoutMs, {
        pythonBin: config.pythonBin,
        cwd,
        onOutput: (output) => {
          if (!isTrustPrompt(output)) return "wait";
          return config.trustCwd ? "accept" : "refuse";
        },
      });
    } catch (err) {
      if (err instanceof RunError) return toolError(err.code, err.message, args);
      throw err;
    }
    if (result.trustPrompt === "refused" || (result.trustPrompt !== "accepted" && isTrustPrompt(result.stdout))) {
      return toolError("WORKSPACE_NOT_TRUSTED", trustMessage(projectPath), args, result);
    }
    if (result.timedOut) {
      return toolError("CLI_TIMEOUT", `claude timed out after ${config.timeoutMs} ms`, args, result);
    }
    if (result.exitCode === 127 && cleanTerminalText(result.stdout).includes("claude binary not found:")) {
      return toolError(
        "CLI_NOT_FOUND",
        `claude binary not found: ${config.claudeBin} (set CLAUDE_BIN)`,
        args,
        result,
      );
    }
    if (result.exitCode !== 0) {
      const how = result.exitCode === null ? `was killed by ${result.signal}` : `exited with code ${result.exitCode}`;
      const detail = outputDetail(result);
      return toolError("CLI_EXIT_NONZERO", `claude ${how}${detail ? `: ${detail}` : ""}`, args, result);
    }
    return result;
  }

  server.registerTool(
    "claude_create_cloud_session",
    {
      title: "Create Claude Code cloud session",
      description:
        "Create a new Claude Code cloud session via `claude --cloud` on a pseudo-terminal (the CLI rejects " +
        "this form when stdout is a pipe). Returns the parsed session_id and session_url. If parsing fails, " +
        "`parsed` is false and the CLI output, with terminal controls removed, is in `cli`. A github.com " +
        "`repo` is cloned into CLAUDE_MCP_REPO_CACHE (origin set to that GitHub repository) and, when " +
        "`base_branch` is set, checked out there before the CLI runs. Any other absolute directory must be " +
        "on CLAUDE_MCP_REPOS. Omit `repo` to use CLAUDE_MCP_CWD. When Claude Code asks to trust the chosen " +
        "folder, the call fails with WORKSPACE_NOT_TRUSTED unless CLAUDE_MCP_TRUST_CWD=1. The cloud VM's " +
        "clone, push, and pull request use the Claude GitHub app (or /web-setup), not this server.",
      inputSchema: createInput,
      outputSchema: createOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ description, environment_id, repo, base_branch }) => {
      const environmentId = environment_id ?? config.defaultEnvironmentId;
      let plan;
      try {
        plan = classifyCreateRequest({
          requested: repo,
          baseBranch: base_branch,
          defaultCwd: config.cwd,
          allowlist: config.repos,
        });
      } catch (err) {
        if (err instanceof RepoNotAllowedError) return toolError("REPO_NOT_ALLOWED", err.message, []);
        if (err instanceof RepoPrepareError) return toolError("REPO_PREPARE_FAILED", err.message, []);
        throw err;
      }
      try {
        if (plan.kind === "github") {
          const github = plan.github;
          return await withPreparedGithubRepo(
            config.repoCache,
            github.owner,
            github.name,
            config.timeoutMs,
            plan.baseBranch,
            (cwd, branch) => finishCreate(description, environmentId, cwd, github.slug, branch, github),
          );
        }
        return await finishCreate(description, environmentId, plan.cwd, plan.kind === "path" ? plan.repo : null, null, null);
      } catch (err) {
        if (err instanceof RepoPrepareError) return toolError("REPO_PREPARE_FAILED", err.message, []);
        throw err;
      }
    },
  );

  async function finishCreate(
    description: string,
    environmentId: string | null,
    cwd: string,
    repo: string | null,
    baseBranch: string | null,
    github: GithubRepo | null,
  ): Promise<CallToolResult> {
    const args = createSessionArgv(description, environmentId);
    const projectPath = await resolveTrustProjectPath(cwd);
    if (config.trustCwd) {
      try {
        // Pre-accept trust for this one directory so the dialog usually never
        // appears. A corrupt ~/.claude.json is left alone; the pty path can
        // still answer the dialog because the opt-in is set.
        await ensureWorkspaceTrusted(claudeJsonPath(), projectPath);
      } catch {
        // Keystroke fallback below covers a dialog the file edit did not prevent.
      }
    }
    const result = await runCreate(args, projectPath, cwd);
    if (!isRunResult(result)) return result;
    const parsed = parseCreateOutput(result.stdout);
    if (github !== null && parsed.parsed && parsed.session_id !== null) {
      try {
        await writeSessionRecord(config.repoCache, {
          session_id: parsed.session_id,
          repo: github.slug,
          owner: github.owner,
          name: github.name,
          base_branch: baseBranch,
        });
      } catch {
        // The session exists. Status can still be called with an explicit repo.
      }
    }
    return ok({
      ...parsed,
      environment_id: environmentId,
      cwd,
      repo,
      base_branch: baseBranch,
      args,
      cli: cli(result),
    });
  }

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
    "claude_get_session",
    {
      title: "Cloud session GitHub status",
      description:
        "Report the branch a cloud session pushed and any pull request it opened. Prepares the github.com " +
        "checkout in CLAUDE_MCP_REPO_CACHE (origin set to that repository), then runs print-mode " +
        "`claude --teleport=<session> --debug` there and stops when the CLI exits. Print mode checks out " +
        "the session branch and exits; it is not given a prompt and it is not started on a terminal, so it " +
        "does not continue as a local interactive session. The branch is taken from the debug line " +
        "`Branch after checkout` when that matches HEAD, otherwise from a HEAD move. The pull request number " +
        "and URL come from that output when present, otherwise from a read-only `gh pr list`. Claude's GitHub " +
        "app (or /web-setup) is what pushes the branch and opens the pull request; this tool only reads them.",
      inputSchema: sessionInput,
      outputSchema: sessionOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ session, repo }) => {
      const sessionId = sessionIdOf(session);
      if (sessionId === null) {
        return toolError("OUTPUT_PARSE_FAILED", `Could not read a session id from ${JSON.stringify(session)}.`, []);
      }
      const record = await readSessionRecord(config.repoCache, sessionId);
      let github: GithubRepo | null = null;
      let baseBranch: string | null = null;
      if (repo !== undefined) {
        github = parseGithubRepoArg(repo);
        if (github === null) {
          return toolError("REPO_NOT_ALLOWED", `Repository ${JSON.stringify(repo)} is not a github.com owner/name.`, []);
        }
        if (record !== null && record.repo === github.slug) baseBranch = record.base_branch;
      } else if (record !== null) {
        github = { kind: "github", slug: record.repo, owner: record.owner, name: record.name };
        baseBranch = record.base_branch;
      }
      if (github === null) {
        return toolError(
          "SESSION_REPO_UNKNOWN",
          "No GitHub repository is recorded for this session. Pass repo as owner/name. A repository is recorded when claude_create_cloud_session is called with a github.com repo.",
          [],
        );
      }
      const target = github;
      try {
        return await withPreparedGithubRepo(
          config.repoCache,
          target.owner,
          target.name,
          config.timeoutMs,
          baseBranch,
          (cwd, checkedOut) => readSessionStatus(sessionId, target, cwd, checkedOut),
        );
      } catch (err) {
        if (err instanceof RepoPrepareError) return toolError("REPO_PREPARE_FAILED", err.message, []);
        throw err;
      }
    },
  );

  async function readSessionStatus(
    sessionId: string,
    github: GithubRepo,
    cwd: string,
    checkedOut: string,
  ): Promise<CallToolResult> {
    const debugFile = teleportDebugPath(config.repoCache, sessionId);
    await mkdir(dirname(debugFile), { recursive: true });
    await rm(debugFile, { force: true }).catch(() => undefined);
    const args = teleportArgv(sessionId, debugFile);
    let result: RunResult;
    try {
      result = await runner(config.claudeBin, args, config.timeoutMs, cwd);
    } catch (err) {
      if (err instanceof RunError) return toolError(err.code, err.message, args);
      throw err;
    }
    if (result.timedOut) {
      return toolError("CLI_TIMEOUT", `claude timed out after ${config.timeoutMs} ms`, args, result);
    }
    let debugText = "";
    try {
      const buf = await readFile(debugFile);
      debugText = buf.subarray(0, 64_000).toString("utf8");
    } catch {
      debugText = "";
    }
    const parsed = parseTeleportOutput(`${result.stdout}\n${result.stderr}\n${debugText}`, github);
    const head = await readCheckedOutBranch(cwd, config.timeoutMs);
    let branch: string | null = null;
    if (parsed.branch !== null && head === parsed.branch) branch = parsed.branch;
    else if (head !== null && head !== checkedOut) branch = head;

    let prNumber = parsed.pr_number;
    let prUrl = parsed.pr_url;
    let prSource: "output" | "gh" | null = prUrl !== null ? "output" : null;
    let prError: string | null = null;
    if (prUrl === null && branch !== null) {
      try {
        const pr = await lookupPullRequest(github.owner, github.name, branch, config.timeoutMs, cwd);
        if (pr !== null) {
          prNumber = pr.number;
          prUrl = pr.url;
          prSource = "gh";
        }
      } catch (err) {
        if (err instanceof PullRequestLookupError) prError = err.message;
        else throw err;
      }
    }
    if (branch === null && result.exitCode !== 0) {
      const how = result.exitCode === null ? `was killed by ${result.signal}` : `exited with code ${result.exitCode}`;
      const detail = parsed.notes.find((line) => line.startsWith("Teleport")) ?? outputDetail(result);
      return toolError("CLI_EXIT_NONZERO", `claude ${how}${detail ? `: ${detail}` : ""}`, args, {
        ...result,
        stderr: [result.stderr, ...parsed.notes].filter((line) => line !== "").join("\n"),
      });
    }
    const stderr = [cleanTerminalText(result.stderr).trim(), ...parsed.notes].filter((line) => line !== "").join("\n");
    return ok({
      session_id: sessionId,
      repo: github.slug,
      branch,
      base_branch: checkedOut,
      pr_number: prNumber,
      pr_url: prUrl,
      pr_source: prSource,
      pr_error: prError,
      parsed: branch !== null,
      args,
      cli: { exit_code: result.exitCode, stdout: cleanTerminalText(result.stdout), stderr },
    });
  }

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

function trustMessage(projectPath: string): string {
  const shown = JSON.stringify(projectPath);
  return (
    `Claude Code asked to trust ${projectPath} before creating a cloud session. ` +
    `Set CLAUDE_MCP_TRUST_CWD=1 to let this server accept that dialog for the directory this session is created from ` +
    `(the GitHub cache checkout when the call names a github.com repository, the allowlisted directory when the call names one, otherwise CLAUDE_MCP_CWD or the server process working directory; the main git checkout when that directory is a repository or worktree). ` +
    `Accepting trust lets that folder's project hooks and allow rules run. ` +
    `To trust it yourself, accept the dialog in an interactive claude session, or set ` +
    `projects[${shown}].hasTrustDialogAccepted to true in ~/.claude.json.`
  );
}

function isRunResult(value: RunResult | PtyRunResult | CallToolResult): value is RunResult {
  return "timedOut" in value;
}

function outputDetail(result: RunResult): string {
  return cleanTerminalText(result.stderr).trim() || cleanTerminalText(result.stdout).trim();
}

function cli(result: RunResult) {
  return {
    exit_code: result.exitCode,
    stdout: cleanTerminalText(result.stdout),
    stderr: cleanTerminalText(result.stderr),
  };
}

function sessionIdOf(session: string): string | null {
  if (/^(?:session|cse)_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session)) return session;
  const id = findSessionId(session);
  return id !== null && /^(?:session|cse)_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? id : null;
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
