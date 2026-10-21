# CLAUDE.md

MCP server (TypeScript, Node 20+, `@modelcontextprotocol/sdk`, stdio) that wraps the Claude Code CLI's cloud-session commands as MCP tools.

## Commands

- `npm run build`: compile `src/` and `test/` to `dist/`
- `npm test`: build, then run all tests with `node:test` (no real sessions; the smoke test uses `test/fixtures/fake-claude.mjs`)
- `npm start`: run the server over stdio

## Conventions

- **Cloud sessions.** Create and follow-up must invoke the CLI with `--cloud=` (`assertCloud` in `src/argv.ts`). They must never fall back to a local Claude Code session, even when a cloud call fails. `claude_get_session` is the exception: it runs print-mode `claude --teleport=<session> --debug --debug-file=<cache file>` (`teleportArgv`) inside `CLAUDE_MCP_REPO_CACHE` only, with no prompt and no pty, so the CLI checks out the branch the cloud session pushed and exits. Do not point teleport at a caller's checkout, do not add a prompt, and do not drop `--cloud=` from create or follow-up.
- **Determinism first.** The tool surface is exactly `claude_create_cloud_session`, `claude_send_followup`, `claude_get_session` and `claude_auth_status`. Don't add a catch-all, raw-shell or "arbitrary claude args" tool. `claude_get_session` returns the pushed branch and pull request; it does not return the assistant transcript.
- **Repositories.** A create call may name any github.com `owner/name` (no per-repo allowlist). The server clones it into `CLAUDE_MCP_REPO_CACHE` with a fixed `git` argv (`shell: false`), sets `origin` to `https://github.com/<owner>/<name>.git`, and checks out optional `base_branch`. Local absolute directories still have to match `CLAUDE_MCP_REPOS` and are never fetched or reset. Don't accept other hosts, tokens, arbitrary paths, or refspecs. `gh pr list` is the only `gh` argv, and it is read-only.
- Input schemas are strict zod objects (`.strict()` gives `additionalProperties: false`). Every field is typed, with patterns or enums wherever the value set is constrained. Validate in the schema, not ad hoc in handlers.
- Argv is built only in `src/argv.ts`, in a fixed order, and passed as an array to `spawn` with `shell: false`. Attach values as `--flag=value`, or place them after `--`, so they can't be read as flags.
- Every tool declares an `outputSchema` and returns `structuredContent`. Errors use the `{ error: { code, message, args, cli } }` shape with a code from `ErrorCode` in `src/server.ts`.
- Output parsing lives in `src/parse.ts` and never throws on unrecognised create/follow-up output. It returns `parsed: false` plus the raw output instead. When you change a regex, add test cases built from real CLI output.
- Keep dependencies minimal (the SDK and zod at runtime; TypeScript and `@types/node` for dev). No telemetry. The server makes no network calls of its own except `git clone` / `git fetch` for a validated github.com `owner/name` into the cache, and `gh pr list` when session status needs a pull request.

## Library docs

- Check library APIs (above all `@modelcontextprotocol/sdk`: server setup, `registerTool`, schema handling, stdio transport) against current docs before writing or changing code against them. Don't rely on memory. `.mcp.json` registers the Context7 MCP server (`https://mcp.context7.com/mcp`) for this. If Context7 is unreachable, check the installed package's `.d.ts`/source under `node_modules` for the pinned version. Where docs and memory disagree, the docs win.
