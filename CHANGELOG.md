# Changelog

## Unreleased

- `claude_create_cloud_session` runs in the background and returns within about 2 seconds, so a slow clone or `claude --cloud` on a large repository no longer hits the MCP client's request timeout (`-32001`). The output gains `job_id`, `status` (`cloning`, `starting`, `running`, `done`) and `elapsed_ms`. When `status` is not `done`, poll `claude_get_session` with the `job_id`.
- `claude_get_session` accepts a `job_id` and returns that create's progress or result in `job`, or its error. `session_id`, `repo` and `cli` in its output are now nullable.
- Server instructions ask calling agents (Muse, Grok Bot and others) to report problems with the server as GitHub issues on this repository: what to include, what to strip, and what not to report. The README has the same text for clients that don't pass server instructions on.
- `serverInfo.version` now reports the package version (it said `0.1.1`).
- The README, package description and AGENTS.md name ChatGPT Dots and Claude Duet alongside Muse and Grok Bot as orchestrators, and describe the planned MCP orchestration suite (one server per agent tool, sharing the #28 job model).
- New `JOB_NOT_FOUND` error for job ids this server doesn't hold (jobs are in memory only).
- New `claude_cancel_session` tool stops a create job that is still running: SIGTERM to every process it started, then SIGKILL 5 s later. It reports `cancelled` and `stopped`. It doesn't stop a cloud session that was already created. Cancelled jobs report `status: "cancelled"`.
- Every child process now leads its own process group and is tracked. A follow-up, session-status or auth request that the client cancels (for example on its own request timeout) stops its processes. When stdin closes, or on SIGINT, SIGTERM or SIGHUP, the server stops every child before exiting. The pty helper stops `claude --cloud` if the server is killed outright.
- `claude_create_cloud_session` accepts `timeout_s` (overrides `CLAUDE_MCP_TIMEOUT_MS` for that create) and `idle_timeout_s` (stops `claude --cloud` after that many seconds with no output). The new `CLAUDE_MCP_IDLE_TIMEOUT_MS` sets the idle default, and is off when unset.
- First clones into `CLAUDE_MCP_REPO_CACHE` are partial (`git clone --filter=blob:none`), so a large repository downloads its history without every old file version. A healthy cache is still reused with `git fetch` and never recloned. The create output (and `job` in `claude_get_session`) gains `cache: { cloned, duration_ms }`.

## 0.1.1

First version on npm (npm refused `0.1.0` because that version number had been used before). Published from `ba454e8`.

- `claude_create_cloud_session` accepts `repo` (any github.com `owner/name`, cloned into `CLAUDE_MCP_REPO_CACHE`, or an absolute directory on `CLAUDE_MCP_REPOS`) and `base_branch`.
- New `claude_get_session` tool reports the branch a cloud session pushed and its pull request.
- Server instructions and tool descriptions explain the patch fallback when a session can't push.
- `CLI_NOT_FOUND` names the install command (`npm install -g @anthropic-ai/claude-code`), the server warns at startup when `claude` is missing, and the new `CLI_NOT_SIGNED_IN` error says to sign in with `claude` first.
- Cloud Agent environment (`.cursor/environment.json`) and `AGENTS.md`.

## 0.1.0

Initial release of `@sohampatwardhan/claude-code-mcp-server`.

- MCP server over stdio with `claude_create_cloud_session`, `claude_send_followup`, and `claude_auth_status`. Session tools always pass `--cloud`.
- Publish the scoped package for `npx -y @sohampatwardhan/claude-code-mcp-server@latest`. The bin name stays `claude-code-mcp-server`.
- `prepack` compiles TypeScript and marks `dist/src/index.js` executable (it keeps the `#!/usr/bin/env node` shebang) before `npm pack` and `npm publish`.
- GitHub Actions (`.github/workflows/release.yml`) publishes `vX.Y.Z` tags to npm with provenance via trusted publishing. No npm token is stored in the repo.
