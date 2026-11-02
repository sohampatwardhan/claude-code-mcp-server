# Changelog

## 0.1.0

Initial release of `@sohampatwardhan/claude-code-mcp-server`.

- MCP server over stdio with `claude_create_cloud_session`, `claude_send_followup`, and `claude_auth_status`. Session tools always pass `--cloud`.
- Publish the scoped package for `npx -y @sohampatwardhan/claude-code-mcp-server@latest`. The bin name stays `claude-code-mcp-server`.
- `prepack` compiles TypeScript and marks `dist/src/index.js` executable (it keeps the `#!/usr/bin/env node` shebang) before `npm pack` and `npm publish`.
- GitHub Actions (`.github/workflows/release.yml`) publishes `vX.Y.Z` tags to npm with provenance via trusted publishing. No npm token is stored in the repo.
