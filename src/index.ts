#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
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
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`claude-code-mcp-server: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
