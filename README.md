# Claude Code MCP Server

MCP server that lets AI agents with an always-on cloud computer (e.g. Muse by Meta, Grok Bot by SpaceXSI, ChatGPT Dots by OpenAI, etc) orchestrate Claude Code cloud sessions natively via the Claude Code CLI.

It exposes three tools over stdio: create a cloud session, queue a follow-up message into one, and check the CLI's sign-in state. Each tool maps to one fixed `claude` invocation, and each returns structured JSON. Agents call typed tools and get typed results back, so they never need to write shell commands.

## Design

- **Strict input schemas.** Every field is typed, required fields are listed explicitly, and every schema sets `additionalProperties: false`. Invalid input is rejected by schema validation before any process is spawned.
- **No escape hatch.** The tool surface is exactly the three tools below. There is no "run any claude command" tool and no shell access.
- **Deterministic argv.** Arguments are built from validated inputs in a fixed order and passed as an array (`shell: false`). Values are attached as `--flag=value`, or placed after `--`, so a value that starts with `-` can never be read as a flag. `claude --cloud=<description>` is executed on a pseudo-terminal because the CLI rejects that form when stdout is a pipe; the pty helper `exec`s the same argv and never goes through a shell.
- **Structured outputs.** Every tool declares an `outputSchema` and returns `structuredContent` with parsed fields, such as `session_id` and `session_url`. CLI stdout and stderr are returned in `cli` with terminal control sequences removed.
- **Cloud only.** The session tools always pass `--cloud`. The server never starts a local Claude Code session.
- **No network of its own, no telemetry.** It only runs the local `claude` binary.

## Prerequisites

- Node.js 20 or later
- The [Claude Code CLI](https://code.claude.com/docs), installed and signed in (`claude auth status` should report `"loggedIn": true`), with cloud sessions available on your account
- Python 3 (the standard library only: `pty`, `fcntl`, `termios`) for `claude_create_cloud_session`. No pip packages. Follow-ups and auth status do not need Python. On Debian/Ubuntu this is the `python3` package, which is usually already installed.

## Install

The package on npm is `@sohampatwardhan/claude-code-mcp-server`. Orchestrator agents start it over stdio:

```sh
npx -y @sohampatwardhan/claude-code-mcp-server@latest
```

The published bin is `claude-code-mcp-server` (`#!/usr/bin/env node`). Stdio is the only transport. Logs go to stderr so they stay off the JSON-RPC stream. The MCP server name is `claude-code-mcp-server`.

The client must be able to run the Claude Code CLI. Install it and sign in on the same machine (`claude auth status` should report `"loggedIn": true`), with cloud sessions available on the account. Python 3 (stdlib only) is required for `claude_create_cloud_session`. See [Prerequisites](#prerequisites).

`claude --cloud` packages the working directory. Set the client's `cwd` to the repository the session should work on, or set `CLAUDE_MCP_CWD` when the host can pass environment variables but not a working directory. The full list is in [Environment variables](#environment-variables).

### Cursor

Add this to `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/claude-code-mcp-server@latest"],
      "cwd": "/absolute/path/to/the/repo/sessions/should/work/on",
      "env": {
        "CLAUDE_MCP_CWD": "/absolute/path/to/the/repo/sessions/should/work/on"
      }
    }
  }
}
```

`cwd` and `CLAUDE_MCP_CWD` should be the same directory. If the client has no `cwd` field, `CLAUDE_MCP_CWD` alone is enough.

### Claude Desktop

The same `mcpServers` block goes in the desktop config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Restart Claude Desktop after saving. Point `cwd` / `CLAUDE_MCP_CWD` at the repository the cloud session should package.

### Generic stdio

Any MCP client that launches a local process uses the same command. Field names vary (`mcpServers` vs `servers`, and some clients omit `type`).

```json
{
  "mcpServers": {
    "claude-code": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/claude-code-mcp-server@latest"],
      "env": {
        "CLAUDE_MCP_CWD": "/absolute/path/to/your/repo",
        "CLAUDE_BIN": "claude",
        "CLAUDE_MCP_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

## Run

The server speaks MCP over stdin/stdout. Normally the MCP client launches it, so you don't run it by hand. From a checkout, after `npm run build`:

```sh
npm start                       # same as: node dist/src/index.js
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | Path or name of the Claude Code CLI binary. |
| `CLAUDE_CLOUD_ENVIRONMENT_ID` | unset | Default cloud environment id (for example `ccpool_...`), passed as `--environment` when a call does not pass `environment_id`. |
| `CLAUDE_MCP_TIMEOUT_MS` | `300000` | Hard timeout for each spawned CLI process, in milliseconds (positive integer). On timeout the process gets SIGTERM, then SIGKILL 5 s later. |
| `CLAUDE_MCP_TRUST_CWD` | unset (off) | `1`, `true`, or `yes` lets create accept Claude Code's workspace-trust dialog for `CLAUDE_MCP_CWD` only (the process working directory when that is unset). `0`, `false`, `no`, or unset leaves the dialog unanswered and the call fails with `WORKSPACE_NOT_TRUSTED`. |
| `CLAUDE_MCP_PYTHON` | `python3` | Python 3 interpreter used to allocate the pseudo-terminal for create. |
| `CLAUDE_MCP_CWD` | process working directory | Directory the CLI runs in. `claude --cloud` packages this tree, and workspace trust is resolved from it. A relative path is resolved at startup. The path must exist and be a directory. |

If any of these values is invalid, the server exits at startup with code 2 and prints a message on stderr.

The CLI runs in `CLAUDE_MCP_CWD`, or in the server process's working directory when that variable is unset or blank. `claude --cloud` packages the repository in that directory for the new session. Set the client's `cwd` to the repository you want the cloud sessions to work on, or set `CLAUDE_MCP_CWD` when the host can pass environment variables but not a working directory. An invalid `CLAUDE_MCP_CWD` (missing path, or a path that is not a directory) makes the server exit at startup with code 2.

### Workspace trust

`claude --cloud <description>` requires an interactive terminal. On a pseudo-terminal the CLI then stops at "Do you trust this folder?" until someone answers, because accepting trust lets that folder's project hooks, allow rules, and `.mcp.json` servers run.

This server does not answer that dialog on its own. Either:

- Trust the folder yourself: run `claude` once in that directory and accept the dialog, or set `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`. `<path>` is the main git checkout when `CLAUDE_MCP_CWD` is a repository or worktree, and `CLAUDE_MCP_CWD` itself otherwise (the process working directory when the variable is unset). Claude Code documents this key under [project allow rules and workspace trust](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust).
- Or set `CLAUDE_MCP_TRUST_CWD=1`. Create then writes that same key for the one directory above and, if the dialog still appears, sends Enter once. The opt-in covers that one directory. Create still runs with the CLI's normal permission prompts.

The trust edit holds `~/.claude.json.lock` (exclusive create, treated as stale after 5 seconds) so two of these servers do not interleave. Inside the lock it re-reads `~/.claude.json` immediately before an atomic rename, skips the write when `hasTrustDialogAccepted` is already true, and retries the merge when the file changed since the first read so other fields are kept.

Claude Code does not take that lock. A Claude process that saves `~/.claude.json` after this server's second read can overwrite the trust flag, and a save that lands between that read and the rename can itself be overwritten. If the dialog comes back, set the flag again while no Claude process is writing the file.

A description that merely contains the words "Do you trust this folder?" is not treated as the dialog. The `Created cloud session:` title line is ignored when the server looks for the prompt.

Trust is stored in `~/.claude.json` in the home directory (not under `~/.claude/`). When `~/.claude.json` is missing or is not a JSON object, the opt-in leaves it unchanged and answers the dialog on the pty instead. Claude Code treats the home directory itself as trusted for the current session only, so a server whose `CLAUDE_MCP_CWD` is `$HOME` still needs the opt-in for the pty to press Enter.

## Tool reference

Every successful call returns `structuredContent` that matches the tool's `outputSchema`, and the same JSON as a text content block.

### `claude_create_cloud_session`

Creates a new cloud session. Runs, on a pseudo-terminal: `claude --cloud=<description> [--environment=<id>]`

The CLI rejects `--cloud` with a task description when stdout is a pipe (`--cloud requires an interactive terminal`). There is a non-interactive create form, `claude -p <task> --environment <ccpool>`, but it only targets self-hosted environments and it omits `--cloud`. This server keeps `--cloud=` on every create so an older CLI cannot fall through to a local session. A pty has a single output stream, so the CLI's stdout and stderr are both returned in `cli.stdout` (`cli.stderr` is empty on this tool). `cli.stdout` and `cli.stderr` have terminal control sequences removed (cursor save and restore, CSI including private parameters, and other C0 controls) before they are returned.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "description": { "type": "string", "minLength": 1, "maxLength": 100000, "pattern": "\\S" },
    "environment_id": { "type": "string", "maxLength": 200, "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]*$" }
  },
  "required": ["description"],
  "additionalProperties": false
}
```

The environment id is chosen in this order: `environment_id` from the call, then `CLAUDE_CLOUD_ENVIRONMENT_ID`, then none (no `--environment` flag).

Output:

```json
{
  "session_id": "session_01AbC...",
  "session_url": "https://claude.ai/code/session_01AbC...?from=cli&m=0",
  "title": "Fix flaky login test",
  "parsed": true,
  "environment_id": null,
  "args": ["--cloud=Fix flaky login test"],
  "cli": { "exit_code": 0, "stdout": "Created cloud session: ...", "stderr": "" }
}
```

`parsed` is `true` when both `session_id` and `session_url` were found in the CLI output. If the output can't be parsed, the call still succeeds with `parsed: false`, the unparsed fields set to `null`, and the cleaned output in `cli`.

### `claude_send_followup`

Queues a message into an existing cloud session. Runs: `claude --cloud=<session> -p -- <message>`

Input schema:

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "maxLength": 2000,
      "pattern": "^(?:(?:session|cse)_[A-Za-z0-9][A-Za-z0-9_-]*|https:\\/\\/claude\\.ai\\/code\\/[^\\s\"'<>]+)$"
    },
    "message": { "type": "string", "minLength": 1, "maxLength": 100000, "pattern": "\\S" }
  },
  "required": ["session", "message"],
  "additionalProperties": false
}
```

Output:

```json
{
  "session": "session_01AbC...",
  "session_id": "session_01AbC...",
  "session_url": "https://claude.ai/code/session_01AbC...?from=cli&m=0",
  "sent": true,
  "parsed": true,
  "args": ["--cloud=session_01AbC...", "-p", "--", "Also update the docs"],
  "cli": { "exit_code": 0, "stdout": "Sent to cloud session.\n...", "stderr": "" }
}
```

`sent` is `true` when the CLI confirmed delivery (`Sent to cloud session.`).

### Session progress

The CLI has no command that prints a cloud session's status or latest reply. `claude -p --cloud <session>` only queues a follow-up and exits; `claude agents` and `claude logs` talk to local background sessions, not claude.ai cloud sessions. Callers check progress by opening `session_url`. On a self-hosted environment a Stop hook on the runner can capture replies (see [Test self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments-testing)); that hook is outside this server, and the server makes no network calls of its own.

### `claude_auth_status`

Reports the CLI's sign-in state. Runs: `claude auth status`

Input schema:

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

Output (fields the CLI does not print are `null`):

```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "email": "dev@example.com",
  "orgName": "Example Org",
  "subscriptionType": "max",
  "cli": { "exit_code": 0, "stdout": "{...}", "stderr": "" }
}
```

### Errors

Failures come back as MCP tool errors (`isError: true`). The text content block holds JSON with this fixed shape:

```json
{
  "error": {
    "code": "CLI_EXIT_NONZERO",
    "message": "claude exited with code 1: Error: Unable to create cloud session ...",
    "args": ["--cloud=..."],
    "cli": { "exit_code": 1, "stdout": "", "stderr": "Error: ..." }
  }
}
```

| `code` | When |
| --- | --- |
| `CLI_EXIT_NONZERO` | The CLI exited non-zero or was killed by a signal. `message` includes the stderr text. |
| `CLI_TIMEOUT` | The CLI ran longer than `CLAUDE_MCP_TIMEOUT_MS`. |
| `CLI_NOT_FOUND` | `CLAUDE_BIN` could not be found. `cli` is `null`. |
| `CLI_SPAWN_FAILED` | The process could not be started for another reason. `cli` is `null`. |
| `OUTPUT_PARSE_FAILED` | `claude auth status` did not print JSON with a boolean `loggedIn`. |
| `PTY_UNAVAILABLE` | Create could not start the Python interpreter that allocates the pseudo-terminal (`CLAUDE_MCP_PYTHON`). `cli` is `null`. |
| `WORKSPACE_NOT_TRUSTED` | Create reached Claude Code's workspace-trust dialog and `CLAUDE_MCP_TRUST_CWD` is off, so the dialog was not answered. |

Schema violations (a missing required field, an unknown property, a value that doesn't match a pattern) are rejected by the MCP SDK's input validation as tool errors, and the CLI is never run.

## Client configuration

Cursor, Claude Desktop, and a generic stdio entry are in [Install](#install). The same `npx` command is what Muse, Grok, and other orchestrators should launch. Pass `CLAUDE_CLOUD_ENVIRONMENT_ID` when every create should target one cloud environment:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/claude-code-mcp-server@latest"],
      "env": {
        "CLAUDE_MCP_CWD": "/absolute/path/to/your/repo",
        "CLAUDE_CLOUD_ENVIRONMENT_ID": "ccpool_your_environment_id"
      }
    }
  }
}
```

A global install (`npm install -g @sohampatwardhan/claude-code-mcp-server`) exposes the same bin as `"command": "claude-code-mcp-server"` with `"args": []`.

## Development

```sh
git clone https://github.com/sohampatwardhan/claude-code-mcp-server.git
cd claude-code-mcp-server
npm install
npm run build
npm test        # unit tests + stdio smoke test (uses a fake CLI; creates no sessions)
```

```text
src/
  index.ts    entry point (bin): loads config, starts the stdio server
  server.ts   tool definitions, input/output schemas, error shape
  argv.ts     deterministic argv construction for each tool
  parse.ts    CLI output parsing (session id / URL regexes, auth JSON)
  runner.ts   child_process spawn with timeout and output caps (follow-up and auth)
  pty.ts      pseudo-terminal spawn used by create (embedded Python helper)
  trust.ts    workspace-trust dialog detection and the opt-in ~/.claude.json edit
  config.ts   environment variable parsing and validation
test/
  parse.test.ts        parser unit tests against realistic CLI output
  argv-config.test.ts  argv and config unit tests
  trust.test.ts        trust-dialog detection, ~/.claude.json edits, worktree path
  smoke.test.ts        starts the built server over stdio and exercises every tool
  fixtures/fake-claude.mjs  stand-in CLI used by the smoke test (TTY and trust dialog)
```

`prepack` compiles TypeScript into `dist/` and marks `dist/src/index.js` executable before the package is packed. CI runs `npm ci`, then `npm run build` and `npm test`.

## Releasing

The owner publishes `0.1.0` once from a maintainer machine. Trusted publishing on npmjs.com can be saved only after that package exists. Later versions then publish from the tag workflow. Skip the `v0.1.0` tag for this bootstrap: the workflow would try to publish `0.1.0` again.

```sh
npm login
npm ci
npm publish --access public
```

Leave `--provenance` off for that local publish. Provenance is added by the GitHub Actions workflow, which has the OIDC token.

On npmjs.com, open `@sohampatwardhan/claude-code-mcp-server` → Settings → Trusted publishing (the section is also labeled Trusted Publisher). Choose GitHub Actions and enter:

| Field | Value |
| --- | --- |
| Organization or user | `sohampatwardhan` |
| Repository | `claude-code-mcp-server` |
| Workflow filename | `release.yml` |
| Environment name | empty |

The filename is `release.yml` only, not `.github/workflows/release.yml`. Allow direct `npm publish`. A publisher created after 3 September 2026 starts with `npm stage publish` allowed and does not allow `npm publish` until that action is selected. Leave dist-tag management off. The same link can be created with npm CLI 11.15.0 or newer:

```sh
npm trust github @sohampatwardhan/claude-code-mcp-server \
  --repo sohampatwardhan/claude-code-mcp-server \
  --file release.yml \
  --allow-publish
```

The first successful publish from that workflow has to happen within two days of saving the publisher, or the configuration expires. Cut the next version for that check:

```sh
npm version patch   # or minor, or major
git push --follow-tags
```

`npm version` writes the version and a `vX.Y.Z` tag. `.github/workflows/release.yml` runs on that tag (and on a manual run that names the tag). It refuses the job when the tag is not `v` plus `package.json` `"version"`, then runs `npm ci`, build, and test, publishes with `npm publish --provenance --access public`, and opens a GitHub Release with generated notes. Trusted publishing authenticates that step with GitHub OIDC.

## License

[MIT](LICENSE)
