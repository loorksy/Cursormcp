# Audit — Repository & GitHub Intelligence

Date: 2026-09-17  
Branch base: `cursor/production-orchestrator-50d3`  
This document was written **before** adding repository-intelligence tools. Claims below are from the current source, not a desired architecture.

## Current architecture

Single Node 22 ESM process (`src/server.js`) serving:

- Express dashboard + REST `/api` and `/api/v2`
- MCP Streamable HTTP at `/mcp` (OAuth 2.1 DCR or `MCP_AUTH_TOKEN`)
- Cursor Cloud Agents client (`src/cursor-api.js`) — v1 list/create/get/runs/cancel; v0 create-with-webhook
- SQLite (`DATA_DIR/app.db`) memory, agents, events, webhooks
- In-process poller + event processors + Telegram

There is **no** repository file explorer, **no** git working-tree layer, and **no** GitHub contents/search/blame/issues/actions client beyond PR inspect/create.

```
Claude / ChatGPT
    → /mcp  →  MCP tools (agents + memory + orchestrator)
    → Cursor API  (agents, models, repositories list)
    → GitHub API  (PR get/create, repo languages only)
    → SQLite memory (projects.repo_url is a string, not a filesystem)
```

## Existing MCP tools

Registered in `src/mcp.js` → `memory-mcp.js` → `mcp-v2.js`.

**Cursor agents:** `create_agent`, `get_agent`, `followup_agent`, `list_repos`, `list_models`, `list_agents`  
**Memory:** `get_system_guide`, `project_list`, `project_create`, `project_get_full`, `project_get_capsule`, `task_add`, `task_propose_done`, `task_update_status`, `error_log`, `error_resolve`, `plan_prompt_save`, `plan_prompt_get_latest`, `ui_ux_save`, `ux_notes_save`, `rules_suggest`, `rules_list`, `pr_link_add`, `pr_link_list`  
**Orchestrator v2:** `project_get`, `project_update`, `project_orchestrate`, `agent_*`, `task_*`, `plan_*`, `run_tests`, `get_verification_status`, `get_build_status`, `get_pr`, `get_pr_status`, `create_pr`, `telegram_*`, `notification_preferences`, `event_*`

`list_repos` calls Cursor `GET /v1/repositories` — a **list of URLs the API key may launch agents on**, not a file tree.

No tools named `repo.*`, `git.*`, `github.pull_request.*` (except URL-based `get_pr`), `project.snapshot`, or `project.audit`.

## Existing GitHub capabilities

`src/github.js` (host hardcoded `https://api.github.com`):

| Function | API | Notes |
| --- | --- | --- |
| `parseGithubRepo` / `parsePrUrl` | regex on `github.com` | SSRF-limited to github.com path shape |
| `inspectPullRequest` | `GET /repos/.../pulls/{n}` + `.../commits/{sha}/check-runs` | existence + failed/pending counts |
| `getPullRequest` | `GET /pulls/{n}` | raw PR JSON |
| `createPullRequest` | `POST /pulls` | requires `GITHUB_TOKEN`; no fake PRs |
| `analyzeRepository` | `GET /repos/{owner}/{repo}` + `/languages` | metadata only |

Not implemented: git trees, contents/blobs, compare/diff, commits list, blame, PR files, PR review comments, reviews, issues, issue comments, Actions runs, code search, GraphQL.

`GITHUB_TOKEN` is optional in `.env.example`. Live VPS had an empty token after orchestrator deploy; GitHub writes will fail until set.

## Existing Cursor capabilities

`src/cursor-api.js`: agents, runs, cancel, archive, models, **repositories list**, `me`. No repository file APIs. Cursor Cloud Agents API is not a source-code host.

## Existing project-memory system

SQLite tables: `projects` (`repo_url` string), `tasks`, `rules`, `errors`, `ux_notes`, `ui_ux_notes`, `plan_prompts`, `pr_links`, governed verified vs draft. Capsules **must not** be treated as a substitute for reading the repo. `orchestrateProject` calls `analyzeRepository` (languages + description) then creates tasks — it does **not** read source files.

## Existing webhook / event system

Idempotent `events` table, Cursor v0 HMAC gateway, poller, Telegram. Unrelated to GitHub file content. GitHub webhooks are **not** installed.

## Authentication / authorization

- Dashboard: session cookie after password
- MCP: bearer token or OAuth
- Telegram: allowlisted chat ids
- GitHub: whatever the token can see
- **No workspace→repository permission table.** Any MCP caller who can use `get_pr`/`create_pr` can pass any `github.com` URL the token can access. `list_repos` is Cursor-scoped, but GitHub tools are not bound to that list.

## Configuration

`.env.example` has `GITHUB_TOKEN`, Cursor, Telegram, poller. No `GITHUB_API_BASE_URL`, no repo allowlist, no local clone root, no intel size limits.

## Tests

`test/*.test.js`: orchestrator lifecycle, events, tasks, state, auth 401, healing. **Zero** tests for GitHub contents, git diff, search, or secret redaction of file bodies.

## Missing capabilities (this work)

1. Real tree / directory listing / file read / batch read / glob / metadata
2. Text/regex search with context and pagination
3. Context engine (ignore, binary, languages, dependency/architecture map, chunking)
4. Secret redaction before MCP output
5. Git status/branches/commits/diff/changed files/history/blame
6. GitHub PRs (files, diff, comments, reviews, checks), issues, Actions
7. `project.snapshot` and evidence-based `project.audit`
8. SHA-pinned reads + cache keyed by repo+ref+sha
9. Repo allowlist (not URL-only auth)
10. Structured intel errors, audit log of tool+repo+path (no file bodies)
11. Pagination (`has_more` / `next_cursor`) on every large tool

## Risks

- **SSRF:** must keep GitHub host allowlist; never fetch operator URLs into the intel layer.
- **Secret leakage:** reading `.env` or keys in source would currently flow straight to the model.
- **Token scope:** without `GITHUB_TOKEN`, GitHub contents for private repos fail; public REST still rate-limited.
- **Code search API** often returns 403 unless the token has code-search access; need a tree-scan fallback (bounded).
- **Blame** is GraphQL or local `git blame`; REST has no equivalent. Do not invent a REST blame.
- **git.status** has no meaning on a remote-only repo (no working tree). Map to compare vs default branch and document it.
- **Large trees:** GitHub recursive trees can be truncated; must paginate and not dump 10k files into one MCP result.
- **Do not clone arbitrary URLs.** Clone cache only for allowlisted `github.com/owner/repo`.
- **Backward compatibility:** existing MCP tool names must remain.

## Proposed architecture

```
MCP (existing tools unchanged)
  + intel MCP tools (repo_*, git_*, github_*, project_snapshot, project_audit)
        │
        ▼
  Allowlist: env GITHUB_ALLOWED_REPOS ∪ projects.repo_url ∪ Cursor list_repos (cached)
        │
        ▼
  GitHub REST/GraphQL (GITHUB_API_BASE_URL, test-overridable)
  optional local git (INTEL_LOCAL_ROOT / clone cache keyed by sha)
        │
        ▼
  Redaction → size limits → pagination → MCP JSON
        │
        ▼
  SQLite intel_cache (repo|sha|kind) + intel_access_log (no bodies)
```

Sources of truth:

- **Remote:** GitHub API at a commit SHA
- **Local (optional):** `git` CLI on an allowlisted working copy or sha-keyed clone
- **Memory:** never used as file content; used in `project.audit` as a separate evidence section

## Migration strategy

1. Add intel modules and MCP registration; do not rename existing tools.
2. Extend `src/github.js` fetch to honor `GITHUB_API_BASE_URL` so tests can mock without touching production host logic.
3. Default-deny unknown repos; if allowlist env is empty, allow only project URLs + Cursor-listed repos + local mapped repo.
4. Keep `get_pr` / `create_pr` behavior; new tools take `owner/repo` or URL plus `pull_number`.
5. Docs: `REPOSITORY_INTELLIGENCE.md` and friends. Live VPS remains systemd; no new ports, no Docker on the locked-down VPS.
6. Tests: temp git repos + mock GitHub HTTP. Live `gh api` against `loorksy/Cursormcp` only when a token is present.
