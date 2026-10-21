# AGENTS.md

Guidance for agents working in this repository. `CLAUDE.md` is a short companion; this file is the fuller operating guide. When they disagree, follow the code.

## What this is

`claude-code-mcp-server` is a Node.js 20+ TypeScript MCP server. It speaks MCP over stdio and exposes exactly three tools that drive the Claude Code CLI:

| Tool | CLI invocation | How it is spawned |
| --- | --- | --- |
| `claude_create_cloud_session` | `claude --cloud=<description> [--environment=<id>]` | Pseudo-terminal (`src/pty.ts`). The CLI rejects this form when stdout is a pipe. |
| `claude_send_followup` | `claude --cloud=<session> -p -- <message>` | `child_process.spawn`, stdin closed (`src/runner.ts`) |
| `claude_auth_status` | `claude auth status` | Same pipe spawn as follow-up |

The server has no HTTP listener, no database, and no network calls of its own. It only spawns the local `claude` binary (or `CLAUDE_BIN`). Session tools always pass `--cloud=` and never start a local Claude Code session.

## Architecture

```text
src/index.ts     load config, connect StdioServerTransport, exit 2 on ConfigError
src/server.ts    tool registration, zod schemas, error shape, create vs pipe dispatch
src/argv.ts      the only place argv is built
src/config.ts    environment variables, validated once at startup
src/runner.ts    pipe spawn, timeout, 4 MiB output cap (follow-up and auth)
src/pty.ts       Python pty helper for create; execs the CLI with no shell
src/trust.ts     detect the workspace-trust dialog; optional ~/.claude.json edit
src/parse.ts     turn CLI text into structured fields
test/fixtures/fake-claude.mjs   stand-in CLI used by the smoke test
```

`createServer` in `src/server.ts` is the composition root. Create goes through `runCliPty`; follow-up and auth go through `runCli`. Both return structured content that matches the tool `outputSchema`. Failures are MCP tool errors whose text body is `{ error: { code, message, args, cli } }` with a code from `ErrorCode`.

Create runs in `CLAUDE_MCP_CWD` (default: the process working directory). `claude --cloud` packages that tree. Workspace trust is keyed on the main git checkout when that directory is inside a repository or worktree, otherwise on the directory itself (`resolveTrustProjectPath`).

## Setup, build, test, lint

Prerequisites on a developer machine: Node.js 20 or later, npm, Python 3 (stdlib only: `pty`, `fcntl`, `termios`), and git. Python is required because create, including the smoke test, allocates a pty with `python3 -I`. No pip packages.

```sh
npm ci          # install from package-lock.json
npm run build   # tsc -p tsconfig.json; emits dist/
npm test        # build, then node:test on the compiled tests
npm start       # node dist/src/index.js (stdio; idle until an MCP client connects)
```

There is no separate lint script and no ESLint or Prettier config. `npm run build` is the static check: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Do not add a linter unless the change is explicitly about linting.

`npm test` runs, in order: `dist/test/parse.test.js`, `dist/test/argv-config.test.js`, `dist/test/trust.test.js`, `dist/test/smoke.test.js`. Tests import the compiled `.js` next to the sources. The smoke fixture stays at `test/fixtures/fake-claude.mjs` and is not compiled.

Runtime environment variables (all optional; invalid values exit the process with code 2):

| Variable | Default | Role |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | CLI path or name |
| `CLAUDE_CLOUD_ENVIRONMENT_ID` | unset | Default `--environment` when a create call omits `environment_id` |
| `CLAUDE_MCP_TIMEOUT_MS` | `300000` | Per-process timeout, then SIGTERM and SIGKILL 5 s later |
| `CLAUDE_MCP_TRUST_CWD` | off | `1` / `true` / `yes` accepts workspace trust for the one resolved directory |
| `CLAUDE_MCP_PYTHON` | `python3` | Interpreter that allocates the create pty |
| `CLAUDE_MCP_CWD` | `process.cwd()` | Directory the CLI runs in; must exist and be a directory |

## Coding conventions

Match the surrounding files:

- ESM (`"type": "module"`), `NodeNext` resolution, and `.js` extensions on relative imports.
- Double quotes, semicolons, trailing commas, 2-space indent, numeric separators (`300_000`).
- Strict zod objects (`.strict()`). Constrain values with patterns, lengths, or enums in the schema. Do not re-validate in handlers.
- Build argv only in `src/argv.ts`, in a fixed order. Pass an array to `spawn` with `shell: false`. Attach values as `--flag=value`, or place them after `--`.
- Keep `assertCloud`: session argv must start with `--cloud=`. Do not switch create to `claude -p <task> --environment=...`; that form drops `--cloud=` and can start a local session on an older CLI.
- Every tool declares an `outputSchema` and returns `structuredContent`. New error codes belong on `ErrorCode` and in the README error table.
- Create and follow-up parsing lives in `src/parse.ts` and does not throw on unrecognised output. Return `parsed: false` and null fields. Auth status is the exception: non-JSON or a missing boolean `loggedIn` throws `AuthParseError`, which becomes `OUTPUT_PARSE_FAILED`.
- Strip terminal control sequences with `cleanTerminalText` before returning `cli` text.
- Keep dependencies to `@modelcontextprotocol/sdk` and `zod` at runtime, plus TypeScript and `@types/node` for dev. No telemetry.
- Check `@modelcontextprotocol/sdk` APIs (`McpServer`, `registerTool`, stdio transport) against current docs before changing them. `.mcp.json` points at the Context7 server. If it is unreachable, read the installed package's `.d.ts` under `node_modules`.

## Testing

`npm test` must pass before a change is done. The suite creates no cloud sessions and does not talk to claude.ai. The smoke test sets `CLAUDE_BIN` to `test/fixtures/fake-claude.mjs`.

When you change behavior, extend the test that owns it:

- Parser regexes and output shapes: `test/parse.test.ts`, using transcripts shaped like real CLI output (labelled lines, JSON lines, ANSI, the trust dialog).
- Argv order and config validation: `test/argv-config.test.ts`.
- Trust-dialog detection, `~/.claude.json` edits, and worktree path resolution: `test/trust.test.ts`. These use a temp directory, not the developer's `~/.claude.json`.
- Tool wiring over stdio (schemas, create, follow-up, auth, failures, trust refusal and accept): `test/smoke.test.ts`. Drive modes with `FAKE_CLAUDE_MODE` and `FAKE_CLAUDE_TRUST`. Do not point tests at a real `claude` binary.

Create smoke cases need Python 3 because they go through the pty helper even when the child is the fake CLI.

## Safety

This process can launch a CLI that packages a repository and, if workspace trust is accepted, runs that folder's hooks and allow rules. Keep the blast radius as it is.

- **Fixed tool allowlist.** The surface is exactly `claude_create_cloud_session`, `claude_send_followup`, and `claude_auth_status`. Do not add a shell tool, a raw-argv tool, or a "run any claude command" tool.
- **Input allowlists.** `environment_id` must match `ENVIRONMENT_ID_PATTERN`. Follow-up `session` must match `SESSION_REF_PATTERN` (a `session_` / `cse_` id or a `https://claude.ai/code/` URL). Description and message are length-capped strings that contain non-whitespace. Unknown properties are rejected before any process is spawned.
- **No arbitrary command execution.** `spawn` and the pty helper (`os.execvp` of the spec binary) never use a shell. The only other subprocess is `git -C <cwd> rev-parse` inside `src/trust.ts`, with a fixed argument list. Do not interpolate user text into a shell command. The pty helper is started as `python3 -I` so it does not import user site packages.
- **Trust is opt-in and narrow.** `CLAUDE_MCP_TRUST_CWD` defaults off. A trust dialog then fails the tool with `WORKSPACE_NOT_TRUSTED` and is not answered. When the flag is on, `ensureWorkspaceTrusted` sets `projects[<one path>].hasTrustDialogAccepted` only, under `~/.claude.json.lock`, and refuses to rewrite a file that is not a JSON object. A description that merely contains "Do you trust this folder?" is not the dialog; `isTrustPrompt` ignores the `Created cloud session:` line. Do not accept trust for extra directories, and do not answer other permission prompts.
- **Do not log tokens or credentials.** Do not print or persist CLI stdout, stderr, `process.env`, or `~/.claude.json`. Auth JSON may carry token material; `parseAuthStatus` copies only `loggedIn`, `authMethod`, `email`, `orgName`, and `subscriptionType`. Do not add token fields to structured output. The `cli` object is the existing diagnostic returned to the MCP client after control sequences are removed; do not add a second log of it.

## Pull requests and commits

History uses a single imperative, sentence-case subject with no type prefix, for example `Run cloud session create under a pseudo-terminal`. Keep the subject specific to the change. Put tests in the same commit as the behavior they cover. Do not commit `node_modules/`, `dist/`, or secrets (see `.gitignore`).

## Cursor Cloud specific instructions

Future Cloud Agents on this repo should boot from a machine where `npm ci` has already run. The committed config is `.cursor/environment.json`.

- **Install:** `npm ci`. It is idempotent: it reinstalls from `package-lock.json`. Do not switch it to `npm install`, which can rewrite the lockfile.
- **Build:** `npm run build`.
- **Test:** `npm test`. This is the full suite.
- **Lint:** no lint script. Use `npm run build` as the typecheck.
- **Base image:** Cursor's default image. It already provides Node.js 22 (the package requires `>=20`) and Python 3. No `.cursor/Dockerfile`.
- **No `start` and no `terminals`.** The server is stdio-only. Nothing needs to listen on a port. `npm start` waits for an MCP client and is not part of boot.
- **The real Claude Code CLI is not available, and there is no claude.ai login.** Do not install the CLI, do not run `claude auth`, and do not set `CLAUDE_BIN` to a real binary in order to make tests pass. `npm test` already points the smoke test at `test/fixtures/fake-claude.mjs`. A missing `claude` on `PATH` is expected.
- **Secrets:** none. Install, build, and test do not read credentials. The `CLAUDE_*` variables above are optional runtime settings for a deployed server; leave them unset here. Do not put tokens, a Claude session, or `~/.claude.json` contents into the repo or into Cursor Secrets for this dev loop.
