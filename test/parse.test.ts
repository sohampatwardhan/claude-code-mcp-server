import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuthParseError,
  LocalStreamParser,
  SESSION_REF_PATTERN,
  findSessionId,
  findSessionUrl,
  parseAuthStatus,
  parseCreateOutput,
  parseFollowupOutput,
  parseGitStatusZ,
  parseTeleportOutput,
  parseUsageReport,
  stripAnsi,
} from "../src/parse.js";

const ID = "session_01LJxoSe5KhweYwd4wXZwMCZ";
const URL = `https://claude.ai/code/${ID}?from=cli&m=0`;

describe("parseCreateOutput", () => {
  it("parses the CLI's standard text output", () => {
    const stdout = [
      "Created cloud session: Fix flaky login test",
      `Session ID: ${ID}`,
      `View: ${URL}`,
      `Resume with: claude --teleport ${ID}`,
      "",
    ].join("\n");
    assert.deepEqual(parseCreateOutput(stdout), {
      session_id: ID,
      session_url: URL,
      title: "Fix flaky login test",
      parsed: true,
    });
  });

  it("parses output with progress lines and trailing notices", () => {
    const stdout = [
      "Packaging this repository",
      "Uploaded this repository",
      "Created cloud session: Add retry to uploader",
      `View: ${URL}`,
      `Resume with: claude --teleport ${ID}`,
      "Fast mode. Cloud sessions don't get it.",
    ].join("\n");
    const parsed = parseCreateOutput(stdout);
    assert.equal(parsed.session_id, ID);
    assert.equal(parsed.session_url, URL);
    assert.equal(parsed.title, "Add retry to uploader");
    assert.equal(parsed.parsed, true);
  });

  it("parses the --output-format json shape", () => {
    const stdout = JSON.stringify({ ok: true, session_id: ID, title: "T", url: URL, pool_id: "ccpool_abc" }) + "\n";
    assert.deepEqual(parseCreateOutput(stdout), { session_id: ID, session_url: URL, title: "T", parsed: true });
  });

  it("strips ANSI colour codes", () => {
    const stdout = `\u001b[1mCreated cloud session:\u001b[22m Demo\nSession ID: \u001b[36m${ID}\u001b[39m\nView: \u001b[4m${URL}\u001b[24m\n`;
    const parsed = parseCreateOutput(stdout);
    assert.equal(parsed.session_id, ID);
    assert.equal(parsed.session_url, URL);
    assert.equal(parsed.title, "Demo");
  });

  it("parses the real pty create transcript, including cursor-save escapes", () => {
    const stdout =
      "\u001b7\u001b8Created cloud session: Single-word ok reply\nView: https://claude.ai/code/session_011fxu2EYatr2hHg3jAszFts?from=cli&m=0\nResume with: claude --teleport session_011fxu2EYatr2hHg3jAszFts\n\u000f\u001b[>4m\u001b[<u\u001b7\u001b8";
    assert.deepEqual(parseCreateOutput(stdout), {
      session_id: "session_011fxu2EYatr2hHg3jAszFts",
      session_url: "https://claude.ai/code/session_011fxu2EYatr2hHg3jAszFts?from=cli&m=0",
      title: "Single-word ok reply",
      parsed: true,
    });
    assert.equal(
      stripAnsi(stdout),
      "Created cloud session: Single-word ok reply\nView: https://claude.ai/code/session_011fxu2EYatr2hHg3jAszFts?from=cli&m=0\nResume with: claude --teleport session_011fxu2EYatr2hHg3jAszFts\n",
    );
  });

  it("accepts cse_ ids", () => {
    const parsed = parseCreateOutput("Session ID: cse_01ABCdefGHIjklMNOpqr\nView: https://claude.ai/code/cse_01ABCdefGHIjklMNOpqr\n");
    assert.equal(parsed.session_id, "cse_01ABCdefGHIjklMNOpqr");
    assert.equal(parsed.parsed, true);
  });

  it("derives the id from the URL when no Session ID line is printed", () => {
    const parsed = parseCreateOutput(`Created cloud session: X\nView: ${URL}\n`);
    assert.equal(parsed.session_id, ID);
    assert.equal(parsed.parsed, true);
  });

  it("returns nulls and parsed=false for unrecognised output", () => {
    assert.deepEqual(parseCreateOutput("Something went sideways\n"), {
      session_id: null,
      session_url: null,
      title: null,
      parsed: false,
    });
    assert.deepEqual(parseCreateOutput(""), { session_id: null, session_url: null, title: null, parsed: false });
  });

  it("parses a transcript that includes the workspace-trust dialog", () => {
    const stdout = [
      "Do you trust the files in this folder?",
      "❯ 1. Yes, I trust this folder",
      "  2. No, exit",
      "Created cloud session: Fix flaky login test",
      `Session ID: ${ID}`,
      `View: ${URL}`,
      "",
    ].join("\n");
    const parsed = parseCreateOutput(stdout);
    assert.equal(parsed.session_id, ID);
    assert.equal(parsed.session_url, URL);
    assert.equal(parsed.title, "Fix flaky login test");
    assert.equal(parsed.parsed, true);
  });

  it("reports parsed=false when only the id is present", () => {
    const parsed = parseCreateOutput(`Session ID: ${ID}\n`);
    assert.equal(parsed.session_id, ID);
    assert.equal(parsed.session_url, null);
    assert.equal(parsed.parsed, false);
  });
});

describe("parseFollowupOutput", () => {
  it("parses the CLI's standard text output", () => {
    const stdout = `Sent to cloud session.\nSession ID: ${ID}\nView: ${URL}\n`;
    assert.deepEqual(parseFollowupOutput(stdout), { session_id: ID, session_url: URL, sent: true, parsed: true });
  });

  it("parses the --output-format json shape", () => {
    const stdout = JSON.stringify({ ok: true, session_id: ID, url: URL }) + "\n";
    assert.deepEqual(parseFollowupOutput(stdout), { session_id: ID, session_url: URL, sent: true, parsed: true });
  });

  it("does not claim delivery for unrecognised output", () => {
    assert.deepEqual(parseFollowupOutput("hmm\n"), { session_id: null, session_url: null, sent: false, parsed: false });
  });
});

describe("findSessionId", () => {
  it("does not match JSON keys like session_id or session_status", () => {
    assert.equal(findSessionId('{"session_id": 1, "session_status": "x"}'), null);
  });

  it("finds an id inside a URL", () => {
    assert.equal(findSessionId(`see ${URL}`), ID);
  });

  it("does not include trailing punctuation", () => {
    assert.equal(findSessionId(`(${ID}).`), ID);
  });
});

describe("findSessionUrl", () => {
  it("trims trailing sentence punctuation and brackets", () => {
    assert.equal(findSessionUrl(`Open ${URL}.`), URL);
    assert.equal(findSessionUrl(`(${URL})`), URL);
    assert.equal(findSessionUrl(`"${URL}"`), URL);
  });

  it("ignores other hosts", () => {
    assert.equal(findSessionUrl(`https://example.com/code/${ID}`), null);
    assert.equal(findSessionUrl(`https://claude.ai.evil.com/code/${ID}`), null);
  });
});

describe("SESSION_REF_PATTERN", () => {
  it("accepts ids and claude.ai/code URLs", () => {
    for (const ok of [ID, "cse_01ABC", URL, `https://claude.ai/code/${ID}`]) {
      assert.ok(SESSION_REF_PATTERN.test(ok), ok);
    }
  });

  it("rejects flags, other hosts, whitespace and empty values", () => {
    for (const bad of ["", "--help", "-p", "session_", "foo", `${ID} --x`, "https://example.com/code/x", `http://claude.ai/code/${ID}`]) {
      assert.ok(!SESSION_REF_PATTERN.test(bad), bad);
    }
  });
});

describe("parseAuthStatus", () => {
  it("parses full auth JSON", () => {
    const stdout = JSON.stringify(
      {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "dev@example.com",
        orgName: "Example Org",
        subscriptionType: "max",
      },
      null,
      2,
    );
    assert.deepEqual(parseAuthStatus(stdout), {
      loggedIn: true,
      authMethod: "claude.ai",
      email: "dev@example.com",
      orgName: "Example Org",
      subscriptionType: "max",
    });
  });

  it("fills missing fields with null (token-based auth prints fewer fields)", () => {
    const stdout = JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }, null, 2);
    assert.deepEqual(parseAuthStatus(stdout), {
      loggedIn: true,
      authMethod: "oauth_token",
      email: null,
      orgName: null,
      subscriptionType: null,
    });
  });

  it("parses logged-out output", () => {
    assert.equal(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}').loggedIn, false);
  });

  it("tolerates a leading warning line", () => {
    assert.equal(parseAuthStatus('Warning: update available\n{"loggedIn": true}\n').loggedIn, true);
  });

  it("throws AuthParseError on non-JSON or missing loggedIn", () => {
    assert.throws(() => parseAuthStatus("Not logged in"), AuthParseError);
    assert.throws(() => parseAuthStatus('{"email": "x"}'), AuthParseError);
    assert.throws(() => parseAuthStatus("[]"), AuthParseError);
  });
});

describe("parseTeleportOutput", () => {
  const repo = { owner: "acme", name: "widgets" };

  it("reads the branch line Claude Code 2.1.300 logs and a pull request URL", () => {
    const text = [
      "Switching to branch 'claude/session-branch'...",
      "Branch after checkout: 'claude/session-branch'",
      "Opened PR #17 https://github.com/acme/widgets/pull/17",
    ].join("\n");
    assert.deepEqual(parseTeleportOutput(text, repo), {
      branch: "claude/session-branch",
      pr_number: 17,
      pr_url: "https://github.com/acme/widgets/pull/17",
      notes: [
        "Switching to branch 'claude/session-branch'...",
        "Branch after checkout: 'claude/session-branch'",
      ],
    });
  });

  it("ignores a pull request for a different repository and an unsafe branch", () => {
    const text = [
      "Branch after checkout: 'feature/../../etc'",
      "Opened PR #4 https://github.com/other/repo/pull/4",
      "something unexpected happened",
    ].join("\n");
    assert.deepEqual(parseTeleportOutput(text, repo), {
      branch: null,
      pr_number: null,
      pr_url: null,
      notes: ["Branch after checkout: 'feature/../../etc'"],
    });
  });

  it("keeps a print-mode failure line and does not invent a branch", () => {
    const text = "Teleport in print mode failed: Cloud sessions need a claude.ai sign-in\n";
    const parsed = parseTeleportOutput(text, repo);
    assert.equal(parsed.branch, null);
    assert.equal(parsed.pr_number, null);
    assert.deepEqual(parsed.notes, ["Teleport in print mode failed: Cloud sessions need a claude.ai sign-in"]);
  });
});

describe("stripAnsi", () => {
  it("removes SGR and OSC sequences", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[0m \u001b]8;;https://x\u0007link\u001b]8;;\u0007"), "red link");
  });

  it("turns cursor moves into the spaces they leave, as Claude Code 2.1.316 draws words", () => {
    assert.equal(stripAnsi("\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:"), " Quick safety check:");
    assert.equal(stripAnsi("Run\u001b[1C`claude\u001b[2Cauth`"), "Run `claude  auth`");
    // A move to a column already passed, or to the current one, adds nothing.
    assert.equal(stripAnsi("abcdef\u001b[3Gxy"), "abcdefxy");
    assert.equal(stripAnsi("abcd\u001b[5Gef"), "abcdef");
    // Columns restart after each line break, and other escapes take no width.
    assert.equal(stripAnsi("ab\r\r\n\u001b[1m\u001b[3Gcd\u001b[22m"), "ab\r\r\n  cd");
    assert.equal(stripAnsi("x\u001b[99999Gy").length, 500, "a move is capped at column 500");
  });
});

describe("LocalStreamParser", () => {
  const SESSION = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
  const lines = [
    { type: "system", subtype: "init", session_id: SESSION, cwd: "/repo", tools: ["Read"] },
    { type: "assistant", session_id: SESSION, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    { type: "user", session_id: SESSION, message: { role: "user", content: [] } },
    { type: "assistant", session_id: SESSION, message: { role: "assistant", content: [] } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5120,
      num_turns: 3,
      result: "Fixed the failing test.",
      session_id: SESSION,
      total_cost_usd: 0.0421,
      usage: { input_tokens: 10, output_tokens: 250, cache_creation_input_tokens: 900, cache_read_input_tokens: 1200, server_tool_use: {} },
      modelUsage: {},
      permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "rm -rf /" } }, { bogus: true }],
    },
  ].map((line) => JSON.stringify(line) + "\n");

  it("reads the session, assistant count and result line, whatever the chunk boundaries", () => {
    const whole = lines.join("");
    for (const size of [1, 7, 64, whole.length]) {
      const parser = new LocalStreamParser();
      for (let i = 0; i < whole.length; i += size) parser.push(whole.slice(i, i + size));
      parser.end();
      assert.equal(parser.sessionId, SESSION, `chunk size ${size}`);
      assert.equal(parser.assistantMessages, 2);
      assert.deepEqual(parser.result, {
        subtype: "success",
        is_error: false,
        result: "Fixed the failing test.",
        num_turns: 3,
        total_cost_usd: 0.0421,
        usage: { input_tokens: 10, output_tokens: 250, cache_creation_input_tokens: 900, cache_read_input_tokens: 1200 },
        permission_denials: ["Bash"],
        errors: [],
      });
    }
  });

  it("reads an error result and a final line with no newline", () => {
    const parser = new LocalStreamParser();
    parser.push(lines[0] ?? "");
    parser.push(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 3,
        session_id: SESSION,
        total_cost_usd: 0.01,
        usage: {},
        permission_denials: [],
        errors: ["Reached maximum number of turns (3)", 42],
      }),
    );
    const pending = parser.result;
    assert.equal(pending, null, "no result until the last line ends");
    parser.end();
    assert.equal(parser.result?.subtype, "error_max_turns");
    assert.equal(parser.result?.is_error, true);
    assert.equal(parser.result?.result, null);
    assert.deepEqual(parser.result?.errors, ["Reached maximum number of turns (3)"]);
    assert.deepEqual(parser.result?.usage, {
      input_tokens: null,
      output_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    });
  });

  it("ignores non-JSON lines, non-UUID session ids, and leaves everything null without a result", () => {
    const parser = new LocalStreamParser();
    parser.push("warning: something\n{not json}\n[1,2]\n");
    parser.push(JSON.stringify({ type: "system", subtype: "init", session_id: "session_01ABCDEFGH" }) + "\n");
    parser.end();
    assert.equal(parser.sessionId, null);
    assert.equal(parser.result, null);
    assert.equal(parser.assistantMessages, 0);
  });

  it("takes the session id from the result line when resume forked a new session", () => {
    const forked = "22222222-3333-4444-8555-666666666666";
    const parser = new LocalStreamParser();
    parser.push(lines[0] ?? "");
    parser.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: forked }) + "\n");
    assert.equal(parser.sessionId, forked);
  });
});

describe("parseGitStatusZ", () => {
  it("reads modified, added, untracked, and renamed entries, including spaces in paths", () => {
    const text = [" M src/a.ts", "A  new file.txt", "?? notes/todo.md", "R  b.ts", "old b.ts", ""].join("\0");
    assert.deepEqual(parseGitStatusZ(text), [
      { status: " M", path: "src/a.ts", from: null },
      { status: "A ", path: "new file.txt", from: null },
      { status: "??", path: "notes/todo.md", from: null },
      { status: "R ", path: "b.ts", from: "old b.ts" },
    ]);
  });

  it("returns no entries for a clean tree and skips malformed fields", () => {
    assert.deepEqual(parseGitStatusZ(""), []);
    assert.deepEqual(parseGitStatusZ("XY\0garbage\0"), []);
  });
});

describe("parseUsageReport", () => {
  // Shaped like Claude Code 2.1.316's `claude -p --restricted --output-format=stream-json --verbose -- /usage`.
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "33333333-4444-4555-8666-777777777777" });
  const report = (rateLimits: unknown) =>
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      local_command_source: "<local-command-stdout>Current session: 68% used · resets Nov 2 at 5:10pm\n\nLast 24h · 1390 requests</local-command-stdout>",
      local_command_run: true,
      message: { role: "assistant", content: [{ type: "text", text: "Current session: 68% used" }] },
      usage_report: {
        session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
        rate_limits: rateLimits,
      },
    });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, local_command: "usage", num_turns: 0, total_cost_usd: 0 });

  it("reads each window and the usage-credit block", () => {
    const text = [
      init,
      report({
        limits: [
          { kind: "session", group: "session", percent: 68, resets_at: "2026-11-02T22:10:00.474794+00:00", scope: null, severity: "normal", is_active: true },
          {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 0,
            resets_at: "2026-11-02T21:00:00+00:00",
            scope: { model: null, surface: { display_name: "Cowork" } },
            severity: "normal",
            is_active: false,
          },
          { kind: "weekly_scoped", group: "weekly", percent: 41.5, resets_at: null, scope: { model: { display_name: "Opus" } }, severity: "warning", is_active: false },
          { kind: "broken", percent: "lots" },
        ],
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24, currency: "USD" },
      }),
      result,
    ].join("\n");
    assert.deepEqual(parseUsageReport(text), {
      parsed: true,
      windows: [
        { kind: "session", group: "session", percent: 68, resets_at: "2026-11-02T22:10:00.474794+00:00", severity: "normal", is_active: true, scope: null },
        { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: "2026-11-02T21:00:00+00:00", severity: "normal", is_active: false, scope: "Cowork" },
        { kind: "weekly_scoped", group: "weekly", percent: 41.5, resets_at: null, severity: "warning", is_active: false, scope: "Opus" },
      ],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1200, utilization: 24, currency: "USD" },
    });
  });

  it("reports windows null when the CLI can't read plan usage, and parsed false with no report", () => {
    assert.deepEqual(parseUsageReport([init, report(null), result].join("\n")), { parsed: true, windows: null, extra_usage: null });
    assert.deepEqual(parseUsageReport([init, result, "not json {", ""].join("\n")), { parsed: false, windows: null, extra_usage: null });
  });
});

describe("LocalStreamParser rate limits", () => {
  it("keeps the latest rate_limit_event, in either field spelling", () => {
    const parser = new LocalStreamParser();
    parser.push(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1793743800, utilization: 0.91 } }) + "\n");
    assert.deepEqual(parser.rateLimit, { status: "allowed_warning", resets_at: 1793743800, utilization: 0.91, type: null });
    parser.push(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resets_at: 1793750000, rate_limit_type: "five_hour" } }) + "\n");
    assert.deepEqual(parser.rateLimit, { status: "rejected", resets_at: 1793750000, utilization: null, type: "five_hour" });
  });
});
