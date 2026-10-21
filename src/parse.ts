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

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
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
  const text = stripAnsi(stdout);
  const json = findJsonObject(text, (o) => "session_id" in o || "url" in o);

  const sessionId =
    stringField(json, "session_id") ?? labelled(text, "Session ID", findSessionId) ?? findSessionId(text);
  const sessionUrl = stringField(json, "url") ?? labelled(text, "View", findSessionUrl) ?? findSessionUrl(text);
  const title = stringField(json, "title") ?? labelledRaw(text, "Created cloud session");

  const session_id = sessionId ?? (sessionUrl ? findSessionId(sessionUrl) : null);
  return { session_id, session_url: sessionUrl, title, parsed: session_id !== null && sessionUrl !== null };
}

export function parseFollowupOutput(stdout: string): ParsedFollowup {
  const text = stripAnsi(stdout);
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

/** Parses `claude auth status` JSON. Throws AuthParseError if it is not JSON with a boolean `loggedIn`. */
export function parseAuthStatus(stdout: string): AuthStatus {
  const text = stripAnsi(stdout).trim();
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
