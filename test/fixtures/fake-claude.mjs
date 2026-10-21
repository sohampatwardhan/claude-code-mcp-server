#!/usr/bin/env node
// Stand-in for the `claude` CLI used by the smoke tests. It mimics the real
// CLI's cloud output and never touches the network.
//
//   FAKE_CLAUDE_ARGV_LOG  if set, the received argv is appended here as a JSON line
//   FAKE_CLAUDE_MODE      "fail" -> exit 1 with stderr; "hang" -> never exit;
//                         "garbled" -> exit 0 with unparseable output
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify(args) + "\n");
}

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const ID = "session_01FakeSessionId0000000000";

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
} else if (args[0]?.startsWith("--cloud=")) {
  const title = args[0].slice("--cloud=".length).split("\n")[0];
  process.stdout.write(
    `Created cloud session: ${title}\nSession ID: ${ID}\nView: https://claude.ai/code/${ID}?from=cli&m=0\n` +
      `Resume with: claude --teleport ${ID}\n`,
  );
} else {
  process.stderr.write(`fake-claude: unexpected argv ${JSON.stringify(args)}\n`);
  process.exit(64);
}
