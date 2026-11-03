# Claude Code MCP Server

[![npm version](https://img.shields.io/npm/v/@sohampatwardhan/claude-code-mcp-server.svg)](https://www.npmjs.com/package/@sohampatwardhan/claude-code-mcp-server)

MCP server that lets AI agents with an always-on cloud computer (e.g. Muse by Meta, Grok Bot by SpaceXSI, ChatGPT Dots by OpenAI, Claude Duet by Anthropic, etc) orchestrate Claude Code cloud sessions natively via the Claude Code CLI.

It is the first server in a planned **MCP orchestration suite**: one MCP server per agent tool (Claude Code now; Codex, Antigravity, Grok and Cursor later), so an orchestrator such as Muse, Grok Bot, ChatGPT Dots or Claude Duet can coordinate tasks across several coding agents through the same kind of tool calls. The servers are meant to share one job model ([#28](https://github.com/sohampatwardhan/claude-code-mcp-server/issues/28)), so one orchestration loop works with all of them.

> **Requires the Claude Code CLI, installed and signed in, on the machine that runs this server.**
>
> 1. Install it: `npm install -g @anthropic-ai/claude-code`
> 2. Sign in: run `claude` once in a terminal and complete the claude.ai login (`claude auth status` should then report `"loggedIn": true`).
> 3. Cloud sessions need a claude.ai account with [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web), and the Claude GitHub app on the repositories sessions work in.
>
> Without the CLI, every tool returns `CLI_NOT_FOUND` with the install command (and the server prints the same warning on stderr at startup). When the CLI is not signed in, tools return `CLI_NOT_SIGNED_IN`, which says to sign in with `claude` first.

It exposes six tools over stdio: create a cloud session, queue a follow-up message into one, read the GitHub branch and pull request a session produced, cancel a create or local run that is stuck, run Claude Code headless in a local checkout (off until you list allowed directories), and check the CLI's sign-in state. Each tool maps to one fixed `claude` invocation, and each returns structured JSON. Agents call typed tools and get typed results back, so they never need to write shell commands.

## Design

- **Strict input schemas.** Every field is typed, required fields are listed explicitly, and every schema sets `additionalProperties: false`. Invalid input is rejected by schema validation before any process is spawned.
- **No escape hatch.** The tool surface is exactly the six tools below. There is no "run any claude command" tool and no shell access.
- **Deterministic argv.** Arguments are built from validated inputs in a fixed order and passed as an array (`shell: false`). Values are attached as `--flag=value`, or placed after `--`, so a value that starts with `-` can never be read as a flag. `claude --cloud=<description>` is executed on a pseudo-terminal because the CLI rejects that form when stdout is a pipe; the pty helper `exec`s the same argv and never goes through a shell.
- **Structured outputs.** Every tool declares an `outputSchema` and returns `structuredContent` with parsed fields, such as `session_id` and `session_url`. CLI stdout and stderr are returned in `cli` with terminal control sequences removed.
- **Cloud sessions.** Create and follow-up always pass `--cloud=`. Session status runs print-mode `claude --teleport=<session>` inside the server's cache so the CLI can check out the branch the cloud session pushed, then the process exits. That argv carries no prompt and is not attached to a terminal.
- **Local runs are opt-in.** `claude_run_local` is the only tool that runs Claude Code on this machine (`claude -p`). It refuses every call until `CLAUDE_MCP_LOCAL_ROOTS` lists directories, only runs inside them (after resolving symlinks), always passes an explicit permission mode from a fixed set, and never bypasses permissions. Until a second opt-in, `CLAUDE_MCP_LOCAL_ALLOW_SHELL`, is set, every run uses Claude Code's `--restricted` mode: no shell or code-running tools, and the checkout's settings, hooks and `.mcp.json` aren't loaded.
- **No orphaned processes.** Every child (git, `gh`, the pty helper, `claude`) leads its own process group and is tracked. A cancelled create, or an MCP request the client cancels (for example on its own timeout), stops its processes with SIGTERM, then SIGKILL 5 s later. When the client closes stdin, or the server gets SIGINT, SIGTERM or SIGHUP, the server stops every child before it exits. If the server is killed outright, the pty helper notices and stops `claude --cloud` the same way. Only `git` and `gh` processes that are already running can outlive a SIGKILL, and each is bound by `CLAUDE_MCP_TIMEOUT_MS`.
- **No telemetry.** The server runs the local `claude` binary. Its own network calls are `git clone` / `git fetch` of a validated `https://github.com/owner/name.git` into the cache, and a read-only `gh pr list` when status needs a pull request number.

## Prerequisites

- Node.js 20 or later
- The [Claude Code CLI](https://code.claude.com/docs) (`npm install -g @anthropic-ai/claude-code`), signed in by running `claude` once and completing the claude.ai login (`claude auth status` should report `"loggedIn": true`). The account needs cloud sessions (Claude Code on the web). Set `CLAUDE_BIN` when `claude` is not on the server's `PATH`.
- Python 3 (the standard library only: `pty`, `fcntl`, `termios`) for `claude_create_cloud_session`. No pip packages. Follow-ups, session status, and auth status do not need Python. On Debian/Ubuntu this is the `python3` package, which is usually already installed.
- Git on `PATH`, when a call names a github.com repository. The server runs `git` with a fixed argument list and `core.hooksPath=/dev/null`.
- The Claude GitHub app installed on each private repository the cloud VM should clone, push, or open a pull request in. Public repositories can be cloned once the claude.ai account is connected to GitHub. See [GitHub access](#github-access) below.
- The [`gh`](https://cli.github.com/) CLI, signed in, when session status should resolve a pull request that teleport's output does not already name. The branch is still returned when `gh` is absent.

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
| `CLAUDE_MCP_TIMEOUT_MS` | `300000` | Hard timeout for each spawned CLI process, in milliseconds (positive integer). On timeout the process gets SIGTERM, then SIGKILL 5 s later. A create call can override it with `timeout_s`. |
| `CLAUDE_MCP_IDLE_TIMEOUT_MS` | unset (off) | Stop `claude --cloud` on create when it prints nothing for this many milliseconds (positive integer). A create call can override it with `idle_timeout_s`. Off by default, because packaging a large repository may print nothing for a while. |
| `CLAUDE_MCP_TRUST_CWD` | unset (off) | `1`, `true`, or `yes` lets create accept Claude Code's workspace-trust dialog for `CLAUDE_MCP_CWD` only (the process working directory when that is unset). `0`, `false`, `no`, or unset leaves the dialog unanswered and the call fails with `WORKSPACE_NOT_TRUSTED`. |
| `CLAUDE_MCP_PYTHON` | `python3` | Python 3 interpreter used to allocate the pseudo-terminal for create. |
| `CLAUDE_MCP_CWD` | process working directory | Directory the CLI runs in when a call omits `repo`. `claude --cloud` packages this tree, and workspace trust is resolved from it. A relative path is resolved at startup. The path must exist and be a directory. |
| `CLAUDE_MCP_REPOS` | empty | Comma-separated allowlist of local directories a create call may select. Each entry is an absolute directory that exists at startup. A github.com `owner/name` is accepted and ignored for access control: any github.com repository can be cloned into the cache. Other hosts, relative paths, and missing directories are rejected at startup. |
| `CLAUDE_MCP_REPO_CACHE` | `~/.claude-mcp/repos` | Directory that holds checkouts of GitHub repositories named by a call. Created on first use. An existing path must be a directory. This directory is the allowlist for where clones are written. |
| `CLAUDE_MCP_LOCAL_ROOTS` | empty (local runs off) | Comma-separated absolute directories `claude_run_local` may run in, together with everything under them. Each must exist at startup and is compared in its real-path form. The filesystem root `/` is refused. Print mode skips Claude Code's workspace-trust dialog; while `CLAUDE_MCP_LOCAL_ALLOW_SHELL` is off, `--restricted` keeps a checkout's settings from loading, but Claude still reads and edits every file under the roots. |
| `CLAUDE_MCP_LOCAL_ALLOW_SHELL` | off | `1` / `true` / `yes` drops `--restricted` from local runs and lets them pre-approve `Bash` or use `permission_mode: "auto"`, either of which runs shell commands on this machine without asking. **It also trusts every checkout under the roots:** their project settings, hooks, allow rules and `.mcp.json` servers load as in a normal `claude -p`. Off, `Bash` and `auto` fail with `LOCAL_SHELL_DISABLED`. |

If any of these values is invalid, the server exits at startup with code 2 and prints a message on stderr.

When a create call omits `repo`, the CLI runs in `CLAUDE_MCP_CWD`, or in the server process's working directory when that variable is unset or blank. `claude --cloud` packages the repository in the directory it is started in: the cloud VM clones that directory's GitHub remote at the current branch, or uploads the local tree when it cannot clone the remote. Set the client's `cwd` or `CLAUDE_MCP_CWD` to the default repository. An invalid `CLAUDE_MCP_CWD` (missing path, or a path that is not a directory) makes the server exit at startup with code 2.

### Choosing a repository per call

`claude --cloud` has no flag for a repository URL. The repository is whichever checkout the command runs in, and the cloud VM clones that directory's GitHub remote at the current branch ([Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web)). The web UI can pick a repository and base branch directly; the CLI cannot, so this server prepares the checkout:

- A github.com `owner/name` (or `https://github.com/owner/name`) needs no local checkout and does not have to be listed in `CLAUDE_MCP_REPOS`. The server clones it into `CLAUDE_MCP_REPO_CACHE/<owner>/<name>` from `https://github.com/<owner>/<name>.git`, sets `origin` to that URL, fetches, and checks out `base_branch` when the call sets one. Omitting `base_branch` checks out the remote's default branch. The first clone is partial (`git clone --filter=blob:none`): it downloads every commit and tree but only the file contents the checkout needs, and git fetches older contents on demand. Later calls never reclone a healthy cache. They fetch again and reset that cache checkout, including removing untracked files there. A cache directory that is not a git checkout is removed and cloned again. The create output's `cache` field says whether a call cloned (`cloned: true`) or reused the cache, and how long that took (`duration_ms`). A cache directory whose `origin` is a different repository is left unchanged and the call fails. `base_branch` must already exist on `origin`.
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

- `git clone --filter=blob:none` / `git fetch` / `git checkout` in `CLAUDE_MCP_REPO_CACHE`, with hooks disabled and submodules not checked out.
- `claude --teleport=<session> --debug --debug-file=<cache>/sessions/<session>.teleport.log`, stdin closed, stdout a pipe. On Claude Code 2.1.300, print mode validates the session, checks out the branch the session pushed, logs `Branch after checkout: '<name>'`, and exits. It does not open a local interactive session. The debug file is required: without `--debug` that line is not emitted, and a signed-out print-mode teleport exits with empty stdout and stderr.
- `git symbolic-ref HEAD` after teleport, used when it disagrees with the pre-teleport branch.
- `gh pr list --repo owner/name --head <branch> --json number,url --limit 1` when the teleport output did not include a pull request URL. That reads the pull request the cloud session already opened.

Teleport has to run in a checkout of the same repository (not a fork) with a clean work tree. The server runs it only in the cache, after a clean reset. It is never run in a directory from `CLAUDE_MCP_REPOS`. A session that has not pushed a branch yet fails teleport; status then returns `CLI_EXIT_NONZERO` and no branch. `claude --resume`, `claude logs`, and `claude agents` list local sessions, and `claude -p --cloud <session>` only queues a follow-up ([CLI reference](https://code.claude.com/docs/en/cli-reference), [sessions](https://code.claude.com/docs/en/sessions), [headless](https://code.claude.com/docs/en/headless)). None of those report the pushed branch or the pull request.

### Workspace trust

`claude --cloud <description>` requires an interactive terminal. On a pseudo-terminal the CLI then stops at its workspace-trust dialog until someone answers. Older versions asked "Do you trust the files in this folder?"; Claude Code 2.1.316 asks "Quick safety check: Is this a project you created or one you trust?" with "No, exit" selected above "Yes, I trust this folder". The server recognises both wordings. It renders the CLI's cursor moves as the spaces they draw, so a dialog built from positioned words still matches. Trust matters because accepting it lets that folder's project hooks, allow rules, and `.mcp.json` servers run.

This server does not answer that dialog on its own. Either:

- Trust the folder yourself: run `claude` once in that directory and accept the dialog, or set `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`. `<path>` is the main git checkout when the selected directory is a repository or worktree, and the directory itself otherwise. The selected directory is `repo` when the call sets one, and `CLAUDE_MCP_CWD` otherwise (the process working directory when that variable is unset). Claude Code documents this key under [project allow rules and workspace trust](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust).
- Or set `CLAUDE_MCP_TRUST_CWD=1`. Create then writes that same key for the one directory above and, if the dialog still appears, answers it once. It reads which option is selected (`❯`) and moves to "Yes, I trust this folder" with the arrow keys before pressing Enter, since Enter alone would choose "No, exit" on current versions. If the menu's selection can't be read, it doesn't answer and fails with `WORKSPACE_NOT_TRUSTED`. The opt-in covers that one directory. Create still runs with the CLI's normal permission prompts.

The trust edit holds `~/.claude.json.lock` (exclusive create, treated as stale after 5 seconds) so two of these servers do not interleave. Inside the lock it re-reads `~/.claude.json` immediately before an atomic rename, skips the write when `hasTrustDialogAccepted` is already true, and retries the merge when the file changed since the first read so other fields are kept.

Claude Code does not take that lock. A Claude process that saves `~/.claude.json` after this server's second read can overwrite the trust flag, and a save that lands between that read and the rename can itself be overwritten. If the dialog comes back, set the flag again while no Claude process is writing the file.

Without the opt-in, the dialog fails the call with `WORKSPACE_NOT_TRUSTED` as soon as it is drawn (under a second on Claude Code 2.1.316), never after the full timeout. A description that merely contains the words "Do you trust this folder?" is not treated as the dialog. The `Created cloud session:` title line is ignored when the server looks for the prompt.

Trust is stored in `~/.claude.json` in the home directory (not under `~/.claude/`). When `~/.claude.json` is missing or is not a JSON object, the opt-in leaves it unchanged and answers the dialog on the pty instead. Claude Code treats the home directory itself as trusted for the current session only, so a server whose `CLAUDE_MCP_CWD` is `$HOME` still needs the opt-in for the pty to answer the dialog.

### Sign-in check

Before create and `claude_run_local` start anything, the server runs `claude auth status` in `CLAUDE_MCP_CWD`, which makes no model call. If it reports `"loggedIn": false`, the call fails in about a second with `CLI_NOT_SIGNED_IN`, naming the auth method the CLI reports and the remedy (`claude auth login` on the server's host; on macOS over SSH the login keychain may be locked). No clone, `--cloud` or `-p` process starts. A signed-in result is reused for 60 seconds. If `auth status` can't be read, times out (10 seconds), or fails for another reason, the run goes ahead and the CLI's own error still surfaces. A missing CLI fails with `CLI_NOT_FOUND`.

## Tool reference

Every successful call returns `structuredContent` that matches the tool's `outputSchema`, and the same JSON as a text content block.

### `claude_create_cloud_session`

Creates a new cloud session. Runs, on a pseudo-terminal: `claude --cloud=<description> [--environment=<id>]`

**Create runs in the background and returns within about 2 seconds.** On a large repository the clone and `claude --cloud` can take minutes, longer than an MCP client waits for one request (60 seconds by default in the MCP SDK). The call starts a job, waits up to 2 seconds, then returns:

- `status: "done"`: the job finished in time, and the fields below are final. A failure in that window comes back as the usual tool error.
- `status: "cloning"`, `"starting"` or `"running"`: the job is still going. Call [`claude_get_session`](#claude_get_session) with `job_id` every few seconds until `job.status` is `"done"` or the call returns a tool error (the same codes as below). `cloning` means the GitHub cache checkout is being prepared. `starting` means `claude --cloud` is running and hasn't printed a session yet. `running` means it printed the session id (`session_id` and `session_url` are already set) and hasn't exited. A job stopped with [`claude_cancel_session`](#claude_cancel_session) reports `cancelled`.

Jobs live in the server's memory only. A finished job is kept for an hour (at most 100 finished jobs), and all jobs are lost when the server exits. Each process a job runs is bound by `timeout_s` (default `CLAUDE_MCP_TIMEOUT_MS`), and `claude --cloud` also by `idle_timeout_s` (default `CLAUDE_MCP_IDLE_TIMEOUT_MS`, off). Both time-outs fail with `CLI_TIMEOUT`. Use [`claude_cancel_session`](#claude_cancel_session) to stop a job early.

The CLI rejects `--cloud` with a task description when stdout is a pipe (`--cloud requires an interactive terminal`). There is a non-interactive create form, `claude -p <task> --environment <ccpool>`, but it only targets self-hosted environments and it omits `--cloud`. This server keeps `--cloud=` on every create so an older CLI cannot fall through to a local session. A pty has a single output stream, so the CLI's stdout and stderr are both returned in `cli.stdout` (`cli.stderr` is empty on this tool). `cli.stdout` and `cli.stderr` have terminal control sequences removed (cursor save and restore, CSI including private parameters, and other C0 controls) before they are returned.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "description": { "type": "string", "minLength": 1, "maxLength": 100000, "pattern": "\\S" },
    "environment_id": { "type": "string", "maxLength": 200, "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]*$" },
    "repo": { "type": "string", "minLength": 1, "maxLength": 4096 },
    "base_branch": { "type": "string", "minLength": 1, "maxLength": 255 },
    "timeout_s": { "type": "integer", "minimum": 1, "maximum": 86400 },
    "idle_timeout_s": { "type": "integer", "minimum": 1, "maximum": 86400 }
  },
  "required": ["description"],
  "additionalProperties": false
}
```

The environment id is chosen in this order: `environment_id` from the call, then `CLAUDE_CLOUD_ENVIRONMENT_ID`, then none (no `--environment` flag). `repo` matches an absolute path, a github.com `owner/name`, or a `https://github.com/owner/name` URL. A github.com value is cloned into the cache; an absolute path has to be on `CLAUDE_MCP_REPOS`. Omit `repo` to use the default directory; the output field is then `null`. When `repo` is set, `cwd` is the directory the CLI ran in and `repo` is the normalized value (`owner/name`, or the canonical directory path). `base_branch` is the branch checked out in the cache before `--cloud` runs. It is `null` in the output when the call did not name a github.com repository. For a GitHub repository it is the requested branch, or the remote default branch when the call omitted it. `cache` is `{ cloned, duration_ms }` once the cache checkout is ready: `cloned` is true when this call made the first (partial) clone and false when it reused the cache with `git fetch`, and `duration_ms` covers the clone or fetch, checkout and clean, not a wait for another call holding the same repository's lock. It is `null` while the job is still cloning and for a local or default directory. When `claude --cloud` has to upload the repository instead of having the VM clone it from GitHub (no Claude GitHub app on the repository), a partial clone uploads as a snapshot of the working tree without history ([Send local repositories without GitHub](https://code.claude.com/docs/en/claude-code-on-the-web)).

Output:

```json
{
  "job_id": "job_5f0c2a9e7b1d43c8a6e2f019",
  "status": "done",
  "elapsed_ms": 41230,
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

`parsed` is `true` when both `session_id` and `session_url` were found in the CLI output. If the output can't be parsed, the call still succeeds with `parsed: false`, the unparsed fields set to `null`, and the cleaned output in `cli`. While the job is still going, `cli.exit_code` is `null` and `cli.stdout` holds the last 4,000 characters of output so far. For a GitHub repository, `base_branch` is the requested branch, or `null` if none was requested, until the checkout is ready.

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

`session` takes a create or local-run `job_id`, or a cloud session.

**With a job id** (`job_` and 24 hex characters), it reads the job from memory and runs nothing. For a create job it returns `job` with the same fields as the [create output](#claude_create_cloud_session): progress while it runs, the final result once `job.status` is `"done"`. For a [`claude_run_local`](#claude_run_local) job it returns `local_job` the same way, with `job` set to `null`. Top-level `session_id` mirrors the job's `session_id`. The other top-level fields are `null`, `false` or `[]`, and `repo` is ignored. A failed job returns its tool error. An id this server doesn't know, because it expired, was never issued, or belonged to a server that has since exited, returns `JOB_NOT_FOUND`.

```json
{
  "job": { "job_id": "job_5f0c2a9e7b1d43c8a6e2f019", "status": "cloning", "elapsed_ms": 18400, "session_id": null, "...": "..." },
  "session_id": null,
  "repo": null, "branch": null, "base_branch": null,
  "pr_number": null, "pr_url": null, "pr_source": null, "pr_error": null,
  "parsed": false, "args": [], "cli": null
}
```

**With a session id or URL**, it reports the GitHub artifacts of a cloud session: the branch it pushed, and the pull request URL and number when one exists. Runs, with stdin closed and stdout a pipe:

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
      "pattern": "(?:^(?:(?:session|cse)_[A-Za-z0-9][A-Za-z0-9_-]*|https:\\/\\/claude\\.ai\\/code\\/[^\\s\"'<>]+)$)|(?:^job_[0-9a-f]{24}$)"
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
  "job": null,
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

### If a session can't push

Cloud sessions sometimes fail to push their branch to the GitHub remote. `claude_get_session` then returns no branch (teleport fails with `CLI_EXIT_NONZERO`), or the session says so at its `session_url`. When that happens, don't wait for a retry; move the changes through the calling agent instead:

1. Use `claude_send_followup` to ask the session for a patch (prompt below).
2. Copy the patch from the `session_url`. `claude_get_session` reports only the pushed branch and pull request, not replies, so the patch is visible only there.
3. Apply it to your own checkout of the base branch with `git am` (for `format-patch` output) or `git apply --3way` (for a plain diff).
4. Run the tests, commit, push, and open or update the pull request yourself.

Ready-to-send follow-up (replace `<base>` with the base branch, e.g. `main`):

```text
Pushing your branch to GitHub failed, so I'll apply your changes myself. Please commit any outstanding work, then run `git format-patch origin/<base>..HEAD --stdout` and paste the complete output in a single fenced code block, with nothing else inside it. If format-patch isn't possible, paste a full unified `git diff origin/<base>` that also includes new and deleted files (stage them first with `git add -A` and use `git diff --cached origin/<base>`). Don't try to push again.
```

### `claude_cancel_session`

Stops a create job or [`claude_run_local`](#claude_run_local) job that is still running. Every process the job started on this machine (git, the pty helper, `claude --cloud` or `claude -p`, and anything they started) gets SIGTERM, then SIGKILL 5 s later. The call waits up to about 6 s for them to exit. Runs no new process.

**It does not stop a cloud session.** If `claude --cloud` already created one (the job's status was `running`), that session keeps running at its `session_url`. Open it there to stop it.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "session": { "type": "string", "maxLength": 2000, "pattern": "<same as claude_get_session>" }
  },
  "required": ["session"],
  "additionalProperties": false
}
```

`session` is the job id, or for a create job the session id or URL it already printed. Output:

```json
{
  "job": { "job_id": "job_5f0c2a9e7b1d43c8a6e2f019", "status": "cancelled", "session_id": null, "...": "..." },
  "local_job": null,
  "cancelled": true,
  "stopped": true
}
```

For a local run, `job` is `null` and `local_job` holds the run (its `session_id` can still be resumed). `cancelled` is `true` when this call cancelled the job. For a job that already finished or was already cancelled it is `false`, and `job` shows that job as it stands. A job that already failed returns its tool error. `stopped` is `true` when every process the job started has exited. After a cancel, `claude_get_session` reports the job with `status: "cancelled"`. A job id the server doesn't hold, or a session no unfinished job printed, returns `JOB_NOT_FOUND`.

Follow-ups, session status and auth status need no cancel tool. When the client cancels one of those requests (MCP `notifications/cancelled`, which the SDK sends when its own request timeout fires), the server stops that request's processes.

### `claude_run_local`

Runs Claude Code headless on this machine, in an existing checkout, for work that needs the local toolchain or hardware rather than a cloud VM. Runs:

`claude -p [--restricted --strict-mcp-config] --output-format=stream-json --verbose --permission-mode=<mode> [--model=<model>] [--max-turns=<n>] [--allowedTools=<tools>] [--resume=<session_id>] -- <prompt>`

in `cwd`, stdin closed, stdout a pipe. It is off by default: with `CLAUDE_MCP_LOCAL_ROOTS` unset, every call fails with `LOCAL_RUNS_DISABLED`.

**Restricted unless you allow shell access.** With `CLAUDE_MCP_LOCAL_ALLOW_SHELL` off (the default), the run gets `--restricted --strict-mcp-config` ([restricted mode](https://code.claude.com/docs/en/cli-reference), Claude Code 2.1.248 or later; an older CLI rejects the flag and the run fails with `CLI_EXIT_NONZERO`). Claude Code then:
- removes Bash, PowerShell and the other tools that run commands or code, and WebFetch
- loads only managed settings: not your user settings, and not the checkout's `.claude/settings*.json`, hooks or allow rules
- starts no MCP servers, including the checkout's `.mcp.json`
- confines the file tools to `cwd`, and refuses writes to settings, git and tool-configuration files (there's no one to approve them)

So a checkout can't give the run shell access, and the run can't rewrite `.git/config` or `.claude/` to give a later run shell access either. Print mode never shows the workspace-trust dialog. With `CLAUDE_MCP_LOCAL_ALLOW_SHELL=1` none of this applies: the checkout's settings, hooks and MCP servers load, so listing a root then trusts every checkout under it. Only turn it on for roots whose checkouts you'd open in Claude Code yourself.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "cwd": { "type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^\\/[^\\0\\n\\r]*$" },
    "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
    "resume": { "type": "string", "pattern": "<UUID>" },
    "model": { "type": "string", "pattern": "<alias or model name>" },
    "permission_mode": { "enum": ["dontAsk", "acceptEdits", "plan", "auto"] },
    "allowed_tools": { "type": "array", "items": { "enum": ["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch"] } },
    "max_turns": { "type": "integer", "minimum": 1, "maximum": 1000 },
    "timeout_s": { "type": "integer", "minimum": 1, "maximum": 86400 }
  },
  "required": ["cwd", "prompt"],
  "additionalProperties": false
}
```

- `cwd` must be an existing directory inside a `CLAUDE_MCP_LOCAL_ROOTS` root, or a root itself. Both are compared after `realpath`, so a symlink that leads out of a root is refused, one that leads into a root is allowed, and macOS `/var/...` and `/private/var/...` spellings agree. Anything else is `REPO_NOT_ALLOWED`, and the CLI is not started.
- `permission_mode` defaults to `dontAsk`: reads and `allowed_tools` run, and anything that would prompt is denied (and listed in `permission_denials`). `acceptEdits` also allows file edits and common filesystem commands in `cwd`, `plan` is read-only exploration, and `auto` lets a background classifier review each action, shell commands included. The mode is always passed explicitly, so a settings file's `defaultMode` can't change it. `bypassPermissions` and `--dangerously-skip-permissions` are never used.
- `allowed_tools` pre-approves built-in tools by name only. No patterns and no MCP tools. `Bash` allows every shell command.
- **Shell access is a separate opt-in.** `allowed_tools` containing `Bash`, or `permission_mode: "auto"`, lets the run execute shell commands on this machine without asking anyone, with your user's credentials and network access. Both fail with `LOCAL_SHELL_DISABLED` unless `CLAUDE_MCP_LOCAL_ALLOW_SHELL=1`. Without it the run is restricted (above): file reads and, in `acceptEdits`, file edits in `cwd`. `WebFetch` in `allowed_tools` then has no effect, because restricted mode removes it.
- `resume` is the `session_id` of an earlier run. Claude Code finds the session by id, and may continue it under a new id; the result's `session_id` is the one to resume next.
- `timeout_s` overrides `CLAUDE_MCP_TIMEOUT_MS` for this run.

Like create, the run is a background job and the call returns within about 2 seconds. Until `status` is `"done"`, poll [`claude_get_session`](#claude_get_session) with `job_id` and read `local_job`. `starting` means `claude -p` hasn't reported a session yet, `running` means `session_id` is known, and [`claude_cancel_session`](#claude_cancel_session) with the `job_id` stops the run. A finished run:

```json
{
  "job_id": "job_9c1d0e2f3a4b5c6d7e8f9012",
  "status": "done",
  "elapsed_ms": 48210,
  "session_id": "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5",
  "cwd": "/Users/dev/GitRepos/app",
  "permission_mode": "acceptEdits",
  "restricted": true,
  "assistant_messages": 6,
  "parsed": true,
  "subtype": "success",
  "is_error": false,
  "result": "Fixed the failing test in src/parse.ts.",
  "num_turns": 7,
  "total_cost_usd": 0.0421,
  "usage": { "input_tokens": 1200, "output_tokens": 950, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 18000 },
  "permission_denials": ["Bash"],
  "errors": [],
  "files": [
    { "path": "src/parse.ts", "status": " M", "from": null, "before": null },
    { "path": "notes.md", "status": " M", "from": null, "before": " M" }
  ],
  "args": ["-p", "--restricted", "--strict-mcp-config", "--output-format=stream-json", "--verbose", "--permission-mode=acceptEdits", "--", "Fix the failing test"],
  "cli": { "exit_code": 0, "stdout": "", "stderr": "" }
}
```

- `result`, `subtype`, `is_error`, `num_turns`, `total_cost_usd`, `usage` and `permission_denials` come from the CLI's final result line. A run that hits `max_turns`, or ends on an API error, is still returned as data: `is_error` is `true`, `subtype` says why (for example `error_max_turns`), and `errors` holds the CLI's messages.
- `files` is `git status` after the run (`--porcelain` codes), plus paths that were dirty before and are clean now (`status: null`). `before` is each path's status before the run, so `before: null` means the run changed a clean file. Changes the run committed don't show up. `files` is `null` when `cwd` isn't a git work tree, and until the job is done.
- The stream-json transcript is read as it arrives and not kept: `cli.stdout` is empty when the result line was read, and otherwise holds the last 4,000 characters for diagnosis. `cli.stderr` is its last 4,000 characters.
- With no result line, a non-zero exit is `CLI_EXIT_NONZERO` (or `CLI_NOT_SIGNED_IN`), and running past the time limit is `CLI_TIMEOUT`, whose message names the session so it can be resumed.

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
| `CLI_TIMEOUT` | The CLI ran longer than `CLAUDE_MCP_TIMEOUT_MS` (or create's `timeout_s`), or `claude --cloud` printed nothing for `idle_timeout_s` / `CLAUDE_MCP_IDLE_TIMEOUT_MS`. |
| `CLI_NOT_FOUND` | `CLAUDE_BIN` could not be found. `message` names the install command (`npm install -g @anthropic-ai/claude-code`) and the sign-in step. `cli` is `null` on the pipe path. |
| `CLI_NOT_SIGNED_IN` | The sign-in check before create or a local run found `"loggedIn": false`, or the CLI exited non-zero with output that reads like a missing or expired login (for example `Invalid API key · Please run /login`, or `Cloud sessions need a claude.ai sign-in`). `message` says to sign in with `claude` first. |
| `CLI_SPAWN_FAILED` | The process could not be started for another reason. `cli` is `null`. |
| `OUTPUT_PARSE_FAILED` | `claude auth status` did not print JSON with a boolean `loggedIn`. |
| `PTY_UNAVAILABLE` | Create could not start the Python interpreter that allocates the pseudo-terminal (`CLAUDE_MCP_PYTHON`). `cli` is `null`. |
| `WORKSPACE_NOT_TRUSTED` | Create reached Claude Code's workspace-trust dialog and `CLAUDE_MCP_TRUST_CWD` is off, so the dialog was not answered. |
| `REPO_NOT_ALLOWED` | `repo` is not an absolute directory on `CLAUDE_MCP_REPOS` and not a github.com `owner/name`, or a local run's `cwd` is missing, not a directory, or outside every `CLAUDE_MCP_LOCAL_ROOTS` root after resolving symlinks. The CLI is not started. |
| `REPO_PREPARE_FAILED` | Preparing the GitHub cache checkout failed (git missing, clone or fetch error, `base_branch` missing on origin, `base_branch` passed for a local directory, lock timeout, or the cache directory has a different `origin`). |
| `SESSION_REPO_UNKNOWN` | Session status was called without `repo` and this server has no record of a github.com repository for that session. |
| `LOCAL_RUNS_DISABLED` | `claude_run_local` was called while `CLAUDE_MCP_LOCAL_ROOTS` lists no directories. |
| `LOCAL_SHELL_DISABLED` | `claude_run_local` asked for `allowed_tools` `Bash` or `permission_mode` `auto` while `CLAUDE_MCP_LOCAL_ALLOW_SHELL` is off. The CLI is not started. |
| `JOB_NOT_FOUND` | `claude_get_session` or `claude_cancel_session` was given a job id this server doesn't hold, or `claude_cancel_session` a session no unfinished job printed. A job id goes missing when: it was never issued, it finished more than an hour ago (or was pushed out by newer jobs), or the server restarted. Create the session again, or use the `session_id` from the finished job. |

Schema violations (a missing required field, an unknown property, a value that doesn't match a pattern) are rejected by the MCP SDK's input validation as tool errors, and the CLI is never run.

## Client configuration

Cursor, Claude Desktop, and a generic stdio entry are in [Install](#install). The same `npx` command is what Muse, Grok Bot, ChatGPT Dots, Claude Duet, and other orchestrators should launch. Pass `CLAUDE_CLOUD_ENVIRONMENT_ID` when every create should target one cloud environment, `CLAUDE_MCP_REPOS` for local checkouts a create call may select, and `CLAUDE_MCP_REPO_CACHE` to choose where GitHub repositories are cloned:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/claude-code-mcp-server@latest"],
      "env": {
        "CLAUDE_MCP_CWD": "/absolute/path/to/your/repo",
        "CLAUDE_CLOUD_ENVIRONMENT_ID": "ccpool_your_environment_id",
        "CLAUDE_MCP_REPOS": "/absolute/path/to/a/local/checkout",
        "CLAUDE_MCP_REPO_CACHE": "/absolute/path/to/the/github/cache"
      }
    }
  }
}
```

A global install (`npm install -g @sohampatwardhan/claude-code-mcp-server`) exposes the same bin as `"command": "claude-code-mcp-server"` with `"args": []`.

### Reporting problems (Muse, Grok Bot, ChatGPT Dots, Claude Duet and other agents)

The server's MCP instructions ask calling agents to report problems with the server itself as issues on this repository, using the agent's own GitHub access (the server makes no GitHub calls for this). If your client doesn't pass server instructions to its model, put this text in the agent's own instructions:

> Report problems with this server as GitHub issues at https://github.com/sohampatwardhan/claude-code-mcp-server/issues, using your own GitHub access. Report a tool result that looks wrong for what happened: an error code that doesn't fit, an unexpected CLI_EXIT_NONZERO or CLI_TIMEOUT, parsed false on output that did name a session, a job that never finishes, or a CLI prompt or message the server didn't recognise. Search open issues first and comment on a match instead of opening a duplicate. Title it `fix: <what went wrong>` (or `feat: <what is missing>`), and include the tool name and arguments, the error code and message, cli.exit_code and the relevant lines of cli.stdout and cli.stderr, the server version from serverInfo, the host OS, what you expected, and whether it happens again. Before posting, remove tokens, credentials, email addresses, and private repository names, paths and code; the issue tracker is public. Don't file issues for problems in the session's own work (failing tests, a wrong change), or for an error whose message already says what to do (CLI_NOT_FOUND, CLI_NOT_SIGNED_IN, WORKSPACE_NOT_TRUSTED, REPO_NOT_ALLOWED) unless doing that didn't help.

Agents report server bugs: an error code that doesn't fit, a timeout or parse failure, a CLI prompt the server didn't recognise. They don't report failures in the session's own work, or setup errors whose message already says what to do. Reports are public, so the instructions tell agents to strip tokens, email addresses and private repository details first.

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
  repos.ts    per-call directory, GitHub checkout cache, session record, gh pr list, git status
  local.ts    CLAUDE_MCP_LOCAL_ROOTS and the local-run directory check
  parse.ts    CLI output parsing (session id / URL regexes, teleport branch and PR, auth JSON, stream-json, git status)
  runner.ts   child_process spawn with timeout and output caps (follow-up, session status, local runs, and auth)
  pty.ts      pseudo-terminal spawn used by create (embedded Python helper)
  trust.ts    workspace-trust dialog detection and the opt-in ~/.claude.json edit
  jobs.ts     in-memory create and local-run jobs (ids, status, retention)
  children.ts registry of child processes: process groups, cancel scopes, shutdown
  config.ts   environment variable parsing and validation
test/
  parse.test.ts        parser unit tests against realistic CLI output
  argv-config.test.ts  argv and config unit tests
  repos.test.ts        allowlist, path checks, GitHub cache, and base branch
  trust.test.ts        trust-dialog detection, ~/.claude.json edits, worktree path
  jobs.test.ts         job store: ids, status, retention
  children.test.ts     process groups, scope cancel, stopAll
  local.test.ts        local roots and cwd checks: symlinks, /var vs /private/var, prefixes
  smoke.test.ts        starts the built server over stdio and exercises every tool
  fixtures/fake-claude.mjs  stand-in CLI used by the smoke test (TTY, trust dialog, teleport, print-mode stream-json)
  fixtures/fake-gh.mjs      stand-in gh used when session status looks up a pull request
```

`prepack` compiles TypeScript into `dist/` and marks `dist/src/index.js` executable before the package is packed. CI runs `npm ci`, then `npm run build` and `npm test`.

## Releasing

The owner published the first version, `0.1.1`, once from a maintainer machine (npm refused `0.1.0` because that version number had been used before). Trusted publishing on npmjs.com can be saved only after that package exists. Later versions then publish from the tag workflow. Skip the `v0.1.1` tag for this bootstrap: the workflow would try to publish `0.1.1` again.

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
