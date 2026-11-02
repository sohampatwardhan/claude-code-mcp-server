import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CLI_INSTALL_COMMAND, cliNotFoundMessage, findCli, isSignInError, signInMessage } from "../src/prereq.js";

const tmp = mkdtempSync(join(tmpdir(), "claude-mcp-prereq-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("CLI prerequisites", () => {
  it("names the install command and the sign-in step when the CLI is missing", () => {
    assert.equal(CLI_INSTALL_COMMAND, "npm install -g @anthropic-ai/claude-code");
    const message = cliNotFoundMessage("claude");
    assert.match(message, /Claude Code CLI not found: claude/);
    assert.match(message, /`npm install -g @anthropic-ai\/claude-code`/);
    assert.match(message, /run `claude` once to sign in/);
    assert.match(message, /CLAUDE_BIN/);
  });

  it("tells the caller to sign in with claude", () => {
    const message = signInMessage("Invalid API key · Please run /login");
    assert.match(message, /not signed in \(Invalid API key/);
    assert.match(message, /Sign in with `claude` first/);
    assert.match(message, /Claude Code on the web/);
  });

  it("recognises login failures and leaves other errors alone", () => {
    for (const text of [
      "Invalid API key · Please run /login",
      "Not logged in · Please run /login",
      "Error: You must be logged in to use cloud sessions",
      "OAuth token has expired. Please obtain a new token or refresh your existing token.",
      "API Error: 401 authentication_error: Authentication failed",
      'Please run `claude login`',
      '{\n  "loggedIn": false,\n  "authMethod": "none"\n}',
    ]) {
      assert.equal(isSignInError(text), true, text);
    }
    for (const text of [
      "Error: Unable to create cloud session: environment unavailable",
      "Teleport failed: branch not found",
      '{ "loggedIn": true }',
      "",
    ]) {
      assert.equal(isSignInError(text), false, text);
    }
  });

  it("finds the CLI on PATH or at an explicit path", () => {
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    const exe = join(bin, "claude");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    const plain = join(bin, "not-exec");
    writeFileSync(plain, "");
    chmodSync(plain, 0o644);

    assert.equal(findCli("claude", { PATH: `${join(tmp, "nowhere")}:${bin}` }), exe);
    assert.equal(findCli("claude", { PATH: join(tmp, "nowhere") }), null);
    assert.equal(findCli("claude", {}), null);
    assert.equal(findCli(exe, {}), exe);
    assert.equal(findCli("./bin/claude", {}, tmp), exe);
    assert.equal(findCli(join(tmp, "missing"), {}), null);
    assert.equal(findCli(plain, {}), null);
    assert.equal(findCli(bin, {}), null);
  });
});
