# Final audit — Repository & GitHub Intelligence

Date: 2026-09-17  
Branch: `cursor/repository-intelligence-50d3`  
Base: `cursor/production-orchestrator-50d3`

Phase 0: `AUDIT_REPOSITORY_INTELLIGENCE.md` committed before implementation.

## Implemented features

| Feature | Implemented | Integrated | Tested | Verified |
| --- | --- | --- | --- | --- |
| Repo tree / dir / read / batch / glob / metadata | yes | MCP | yes | local git + filesystem checkout |
| Search (GitHub + tree scan) | yes | MCP | yes | tree scan (search API 403 path) |
| Context engine ignore/binary/languages | yes | snapshot | yes | |
| Secret redaction | yes | read/diff/MCP | yes | |
| Git status/branches/commits/diff/changed/history/blame | yes | MCP | yes | local git |
| GitHub PR files/diff/comments/reviews/checks | yes | MCP | yes | mock HTTP |
| Issues + Actions | yes | MCP | yes | mock HTTP |
| Snapshot + architecture + audit + PR review context | yes | MCP | yes | |
| Pagination / SHA pin / cache | yes | SQLite | yes | 10k + 120 files |
| Allowlist + path traversal + SSRF path rules | yes | MCP | yes | |
| Backward compatible existing tools | yes | mcp.js | previous suite | |

## Changed / added files (selected)

`src/intel/*`, `src/intel-mcp.js`, `src/github.js` (`GITHUB_API_BASE_URL`, `parseOwnerRepo`), `src/mcp.js`, `src/config.js`, `src/schema-v2.js` (`intel_cache`, `intel_access_log`), tests, docs listed below.

## Database

- `intel_cache` — keyed payload by repo/sha/kind, TTL
- `intel_access_log` — actor, tool, repository, path, ref, request_id, status, code (no bodies)

## New MCP tools

See `INTEL_TOOL_NAMES` in `src/intel-mcp.js` (32 tools: repo_*, git_*, github_*, project_snapshot/audit/architecture).

## Tests executed

```
npm test   → 37 passed, 0 failed (node:test, process isolation)
npm run lint → node --check on all src/*.js
```

Live GitHub `GET /repos/loorksy/Cursormcp` succeeded (`private: false`, default `main`). Live intel against this checkout + GitHub token: tree includes `src/`, `repo_file_read` of `src/server.js`, search, commits, open PRs.

## Known limitations

1. GitHub code search often 403 → bounded tree scan.
2. REST has no blame; GraphQL or local git or commit history fallback.
3. `git_status` without a worktree is compare vs default branch.
4. No automatic git clone of arbitrary repos.
5. Cursor API is not a source-code host.
6. If `GITHUB_ALLOWED_REPOS` is unset in production, allowlist is projects + Cursor-listed repos + local origin — still not the open internet.
7. Mapped non-git checkouts (`INTEL_LOCAL_REPOS`) are read as `source: filesystem` so a stale/empty GitHub `main` cannot hide deployed files. Pin a commit SHA to read GitHub instead.

## Deployment

Same systemd unit. Set `GITHUB_TOKEN` to read private GitHub data. For a deploy tree that is not a git clone, set `INTEL_LOCAL_REPOS=owner/repo:/opt/mcp-cursor-bridge` (and optional `INTEL_LOCAL_ROOT` of the same path). No new ports, no Docker on the locked-down VPS.
