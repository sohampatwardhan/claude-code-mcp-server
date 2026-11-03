/**
 * Streamable HTTP transport, off unless `CLAUDE_MCP_HTTP_PORT` is set.
 *
 * Built on Node's own `http` module, with no web framework. Every request is
 * checked in this order before any MCP handling: the Host header (DNS
 * rebinding), the Origin header when a browser sends one, then the bearer
 * token, which is compared in constant time. Only then is the path, method,
 * and body looked at. The transport is stateless: each POST gets a fresh
 * McpServer and transport, sharing one `ServerState`, so jobs outlive the
 * request that started them, as on stdio.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { Config, HttpConfig } from "./config.js";
import { runCli, type Runner } from "./runner.js";
import { createServer, createServerState } from "./server.js";

/** The one path the server answers. */
export const MCP_PATH = "/mcp";

/** Largest request body read. Tool inputs are capped far below this. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** JSON-RPC error code the MCP SDK uses for transport-level rejections. */
const TRANSPORT_ERROR = -32_000;

export interface HttpServerHandle {
  server: Server;
  /** The address actually bound, for a log line or a test (port 0 picks one). */
  url: string;
  /** Stop accepting requests and drop open connections. */
  close(): Promise<void>;
}

/** Start the HTTP listener. Resolves once it is bound. */
export async function startHttpServer(
  config: Config & { http: HttpConfig },
  runner: Runner = runCli,
): Promise<HttpServerHandle> {
  const http = config.http;
  const state = createServerState();
  const expected = digest(http.token);
  const allowed = new Set(http.allowedHosts);

  const server = createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, -32_603, "Internal server error");
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = hostnameOf(req.headers.host);
    if (host === null || !allowed.has(host)) {
      reply(res, 403, TRANSPORT_ERROR, "Host not allowed");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(originHostname(origin) ?? "")) {
      reply(res, 403, TRANSPORT_ERROR, "Origin not allowed");
      return;
    }
    if (!tokenMatches(req.headers.authorization, expected)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="claude-code-mcp-server"');
      reply(res, 401, TRANSPORT_ERROR, "Unauthorized");
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== MCP_PATH) {
      reply(res, 404, TRANSPORT_ERROR, `Not found; the MCP endpoint is ${MCP_PATH}`);
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no GET event stream and no DELETE session teardown.
      res.setHeader("Allow", "POST");
      reply(res, 405, TRANSPORT_ERROR, "Method not allowed");
      return;
    }
    const body = await readBody(req);
    if (body === "too_large") {
      reply(res, 413, TRANSPORT_ERROR, `Request body is larger than ${MAX_BODY_BYTES} bytes`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      reply(res, 400, -32_700, "Parse error");
      return;
    }
    const mcp = createServer(config, runner, state);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(http.port, http.host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : http.port;
  const shown = http.host.includes(":") ? `[${http.host}]` : http.host;
  return {
    server,
    url: `http://${shown}:${port}${MCP_PATH}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
      }),
  };
}

/** True when `header` is `Bearer <token>` for the configured token. Constant time in the token. */
function tokenMatches(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(header ?? "");
  if (match?.[1] === undefined) return false;
  // Hashing first makes both sides the same length, so the comparison leaks neither content nor length.
  return timingSafeEqual(digest(match[1]), expected);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The Host header's hostname, port dropped, IPv6 in brackets, as the URL API parses it. */
function hostnameOf(header: string | undefined): string | null {
  if (header === undefined || header === "") return null;
  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function originHostname(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The request body as text, or `too_large` past MAX_BODY_BYTES (the rest is not read). */
function readBody(req: IncomingMessage): Promise<string | "too_large"> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    return Promise.resolve("too_large");
  }
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolvePromise(over ? "too_large" : Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
}

function reply(res: ServerResponse, status: number, code: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
