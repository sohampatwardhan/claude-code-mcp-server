# CLAUDE.md

MCP server (TypeScript, Node 20+, `@modelcontextprotocol/sdk`, stdio) that wraps the Claude Code CLI's cloud-session commands as MCP tools.

## Commands

- `npm run build`: compile `src/` and `test/` to `dist/`
- `npm test`: build, then run all tests with `node:test` (no real sessions; the smoke test uses `test/fixtures/fake-claude.mjs`)
- `npm start`: run the server over stdio

## Conventions

- **Cloud sessions only.** Session tools must always invoke the CLI with `--cloud=`. They must never fall back to running a local Claude Code session, even when a cloud call fails. `src/argv.ts` asserts this invariant, so don't remove it.
- **Determinism first.** The tool surface is exactly `claude_create_cloud_session`, `claude_send_followup` and `claude_auth_status`. Don't add a catch-all, raw-shell or "arbitrary claude args" tool.
- Input schemas are strict zod objects (`.strict()` gives `additionalProperties: false`). Every field is typed, with patterns or enums wherever the value set is constrained. Validate in the schema, not ad hoc in handlers.
- Argv is built only in `src/argv.ts`, in a fixed order, and passed as an array to `spawn` with `shell: false`. Attach values as `--flag=value`, or place them after `--`, so they can't be read as flags.
- Every tool declares an `outputSchema` and returns `structuredContent`. Errors use the `{ error: { code, message, args, cli } }` shape with a code from `ErrorCode` in `src/server.ts`.
- Output parsing lives in `src/parse.ts` and never throws on unrecognised create/follow-up output. It returns `parsed: false` plus the raw output instead. When you change a regex, add test cases built from real CLI output.
- Keep dependencies minimal (the SDK and zod at runtime; TypeScript and `@types/node` for dev). No telemetry, and no network calls of the server's own.

## Library docs

- Check library APIs (above all `@modelcontextprotocol/sdk`: server setup, `registerTool`, schema handling, stdio transport) against current docs before writing or changing code against them. Don't rely on memory. `.mcp.json` registers the Context7 MCP server (`https://mcp.context7.com/mcp`) for this. If Context7 is unreachable, check the installed package's `.d.ts`/source under `node_modules` for the pinned version. Where docs and memory disagree, the docs win.
