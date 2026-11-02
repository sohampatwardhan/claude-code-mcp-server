import { readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { authStatusArgv, createSessionArgv, sendFollowupArgv, teleportArgv } from "./argv.js";
import { KILL_GRACE_MS, Scope, abortOnSignal, runInScope } from "./children.js";
import { ENVIRONMENT_ID_PATTERN, type Config } from "./config.js";
import { JOB_ID_PATTERN, JobStore, settleWithin, type Job, type JobStatus } from "./jobs.js";
import { cliNotFoundMessage, isSignInError, signInMessage } from "./prereq.js";
import { normalizePtyText, runCliPty, type PtyRunResult } from "./pty.js";
import {
  AuthParseError,
  SESSION_REF_PATTERN,
  cleanTerminalText,
  findSessionId,
  parseAuthStatus,
  parseCreateOutput,
  parseFollowupOutput,
  parseTeleportOutput,
  type ParsedCreate,
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
  githubCacheDir,
  lookupPullRequest,
  parseGithubRepoArg,
  readCheckedOutBranch,
  readSessionRecord,
  teleportDebugPath,
  withPreparedGithubRepo,
  writeSessionRecord,
  type CreatePlan,
  type GithubRepo,
} from "./repos.js";
import { claudeJsonPath, ensureWorkspaceTrusted, isTrustPrompt, resolveTrustProjectPath } from "./trust.js";

export const SERVER_NAME = "claude-code-mcp-server";
/** The package version, read from package.json so serverInfo matches the installed release. */
export const SERVER_VERSION = readPackageVersion();

/** Where calling agents report problems with this server. */
export const ISSUES_URL = "https://github.com/sohampatwardhan/claude-code-mcp-server/issues";

/**
 * Guidance for calling agents on reporting problems with this server. Part
 * of SERVER_INSTRUCTIONS; the README carries the same text for clients that
 * don't pass server instructions to the model.
 */
export const ISSUE_REPORTING =
  `Report problems with this server as GitHub issues at ${ISSUES_URL}, using your own GitHub access. ` +
  "Report a tool result that looks wrong for what happened: an error code that doesn't fit, an unexpected " +
  "CLI_EXIT_NONZERO or CLI_TIMEOUT, parsed false on output that did name a session, a job that never " +
  "finishes, or a CLI prompt or message the server didn't recognise. Search open issues first and comment " +
  "on a match instead of opening a duplicate. Title it `fix: <what went wrong>` (or `feat: <what is " +
  "missing>`), and include the tool name and arguments, the error code and message, cli.exit_code and the " +
  "relevant lines of cli.stdout and cli.stderr, the server version from serverInfo, the host OS, what you " +
  "expected, and whether it happens again. Before posting, remove tokens, credentials, email addresses, " +
  "and private repository names, paths and code; the issue tracker is public. Don't file issues for " +
  "problems in the session's own work (failing tests, a wrong change), or for an error whose message " +
  "already says what to do (CLI_NOT_FOUND, CLI_NOT_SIGNED_IN, WORKSPACE_NOT_TRUSTED, REPO_NOT_ALLOWED) " +
  "unless doing that didn't help.";

/** Server-level guidance sent to clients in the initialize result. */
export const SERVER_INSTRUCTIONS =
  "Starts and drives Claude Code cloud sessions. Requires the Claude Code CLI on this machine, installed with " +
  "`npm install -g @anthropic-ai/claude-code` and signed in by running `claude` once (claude_auth_status checks " +
  "this). CLI_NOT_FOUND and CLI_NOT_SIGNED_IN errors say which step is missing.\n\n" +
  "claude_create_cloud_session returns within a few seconds. When its status is not `done`, the session is " +
  "still being prepared in the background: call claude_get_session with the returned job_id every few seconds " +
  "until job.status is `done` (session_id and session_url are then set) or the call returns an error. Job ids " +
  "are kept in this server's memory only. claude_cancel_session stops a job that is stuck; it stops only " +
  "processes on this machine, and a cloud session that was already created keeps running.\n\n" +
  "Check results with claude_get_session, which reports the " +
  "branch a session pushed and any pull request it opened; the conversation and replies are only visible at " +
  "the session's session_url.\n\n" +
  "If a cloud session can't push its branch to GitHub (claude_get_session finds no branch, or the session " +
  "says the push failed), don't wait for it to retry. Use claude_send_followup to ask it to print its changes " +
  "as a patch: preferably `git format-patch origin/<base>..HEAD --stdout` against the base branch, otherwise " +
  "a full unified `git diff` that includes new files. Copy the patch from the session_url, apply it to your " +
  "own checkout (`git am`, or `git apply --3way`), run the tests, then commit, push and open or update the " +
  "pull request yourself.\n\n" +
  ISSUE_REPORTING;

/** Below Linux's per-argument limit (MAX_ARG_STRLEN, 128 KiB). */
const MAX_TEXT_LENGTH = 100_000;
/**
 * How long create waits for its job before returning a job id. Well under
 * the 60 s request timeout MCP clients default to.
 */
const CREATE_WAIT_MS = 2_000;
/** Characters of cleaned CLI output a running job reports. */
const OUTPUT_TAIL_CHARS = 4_000;
/** Raw CLI output kept per job, to bound memory. Mirrors the pty cap. */
const MAX_JOB_OUTPUT_CHARS = 4 * 1024 * 1024;

/** `session` for claude_get_session: a session ref or a create job id. */
const SESSION_OR_JOB_PATTERN = new RegExp(`(?:${SESSION_REF_PATTERN.source})|(?:${JOB_ID_PATTERN.source})`);

export const TOOL_NAMES = [
  "claude_create_cloud_session",
  "claude_send_followup",
  "claude_get_session",
  "claude_cancel_session",
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
  | "SESSION_REPO_UNKNOWN"
  | "CLI_NOT_SIGNED_IN"
  | "JOB_NOT_FOUND";

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
    timeout_s: z
      .number()
      .int()
      .min(1)
      .max(86_400)
      .optional()
      .describe("Per-process time limit for this create's git steps and claude --cloud, in seconds. Omit to use CLAUDE_MCP_TIMEOUT_MS."),
    idle_timeout_s: z
      .number()
      .int()
      .min(1)
      .max(86_400)
      .optional()
      .describe(
        "Stop claude --cloud when it prints nothing for this many seconds. Omit to use CLAUDE_MCP_IDLE_TIMEOUT_MS (off when unset).",
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
      .regex(SESSION_OR_JOB_PATTERN)
      .describe(
        "What to read: a job id (job_...) returned by claude_create_cloud_session, or a cloud session id (session_... / cse_...) or https://claude.ai/code/... URL.",
      ),
    repo: z
      .string()
      .min(1)
      .max(4_096)
      .regex(GITHUB_REPO_ARG_PATTERN)
      .optional()
      .describe(
        "github.com owner/name the session was started in. Omit when this server created the session with repo set; that repository is recorded in the cache. Ignored for a job id.",
      ),
  })
  .strict();

const cancelInput = z
  .object({
    session: z
      .string()
      .max(2_000)
      .regex(SESSION_OR_JOB_PATTERN)
      .describe(
        "Create job to stop: its job id (job_...), or the session id (session_... / cse_...) or https://claude.ai/code/... URL an unfinished job printed.",
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
    job_id: z.string().describe("Background job for this create. Pass it to claude_get_session until status is done."),
    status: z
      .enum(["cloning", "starting", "running", "done", "cancelled"])
      .describe(
        "cloning: preparing the GitHub cache checkout. starting: claude --cloud is running and has not printed a session yet. running: the session id was printed and the CLI has not exited. done: the CLI exited and the result below is final. cancelled: claude_cancel_session stopped the job; a session it already printed keeps running in the cloud.",
      ),
    elapsed_ms: z.number().int().describe("Time since the job started, or its total duration once done."),
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
    cache: z
      .object({
        cloned: z
          .boolean()
          .describe("True when this job made a fresh partial clone; false when it reused the existing cache with git fetch."),
        duration_ms: z
          .number()
          .int()
          .describe("Time spent on the clone or fetch, checkout and clean, not counting a wait for another job's lock."),
      })
      .strict()
      .nullable()
      .describe("How the GitHub cache checkout was prepared. Null until it is ready, and for a local or default directory."),
    args: z.array(z.string()),
    cli: cliOutput.describe(
      "CLI output with terminal control sequences removed. Until status is done, exit_code is null and stdout holds the last 4,000 characters so far.",
    ),
  })
  .strict();

const sessionOutput = z
  .object({
    job: createOutput
      .nullable()
      .describe("Set when `session` was a job id: that create's progress or result. The other fields are then null, false or empty."),
    session_id: z.string().nullable(),
    repo: z.string().nullable().describe("github.com owner/name the status read used."),
    branch: z.string().nullable().describe("Branch the cloud session pushed, or null when none is checked out yet."),
    base_branch: z.string().nullable().describe("Branch the cache was reset to before teleport."),
    pr_number: z.number().int().nullable(),
    pr_url: z.string().nullable(),
    pr_source: z.enum(["output", "gh"]).nullable().describe("Where the pull request fields came from."),
    pr_error: z.string().nullable().describe("Set when gh could not look up a pull request. Null when there is no pull request."),
    parsed: z.boolean().describe("True when the pushed branch was identified."),
    args: z.array(z.string()),
    cli: cliOutput.nullable(),
  })
  .strict();

const cancelOutput = z
  .object({
    job: createOutput.describe("The job after this call."),
    cancelled: z
      .boolean()
      .describe("True when this call cancelled the job. False when it had already finished or been cancelled."),
    stopped: z.boolean().describe("True when every process the job started has exited."),
  })
  .strict();

type CreateBody = z.infer<typeof createOutput>;

/** Fixed fields of one create job. `cwd`, `baseBranch` and `cache` are updated once the cache checkout is ready. */
interface CreateJob {
  args: string[];
  environmentId: string | null;
  cwd: string;
  repo: string | null;
  baseBranch: string | null;
  cache: CreateBody["cache"];
  /** Every process the job starts, so a cancel can stop them. */
  scope: Scope;
  timeoutMs: number;
  idleTimeoutMs: number | null;
}

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
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const jobs = new JobStore<CreateJob>();

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
      return exitError(result, args);
    }
    return result;
  }

  /**
   * `claude --cloud=<description>` exits immediately unless stdout is a
   * terminal. Run that argv on a pty. A workspace-trust dialog is refused
   * unless CLAUDE_MCP_TRUST_CWD is set, in which case Enter is sent once.
   */
  async function runCreate(
    args: string[],
    projectPath: string,
    cwd: string,
    limits: { timeoutMs: number; idleTimeoutMs: number | null },
    onProgress: (chunk: string) => void,
  ): Promise<PtyRunResult | CallToolResult> {
    let result: PtyRunResult;
    try {
      result = await runCliPty(config.claudeBin, args, limits.timeoutMs, {
        pythonBin: config.pythonBin,
        cwd,
        idleTimeoutMs: limits.idleTimeoutMs,
        onProgress,
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
      return toolError("CLI_TIMEOUT", `claude timed out after ${limits.timeoutMs} ms`, args, result);
    }
    if (result.idleTimedOut) {
      return toolError("CLI_TIMEOUT", `claude printed nothing for ${limits.idleTimeoutMs ?? 0} ms and was stopped`, args, result);
    }
    if (result.exitCode === 127 && cleanTerminalText(result.stdout).includes("claude binary not found:")) {
      return toolError(
        "CLI_NOT_FOUND",
        cliNotFoundMessage(config.claudeBin),
        args,
        result,
      );
    }
    if (result.exitCode !== 0) {
      return exitError(result, args);
    }
    return result;
  }

  server.registerTool(
    "claude_create_cloud_session",
    {
      title: "Create Claude Code cloud session",
      description:
        "Create a new Claude Code cloud session via `claude --cloud` on a pseudo-terminal (the CLI rejects " +
        "this form when stdout is a pipe). The work runs as a background job and this call returns within a " +
        "few seconds. If `status` is `done`, the result is final: the parsed session_id and session_url, or, " +
        "when parsing fails, `parsed` false and the CLI output (terminal controls removed) in `cli`. Otherwise " +
        "poll claude_get_session with `job_id` until `job.status` is `done` or the call returns an error; " +
        "failures surface there with the same error codes. A github.com " +
        "`repo` is cloned into CLAUDE_MCP_REPO_CACHE (origin set to that GitHub repository) and, when " +
        "`base_branch` is set, checked out there before the CLI runs. Any other absolute directory must be " +
        "on CLAUDE_MCP_REPOS. Omit `repo` to use CLAUDE_MCP_CWD. When Claude Code asks to trust the chosen " +
        "folder, the call fails with WORKSPACE_NOT_TRUSTED unless CLAUDE_MCP_TRUST_CWD=1. The cloud VM's " +
        "clone, push, and pull request use the Claude GitHub app (or /web-setup), not this server. " +
        "If the session later can't push its branch to GitHub, ask it via claude_send_followup for a " +
        "`git format-patch` (or full `git diff`) of its changes and apply, test, push and open the PR yourself.",
      inputSchema: createInput,
      outputSchema: createOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ description, environment_id, repo, base_branch, timeout_s, idle_timeout_s }, extra) => {
      const environmentId = environment_id ?? config.defaultEnvironmentId;
      let plan: CreatePlan;
      let cwd: string;
      try {
        plan = classifyCreateRequest({
          requested: repo,
          baseBranch: base_branch,
          defaultCwd: config.cwd,
          allowlist: config.repos,
        });
        cwd = plan.kind === "github" ? githubCacheDir(config.repoCache, plan.github.owner, plan.github.name) : plan.cwd;
      } catch (err) {
        if (err instanceof RepoNotAllowedError) return toolError("REPO_NOT_ALLOWED", err.message, []);
        if (err instanceof RepoPrepareError) return toolError("REPO_PREPARE_FAILED", err.message, []);
        throw err;
      }
      const details: CreateJob = {
        args: createSessionArgv(description, environmentId),
        environmentId,
        cwd,
        repo: plan.kind === "github" ? plan.github.slug : plan.kind === "path" ? plan.repo : null,
        baseBranch: plan.kind === "github" ? plan.baseBranch : null,
        cache: null,
        scope: new Scope(),
        timeoutMs: timeout_s === undefined ? config.timeoutMs : timeout_s * 1_000,
        idleTimeoutMs: idle_timeout_s === undefined ? config.idleTimeoutMs : idle_timeout_s * 1_000,
      };
      const target = plan;
      const job = jobs.start(details, plan.kind === "github" ? "cloning" : "starting", (started) =>
        runInScope(started.details.scope, () => runCreateJob(started, target)),
      );
      // A caller that cancels this request never learns the job id, so the job goes with it.
      const onAbort = () => cancelJob(job);
      extra.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await settleWithin(job, CREATE_WAIT_MS);
      } finally {
        extra.signal.removeEventListener("abort", onAbort);
      }
      const body = jobBody(job);
      return isCreateBody(body) ? ok(body) : body;
    },
  );

  /** Clone (for GitHub), then run `claude --cloud`. Settles with the final tool result. */
  async function runCreateJob(job: Job<CreateJob>, plan: CreatePlan): Promise<CallToolResult> {
    try {
      if (plan.kind === "github") {
        const github = plan.github;
        return await withPreparedGithubRepo(
          config.repoCache,
          github.owner,
          github.name,
          job.details.timeoutMs,
          plan.baseBranch,
          (cwd, checkout) => {
            job.details.cwd = cwd;
            job.details.baseBranch = checkout.branch;
            job.details.cache = { cloned: checkout.cloned, duration_ms: checkout.durationMs };
            return finishCreate(job, github);
          },
        );
      }
      return await finishCreate(job, null);
    } catch (err) {
      if (err instanceof RepoPrepareError) return toolError("REPO_PREPARE_FAILED", err.message, []);
      throw err;
    }
  }

  async function finishCreate(job: Job<CreateJob>, github: GithubRepo | null): Promise<CallToolResult> {
    const { args, cwd, baseBranch, timeoutMs, idleTimeoutMs } = job.details;
    jobs.advance(job, "starting");
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
    const result = await runCreate(args, projectPath, cwd, { timeoutMs, idleTimeoutMs }, (chunk) => {
      if (job.output.length < MAX_JOB_OUTPUT_CHARS) job.output += chunk;
    });
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
    return ok(createBody(job, "done", parsed, cli(result)));
  }

  /** Cancel `job` and stop its processes. Returns false when it had already finished or been cancelled. */
  function cancelJob(job: Job<CreateJob>): boolean {
    if (!jobs.cancel(job)) return false;
    job.details.scope.abort();
    return true;
  }

  function createBody(job: Job<CreateJob>, status: JobStatus, parsed: ParsedCreate, output: CreateBody["cli"]): CreateBody {
    const { args, environmentId, cwd, repo, baseBranch, cache } = job.details;
    return {
      job_id: job.id,
      status,
      elapsed_ms: jobs.elapsedMs(job),
      ...parsed,
      environment_id: environmentId,
      cwd,
      repo,
      base_branch: baseBranch,
      cache,
      args,
      cli: output,
    };
  }

  /** Progress of a job that has not settled: parsed fields and the tail of the output so far. */
  function pendingBody(job: Job<CreateJob>): CreateBody {
    const text = normalizePtyText(job.output);
    const parsed = parseCreateOutput(text);
    const status = job.status === "starting" && parsed.session_id !== null ? "running" : job.status;
    const cleaned = cleanTerminalText(text);
    return createBody(job, status, parsed, {
      exit_code: null,
      stdout: cleaned.length > OUTPUT_TAIL_CHARS ? cleaned.slice(-OUTPUT_TAIL_CHARS) : cleaned,
      stderr: "",
    });
  }

  /**
   * What a job reports now: progress while it runs or once cancelled, its
   * final body when done, or its tool error when it failed.
   */
  function jobBody(job: Job<CreateJob>): CreateBody | CallToolResult {
    if (job.status === "cancelled") return pendingBody(job);
    if (job.failure !== null) throw job.failure.error;
    if (job.result !== null && job.result.isError === true) return job.result;
    return job.result !== null ? (job.result.structuredContent as CreateBody) : pendingBody(job);
  }

  function jobNotFound(what: string): CallToolResult {
    return toolError(
      "JOB_NOT_FOUND",
      `No create job ${what} on this server. Jobs live in memory, are dropped an hour after they finish, and are lost when the server restarts. Use the session_id from a finished job, or create the session again.`,
      [],
    );
  }

  /** claude_get_session for a job id: progress, the final result, or the job's tool error. */
  function readJob(id: string): CallToolResult {
    const job = jobs.get(id);
    if (job === null) return jobNotFound(id);
    const body = jobBody(job);
    if (!isCreateBody(body)) return body;
    return ok({
      job: body,
      session_id: body.session_id,
      repo: null,
      branch: null,
      base_branch: null,
      pr_number: null,
      pr_url: null,
      pr_source: null,
      pr_error: null,
      parsed: false,
      args: [],
      cli: null,
    });
  }

  server.registerTool(
    "claude_send_followup",
    {
      title: "Send follow-up to Claude Code cloud session",
      description:
        "Queue a follow-up message into an existing Claude Code cloud session via " +
        "`claude --cloud <session> -p <message>`. Replies are only visible at the session_url; claude_get_session " +
        "reports the pushed branch and pull request. If the session " +
        "can't push to GitHub, use this to ask for `git format-patch origin/<base>..HEAD --stdout` (or a full " +
        "`git diff` including new files), then apply it locally with `git am` / `git apply --3way` and push it yourself.",
      inputSchema: followupInput,
      outputSchema: followupOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ session, message }, extra) =>
      inRequestScope(extra.signal, async () => {
        const args = sendFollowupArgv(session, message);
        const result = await run(args);
        if (!isRunResult(result)) return result;
        const parsed = parseFollowupOutput(result.stdout);
        return ok({ session, ...parsed, args, cli: cli(result) });
      }),
  );

  server.registerTool(
    "claude_get_session",
    {
      title: "Cloud session GitHub status",
      description:
        "With a job id from claude_create_cloud_session, report that create's progress in `job` (status, " +
        "elapsed time, the tail of the CLI output, and session_id once the CLI prints it), its final result once " +
        "`job.status` is `done`, or its error; this reads memory only and runs nothing. " +
        "With a session id or URL, report the branch a cloud session pushed and any pull request it opened. Prepares the github.com " +
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
    async ({ session, repo }, extra) => {
      if (JOB_ID_PATTERN.test(session)) return readJob(session);
      return inRequestScope(extra.signal, () => readSession(session, repo));
    },
  );

  async function readSession(session: string, repo: string | undefined): Promise<CallToolResult> {
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
        (cwd, checkout) => readSessionStatus(sessionId, target, cwd, checkout.branch),
      );
    } catch (err) {
      if (err instanceof RepoPrepareError) return toolError("REPO_PREPARE_FAILED", err.message, []);
      throw err;
    }
  }

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
      const withNotes = { ...result, stderr: [result.stderr, ...parsed.notes].filter((line) => line !== "").join("\n") };
      if (signedOut(withNotes)) return toolError("CLI_NOT_SIGNED_IN", signInMessage(detail), args, withNotes);
      return toolError("CLI_EXIT_NONZERO", `claude ${how}${detail ? `: ${detail}` : ""}`, args, withNotes);
    }
    const stderr = [cleanTerminalText(result.stderr).trim(), ...parsed.notes].filter((line) => line !== "").join("\n");
    return ok({
      job: null,
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
    "claude_cancel_session",
    {
      title: "Cancel a create job",
      description:
        "Stop a claude_create_cloud_session job that is still running: every process it started on this machine " +
        "(git, the pty helper and claude --cloud) gets SIGTERM, then SIGKILL 5 s later. Pass the job_id, or the " +
        "session id or URL an unfinished job already printed. Waits up to about 6 s for the processes to exit and " +
        "reports `stopped`. This does not stop a cloud session: one the CLI already created keeps running at its " +
        "session_url. A job that already finished is left as it is (`cancelled` false), and one that failed " +
        "returns its error.",
      inputSchema: cancelInput,
      outputSchema: cancelOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ session }) => {
      let job: Job<CreateJob> | null;
      if (JOB_ID_PATTERN.test(session)) {
        job = jobs.get(session);
        if (job === null) return jobNotFound(session);
      } else {
        const sessionId = sessionIdOf(session);
        job = jobs.unfinished().find((candidate) => sessionId !== null && pendingBody(candidate).session_id === sessionId) ?? null;
        if (job === null) {
          return toolError(
            "JOB_NOT_FOUND",
            `No unfinished create job on this server printed session ${JSON.stringify(session)}. claude_cancel_session stops only processes this server started; it does not stop a cloud session, which keeps running at its session_url.`,
            [],
          );
        }
      }
      const cancelled = cancelJob(job);
      if (job.status !== "cancelled") {
        const body = jobBody(job);
        if (!isCreateBody(body)) return body;
        return ok({ job: body, cancelled: false, stopped: job.details.scope.idle });
      }
      await settleWithin(job, KILL_GRACE_MS + 1_000);
      return ok({
        job: pendingBody(job),
        cancelled,
        stopped: job.finishedAt !== null && job.details.scope.idle,
      });
    },
  );

  server.registerTool(
    "claude_auth_status",
    {
      title: "Claude Code auth status",
      description:
        "Report whether the local Claude Code CLI is signed in, via `claude auth status`. If it is not, sign in " +
        "with `claude` first (run it once in a terminal and complete the claude.ai login). A missing CLI returns " +
        "CLI_NOT_FOUND with the install command (`npm install -g @anthropic-ai/claude-code`).",
      inputSchema: authInput,
      outputSchema: authOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      inRequestScope(extra.signal, async () => {
        const args = authStatusArgv();
        const result = await run(args);
        if (!isRunResult(result)) return result;
        try {
          return ok({ ...parseAuthStatus(result.stdout), cli: cli(result) });
        } catch (err) {
          if (err instanceof AuthParseError) return toolError("OUTPUT_PARSE_FAILED", err.message, args, result);
          throw err;
        }
      }),
  );

  return server;
}

/**
 * Run a tool request in its own scope, so processes it starts are stopped
 * when the client cancels the request (for example on its own timeout).
 */
async function inRequestScope<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const scope = new Scope();
  const detach = abortOnSignal(scope, signal);
  try {
    return await runInScope(scope, fn);
  } finally {
    detach();
  }
}

function isCreateBody(value: CreateBody | CallToolResult): value is CreateBody {
  return "job_id" in value;
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

/** A non-zero exit: CLI_NOT_SIGNED_IN when the output reads like a login problem, else CLI_EXIT_NONZERO. */
function exitError(result: RunResult, args: string[]): CallToolResult {
  const how = result.exitCode === null ? `was killed by ${result.signal}` : `exited with code ${result.exitCode}`;
  const detail = outputDetail(result);
  if (signedOut(result)) return toolError("CLI_NOT_SIGNED_IN", signInMessage(detail), args, result);
  return toolError("CLI_EXIT_NONZERO", `claude ${how}${detail ? `: ${detail}` : ""}`, args, result);
}

function signedOut(result: RunResult): boolean {
  return isSignInError(`${cleanTerminalText(result.stderr)}\n${cleanTerminalText(result.stdout)}`);
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

function readPackageVersion(): string {
  try {
    // dist/src/server.js -> package.json at the package root (npm always ships it).
    const pkg: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const version = typeof pkg === "object" && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
    return typeof version === "string" && version !== "" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
