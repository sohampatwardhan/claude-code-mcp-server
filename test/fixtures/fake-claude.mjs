#!/usr/bin/env node
// Stand-in for the `claude` CLI used by the smoke tests. It mimics the real
// CLI's cloud output and never touches the network.
//
//   FAKE_CLAUDE_ARGV_LOG   if set, the received argv is appended here as a JSON line
//   FAKE_CLAUDE_META_LOG   if set, { args, stdoutIsTTY, stdinIsTTY } is appended
//   FAKE_CLAUDE_STDIN_LOG  if set, bytes read while the trust dialog is up are appended
//   FAKE_CLAUDE_MODE       "fail" -> exit 1 with stderr; "hang" -> never exit;
//                          "garbled" -> exit 0 with unparseable output
//   FAKE_CLAUDE_TRUST      "prompt" -> create always shows the trust dialog
//                          "file"   -> create shows it unless ~/.claude.json trusts this checkout
//                          unset    -> create does not ask (folder already trusted)
//   FAKE_CLAUDE_TRUST_QUESTION
//                          override the dialog question (default is the long form)
//
// Creating a session (`--cloud=<description>` without `-p`) requires a TTY,
// matching Claude Code: a piped stdout exits 3 with the interactive-terminal error.
import { appendFileSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify(args) + "\n");
}
if (process.env.FAKE_CLAUDE_META_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_META_LOG,
    JSON.stringify({
      args,
      stdoutIsTTY: process.stdout.isTTY === true,
      stdinIsTTY: process.stdin.isTTY === true,
    }) + "\n",
  );
}

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const ID = "session_01FakeSessionId0000000000";

const isCreate = () => args[0]?.startsWith("--cloud=") === true && !args.includes("-p");

if (mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (mode === "fail") {
  process.stderr.write("Error: Unable to create cloud session: not signed in\n");
  process.exit(1);
} else if (mode === "garbled") {
  process.stdout.write("something unexpected happened\n");
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    JSON.stringify(
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
    ) + "\n",
  );
} else if (args[0]?.startsWith("--cloud=") && args.includes("-p")) {
  const session = args[0].slice("--cloud=".length);
  const id = session.startsWith("http") ? ID : session;
  process.stdout.write(`Sent to cloud session.\nSession ID: ${id}\nView: https://claude.ai/code/${id}?from=cli&m=0\n`);
} else if (isCreate()) {
  if (process.stdout.isTTY !== true) {
    process.stderr.write(
      "Error: --cloud requires an interactive terminal. Non-interactive invocations (piped stdout) cannot create a cloud session. Drop --cloud, or run from a TTY.\n",
    );
    process.exit(3);
  }
  if (trustDialogRequired()) {
    const question = process.env.FAKE_CLAUDE_TRUST_QUESTION ?? "Do you trust the files in this folder?";
    writeSync(1, `${question}\n❯ 1. Yes, I trust this folder\n  2. No, exit\n`);
    process.stdin.on("data", (chunk) => {
      if (process.env.FAKE_CLAUDE_STDIN_LOG) appendFileSync(process.env.FAKE_CLAUDE_STDIN_LOG, chunk);
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (/[yY1\r\n]/.test(text)) {
        writeCreated();
        process.exit(0);
      }
    });
  } else {
    writeCreated();
  }
} else {
  process.stderr.write(`fake-claude: unexpected argv ${JSON.stringify(args)}\n`);
  process.exit(64);
}

function writeCreated() {
  const title = args[0].slice("--cloud=".length).split("\n")[0];
  process.stdout.write(
    `Created cloud session: ${title}\nSession ID: ${ID}\nView: https://claude.ai/code/${ID}?from=cli&m=0\n` +
      `Resume with: claude --teleport ${ID}\n`,
  );
}

function trustDialogRequired() {
  const trust = process.env.FAKE_CLAUDE_TRUST ?? "trusted";
  if (trust === "prompt") return true;
  if (trust === "file") return !fileTrusted();
  return false;
}

/** Mirrors the server's trust key: main checkout, else toplevel, else cwd. */
function fileTrusted() {
  let projects = {};
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    projects = parsed.projects ?? {};
  } catch {
    return false;
  }
  const keys = new Set([process.cwd()]);
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    keys.add(toplevel);
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common.endsWith("/.git")) keys.add(common.slice(0, -"/.git".length));
  } catch {
    // not a git checkout; cwd is the only key
  }
  for (const key of keys) {
    if (projects[key]?.hasTrustDialogAccepted === true) return true;
  }
  return false;
}
