# Changelog

## Unreleased

- `claude_create_cloud_session` runs in the background and returns within about 2 seconds, so a slow clone or `claude --cloud` on a large repository no longer hits the MCP client's request timeout (`-32001`). The output gains `job_id`, `status` (`cloning`, `starting`, `running`, `done`) and `elapsed_ms`. When `status` is not `done`, poll `claude_get_session` with the `job_id`.
- `claude_get_session` accepts a `job_id` and returns that create's progress or result in `job`, or its error. `session_id`, `repo` and `cli` in its output are now nullable.
- New `JOB_NOT_FOUND` error for job ids this server doesn't hold (jobs are in memory only).

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
