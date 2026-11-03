#!/usr/bin/env node
// Stand-in for the `claude` CLI used by the smoke tests. It mimics the real
// CLI's cloud output and never touches the network.
//
//   FAKE_CLAUDE_ARGV_LOG   if set, the received argv is appended here as a JSON line
//   FAKE_CLAUDE_META_LOG   if set, { args, cwd, pid, stdoutIsTTY, stdinIsTTY } is appended
//   FAKE_CLAUDE_STDIN_LOG  if set, bytes read while the trust dialog is up are appended
//   FAKE_CLAUDE_MODE       "fail" -> exit 1 with stderr; "hang" -> never exit (except
//                          `auth status`, so the sign-in preflight still answers);
//                          "garbled" -> exit 0 with unparseable output;
//                          "signed_out" -> every command fails like a CLI with no login
//                          (auth status prints loggedIn false and exits 1)
//   FAKE_CLAUDE_TRUST      "prompt" -> create always shows the trust dialog
//                          "file"   -> create shows it unless ~/.claude.json trusts this checkout
//                          unset    -> create does not ask (folder already trusted)
//   FAKE_CLAUDE_TRUST_QUESTION
//                          override the dialog question (default is the long form)
//   FAKE_CLAUDE_TRUST_LAYOUT
//                          "2.1.316" draws the current dialog instead: "Quick safety
//                          check" question, words placed with CSI n G, "❯ No, exit"
//                          selected above "Yes, I trust this folder"; the down arrow
//                          then Enter accepts, Enter alone exits 1
//   FAKE_AUTH_STATUS       `auth status` only: "out" prints loggedIn false and exits 1;
//                          "garbled" prints non-JSON; everything else still succeeds
//   FAKE_CLAUDE_CREATE_DELAY_MS
//                          create waits this long before printing the session
//   FAKE_CLAUDE_CREATE_LINGER_MS
//                          create waits this long after printing the session before exiting
//   FAKE_TELEPORT_MODE     "fail" exits 1 and writes a teleport error; "silent"
//                          checks out the branch and writes the debug log with
//                          no pull-request line; "hang" never exits; unset checks
//                          out the branch, writes the debug log, and prints a PR
//                          line when FAKE_TELEPORT_PR_NUMBER and FAKE_TELEPORT_PR_URL are set
//   FAKE_TELEPORT_BRANCH   branch name to check out (default claude/session-branch)
//   FAKE_TELEPORT_ERROR    stderr and debug text for fail mode
//   FAKE_LOCAL_MODE        local print-mode run (`-p` first): unset prints init, an
//                          assistant message and a success result; "max_turns" ends
//                          with an error_max_turns result and exits 1; "hang" prints
//                          init and never exits; "no_result" exits 1 with stderr only
//   FAKE_LOCAL_DELAY_MS    a local run waits this long before its result
//   FAKE_LOCAL_WRITE       a local run writes this file (relative to cwd) before its result
//   FAKE_LOCAL_RATE_LIMIT  a local run emits a rate_limit_event with this status first
//   FAKE_USAGE_MODE        `-p -- /usage`: unset prints a usage_report; "null" reports
//                          rate_limits null; "fail" exits 1; "garbled" prints no report
//   FAKE_USAGE_SESSION_PERCENT / FAKE_USAGE_WEEKLY_PERCENT
//                          percents in that report (default 68 and 10)
//
// Creating a session (`--cloud=<description>` without `-p`) requires a TTY,
// matching Claude Code: a piped stdout exits 3 with the interactive-terminal error.
import { appendFileSync, readFileSync, writeFileSync, writeSync } from "node:fs";
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
      cwd: process.cwd(),
      pid: process.pid,
      stdoutIsTTY: process.stdout.isTTY === true,
      stdinIsTTY: process.stdin.isTTY === true,
    }) + "\n",
  );
}

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const ID = "session_01FakeSessionId0000000000";

const isCreate = () => args[0]?.startsWith("--cloud=") === true && !args.includes("-p");

if (mode === "hang" && !(args[0] === "auth" && args[1] === "status")) {
  setInterval(() => {}, 1_000);
} else if (mode === "fail") {
  process.stderr.write("Error: Unable to create cloud session: environment unavailable\n");
  process.exit(1);
} else if (mode === "signed_out") {
  if (args[0] === "auth" && args[1] === "status") {
    process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2) + "\n");
  } else {
    process.stderr.write("Invalid API key \u00b7 Please run /login\n");
  }
  process.exit(1);
} else if (mode === "garbled") {
  process.stdout.write("something unexpected happened\n");
} else if (args[0] === "auth" && args[1] === "status" && process.env.FAKE_AUTH_STATUS === "out") {
  process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\n", () => process.exit(1));
} else if (args[0] === "auth" && args[1] === "status" && process.env.FAKE_AUTH_STATUS === "garbled") {
  process.stdout.write("auth: something unexpected\n");
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
  process.stdout.write(
    `\u001b7Sent to cloud session.\nSession ID: ${id}\nView: https://claude.ai/code/${id}?from=cli&m=0\n`,
  );
} else if (isCreate()) {
  if (process.stdout.isTTY !== true) {
    process.stderr.write(
      "Error: --cloud requires an interactive terminal. Non-interactive invocations (piped stdout) cannot create a cloud session. Drop --cloud, or run from a TTY.\n",
    );
    process.exit(3);
  }
  if (trustDialogRequired() && process.env.FAKE_CLAUDE_TRUST_LAYOUT === "2.1.316") {
    showCurrentTrustDialog();
  } else if (trustDialogRequired()) {
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
    const delay = Number(process.env.FAKE_CLAUDE_CREATE_DELAY_MS ?? "0");
    const linger = Number(process.env.FAKE_CLAUDE_CREATE_LINGER_MS ?? "0");
    setTimeout(() => {
      writeCreated();
      if (linger > 0) setTimeout(() => process.exit(0), linger);
    }, delay);
  }
} else if (args[0]?.startsWith("--teleport=")) {
  handleTeleport(args[0].slice("--teleport=".length));
} else if (args[0] === "-p" && args.includes("--output-format=stream-json") && args[args.indexOf("--") + 1] === "/usage") {
  handleUsage();
} else if (args[0] === "-p" && args.includes("--output-format=stream-json")) {
  handleLocal();
} else {
  process.stderr.write(`fake-claude: unexpected argv ${JSON.stringify(args)}\n`);
  process.exit(64);
}

function handleTeleport(session) {
  const debugArg = args.find((arg) => arg.startsWith("--debug-file="));
  const debugFile = debugArg === undefined ? "" : debugArg.slice("--debug-file=".length);
  const teleportMode = process.env.FAKE_TELEPORT_MODE ?? "ok";
  const branch = process.env.FAKE_TELEPORT_BRANCH ?? "claude/session-branch";
  if (teleportMode === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  if (teleportMode === "fail") {
    const line = process.env.FAKE_TELEPORT_ERROR ?? "Teleport in print mode failed: branch not on GitHub";
    if (debugFile !== "") writeFileSync(debugFile, `${line}\n`);
    process.stderr.write(`${line}\n`);
    process.exit(1);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    process.stderr.write(`fake-claude: refusing branch ${JSON.stringify(branch)}\n`);
    process.exit(64);
  }
  try {
    execFileSync("git", ["checkout", "-B", branch], { stdio: "ignore" });
  } catch {
    // The debug line still names the branch when this directory is not a checkout.
  }
  const logged = `Switching to branch '${branch}'...\nBranch after checkout: '${branch}'\n`;
  if (debugFile !== "") writeFileSync(debugFile, logged);
  if (teleportMode !== "silent") {
    const number = process.env.FAKE_TELEPORT_PR_NUMBER ?? "";
    const url = process.env.FAKE_TELEPORT_PR_URL ?? "";
    if (number !== "" && url !== "") process.stdout.write(`Opened PR #${number} ${url}\n`);
  }
  process.stdout.write(`teleport ${session}\n`);
  process.exit(0);
}

function writeCreated() {
  const title = args[0].slice("--cloud=".length).split("\n")[0];
  // Same controls as a real Claude Code pty transcript: ESC 7 / ESC 8 (save
  // and restore cursor), SI, and CSI with private parameter bytes (`>`, `<`).
  process.stdout.write(
    "\u001b7\u001b8" +
      `Created cloud session: ${title}\nSession ID: ${ID}\nView: https://claude.ai/code/${ID}?from=cli&m=0\n` +
      `Resume with: claude --teleport ${ID}\n` +
      "\u000f\u001b[>4m\u001b[<u\u001b7\u001b8",
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

function handleUsage() {
  const usageMode = process.env.FAKE_USAGE_MODE ?? "ok";
  const session = "33333333-4444-4555-8666-777777777777";
  const write = (value, done) => process.stdout.write(JSON.stringify(value) + "\n", done);
  if (usageMode === "fail") {
    process.stderr.write("Error: could not load usage\n");
    process.exit(1);
  }
  write({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), tools: [] });
  if (usageMode === "garbled") {
    write({ type: "result", subtype: "success", is_error: false, result: "?", local_command: "usage", num_turns: 0, session_id: session }, () => process.exit(0));
    return;
  }
  const rateLimits =
    usageMode === "null"
      ? null
      : {
          limits: [
            {
              kind: "session",
              group: "session",
              percent: Number(process.env.FAKE_USAGE_SESSION_PERCENT ?? "68"),
              resets_at: "2026-11-02T22:10:00.474794+00:00",
              scope: null,
              severity: "normal",
              is_active: true,
            },
            {
              kind: "weekly_all",
              group: "weekly",
              percent: Number(process.env.FAKE_USAGE_WEEKLY_PERCENT ?? "10"),
              resets_at: "2026-11-06T21:00:00+00:00",
              scope: null,
              severity: "normal",
              is_active: false,
            },
            {
              kind: "weekly_scoped",
              group: "weekly",
              percent: 99,
              resets_at: "2026-11-02T21:00:00+00:00",
              scope: { model: null, surface: { display_name: "Cowork" } },
              severity: "critical",
              is_active: false,
            },
          ],
          extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
        };
  write({
    type: "assistant",
    session_id: session,
    local_command_run: true,
    local_command_source: "<local-command-stdout>Current session: 68% used · Last 24h · 1390 requests</local-command-stdout>",
    message: { role: "assistant", content: [{ type: "text", text: "Current session: 68% used" }] },
    usage_report: {
      session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
      rate_limits: rateLimits,
    },
  });
  write(
    { type: "result", subtype: "success", is_error: false, result: "Current session: 68% used", local_command: "usage", num_turns: 0, total_cost_usd: 0, session_id: session },
    () => process.exit(0),
  );
}

function handleLocal() {
  const localMode = process.env.FAKE_LOCAL_MODE ?? "ok";
  const resume = args.find((arg) => arg.startsWith("--resume="));
  const session = resume === undefined ? "11111111-2222-4333-8444-555555555555" : resume.slice("--resume=".length);
  const prompt = args[args.indexOf("--") + 1] ?? "";
  const emit = (value, done) => process.stdout.write(JSON.stringify(value) + "\n", done);
  if (localMode === "no_result") {
    process.stderr.write("Error: something went wrong before the session started\n");
    process.exit(1);
  }
  emit({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), tools: ["Read", "Edit", "Bash"] });
  if (process.env.FAKE_LOCAL_RATE_LIMIT) {
    emit({
      type: "rate_limit_event",
      session_id: session,
      uuid: "44444444-5555-4666-8777-888888888888",
      rate_limit_info: { status: process.env.FAKE_LOCAL_RATE_LIMIT, resetsAt: 1793743800, utilization: 0.91 },
    });
  }
  if (localMode === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  emit({
    type: "assistant",
    session_id: session,
    message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] },
  });
  setTimeout(() => {
    if (process.env.FAKE_LOCAL_WRITE) writeFileSync(join(process.cwd(), process.env.FAKE_LOCAL_WRITE), `${prompt}\n`);
    const usage = { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 };
    if (localMode === "max_turns") {
      emit({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 3,
        total_cost_usd: 0.02,
        usage,
        permission_denials: [],
        errors: ["Reached maximum number of turns (3)"],
        session_id: session,
      }, () => process.exit(1));
      return;
    }
    // A partial line split across writes, as a pipe can deliver it.
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: `Done: ${prompt}`,
      num_turns: 2,
      total_cost_usd: 0.0123,
      usage,
      permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_01", tool_input: { command: "rm -rf build" } }],
      session_id: session,
    });
    process.stdout.write(line.slice(0, 20));
    setTimeout(() => {
      process.stdout.write(line.slice(20) + "\n", () => process.exit(0));
    }, 20);
  }, Number(process.env.FAKE_LOCAL_DELAY_MS ?? "0"));
}

/**
 * The trust dialog as Claude Code 2.1.316 draws it: every word placed with
 * CSI n G (no spaces), "No, exit" selected first. Down then Enter trusts the
 * folder; Enter on "No, exit" exits 1, like the real CLI.
 */
function showCurrentTrustDialog() {
  const place = (words, start = 2) => {
    let col = start;
    return words
      .map((word) => {
        const out = `\u001b[${col}G${word}`;
        col += [...word].length + 1;
        return out;
      })
      .join("");
  };
  const draw = (selected) => {
    const lines = [
      "\u001b[2G\u001b[1mAccessing workspace:\u001b[22m",
      `\u001b[2G${process.cwd()}`,
      "",
      place("Quick safety check: Is this a project you created or one you trust? (Like your".split(" ")),
      place("own code, a well-known open source project, or work from your team). If not,".split(" ")),
      "",
      `\u001b[2G\u001b[38;5;105m${selected === 0 ? "❯" : " "}\u001b[4GNo,\u001b[8Gexit\u001b[39m`,
      `\u001b[2G${selected === 1 ? "❯" : " "}\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder`,
      "",
      place("Enter to confirm · Esc to cancel".split(" ")),
    ];
    writeSync(1, lines.join("\r\r\n") + "\r\r\n");
  };
  let selected = 0;
  draw(selected);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", (chunk) => {
    if (process.env.FAKE_CLAUDE_STDIN_LOG) appendFileSync(process.env.FAKE_CLAUDE_STDIN_LOG, chunk);
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.includes("\u001b[B")) selected = 1;
    if (text.includes("\u001b[A")) selected = 0;
    if (text.includes("\r") || text.includes("\n")) {
      if (selected === 1) {
        writeCreated();
        process.exit(0);
      }
      process.stderr.write("fake-claude: chose No, exit\n");
      process.exit(1);
    }
  });
}
