# AGENTS.md

Operating guide for every coding agent working in this repository (Claude Code, Codex, Cursor, Copilot and others). It is the only project instruction file: `CLAUDE.md` just imports it, so edit this file, not that one.

The descriptive sections (what the server does, architecture, setup) follow the code. When they disagree, the code is right and this file gets fixed in the same change. The rules under [Safety](#safety) and [Planned changes](#planned-changes) are constraints, not descriptions. Change them only deliberately, in the pull request that needs the change, and say so in its description.

## What this is

`claude-code-mcp-server` is a Node.js 20+ TypeScript MCP server. It speaks MCP over stdio and exposes exactly six tools that drive the Claude Code CLI:

| Tool | CLI invocation | How it is spawned |
| --- | --- | --- |
| `claude_create_cloud_session` | `claude --cloud=<description> [--environment=<id>]` | Pseudo-terminal (`src/pty.ts`), inside an in-memory background job (`src/jobs.ts`). The CLI rejects this form when stdout is a pipe. The call returns within `CREATE_WAIT_MS` (2 s), with the final result or a `job_id`. |
| `claude_send_followup` | `claude --cloud=<session> -p -- <message>` | `child_process.spawn`, stdin closed (`src/runner.ts`) |
| `claude_get_session` | For a session: `claude --teleport=<session> --debug --debug-file=<cache file>` in `CLAUDE_MCP_REPO_CACHE`, then read-only `gh pr list` if needed. For a `job_` id: nothing; the job is read from memory. | Pipe spawn, stdin closed, no prompt (`src/repos.ts`, `src/runner.ts`) |
| `claude_cancel_session` | Nothing new. It stops a create or local-run job's processes (SIGTERM, then SIGKILL 5 s later). | Signals only the job's tracked process groups (`src/children.ts`) |
| `claude_run_local` | `claude -p --output-format=stream-json --verbose --permission-mode=<mode> [--model=] [--max-turns=] [--allowedTools=] [--resume=] -- <prompt>` in a `cwd` under `CLAUDE_MCP_LOCAL_ROOTS`, plus read-only `git status` before and after | Pipe spawn, stdin closed (`src/runner.ts`), inside an in-memory background job like create |
| `claude_auth_status` | `claude auth status` | Same pipe spawn as follow-up |

The server has no HTTP listener and no database. It spawns the local `claude` binary (or `CLAUDE_BIN`); its only network calls of its own are `git clone` / `git fetch` of a validated github.com `owner/name` into `CLAUDE_MCP_REPO_CACHE`, and `gh pr list` for `claude_get_session`. Create and follow-up always pass `--cloud=` and never start a local Claude Code session; `claude_run_local` is the only local run. `claude_get_session` returns the branch a session pushed and its pull request, not the assistant transcript. Server-level guidance for calling agents (check results with `claude_get_session` and the `session_url`; patch fallback when a session can't push) is `SERVER_INSTRUCTIONS` in `src/server.ts`.

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
src/prereq.ts    CLI install/sign-in messages, PATH lookup, login-error detection
src/repos.ts     repo allowlist, GitHub cache clone/fetch/checkout, session records, gh pr lookup, local git status
src/local.ts     CLAUDE_MCP_LOCAL_ROOTS parsing and the realpath check for a local run's cwd
src/jobs.ts      in-memory jobs (create and local runs): ids, status, TTL and cap, settleWithin
src/children.ts  child-process registry: process groups, cancel scopes (AsyncLocalStorage), stopAll
test/fixtures/fake-claude.mjs   stand-in CLI used by the smoke test (including teleport and print-mode stream-json)
test/fixtures/fake-gh.mjs       stand-in gh used by session-status smoke cases
```

`createServer` in `src/server.ts` is the composition root. Create starts a `JobStore` job (`runCreateJob`: clone, then `runCliPty`) and waits up to `CREATE_WAIT_MS` for it. Follow-up and auth go through `runCli`. `claude_run_local` starts a second `JobStore` job (`runLocalJob`: `git status`, `runCli` with a `LocalStreamParser` reading stdout as it arrives, `git status` again). Both return structured content that matches the tool `outputSchema`. Failures are MCP tool errors whose text body is `{ error: { code, message, args, cli } }` with a code from `ErrorCode`.

Create runs in the selected `repo` (a github.com cache checkout, or an absolute directory on `CLAUDE_MCP_REPOS`), otherwise in `CLAUDE_MCP_CWD` (default: the process working directory). `claude --cloud` packages that tree. Workspace trust is keyed on the main git checkout when that directory is inside a repository or worktree, otherwise on the directory itself (`resolveTrustProjectPath`).

## Setup, build, test, lint

Prerequisites on a developer machine: Node.js 20 or later, npm, Python 3 (stdlib only: `pty`, `fcntl`, `termios`), and git. Python is required because create, including the smoke test, allocates a pty with `python3 -I`. No pip packages.

```sh
npm ci          # install from package-lock.json
npm run build   # tsc -p tsconfig.json; emits dist/
npm test        # build, then node:test on the compiled tests
npm start       # node dist/src/index.js (stdio; idle until an MCP client connects)
```

There is no separate lint script and no ESLint or Prettier config. `npm run build` is the static check: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`. Do not add a linter unless the change is explicitly about linting.

`npm test` runs, in order: `dist/test/parse.test.js`, `dist/test/argv-config.test.js`, `dist/test/trust.test.js`, `dist/test/repos.test.js`, `dist/test/prereq.test.js`, `dist/test/jobs.test.js`, `dist/test/children.test.js`, `dist/test/local.test.js`, `dist/test/smoke.test.js`. Tests import the compiled `.js` next to the sources. The smoke fixtures stay at `test/fixtures/fake-claude.mjs` and `test/fixtures/fake-gh.mjs` and are not compiled.

Runtime environment variables (all optional; invalid values exit the process with code 2):

| Variable | Default | Role |
| --- | --- | --- |
| `CLAUDE_BIN` | `claude` | CLI path or name |
| `CLAUDE_CLOUD_ENVIRONMENT_ID` | unset | Default `--environment` when a create call omits `environment_id` |
| `CLAUDE_MCP_TIMEOUT_MS` | `300000` | Per-process timeout, then SIGTERM and SIGKILL 5 s later. Create's `timeout_s` overrides it. |
| `CLAUDE_MCP_IDLE_TIMEOUT_MS` | unset (off) | Stop `claude --cloud` on create after this long with no output. Create's `idle_timeout_s` overrides it. |
| `CLAUDE_MCP_TRUST_CWD` | off | `1` / `true` / `yes` accepts workspace trust for the one resolved directory |
| `CLAUDE_MCP_PYTHON` | `python3` | Interpreter that allocates the create pty |
| `CLAUDE_MCP_CWD` | `process.cwd()` | Directory the CLI runs in when a call omits `repo`; must exist and be a directory |
| `CLAUDE_MCP_REPOS` | empty | Comma-separated absolute directories a create call may select (github.com repos need no entry) |
| `CLAUDE_MCP_REPO_CACHE` | `~/.claude-mcp/repos` | Where github.com repositories named by a call are cloned |
| `CLAUDE_MCP_LOCAL_ROOTS` | empty (local runs refused) | Comma-separated absolute directories `claude_run_local` may run in (and below), stored as real paths |
| `CLAUDE_MCP_LOCAL_ALLOW_SHELL` | off | `1` / `true` / `yes` lets a local run pre-approve `Bash` or use `auto` mode |

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
- **Push-failure fallback.** If a cloud session can't push to GitHub (`claude_get_session` finds no branch), the calling agent asks it through `claude_send_followup` for `git format-patch origin/<base>..HEAD --stdout` or a full `git diff`. It copies the patch from the `session_url`, applies it locally (`git am` / `git apply --3way`), runs the tests, and pushes and opens the PR itself. Keep this guidance the same in `SERVER_INSTRUCTIONS`, the create and follow-up tool descriptions, and the README.
- Keep dependencies to `@modelcontextprotocol/sdk` and `zod` at runtime, plus TypeScript and `@types/node` for dev. No telemetry.
- Check library APIs (above all `@modelcontextprotocol/sdk`: `McpServer`, `registerTool`, schema handling, transports) against current docs before writing or changing code against them. Don't rely on memory. `.mcp.json` registers the Context7 server for this. If it is unreachable, read the installed package's `.d.ts` and source under `node_modules` for the pinned version. Where docs and memory disagree, the docs win.

## Testing

`npm test` must pass before a change is done. The suite creates no cloud sessions and does not talk to claude.ai. The smoke test sets `CLAUDE_BIN` to `test/fixtures/fake-claude.mjs`.

When you change behavior, extend the test that owns it:

- Parser regexes and output shapes: `test/parse.test.ts`, using transcripts shaped like real CLI output (labelled lines, JSON lines, ANSI, the trust dialog, stream-json split at any chunk boundary, `git status -z`).
- Argv order and config validation: `test/argv-config.test.ts`, including the local-run argv and what `assertLocal` refuses.
- Local roots and the local `cwd` check: `test/local.test.ts` (symlinks in and out of a root, macOS `/var` vs `/private/var`, a sibling that shares a name prefix).
- Missing-CLI and sign-in messages, PATH lookup, and login-error detection: `test/prereq.test.ts`.
- Repo allowlist, path checks, the GitHub cache (partial clone over `file://` with `uploadpack.allowFilter`, reuse without recloning), and base branch: `test/repos.test.ts` (local bare repos, no network).
- Trust-dialog detection, `~/.claude.json` edits, and worktree path resolution: `test/trust.test.ts`. These use a temp directory, not the developer's `~/.claude.json`.
- Job ids, status, TTL and cap, thrown-error capture, and `settleWithin`: `test/jobs.test.ts` (injected clock, no processes).
- Process groups, scope cancel, and `stopAll`: `test/children.test.ts` (real `node` children, including a grandchild).
- Tool wiring over stdio (schemas, server instructions, create, create jobs and polling, follow-up, session status, local runs, auth, failures, trust refusal and accept): `test/smoke.test.ts`. Drive modes (including `signed_out`) with `FAKE_CLAUDE_MODE`, `FAKE_CLAUDE_TRUST`, `FAKE_CLAUDE_CREATE_DELAY_MS` / `FAKE_CLAUDE_CREATE_LINGER_MS` (a create slower than the 2 s wait), `FAKE_TELEPORT_*`, `FAKE_LOCAL_*` (local runs), and `FAKE_GH_*`. Poll jobs with the `pollJob` helper and processes with `waitFor`, never fixed sleeps. The fake's meta log records its `pid`, so cancel and shutdown tests can check that the process actually exited. Do not point tests at a real `claude` binary.

Create smoke cases need Python 3 because they go through the pty helper even when the child is the fake CLI.

## Safety

This process can launch a CLI that packages a repository and, if workspace trust is accepted, runs that folder's hooks and allow rules. Keep the blast radius as it is. Widening it takes an explicit rule change (see [Planned changes](#planned-changes)), not a side effect of a feature.

- **Cloud tools stay cloud.** Create and follow-up argv starts with `--cloud=` (`assertCloud` in `src/argv.ts`). They never fall back to a local Claude Code session, even when the cloud call fails, and never take a flag that makes them local. `claude_get_session` is the one non-cloud invocation: print-mode `claude --teleport=<session> --debug --debug-file=<cache file>` (`teleportArgv`), only inside `CLAUDE_MCP_REPO_CACHE`, with no prompt and no pty. Do not point teleport at a caller's checkout, and do not add a prompt to it. The only local Claude Code run is `claude_run_local` (see **Local runs**).
- **Fixed tool allowlist.** The surface is the tools in the table under [What this is](#what-this-is), and no others. Adding a tool is a deliberate change: it needs an issue, a row in that table, a strict input schema, an `outputSchema`, and smoke coverage. Never add a shell tool, a raw-argv tool, a "run any claude command" tool, or a field that passes free-form CLI flags through.
- **Input allowlists.** `environment_id` must match `ENVIRONMENT_ID_PATTERN`. `repo` must be a github.com `owner/name` (or URL) or an absolute directory on `CLAUDE_MCP_REPOS`; `base_branch` must already exist on `origin`. Follow-up `session` must match `SESSION_REF_PATTERN` (a `session_` / `cse_` id or a `https://claude.ai/code/` URL). Status `session` matches that or `JOB_ID_PATTERN` (`job_` and 24 hex characters). Description, message and prompt are length-capped strings that contain non-whitespace. Local-run inputs are covered under **Local runs**. Unknown properties are rejected before any process is spawned. Don't accept other git hosts, tokens, arbitrary paths, or refspecs.
- **Network surface.** Outbound, the server only runs `git clone` / `git fetch` of a validated github.com `owner/name` into the cache (including the on-demand content fetches of a partial clone) and read-only `gh pr list`. Inbound, it has no listener today: MCP runs over stdio. Any listener follows the HTTP transport rules in [Planned changes](#planned-changes).
- **Create jobs.** Create work runs in a `JobStore` job held in memory only: no database, and nothing on disk beyond the existing cache and session records. Finished jobs are dropped after `JOB_TTL_MS` (1 h), keeping at most `MAX_FINISHED_JOBS` (100). Job phases are `cloning`, `starting`, `running`, `done` and `cancelled`. `cancelled` is final, and `JobStore.advance` never moves a job out of it. A failed job never reports an `error` status. Reading it returns its tool error, with the same codes as a synchronous failure. A job reports a bounded tail of CLI output (`OUTPUT_TAIL_CHARS`, after `cleanTerminalText`), never the assistant transcript. Reading a job id spawns nothing. Every client must be able to get the result by polling `claude_get_session`; MCP progress notifications and MCP Tasks may be added, but only as extras. Create still always passes `--cloud=`.
- **Child processes.** Every spawn site passes `detached: true` and calls `track()` from `src/children.ts`, so each child leads its own process group and is in the registry. Signals go to the group (`killGroup`); the pty path also signals the recorded `claude` pid, which `pty.fork` puts in its own session. Every child has a timeout (`CLAUDE_MCP_TIMEOUT_MS` or create's `timeout_s`, then SIGTERM, then SIGKILL 5 s later). A create job, a local-run job, and each follow-up, session-status and auth request, runs in a `Scope`. `claude_cancel_session`, a request the client cancels, or a job cancelled before create returns aborts that scope. Lock waits in `src/repos.ts` stop when the scope is aborted. On stdin close, SIGINT, SIGTERM or SIGHUP, `src/index.ts` runs `stopAll` before exiting. The pty helper stops `claude` if the server disappears. Only signal processes this server started and tracked, never a PID that came from input. A new spawn site must use `detached: true` and `track()`.
- **Cache clones.** A first clone into the cache is `git clone --filter=blob:none` (`CLONE_FILTER` in `src/repos.ts`), never a shallow `--depth` clone, so the cache keeps full history for teleport and later fetches. Git fetches missing file contents from the same `origin` on demand. An existing, healthy cache checkout is always reused with `git fetch` and never recloned; only a cache directory that is not a git work tree is removed and cloned again. Hooks stay disabled, and the server still builds every refspec itself. Create reports `cache: { cloned, duration_ms }`.
- **Local runs.** `claude_run_local` is the only tool that runs Claude Code locally (`claude -p`, no `--cloud=`). Its argv comes from `localRunArgv` in `src/argv.ts`, and `assertLocal` refuses anything that isn't print mode or that carries `--cloud`, `--teleport`, `--dangerously*` or `bypassPermissions` before the `--`. `assertCloud` stays on create and follow-up. `cwd` must resolve, after `realpath`, to a directory inside a `CLAUDE_MCP_LOCAL_ROOTS` root (stored as real paths, `/` refused). With no roots the tool refuses with `LOCAL_RUNS_DISABLED` before anything runs. Print mode skips the workspace-trust dialog, so adding a root trusts every checkout under it, and the README says so. `permission_mode` is an enum (`dontAsk`, the default, `acceptEdits`, `plan`, `auto`) and is always passed, so a settings file's `defaultMode` can't change it. `allowed_tools` takes built-in names from `LOCAL_ALLOWED_TOOLS` only (no patterns, no MCP tools). Pre-approving `Bash` or choosing `auto` runs shell commands unasked, so both are refused with `LOCAL_SHELL_DISABLED` unless the operator sets `CLAUDE_MCP_LOCAL_ALLOW_SHELL`; a caller can never turn that on. Do not add another way for a call to get unasked shell access (Bash patterns, `PowerShell`, a mode) that skips this gate. `model` matches `MODEL_PATTERN`, and `resume` matches `LOCAL_SESSION_ID_PATTERN` (a UUID). `--dangerously-skip-permissions` and `bypassPermissions` are never passed, and no field forwards free-form flags. The run is a `JobStore` job in memory like create, polled with `claude_get_session`. The stream-json transcript is parsed as it arrives and not kept: the job reports the final result fields, never the transcript, and `cli.stdout` carries a bounded tail only when no result line was read.
- **No arbitrary command execution.** `spawn` and the pty helper (`os.execvp` of the spec binary) never use a shell. The other subprocesses are `git -C <cwd> rev-parse` inside `src/trust.ts`, `git` clone/fetch/checkout in the cache (hooks disabled), read-only `gh pr list`, and read-only `git status` (no optional locks, hooks and fsmonitor off) in a local run's `cwd`, all in `src/repos.ts` with fixed argument lists. Teleport runs only inside `CLAUDE_MCP_REPO_CACHE`, never in a caller's checkout. Do not interpolate user text into a shell command. The pty helper is started as `python3 -I` so it does not import user site packages.
- **Trust is opt-in and narrow.** `CLAUDE_MCP_TRUST_CWD` defaults off. A trust dialog then fails the tool with `WORKSPACE_NOT_TRUSTED` and is not answered. When the flag is on, `ensureWorkspaceTrusted` sets `projects[<one path>].hasTrustDialogAccepted` only, under `~/.claude.json.lock`, and refuses to rewrite a file that is not a JSON object. A description that merely contains "Do you trust this folder?" is not the dialog; `isTrustPrompt` ignores the `Created cloud session:` line. Do not accept trust for extra directories, and do not answer other permission prompts.
- **Do not log tokens or credentials.** Do not print or persist CLI stdout, stderr, `process.env`, or `~/.claude.json`. Auth JSON may carry token material; `parseAuthStatus` copies only `loggedIn`, `authMethod`, `email`, `orgName`, and `subscriptionType`. Do not add token fields to structured output. The `cli` object is the existing diagnostic returned to the MCP client after control sequences are removed; do not add a second log of it.

## Planned changes

Open issues that change the rules above. None of them is implemented yet, and until its PR lands the current rules apply. Each entry is the set of constraints that PR must meet. When it lands, move its rules into the sections above (and the tool table) and delete its entry here. The HTTP transport (#15) must still stop every child, including local runs, when the server shuts down.

- **Streamable HTTP transport (#15).** Off unless an explicit flag turns it on. Stdio stays the default, and the Cursor boot setup stays stdio-only. It binds `127.0.0.1` unless told otherwise. It refuses to start without `CLAUDE_MCP_TOKEN`, and every request needs `Authorization: Bearer <token>`, compared in constant time. A missing or wrong token gets 401 before any MCP handling. Turn on the SDK's DNS-rebinding protection (allowed hosts), checked against current SDK docs. Use Node's built-in `http`, with no new framework dependency. Never log the token. The docs cover private exposure only (`tailscale serve`), never Funnel or the public internet.

## Pull requests and commits

Use Conventional Commits subjects (`feat:`, `fix:`, `docs:`, `build:`, `ci:`, `test:`, `chore:`), for example `feat: target any GitHub repo and report the session branch and pull request`. Keep the subject specific to the change. Put tests in the same commit as the behavior they cover. Do not commit `node_modules/`, `dist/`, MCP client config files, or secrets (see `.gitignore`).

The package publishes to npm as `@sohampatwardhan/claude-code-mcp-server` from `v*` tags via `.github/workflows/release.yml` (trusted publishing). Agents do not bump the version, push tags, or run `npm publish`.

## Cursor Cloud specific instructions

Future Cloud Agents on this repo should boot from a machine where `npm ci` has already run. The committed config is `.cursor/environment.json`.

- **Install:** `npm ci`. It is idempotent: it reinstalls from `package-lock.json`. Do not switch it to `npm install`, which can rewrite the lockfile.
- **Build:** `npm run build`.
- **Test:** `npm test`. This is the full suite.
- **Lint:** no lint script. Use `npm run build` as the typecheck.
- **Base image:** Cursor's default image. It already provides Node.js 22 (the package requires `>=20`) and Python 3. No `.cursor/Dockerfile`.
- **No `start` and no `terminals`.** The server is stdio-only. Nothing needs to listen on a port. `npm start` waits for an MCP client and is not part of boot.
- **The real Claude Code CLI is not available, and there is no claude.ai login.** Do not install the CLI, do not run `claude auth`, and do not set `CLAUDE_BIN` to a real binary in order to make tests pass. `npm test` already points the smoke test at `test/fixtures/fake-claude.mjs`. A missing `claude` on `PATH` is expected.
- **Secrets:** none. Install, build, and test do not read credentials, need no network beyond `npm ci`, and do not need a real `gh` (the smoke test uses `test/fixtures/fake-gh.mjs`). The `CLAUDE_*` variables above are optional runtime settings for a deployed server; leave them unset here. Do not put tokens, a Claude session, or `~/.claude.json` contents into the repo or into Cursor Secrets for this dev loop.
