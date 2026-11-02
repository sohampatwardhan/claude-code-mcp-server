#!/usr/bin/env node
import { constants } from "node:os";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { stopAll } from "./children.js";
import { ConfigError, loadConfig } from "./config.js";
import { cliNotFoundMessage, findCli } from "./prereq.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`claude-code-mcp-server: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (findCli(config.claudeBin, process.env, config.cwd) === null) {
    // Keep serving: tool calls return CLI_NOT_FOUND with the same message.
    process.stderr.write(`claude-code-mcp-server: warning: ${cliNotFoundMessage(config.claudeBin)}\n`);
  }
  const server = createServer(config);
  await server.connect(new StdioServerTransport());

  // The client closing stdin, or a signal, ends the server. Stop every child
  // it started first, so no claude, git, or pty helper process is left behind.
  let stopping = false;
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    void stopAll().finally(() => process.exit(code));
  };
  process.stdin.once("end", () => shutdown(0));
  process.stdin.once("close", () => shutdown(0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => shutdown(128 + constants.signals[signal]));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`claude-code-mcp-server: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
