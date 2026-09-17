# Security

- Secrets live in `.env` (mode 600) or AES-256-GCM `settings` for the Cursor API key. Telegram bot token is not written to SQLite.
- Webhook HMAC and optional Telegram `secret_token`.
- Telegram actions require an allowlisted chat id.
- Dashboard session: HttpOnly, Secure, SameSite=lax.
- MCP: OAuth 2.1 + DCR or bearer token.
- Logs redact keys matching `api_key|authorization|password|secret|token|cookie`.
- MCP tool results must not include env secrets; Cursor error bodies are passed through but local env is not.
- Verification commands spawn argv arrays from an allowlist (`npm`, `node`, `npx`) with cwd confined under the app root.
- GitHub fetches are host `GITHUB_API_BASE_URL` (default `api.github.com`) with path-only URLs; owner/repo charset is restricted.
- Intelligence tools require an allowlisted repository (`GITHUB_ALLOWED_REPOS` and/or project URLs / Cursor list / local maps). Arbitrary GitHub URLs are rejected.
- File/diff bodies are secret-redacted before MCP responses. `intel_access_log` stores tool/repo/path/ref/status, not file contents.
- `audit_log` is append-only (SQLite triggers).
- SSRF: webhook URLs are outbound Cursor-defined; this process does not fetch operator-supplied arbitrary URLs except GitHub PR/repo paths parsed from `github.com`.
