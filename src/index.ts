#!/usr/bin/env node
import { constants } from "node:os";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { stopAll } from "./children.js";
import { ConfigError, loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
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
  let stopping = false;
  // Stop every child the server started before exiting, so no claude, git,
  // or pty helper process is left behind.
  const shutdown = (code: number, before: () => Promise<void> = async () => undefined) => {
    if (stopping) return;
    stopping = true;
    void before()
      .catch(() => undefined)
      .then(() => stopAll())
      .finally(() => process.exit(code));
  };

  if (config.http !== null) {
    // HTTP: a signal ends the server. Stdin is ignored; under launchd it is /dev/null.
    const http = await startHttpServer({ ...config, http: config.http });
    process.stderr.write(`claude-code-mcp-server: listening on ${http.url} (Streamable HTTP, bearer token required)\n`);
    if (!["localhost", "127.0.0.1", "::1"].includes(config.http.host)) {
      process.stderr.write(
        `claude-code-mcp-server: warning: bound to ${config.http.host}, not loopback. Prefer 127.0.0.1 behind \`tailscale serve\`; never expose this port to the public internet.\n`,
      );
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => shutdown(128 + constants.signals[signal], () => http.close()));
    }
    return;
  }

  const server = createServer(config);
  await server.connect(new StdioServerTransport());

  // Stdio: the client closing stdin, or a signal, ends the server.
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
