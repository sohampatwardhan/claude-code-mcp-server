# Claude Code MCP Server

MCP server that lets AI agents with an always-on cloud computer (e.g. Muse by Meta, Grok Bot by SpaceXSI, ChatGPT Dots by OpenAI, etc) orchestrate Claude Code cloud sessions natively via the Claude Code CLI.

It exposes three tools over stdio: create a cloud session, queue a follow-up message into one, and check the CLI's sign-in state. Each tool maps to one fixed `claude` invocation, and each returns structured JSON. Agents call typed tools and get typed results back, so they never need to write shell commands.

## Design

- **Strict input schemas.** Every field is typed, required fields are listed explicitly, and every schema sets `additionalProperties: false`. Invalid input is rejected by schema validation before any process is spawned.
- **No escape hatch.** The tool surface is exactly the three tools below. There is no "run any claude command" tool and no shell access.
- **Deterministic argv.** Arguments are built from validated inputs in a fixed order and passed as an array (`shell: false`). Values are attached as `--flag=value`, or placed after `--`, so a value that starts with `-` can never be read as a flag. `claude --cloud=<description>` is executed on a pseudo-terminal because the CLI rejects that form when stdout is a pipe; the pty helper `exec`s the same argv and never goes through a shell.
- **Structured outputs.** Every tool declares an `outputSchema` and returns `structuredContent` with parsed fields, such as `session_id` and `session_url`. CLI stdout and stderr are returned in `cli` with terminal control sequences removed.
- **Cloud only.** The session tools always pass `--cloud`. The server never starts a local Claude Code session.
- **No network of its own, no telemetry.** It only runs the local `claude` binary. The one exception is `git clone` and `git fetch` for a github.com repository named on `CLAUDE_MCP_REPOS`, into a cache directory this server owns.

## Prerequisites

- Node.js 20 or later
- The [Claude Code CLI](https://code.claude.com/docs), installed and signed in (`claude auth status` should report `"loggedIn": true`), with cloud sessions available on your account
- Python 3 (the standard library only: `pty`, `fcntl`, `termios`) for `claude_create_cloud_session`. No pip packages. Follow-ups and auth status do not need Python. On Debian/Ubuntu this is the `python3` package, which is usually already installed.
- Git, when a call selects a github.com repository from `CLAUDE_MCP_REPOS`. The server runs `git` with a fixed argument list. Directory entries on that list do not need a separate clone.

## Install and build

```sh
git clone <this repo> claude-code-mcp-server
cd claude-code-mcp-server
npm install
npm run build
npm test        # unit tests + stdio smoke test (uses a fake CLI; creates no sessions)
```

## Run

```sh
npm start                       # same as: node dist/src/index.js
```

The server speaks MCP over stdin/stdout. Normally the MCP client launches it, so you don't run it by hand.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | Path or name of the Claude Code CLI binary. |
| `CLAUDE_CLOUD_ENVIRONMENT_ID` | unset | Default cloud environment id (for example `ccpool_...`), passed as `--environment` when a call does not pass `environment_id`. |
| `CLAUDE_MCP_TIMEOUT_MS` | `300000` | Hard timeout for each spawned CLI process, in milliseconds (positive integer). On timeout the process gets SIGTERM, then SIGKILL 5 s later. |
| `CLAUDE_MCP_TRUST_CWD` | unset (off) | `1`, `true`, or `yes` lets create accept Claude Code's workspace-trust dialog for `CLAUDE_MCP_CWD` only (the process working directory when that is unset). `0`, `false`, `no`, or unset leaves the dialog unanswered and the call fails with `WORKSPACE_NOT_TRUSTED`. |
| `CLAUDE_MCP_PYTHON` | `python3` | Python 3 interpreter used to allocate the pseudo-terminal for create. |
| `CLAUDE_MCP_CWD` | process working directory | Directory the CLI runs in when a call omits `repo`. `claude --cloud` packages this tree, and workspace trust is resolved from it. A relative path is resolved at startup. The path must exist and be a directory. |
| `CLAUDE_MCP_REPOS` | empty | Comma-separated allowlist of repositories a create call may select. Each entry is an absolute directory that exists at startup, or a github.com `owner/name` (a `https://github.com/owner/name` URL is stored as the slug). Anything else is rejected at startup. |
| `CLAUDE_MCP_REPO_CACHE` | `~/.claude-mcp/repos` | Directory that holds checkouts of allowlisted GitHub repositories. Created on first use. An existing path must be a directory. |

If any of these values is invalid, the server exits at startup with code 2 and prints a message on stderr.

When a create call omits `repo`, the CLI runs in `CLAUDE_MCP_CWD`, or in the server process's working directory when that variable is unset or blank. `claude --cloud` packages the repository in the directory it is started in: the cloud VM clones that directory's GitHub remote at the current branch, or uploads the local tree when it cannot clone the remote. Set the client's `cwd` or `CLAUDE_MCP_CWD` to the default repository. An invalid `CLAUDE_MCP_CWD` (missing path, or a path that is not a directory) makes the server exit at startup with code 2.

### Choosing a repository per call

`claude --cloud` has no flag for a repository URL. The repository is whichever checkout the command runs in ([Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)). Create accepts an optional `repo` so one connector can start sessions in more than one place. The value has to be on `CLAUDE_MCP_REPOS`:

- An absolute directory on the list is used as the CLI working directory. The server does not fetch, reset, or otherwise modify that checkout.
- A github.com `owner/name` on the list (or the same repository written as `https://github.com/owner/name`) is cloned into `CLAUDE_MCP_REPO_CACHE/<owner>/<name>` with `git clone https://github.com/<owner>/<name>.git`. Later calls fetch and reset that cache checkout to the remote's default branch, and remove untracked files there. A cache directory whose `origin` is a different URL is left unchanged and the call fails. Private repositories use whatever credential helper `git` already has. The server does not read tokens from the tool arguments.
- Any other value, including a subdirectory of an allowlisted directory, a relative path, or a repository that is not on the list, fails with `REPO_NOT_ALLOWED` and the CLI is not started. A clone or fetch failure fails with `REPO_PREPARE_FAILED`.

Workspace trust follows the directory that was selected. With `CLAUDE_MCP_TRUST_CWD=1`, the opt-in writes the trust flag for that directory's main git checkout (or the directory itself when it is not a repository) and answers the dialog only for that folder.

### Workspace trust

`claude --cloud <description>` requires an interactive terminal. On a pseudo-terminal the CLI then stops at "Do you trust this folder?" until someone answers, because accepting trust lets that folder's project hooks, allow rules, and `.mcp.json` servers run.

This server does not answer that dialog on its own. Either:

- Trust the folder yourself: run `claude` once in that directory and accept the dialog, or set `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`. `<path>` is the main git checkout when the selected directory is a repository or worktree, and the directory itself otherwise. The selected directory is `repo` when the call sets one, and `CLAUDE_MCP_CWD` otherwise (the process working directory when that variable is unset). Claude Code documents this key under [project allow rules and workspace trust](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust).
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
    "environment_id": { "type": "string", "maxLength": 200, "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
    "repo": { "type": "string", "minLength": 1, "maxLength": 4096 }
  },
  "required": ["description"],
  "additionalProperties": false
}
```

The environment id is chosen in this order: `environment_id` from the call, then `CLAUDE_CLOUD_ENVIRONMENT_ID`, then none (no `--environment` flag). `repo` matches an absolute path, a github.com `owner/name`, or a `https://github.com/owner/name` URL, and it has to be on `CLAUDE_MCP_REPOS`. Omit `repo` to use the default directory; the output field is then `null`. When `repo` is set, `cwd` is the directory the CLI ran in and `repo` is the normalized value (`owner/name`, or the canonical directory path).

Output:

```json
{
  "session_id": "session_01AbC...",
  "session_url": "https://claude.ai/code/session_01AbC...?from=cli&m=0",
  "title": "Fix flaky login test",
  "parsed": true,
  "environment_id": null,
  "cwd": "/absolute/path/to/the/repo",
  "repo": "owner/name",
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

There is no supported way for this server to read a cloud session's status or latest assistant message, so it does not expose a `claude_get_session` tool. Callers open `session_url`.

The current CLI documents these related commands, and none of them is a read of a claude.ai cloud session:

- [`claude -p --cloud <session>`](https://code.claude.com/docs/en/claude-code-on-the-web) queues one message and exits. It does not wait for a reply. `--output-format json` on that command returns `{ok, session_id, url}` (or `{ok: false, session_id, error}`), and `--output-format stream-json` is not supported with `--cloud`. The same page says to open the session on claude.ai to check progress. The [CLI reference](https://code.claude.com/docs/en/cli-reference) (also published at [docs.claude.com](https://docs.claude.com/en/docs/claude-code/cli-reference)) describes `--cloud` the same way: a task description creates a session, and a session id with `-p` queues a message.
- [`claude --teleport <session>`](https://code.claude.com/docs/en/claude-code-on-the-web) resumes the cloud session in a local terminal. It fetches and checks out the session's branch, prompts to stash uncommitted changes, and loads the conversation into a local session whose later work stays on that machine. That modifies a checkout and starts a local Claude Code session, so it is not a safe read of status or of the latest cloud reply.
- [`claude --resume`](https://code.claude.com/docs/en/sessions), `claude logs`, and `claude agents --json` address local and background sessions stored on this machine. [Manage sessions](https://code.claude.com/docs/en/sessions) says the desktop app, claude.ai/code, and the CLI each keep their own session list, and the cloud-sessions page says `--resume` does not list cloud sessions. `/export` renders the conversation of a local CLI session. [Headless](https://code.claude.com/docs/en/headless) `--output-format json` is the result of a local `claude -p` run.
- [`--remote`](https://code.claude.com/docs/en/cli-reference) is a deprecated alias of `--cloud`. `--remote-control` steers a local session from another device. Neither reports a cloud session's messages.

On a self-hosted environment a Stop hook on the runner can capture replies (see [Test self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments-testing)). That hook runs on the runner, outside this server.

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
| `REPO_NOT_ALLOWED` | `repo` is missing from `CLAUDE_MCP_REPOS`, or it is not an absolute directory or a github.com `owner/name`. The CLI is not started. |
| `REPO_PREPARE_FAILED` | Preparing the allowlisted GitHub checkout failed (git missing, clone or fetch error, lock timeout, or the cache directory has a different `origin`). |

Schema violations (a missing required field, an unknown property, a value that doesn't match a pattern) are rejected by the MCP SDK's input validation as tool errors, and the CLI is never run.

## Client configuration

The server uses standard MCP stdio, so any client that accepts an `mcpServers`-style stdio entry can launch it. Use absolute paths, since clients usually launch servers from their own working directory.

### Generic MCP stdio config

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-mcp-server/dist/src/index.js"],
      "cwd": "/absolute/path/to/the/repo/sessions/should/work/on",
      "env": {
        "CLAUDE_BIN": "claude",
        "CLAUDE_MCP_TIMEOUT_MS": "300000",
        "CLAUDE_MCP_REPOS": "/absolute/path/to/a/local/checkout,owner/name"
      }
    }
  }
}
```

If you've installed the package globally (`npm install -g .` from this repo), you can use `"command": "claude-code-mcp-server"` with `"args": []` instead.

### Muse

Add the server as a stdio MCP server in Muse's MCP server configuration:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-mcp-server/dist/src/index.js"],
      "cwd": "/absolute/path/to/your/repo",
      "env": {
        "CLAUDE_CLOUD_ENVIRONMENT_ID": "ccpool_your_environment_id"
      }
    }
  }
}
```

### Grok and other MCP clients

Any MCP client that can launch a local stdio server uses the command (`node`), the args (the path to `dist/src/index.js`), and optional env vars. When the client has no `cwd` field, set `CLAUDE_MCP_CWD` to the repository the cloud sessions should package. For example:

```json
{
  "mcpServers": {
    "claude-code": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/claude-code-mcp-server/dist/src/index.js"],
      "env": {
        "CLAUDE_MCP_CWD": "/absolute/path/to/your/repo"
      }
    }
  }
}
```

Field names vary slightly between clients (some leave out `type`, and some call the map `servers`). Check your client's MCP documentation for the exact config file location and keys.

## Development

```text
src/
  index.ts    entry point (bin): loads config, starts the stdio server
  server.ts   tool definitions, input/output schemas, error shape
  argv.ts     deterministic argv construction for each tool
  repos.ts    allowlisted per-call directory and GitHub checkout cache
  parse.ts    CLI output parsing (session id / URL regexes, auth JSON)
  runner.ts   child_process spawn with timeout and output caps (follow-up and auth)
  pty.ts      pseudo-terminal spawn used by create (embedded Python helper)
  trust.ts    workspace-trust dialog detection and the opt-in ~/.claude.json edit
  config.ts   environment variable parsing and validation
test/
  parse.test.ts        parser unit tests against realistic CLI output
  argv-config.test.ts  argv and config unit tests
  repos.test.ts        allowlist, path checks, and the GitHub checkout cache
  trust.test.ts        trust-dialog detection, ~/.claude.json edits, worktree path
  smoke.test.ts        starts the built server over stdio and exercises every tool
  fixtures/fake-claude.mjs  stand-in CLI used by the smoke test (TTY and trust dialog)
```

## License

[MIT](LICENSE)
