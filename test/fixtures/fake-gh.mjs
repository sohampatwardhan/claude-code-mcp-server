#!/usr/bin/env node
// Stand-in for read-only `gh pr list`. The server's argv is fixed; anything
// else exits non-zero so a drifted argument list fails the test.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_GH_ARGV_LOG) {
  appendFileSync(process.env.FAKE_GH_ARGV_LOG, JSON.stringify(args) + "\n");
}

const expected = [
  "pr",
  "list",
  "--repo",
  process.env.FAKE_GH_REPO ?? "acme/widgets",
  "--head",
  process.env.FAKE_GH_BRANCH ?? "claude/session-branch",
  "--state",
  "all",
  "--json",
  "number,url",
  "--limit",
  "1",
];
const same = args.length === expected.length && args.every((arg, index) => arg === expected[index]);
if (!same) {
  process.stderr.write(`fake-gh: unexpected argv ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const number = process.env.FAKE_GH_PR_NUMBER ?? "";
const url = process.env.FAKE_GH_PR_URL ?? "";
if (number === "") {
  process.stdout.write("[]\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify([{ number: Number(number), url }]) + "\n");
