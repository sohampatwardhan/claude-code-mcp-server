import { isSafeBranchName } from "./repos.js";

/**
 * Parsing of `claude` CLI output into structured fields.
 *
 * The CLI's human-readable cloud output looks like:
 *
 *   Created cloud session: Fix flaky login test
 *   Session ID: session_01AbC...
 *   View: https://claude.ai/code/session_01AbC...?from=cli&m=0
 *   Resume with: claude --teleport session_01AbC...
 *
 * and for follow-ups:
 *
 *   Sent to cloud session.
 *   Session ID: session_01AbC...
 *   View: https://claude.ai/code/session_01AbC...
 *
 * Parsing prefers, in order: a JSON object line (`--output-format json`
 * shape), the labelled lines above, then the first id / URL anywhere in the
 * output. Nothing here throws on unexpected text: unparsed fields are null.
 */

/** Session ids: `session_` or `cse_` followed by an opaque base62-ish body. */
export const SESSION_ID_REGEX = /\b(?:session|cse)_[A-Za-z0-9]{8,}(?:[A-Za-z0-9_-]*[A-Za-z0-9])?/;

/** claude.ai/code URLs, up to whitespace, quotes or closing brackets. */
export const SESSION_URL_REGEX = /https:\/\/claude\.ai\/code(?:\/[^\s"'<>)\]]*)?/;

/** Accepted values for the `session` input of `claude_send_followup`. */
export const SESSION_REF_PATTERN =
  /^(?:(?:session|cse)_[A-Za-z0-9][A-Za-z0-9_-]*|https:\/\/claude\.ai\/code\/[^\s"'<>]+)$/;

/**
 * Terminal controls that show up in pty transcripts.
 *
 * Order matters: a generic ESC-final sequence would otherwise swallow the `[`
 * of a CSI. CSI parameters include the private bytes `<=>` (`ESC [>4m`,
 * `ESC [<u`). ESC 7 / ESC 8 (save and restore cursor) are single-byte
 * escapes, not CSI. C0 bytes other than tab, LF, and CR — SI is 0x0F — are
 * removed after the escape sequences.
 */
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_REGEX = new RegExp(
  [
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b[P^_][\\s\\S]*?(?:\\u001b\\\\|\\u0007)",
    "\\u001b\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
    "\\u009b[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
    "\\u001b[\\x20-\\x2f]*[\\x30-\\x7e]",
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u0080-\\u009f]",
  ].join("|"),
  "g",
);

/**
 * Cursor moves (`CSI n C` forward, `CSI n G` to column n), and the other
 * escape sequences and line breaks that change the column. Claude Code's
 * full-screen UI places each word with `CSI n G` instead of printing spaces.
 */
// eslint-disable-next-line no-control-regex
const CURSOR_TOKEN_REGEX = new RegExp(
  [
    "\\u001b\\[(\\d*)([CG])",
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    "\\u001b[P^_][\\s\\S]*?(?:\\u001b\\\\|\\u0007)",
    "\\u001b\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
    "\\u001b[\\x20-\\x2f]*[\\x30-\\x7e]",
    "\\r\\n|\\r|\\n",
  ].join("|"),
  "g",
);

/** Widest gap a single cursor move may turn into. */
const MAX_CURSOR_GAP = 500;

/**
 * Turn cursor moves into the spaces they leave on screen, so `Is\u001b[25Gthis`
 * reads `Is this`. A move to a column already passed adds nothing. Other
 * escape sequences are kept for `stripAnsi` to remove.
 */
function expandCursorMoves(text: string): string {
  let out = "";
  let column = 0;
  let last = 0;
  for (const match of text.matchAll(CURSOR_TOKEN_REGEX)) {
    const plain = text.slice(last, match.index);
    out += plain;
    column += [...plain].length;
    last = match.index + match[0].length;
    const [token, count, kind] = match;
    if (kind === "C") {
      const gap = Math.min(Math.max(Number(count || "1"), 1), MAX_CURSOR_GAP);
      out += " ".repeat(gap);
      column += gap;
    } else if (kind === "G") {
      const target = Math.min(Math.max(Number(count || "1"), 1), MAX_CURSOR_GAP) - 1;
      if (target > column) {
        out += " ".repeat(target - column);
        column = target;
      }
    } else {
      out += token;
      if (token === "\n" || token === "\r" || token === "\r\n") column = 0;
    }
  }
  return out + text.slice(last);
}

export function stripAnsi(text: string): string {
  return expandCursorMoves(text).replace(TERMINAL_CONTROL_REGEX, "");
}

/** Escape-free text with pty `\r` newlines folded into `\n`. */
export function cleanTerminalText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function findSessionId(text: string): string | null {
  return SESSION_ID_REGEX.exec(text)?.[0] ?? null;
}

export function findSessionUrl(text: string): string | null {
  const match = SESSION_URL_REGEX.exec(text)?.[0];
  return match === undefined ? null : match.replace(/[.,;:!?]+$/, "");
}

export interface ParsedCreate {
  session_id: string | null;
  session_url: string | null;
  title: string | null;
  /** True when both the session id and URL were found. */
  parsed: boolean;
}

export interface ParsedFollowup {
  session_id: string | null;
  session_url: string | null;
  /** True when the CLI confirmed delivery. */
  sent: boolean;
  /** True when both the session id and URL were found. */
  parsed: boolean;
}

export function parseCreateOutput(stdout: string): ParsedCreate {
  const text = cleanTerminalText(stdout);
  const json = findJsonObject(text, (o) => "session_id" in o || "url" in o);

  const sessionId =
    stringField(json, "session_id") ?? labelled(text, "Session ID", findSessionId) ?? findSessionId(text);
  const sessionUrl = stringField(json, "url") ?? labelled(text, "View", findSessionUrl) ?? findSessionUrl(text);
  const title = stringField(json, "title") ?? labelledRaw(text, "Created cloud session");

  const session_id = sessionId ?? (sessionUrl ? findSessionId(sessionUrl) : null);
  return { session_id, session_url: sessionUrl, title, parsed: session_id !== null && sessionUrl !== null };
}

export function parseFollowupOutput(stdout: string): ParsedFollowup {
  const text = cleanTerminalText(stdout);
  const json = findJsonObject(text, (o) => "ok" in o || "session_id" in o);

  const sessionId =
    stringField(json, "session_id") ?? labelled(text, "Session ID", findSessionId) ?? findSessionId(text);
  const sessionUrl = stringField(json, "url") ?? labelled(text, "View", findSessionUrl) ?? findSessionUrl(text);
  const sent = (json !== null && json.ok === true) || /^Sent to cloud session\.?\s*$/m.test(text);

  const session_id = sessionId ?? (sessionUrl ? findSessionId(sessionUrl) : null);
  return { session_id, session_url: sessionUrl, sent, parsed: session_id !== null && sessionUrl !== null };
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}

export class AuthParseError extends Error {
  override name = "AuthParseError";
}

export interface ParsedTeleport {
  /** Branch named by `Branch after checkout`, when it is a safe branch name. */
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  /** Short diagnostic lines. Unrecognised text is ignored. */
  notes: string[];
}

/**
 * Branch and pull request from teleport's debug log or stdout.
 * Never throws. A pull request URL is kept only when it belongs to `repo`.
 *
 * Claude Code 2.1.300 print-mode teleport logs these lines when `--debug` is on:
 * `Switching to branch '<name>'...` and `Branch after checkout: '<name>'`.
 */
export function parseTeleportOutput(text: string, repo: { owner: string; name: string }): ParsedTeleport {
  const cleaned = cleanTerminalText(text);
  const after = /Branch after checkout: '([^'\r\n]+)'/.exec(cleaned)?.[1] ?? null;
  const switching = /Switching to branch '([^'\r\n]+)'/.exec(cleaned)?.[1] ?? null;
  const labelled = /(?:^|\n)\s*Checking out branch\s+(\S+)/.exec(cleaned)?.[1] ?? null;
  const branchCandidate = after ?? switching ?? labelled;
  const branch = branchCandidate !== null && isSafeBranchName(branchCandidate) ? branchCandidate : null;

  const urlMatch = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(cleaned);
  const numberMatch = /(?:Opened|Created)\s+PR\s+#(\d{1,9})\b/i.exec(cleaned);
  const urlOwner = urlMatch?.[1];
  const urlName = urlMatch?.[2];
  const urlNumber = urlMatch?.[3];
  const urlMatchesRepo =
    urlOwner !== undefined &&
    urlName !== undefined &&
    urlNumber !== undefined &&
    urlOwner.toLowerCase() === repo.owner.toLowerCase() &&
    urlName.toLowerCase() === repo.name.toLowerCase();
  let pr_number: number | null = null;
  let pr_url: string | null = null;
  const bareNumber = numberMatch?.[1];
  if (urlMatchesRepo && urlNumber !== undefined) {
    pr_number = Number(urlNumber);
    pr_url = `https://github.com/${repo.owner}/${repo.name}/pull/${pr_number}`;
  } else if (urlMatch === null && bareNumber !== undefined) {
    pr_number = Number(bareNumber);
    pr_url = `https://github.com/${repo.owner}/${repo.name}/pull/${pr_number}`;
  }

  const notes: string[] = [];
  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("Teleport in print mode failed:") ||
      trimmed.startsWith("Teleport failed:") ||
      trimmed.startsWith("Invalid branch name from cloud session") ||
      trimmed.startsWith("Branch after checkout:") ||
      trimmed.startsWith("Switching to branch ")
    ) {
      notes.push(trimmed.slice(0, 500));
    }
  }
  return { branch, pr_number, pr_url, notes };
}

/** Parses `claude auth status` JSON. Throws AuthParseError if it is not JSON with a boolean `loggedIn`. */
export function parseAuthStatus(stdout: string): AuthStatus {
  const text = cleanTerminalText(stdout).trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new AuthParseError("`claude auth status` did not print JSON");
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new AuthParseError("`claude auth status` did not print valid JSON");
    }
  }
  if (!isRecord(value) || typeof value.loggedIn !== "boolean") {
    throw new AuthParseError("`claude auth status` JSON has no boolean `loggedIn` field");
  }
  return {
    loggedIn: value.loggedIn,
    authMethod: stringField(value, "authMethod"),
    email: stringField(value, "email"),
    orgName: stringField(value, "orgName"),
    subscriptionType: stringField(value, "subscriptionType"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** First line of `text` that is a JSON object satisfying `accept`. */
function findJsonObject(
  text: string,
  accept: (o: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value) && accept(value)) return value;
    } catch {
      // not JSON; keep scanning
    }
  }
  return null;
}

/** Value of a `Label: value` line, or null. */
function labelledRaw(text: string, label: string): string | null {
  const re = new RegExp(`^\\s*${label}:[ \\t]*(.+?)\\s*$`, "m");
  return re.exec(text)?.[1] ?? null;
}

/** Applies `extract` to the value of a `Label: value` line. */
function labelled(text: string, label: string, extract: (s: string) => string | null): string | null {
  const raw = labelledRaw(text, label);
  return raw === null ? null : extract(raw);
}

// ---- local runs (`claude -p --output-format=stream-json`) ----------------

const LOCAL_SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Longest stream-json line kept; a longer one is skipped rather than buffered. */
const MAX_STREAM_LINE_CHARS = 8 * 1024 * 1024;

/** Characters of the final result text kept. */
const MAX_RESULT_CHARS = 100_000;

export interface LocalUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

/** Fields read from the final `{"type":"result"}` line. */
export interface LocalResult {
  subtype: string | null;
  is_error: boolean;
  result: string | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  usage: LocalUsage | null;
  /** Names of tools whose calls were denied. */
  permission_denials: string[];
  errors: string[];
}

/**
 * Incremental reader for print-mode stream-json. It keeps only the session
 * id, a count of assistant messages, and the final result line, so memory
 * stays bounded however long the transcript gets. Lines that are not JSON
 * objects are ignored. Never throws.
 */
export class LocalStreamParser {
  sessionId: string | null = null;
  assistantMessages = 0;
  result: LocalResult | null = null;
  /** The latest `rate_limit_event` the run reported. */
  rateLimit: LocalRateLimit | null = null;
  private partial = "";
  private skipping = false;

  push(chunk: string): void {
    let text = chunk;
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline === -1) break;
      const line = this.partial + text.slice(0, newline);
      text = text.slice(newline + 1);
      this.partial = "";
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    if (this.skipping) return;
    this.partial += text;
    if (this.partial.length > MAX_STREAM_LINE_CHARS) {
      this.partial = "";
      this.skipping = true;
    }
  }

  /** Flush a last line that had no trailing newline. */
  end(): void {
    if (!this.skipping && this.partial !== "") this.line(this.partial);
    this.partial = "";
    this.skipping = false;
  }

  private line(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(value)) return;
    const sessionId = value.session_id;
    if (typeof sessionId === "string" && LOCAL_SESSION_ID.test(sessionId)) {
      // The result line names the session to resume, so it wins over earlier lines.
      if (this.sessionId === null || value.type === "result") this.sessionId = sessionId;
    }
    if (value.type === "assistant") this.assistantMessages++;
    if (value.type === "rate_limit_event" && isRecord(value.rate_limit_info)) this.rateLimit = rateLimit(value.rate_limit_info);
    if (value.type === "result") this.result = localResult(value);
  }
}

/** Rate-limit state from a run's `rate_limit_event`. */
export interface LocalRateLimit {
  /** `allowed`, `allowed_warning` (approaching the limit) or `rejected` (limit hit). */
  status: string | null;
  /** Unix seconds when the window resets. */
  resets_at: number | null;
  /** Fraction of the window used, 0-1. */
  utilization: number | null;
  /** Which window, such as `five_hour` or `seven_day`, when the CLI says. */
  type: string | null;
}

function rateLimit(info: Record<string, unknown>): LocalRateLimit {
  return {
    status: stringField(info, "status"),
    resets_at: finiteField(info, "resetsAt") ?? finiteField(info, "resets_at"),
    utilization: finiteField(info, "utilization"),
    type: stringField(info, "rateLimitType") ?? stringField(info, "rate_limit_type"),
  };
}

function localResult(value: Record<string, unknown>): LocalResult {
  const result = typeof value.result === "string" ? value.result.slice(0, MAX_RESULT_CHARS) : null;
  const denials = Array.isArray(value.permission_denials) ? value.permission_denials : [];
  const errors = Array.isArray(value.errors) ? value.errors : [];
  return {
    subtype: stringField(value, "subtype"),
    is_error: value.is_error === true,
    result,
    num_turns: intField(value, "num_turns"),
    total_cost_usd: typeof value.total_cost_usd === "number" && Number.isFinite(value.total_cost_usd) ? value.total_cost_usd : null,
    usage: isRecord(value.usage)
      ? {
          input_tokens: intField(value.usage, "input_tokens"),
          output_tokens: intField(value.usage, "output_tokens"),
          cache_creation_input_tokens: intField(value.usage, "cache_creation_input_tokens"),
          cache_read_input_tokens: intField(value.usage, "cache_read_input_tokens"),
        }
      : null,
    permission_denials: denials
      .map((denial) => (isRecord(denial) ? stringField(denial, "tool_name") : null))
      .filter((name): name is string => name !== null)
      .slice(0, 100),
    errors: errors.filter((error): error is string => typeof error === "string").map((error) => error.slice(0, 2_000)).slice(0, 20),
  };
}

function intField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export interface GitStatusEntry {
  /** Two-letter porcelain status, such as ` M`, `A `, or `??`. */
  status: string;
  path: string;
  /** Previous path of a rename or copy. */
  from: string | null;
}

/** Parse `git status --porcelain=v1 -z`. Malformed entries are skipped. */
export function parseGitStatusZ(text: string): GitStatusEntry[] {
  const fields = text.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === undefined || field.length < 4 || field[2] !== " ") continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    let from: string | null = null;
    if (status.includes("R") || status.includes("C")) {
      from = fields[i + 1] ?? null;
      i++;
    }
    entries.push({ status, path, from });
  }
  return entries;
}

// ---- plan usage (`claude -p -- /usage`) ----------------------------------

export interface UsageWindow {
  /** The server's meter kind, such as `session`, `weekly_all`, or `weekly_scoped`. */
  kind: string;
  group: string | null;
  /** Share of the window used, 0-100 (above 100 past the limit). */
  percent: number;
  /** ISO 8601 time the window resets. */
  resets_at: string | null;
  severity: string | null;
  is_active: boolean;
  /** Display name of the model or surface a scoped window applies to. */
  scope: string | null;
}

export interface UsageExtra {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface ParsedUsage {
  /** True when a `usage_report` line was found. */
  parsed: boolean;
  /** Null when the CLI could not read the plan's usage (for example, a token without that scope). */
  windows: UsageWindow[] | null;
  extra_usage: UsageExtra | null;
}

/**
 * Read the structured `usage_report` from `/usage` stream-json. Only the
 * meters are kept: the report's text and local activity summary are not.
 * Never throws.
 */
export function parseUsageReport(stdout: string): ParsedUsage {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"usage_report"')) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(value) || !isRecord(value.usage_report)) continue;
    const limits = isRecord(value.usage_report.rate_limits) ? value.usage_report.rate_limits : null;
    if (limits === null) return { parsed: true, windows: null, extra_usage: null };
    const rows = Array.isArray(limits.limits) ? limits.limits : [];
    const windows: UsageWindow[] = [];
    for (const row of rows.slice(0, 50)) {
      if (!isRecord(row)) continue;
      const kind = stringField(row, "kind");
      const percent = row.percent;
      if (kind === null || typeof percent !== "number" || !Number.isFinite(percent)) continue;
      const scope = isRecord(row.scope) ? row.scope : null;
      const scopeOwner = scope === null ? null : isRecord(scope.model) ? scope.model : isRecord(scope.surface) ? scope.surface : null;
      windows.push({
        kind,
        group: stringField(row, "group"),
        percent,
        resets_at: stringField(row, "resets_at"),
        severity: stringField(row, "severity"),
        is_active: row.is_active === true,
        scope: scopeOwner === null ? null : stringField(scopeOwner, "display_name"),
      });
    }
    const extra = isRecord(limits.extra_usage) ? limits.extra_usage : null;
    return {
      parsed: true,
      windows,
      extra_usage:
        extra === null
          ? null
          : {
              is_enabled: extra.is_enabled === true,
              monthly_limit: finiteField(extra, "monthly_limit"),
              used_credits: finiteField(extra, "used_credits"),
              utilization: finiteField(extra, "utilization"),
              currency: stringField(extra, "currency"),
            },
    };
  }
  return { parsed: false, windows: null, extra_usage: null };
}

function finiteField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
