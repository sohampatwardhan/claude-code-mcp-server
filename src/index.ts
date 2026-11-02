#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
}

main().catch((err: unknown) => {
  process.stderr.write(`claude-code-mcp-server: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
