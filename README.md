# Claude Code MCP Server

MCP server that lets AI agents with an always-on cloud computer (e.g. Muse by Meta, Grok Bot by SpaceXSI, ChatGPT Dots by OpenAI, etc) orchestrate Claude Code cloud sessions natively via the Claude Code CLI.

It exposes four tools over stdio: create a cloud session, queue a follow-up message into one, read the GitHub branch and pull request a session produced, and check the CLI's sign-in state. Each tool maps to one fixed `claude` invocation, and each returns structured JSON. Agents call typed tools and get typed results back, so they never need to write shell commands.

## Design

- **Strict input schemas.** Every field is typed, required fields are listed explicitly, and every schema sets `additionalProperties: false`. Invalid input is rejected by schema validation before any process is spawned.
- **No escape hatch.** The tool surface is exactly the four tools below. There is no "run any claude command" tool and no shell access.
- **Deterministic argv.** Arguments are built from validated inputs in a fixed order and passed as an array (`shell: false`). Values are attached as `--flag=value`, or placed after `--`, so a value that starts with `-` can never be read as a flag. `claude --cloud=<description>` is executed on a pseudo-terminal because the CLI rejects that form when stdout is a pipe; the pty helper `exec`s the same argv and never goes through a shell.
- **Structured outputs.** Every tool declares an `outputSchema` and returns `structuredContent` with parsed fields, such as `session_id` and `session_url`. CLI stdout and stderr are returned in `cli` with terminal control sequences removed.
- **Cloud sessions.** Create and follow-up always pass `--cloud=`. Session status runs print-mode `claude --teleport=<session>` inside the server's cache so the CLI can check out the branch the cloud session pushed, then the process exits. That argv carries no prompt and is not attached to a terminal.
- **No telemetry.** The server runs the local `claude` binary. Its own network calls are `git clone` / `git fetch` of a validated `https://github.com/owner/name.git` into the cache, and a read-only `gh pr list` when status needs a pull request number.

## Prerequisites

- Node.js 20 or later
- The [Claude Code CLI](https://code.claude.com/docs), installed and signed in (`claude auth status` should report `"loggedIn": true`), with cloud sessions available on your account
- Python 3 (the standard library only: `pty`, `fcntl`, `termios`) for `claude_create_cloud_session`. No pip packages. Follow-ups, session status, and auth status do not need Python. On Debian/Ubuntu this is the `python3` package, which is usually already installed.
- Git on `PATH`, when a call names a github.com repository. The server runs `git` with a fixed argument list and `core.hooksPath=/dev/null`.
- The Claude GitHub app installed on each private repository the cloud VM should clone, push, or open a pull request in. Public repositories can be cloned once the claude.ai account is connected to GitHub. See [GitHub access](#github-access) below.
- The [`gh`](https://cli.github.com/) CLI, signed in, when session status should resolve a pull request that teleport's output does not already name. The branch is still returned when `gh` is absent.

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
| `CLAUDE_MCP_REPOS` | empty | Comma-separated allowlist of local directories a create call may select. Each entry is an absolute directory that exists at startup. A github.com `owner/name` is accepted and ignored for access control: any github.com repository can be cloned into the cache. Other hosts, relative paths, and missing directories are rejected at startup. |
| `CLAUDE_MCP_REPO_CACHE` | `~/.claude-mcp/repos` | Directory that holds checkouts of GitHub repositories named by a call. Created on first use. An existing path must be a directory. This directory is the allowlist for where clones are written. |

If any of these values is invalid, the server exits at startup with code 2 and prints a message on stderr.

When a create call omits `repo`, the CLI runs in `CLAUDE_MCP_CWD`, or in the server process's working directory when that variable is unset or blank. `claude --cloud` packages the repository in the directory it is started in: the cloud VM clones that directory's GitHub remote at the current branch, or uploads the local tree when it cannot clone the remote. Set the client's `cwd` or `CLAUDE_MCP_CWD` to the default repository. An invalid `CLAUDE_MCP_CWD` (missing path, or a path that is not a directory) makes the server exit at startup with code 2.

### Choosing a repository per call

`claude --cloud` has no flag for a repository URL. The repository is whichever checkout the command runs in, and the cloud VM clones that directory's GitHub remote at the current branch ([Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)). The web UI can pick a repository and base branch directly; the CLI cannot, so this server prepares the checkout:

- A github.com `owner/name` (or `https://github.com/owner/name`) needs no local checkout and does not have to be listed in `CLAUDE_MCP_REPOS`. The server clones it into `CLAUDE_MCP_REPO_CACHE/<owner>/<name>` from `https://github.com/<owner>/<name>.git`, sets `origin` to that URL, fetches, and checks out `base_branch` when the call sets one. Omitting `base_branch` checks out the remote's default branch. Later calls fetch again and reset that cache checkout, including removing untracked files there. A cache directory whose `origin` is a different repository is left unchanged and the call fails. `base_branch` must already exist on `origin`.
- An absolute directory on `CLAUDE_MCP_REPOS` is used as the CLI working directory. The server does not fetch, reset, or otherwise modify that checkout, and `base_branch` is rejected for it.
- Any other value, including a subdirectory of an allowlisted directory, a relative path, another host, or a URL with a token, fails before the CLI starts (`REPO_NOT_ALLOWED`). A clone, fetch, or missing-branch failure is `REPO_PREPARE_FAILED`.

The clone URL is built by the server. Tool arguments cannot name a host, a credential, or a refspec. Private clones use whatever credential helper `git` already has on this machine; that credential is what lets the *local* cache see the repository. It is not uploaded, and it is not what the cloud VM uses to push.

Workspace trust follows the directory that was selected. With `CLAUDE_MCP_TRUST_CWD=1`, the opt-in writes the trust flag for that directory's main git checkout (or the directory itself when it is not a repository) and answers the dialog only for that folder.

### GitHub access

Two different GitHub identities are involved. They are easy to mix up because both end up talking about the same `owner/name`.

**Claude Code's GitHub integration** is what the cloud virtual machine uses. From [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web) and the [web quickstart](https://code.claude.com/docs/en/web-quickstart):

- The VM clones the GitHub remote of the directory `--cloud` was started in, at that directory's current branch. It does not upload the local tree when that remote can be cloned. Push local commits first if the VM should see them; this server's cache is reset to the remote, so the branch on GitHub is what the VM clones.
- Connecting the claude.ai account to GitHub lets a cloud session clone public repositories. Private repositories need the Claude GitHub app installed on that repository (repository settings, or the install URL Claude shows). The app is also required for auto-fix and for Projects.
- `/web-setup` in a local Claude Code session stores the machine's `gh` token on the claude.ai account. Cloud sessions can then use any repository that token can access. The app is still required for auto-fix.
- Each cloud task gets its own session and its own branch. After the branch is pushed, the session opens a pull request with `gh pr create` inside the cloud conversation. This server does not call the GitHub API to open a pull request.
- The browser repository-and-branch picker is not available on the CLI. `base_branch` plus the cache checkout is how a CLI caller selects them.

**This server** only makes the local `claude --cloud` see the right remote and branch, then reads the artifacts back:

- `git clone` / `git fetch` / `git checkout` in `CLAUDE_MCP_REPO_CACHE`, with hooks disabled and submodules not checked out.
- `claude --teleport=<session> --debug --debug-file=<cache>/sessions/<session>.teleport.log`, stdin closed, stdout a pipe. On Claude Code 2.1.300, print mode validates the session, checks out the branch the session pushed, logs `Branch after checkout: '<name>'`, and exits. It does not open a local interactive session. The debug file is required: without `--debug` that line is not emitted, and a signed-out print-mode teleport exits with empty stdout and stderr.
- `git symbolic-ref HEAD` after teleport, used when it disagrees with the pre-teleport branch.
- `gh pr list --repo owner/name --head <branch> --json number,url --limit 1` when the teleport output did not include a pull request URL. That reads the pull request the cloud session already opened.

Teleport has to run in a checkout of the same repository (not a fork) with a clean work tree. The server runs it only in the cache, after a clean reset. It is never run in a directory from `CLAUDE_MCP_REPOS`. A session that has not pushed a branch yet fails teleport; status then returns `CLI_EXIT_NONZERO` and no branch. `claude --resume`, `claude logs`, and `claude agents` list local sessions, and `claude -p --cloud <session>` only queues a follow-up ([CLI reference](https://code.claude.com/docs/en/cli-reference), [sessions](https://code.claude.com/docs/en/sessions), [headless](https://code.claude.com/docs/en/headless)). None of those report the pushed branch or the pull request.

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
    "repo": { "type": "string", "minLength": 1, "maxLength": 4096 },
    "base_branch": { "type": "string", "minLength": 1, "maxLength": 255 }
  },
  "required": ["description"],
  "additionalProperties": false
}
```

The environment id is chosen in this order: `environment_id` from the call, then `CLAUDE_CLOUD_ENVIRONMENT_ID`, then none (no `--environment` flag). `repo` matches an absolute path, a github.com `owner/name`, or a `https://github.com/owner/name` URL. A github.com value is cloned into the cache; an absolute path has to be on `CLAUDE_MCP_REPOS`. Omit `repo` to use the default directory; the output field is then `null`. When `repo` is set, `cwd` is the directory the CLI ran in and `repo` is the normalized value (`owner/name`, or the canonical directory path). `base_branch` is the branch checked out in the cache before `--cloud` runs. It is `null` in the output when the call did not name a github.com repository. For a GitHub repository it is the requested branch, or the remote default branch when the call omitted it.

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
  "base_branch": "main",
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

### `claude_get_session`

Session status for the GitHub artifacts of a cloud session: the branch it pushed, and the pull request URL and number when one exists. Runs, with stdin closed and stdout a pipe:

`claude --teleport=<session_id> --debug --debug-file=<cache>/sessions/<session_id>.teleport.log`

in the cache checkout of the session's repository. The process is killed if it exceeds `CLAUDE_MCP_TIMEOUT_MS`. No follow-up text is sent.

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
    "repo": { "type": "string", "minLength": 1, "maxLength": 4096 }
  },
  "required": ["session"],
  "additionalProperties": false
}
```

`repo` is a github.com `owner/name` or `https://github.com/owner/name` URL. Omit it when `claude_create_cloud_session` created this session with a github.com `repo`: that slug and base branch are stored under the cache. A session created from a local directory has no record; pass `repo` then. Passing `repo` selects that repository even when a record exists. When the slug matches the record, the recorded base branch is checked out before teleport so the cache is clean.

Output:

```json
{
  "session_id": "session_01AbC...",
  "repo": "owner/name",
  "branch": "claude/add-retry",
  "base_branch": "main",
  "pr_number": 17,
  "pr_url": "https://github.com/owner/name/pull/17",
  "pr_source": "gh",
  "pr_error": null,
  "parsed": true,
  "args": ["--teleport=session_01AbC...", "--debug", "--debug-file=/.../sessions/session_01AbC....teleport.log"],
  "cli": { "exit_code": 0, "stdout": "", "stderr": "Branch after checkout: 'claude/add-retry'" }
}
```

`parsed` is true when `branch` was identified. `branch` is null when teleport exits 0 without moving HEAD off the base branch and without logging a checkout. `pr_number` and `pr_url` are null when the branch has no pull request. `pr_source` is `output` when teleport's text included the pull request, `gh` when `gh pr list` supplied it, and null when neither did. `pr_error` is set when `gh` is missing or fails; an empty pull-request list leaves `pr_error` null.

This tool does not return the assistant's latest reply. Open `session_url` from create for the conversation. `claude -p --cloud <session>` queues a message and exits; `--output-format stream-json` is not supported with `--cloud` ([cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web), [CLI reference](https://code.claude.com/docs/en/cli-reference), also at [docs.claude.com](https://docs.claude.com/en/docs/claude-code/cli-reference)). `--resume`, `claude logs`, and `claude agents --json` address local sessions ([sessions](https://code.claude.com/docs/en/sessions)). `--remote` is a deprecated alias of `--cloud`.

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
| `REPO_NOT_ALLOWED` | `repo` is not an absolute directory on `CLAUDE_MCP_REPOS` and not a github.com `owner/name`. The CLI is not started. |
| `REPO_PREPARE_FAILED` | Preparing the GitHub cache checkout failed (git missing, clone or fetch error, `base_branch` missing on origin, `base_branch` passed for a local directory, lock timeout, or the cache directory has a different `origin`). |
| `SESSION_REPO_UNKNOWN` | Session status was called without `repo` and this server has no record of a github.com repository for that session. |

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
        "CLAUDE_MCP_REPOS": "/absolute/path/to/a/local/checkout",
        "CLAUDE_MCP_REPO_CACHE": "/absolute/path/to/the/github/cache"
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
  repos.ts    per-call directory, GitHub checkout cache, session record, gh pr list
  parse.ts    CLI output parsing (session id / URL regexes, teleport branch and PR, auth JSON)
  runner.ts   child_process spawn with timeout and output caps (follow-up, session status, and auth)
  pty.ts      pseudo-terminal spawn used by create (embedded Python helper)
  trust.ts    workspace-trust dialog detection and the opt-in ~/.claude.json edit
  config.ts   environment variable parsing and validation
test/
  parse.test.ts        parser unit tests against realistic CLI output
  argv-config.test.ts  argv and config unit tests
  repos.test.ts        allowlist, path checks, GitHub cache, and base branch
  trust.test.ts        trust-dialog detection, ~/.claude.json edits, worktree path
  smoke.test.ts        starts the built server over stdio and exercises every tool
  fixtures/fake-claude.mjs  stand-in CLI used by the smoke test (TTY, trust dialog, teleport)
  fixtures/fake-gh.mjs      stand-in gh used when session status looks up a pull request
```

## License

[MIT](LICENSE)
