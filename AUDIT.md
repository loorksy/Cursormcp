# Cursor MCP V2 — Phase 0 Audit

Date: 2026-09-17  
Repository: `loorksy/Cursormcp`  
Live service: systemd unit `mcp-cursor-bridge` at `/opt/mcp-cursor-bridge`, bind `127.0.0.1:18800`, HTTPS `https://mcp.lork.cloud`  
This document was written **before** orchestrator restructuring. It describes what exists, not what we wish existed.

## 1. Structure

```
src/                 Node ESM application (no TypeScript)
  server.js          Express HTTP + dashboard APIs + MCP mount
  mcp.js             MCP Streamable HTTP tools (agents)
  memory.js          Governed SQLite memory
  memory-mcp.js      MCP tools for memory
  memory-guide.js    Public system guide text
  cursor-api.js      Cursor Cloud Agents HTTP client
  webhook.js         HMAC webhook + Telegram notify-on-finish
  telegram-notify.js sendMessage helper
  oauth.js           OAuth 2.1 + DCR for Claude.ai
  lib.js             env, sqlite, encrypt, sessions, logs
public/              RTL Arabic dashboard (HTML/CSS/JS)
deploy/              systemd unit + nginx site snippets
.env.example
README.md
package.json         scripts: start only
```

Absent before this work:

- `test/` directory
- TypeScript / lint / typecheck / CI config
- Dockerfile / docker-compose
- Redis / Postgres clients
- Migration runner (schema is `CREATE TABLE IF NOT EXISTS` in process)
- Event bus, polling worker, orchestrator, verification engine, self-heal loop
- Persistent agent/run tables
- `GET /ready`

Dependencies actually installed: `@modelcontextprotocol/sdk`, `express`, `zod`. Runtime: Node `>=22` (`node:sqlite`, `node:crypto`).

## 2. Backend

Single process. `node src/server.js` serves:

- Dashboard (cookie session, Secure, HttpOnly)
- MCP Streamable HTTP at `/mcp`
- OAuth well-known + `/register` + `/token` + `/authorize` + `/oauth/login`
- Cursor webhook `POST /webhooks/cursor-agent`
- Memory dashboard APIs under `/api/memory/*`
- Public `GET /health` and `GET /system-guide`

There is no separate worker or scheduler process. There is no in-process queue beyond Express request handling.

## 3. Database

SQLite file `DATA_DIR/app.db` (`node:sqlite` `DatabaseSync`), WAL, foreign keys on.

**Core tables (`lib.js`):** `settings`, `sessions`, `request_log`

**OAuth (`oauth.js`):** `oauth_clients`, `oauth_tokens`, `oauth_pending`

**Memory (`memory.js`):** `projects`, `tasks`, `errors`, `plan_prompts`, `ui_ux_notes`, `ux_notes`, `rules`, `rules_suggestions`, `pr_links`, `audit_log` (append-only triggers)

**Notify (`webhook.js`):** `telegram_notify_log`

No tables for: durable agents, runs, events, event dead-letters, task dependencies, agent roles, verification results, notification targets, correlation IDs.

`tasks.agent_id` is a free-text Cursor id (`bc-…`), not a foreign key. There is no `depends_on`. Task statuses in code: `pending | in_progress | done_proposed | done_verified | partial | failed`. `blocked` is **not** implemented.

## 4. MCP tools currently registered

Agent surface (`src/mcp.js`):

| Tool | Purpose |
| --- | --- |
| `create_agent` | Launch via Cursor API (v0+webhook when secret ≥32 chars, else v1) |
| `get_agent` | GET v1 agent + latest run enrich |
| `followup_agent` | POST v1 `/agents/{id}/runs` |
| `list_agents` | GET v1 `/agents` + enrich |
| `list_repos` | GET v1 `/repositories` |
| `list_models` | GET v1 `/models` |

Memory surface (`src/memory-mcp.js`):

| Tool | Purpose |
| --- | --- |
| `get_system_guide` | Instructional text, no project data |
| `project_list` / `project_create` | Projects |
| `project_get_full` / `project_get_capsule` | Verified vs Draft |
| `task_add` / `task_update_status` / `task_propose_done` | Tasks (no `done_verified` via MCP) |
| `error_log` / `error_resolve` | Errors |
| `plan_prompt_save` / `plan_prompt_get_latest` | Plan drafts |
| `ui_ux_save` / `ux_notes_save` | Draft notes |
| `rules_suggest` / `rules_list` | Suggest vs approved-only list |
| `pr_link_add` / `pr_link_list` | PR URLs + public GitHub GET check |

Not present: `agent_stop`, `project_update`, `project_get` (named), task get/complete aliases, verification tools, GitHub create_pr, telegram_send, event_list/retry, orchestrator tools.

## 5. Domain relationships (as implemented)

```
projects 1──N tasks          (optional tasks.agent_id string)
projects 1──N errors         (optional errors.task_id)
projects 1──N plan_prompts   (verified_by_user)
projects 1──N ui_ux_notes    (verified_by_user)
projects 1──N ux_notes       (verified_by_user)
projects 1──N rules          (dashboard-approved only)
projects 1──N rules_suggestions
projects 1──N pr_links       (optional task_id; GitHub existence check)
projects 1──N audit_log

Cursor agents/runs  —— live HTTP only ——  not stored as rows
```

Governance already enforced:

- `done_verified` and approved `rules` are dashboard-only
- Capsule uses verified facts only
- Max 3 consecutive MCP write steps per task; reset on human confirm/reject/request-fix
- `task_propose_done` requires evidence; PR URLs get a public GitHub inspect

## 6. Cursor Cloud Agents API (actually used)

Client: `src/cursor-api.js`, base `https://api.cursor.com`.

| Operation | Path used | Notes |
| --- | --- | --- |
| Create | `POST /v0/agents` when `CURSOR_WEBHOOK_SECRET` length ≥ 32 | v0 accepts `webhook.url` + `webhook.secret`. v1 create **rejects** `webhook`. Invalid v0 model → retry without model. |
| Create | `POST /v1/agents` when no webhook secret | `repos[]`, `model: { id }` |
| List / get | `GET /v1/agents`, `GET /v1/agents/{id}` | |
| Follow-up | `POST /v1/agents/{id}/runs` | |
| Get run | `GET /v1/agents/{id}/runs/{runId}` | used in `enrichAgent` |
| Models / repos / me | `/v1/models`, `/v1/repositories`, `/v1/me` | |

Documented v1 (docs 2026-09-17) **not wrapped yet**:

- `GET /v1/agents/{id}/runs` (list runs)
- `POST /v1/agents/{id}/runs/{runId}/cancel`
- `POST /v1/agents/{id}/archive` / `unarchive`
- `DELETE /v1/agents/{id}`
- SSE stream

**Webhooks:** official v1 docs: “Webhooks are coming soon. The legacy v0 API still supports them.” Current production attaches webhook only on v0 create. There is no v1 webhook field. HMAC header `X-Webhook-Signature: sha256=<hex>` over raw body.

Run statuses in docs/client: `CREATING`, `RUNNING`, `FINISHED`, `ERROR`, `CANCELLED`, `EXPIRED`.  
Agent statuses: `ACTIVE`, `IDLE`, `ARCHIVED`.  
Local simplified labels: `running | finished | failed`.

**There is no Cursor state named QUEUED or WAITING.** Those must be local machine states (pre-create / IDLE between runs).

## 7. Webhook / Telegram today

- Endpoint: `POST /webhooks/cursor-agent` (raw body)
- Auth: HMAC-SHA256, 401 if invalid
- Processing: **synchronous** inside the HTTP handler
- Notify only `statusChange` + `FINISHED|ERROR`
- **No idempotency key** (duplicate Cursor deliveries can duplicate Telegram + log rows)
- **No async queue, retry worker, or dead-letter table**
- Telegram: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in `.env` (mode 600). Not stored in SQLite plaintext. Send helper has timeout, **no retry/rate-limit**. No Telegram inbound webhook, no inline keyboards, no per-user allowlist beyond a single chat id.

## 8. Configuration / secrets

`.env.example`: `PORT`, `HOST`, `PUBLIC_BASE_URL`, `APP_SECRET`, `SESSION_SECRET`, `MCP_AUTH_TOKEN`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `CURSOR_AGENTS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CURSOR_WEBHOOK_SECRET`, `LOG_DIR`, `DATA_DIR`.

Cursor API key may also be AES-256-GCM in `settings.cursor_api_key_enc`.

No `POLL_INTERVAL_SECONDS`, `MAX_AGENT_RETRIES`, `DATABASE_URL`, `REDIS_URL`, `GITHUB_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`.

Logs JSON-line to stdout + `logs/bridge.log` with key-name redaction. Webhook secret **is** returned in full on authenticated `GET /api/telegram` (intentional dashboard copy UX). MCP tool results can include Cursor API error bodies — must stay free of env secrets.

## 9. Docker / deployment

Production is **not** Docker. VPS isolation rules (seeded approved memory rules):

- Do not touch nginx/docker/pm2/postgresql/redis or other apps
- Same systemd unit `mcp-cursor-bridge` only
- No extra listen ports; keep 18800
- User `mcpbridge`, `ProtectSystem=strict`, write paths: `data`, `logs`, `.env`

`deploy/mcp-cursor-bridge.service` and nginx snippets exist. No Dockerfile.

## 10. Tests

None in-repo (`package.json` has only `npm start`). No lint/typecheck scripts. Verification of the live bridge has been manual (dashboard + curl of `/health`, webhook 401, `/mcp` 401).

## 11. Gaps vs requested V2 (honest)

| Requested | Current |
| --- | --- |
| Persistent agent/run/project/task links | Live Cursor list only; optional `tasks.agent_id` |
| State machine with history | `simplifyStatus()` strings |
| Event bus + idempotency | None |
| Webhook gateway + async + DLQ | Sync HMAC handler, one path |
| Polling fallback | None |
| Production Telegram service | One send function |
| Interactive Telegram controls | None |
| Project orchestrator / roles / deps | None (`blocked` / `depends_on` missing) |
| Real verification (lint/tests/build) | GitHub PR existence GET only |
| Self-heal retries | Human “request fix” follow-up only |
| Observability correlation IDs | HTTP logs without agent/run/task chain |
| Tests + E2E + `/ready` + Docker docs | Missing |

## 12. Constraints for the rebuild

1. Do not invent a v1 webhook provider. Keep v0 attach + HMAC; add a **provider adapter** so a future v1 webhook can land without rewriting consumers.
2. Do not add Redis on the live VPS. SQLite event table is the bus.
3. Do not start Docker/Postgres on the live VPS. Optional compose is for portable installs; production stays systemd + in-process poller.
4. Do not listen on new VPS ports.
5. Do not print or log Telegram tokens, admin password, webhook secret, or VPS credentials.
6. Keep existing MCP tool names working; new names may be aliases plus genuinely new tools.
7. Keep memory governance: models cannot write `done_verified` or approved rules.

## 13. Recommended implementation shape (post-audit)

In-process modules under `src/` plus SQLite tables `agents`, `agent_runs`, `agent_state_transitions`, `events`, `event_dead_letters`, `task_dependencies`, `verifications`, `notification_targets`. Express remains the HTTP surface. A `setInterval` poller and an event drain loop run in the same Node process (and as `node src/worker.js` in compose). Tests use `node:test` against a temp `DATA_DIR` and a mock Cursor/Telegram HTTP server.
