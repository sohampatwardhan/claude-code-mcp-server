import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuthParseError,
  SESSION_REF_PATTERN,
  findSessionId,
  findSessionUrl,
  parseAuthStatus,
  parseCreateOutput,
  parseFollowupOutput,
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

describe("stripAnsi", () => {
  it("removes SGR and OSC sequences", () => {
    assert.equal(stripAnsi("\u001b[31mred\u001b[0m \u001b]8;;https://x\u0007link\u001b]8;;\u0007"), "red link");
  });
});
