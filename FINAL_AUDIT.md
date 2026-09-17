# Final audit — Cursor MCP V2 orchestrator

Date: 2026-09-17  
Branch: `cursor/production-orchestrator-50d3`

## What was implemented

- Phase 0 audit (`AUDIT.md`) before restructure.
- Persistent agents/runs/state transitions in SQLite.
- State machine with history (`previous_state`, `new_state`, `timestamp`, `source`, ids).
- Event bus with unique `idempotency_key`, retries, dead-letter.
- Webhook gateway `POST /webhooks/cursor` + legacy `/webhooks/cursor-agent` (Cursor **v0 HMAC**; v1 webhooks still not provided by Cursor).
- In-process poller (`POLL_INTERVAL_SECONDS`) emitting the same idempotent status events.
- TelegramService (retry, timeout, rate limit) + allowlisted interactive webhook.
- Orchestrator, role selection, `depends_on` / `blocked`.
- Verification (Cursor FINISHED + optional GitHub checks + allowlisted local commands). Failure is `FAILED`, not `COMPLETED`.
- Self-heal with `MAX_AGENT_RETRIES` then task `blocked` + Telegram.
- GitHub inspect/create PR (create requires `GITHUB_TOKEN`; no fake PRs).
- MCP v2 tools (aliases + new) keeping original tool names.
- Correlation fields on logs (`correlationId`, agent/run/task/project/event).
- `/ready`, Dockerfile/compose for portable installs (VPS stays systemd).
- Docs listed in README.

## Files added (selected)

`src/config.js`, `context.js`, `schema-v2.js`, `state-machine.js`, `events.js`, `agents-store.js`, `webhook-gateway.js`, `polling.js`, `telegram-service.js`, `telegram-webhook.js`, `github.js`, `verification.js`, `healing.js`, `roles.js`, `orchestrator.js`, `processors.js`, `mcp-v2.js`, `http-v2.js`, `worker.js`, `test/*`, `Dockerfile`, `docker-compose.yml`, docs.

## Database changes

New tables: `agents`, `agent_runs`, `agent_state_transitions`, `events`, `event_dead_letters`, `task_dependencies`, `verifications`, `notification_targets`, `webhook_receipts`.  
New columns on `tasks`: `role`, `blocked_reason`. On `projects`: `goal`, `stack_json`, `verify_json`.  
Applied via `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` at startup (no separate migration runner).

## APIs added

`GET /ready`, `POST /webhooks/cursor`, `POST /webhooks/telegram`, `/api/v2/agents*`, `/api/v2/events*`, `/api/v2/projects/:id/orchestrate`, `/api/v2/poll`.

## MCP tools added

`project_get`, `project_update`, `project_orchestrate`, `agent_*`, `task_create/get/update/complete_proposal`, `plan_*`, `run_tests`, `get_verification_status`, `get_build_status`, `get_pr`, `create_pr`, `get_pr_status`, `telegram_send/test`, `notification_preferences`, `event_list/get/retry`. Original tools remain.

## Tests executed

```
npm test   → 13 passed, 0 failed (node:test, process isolation)
npm run lint / typecheck → node --check on server modules, pass
```

No TypeScript compiler. No live `POST /v1/agents` against Cursor in CI (mock HTTP).

## Live VPS verification (mcp-cursor-bridge unit only)

- `systemctl is-active mcp-cursor-bridge` → active
- nginx / docker / postgresql / redis-server left active (not restarted)
- `GET /health` 200, `orchestrator: true`
- `GET /ready` 200, `db: true`
- `https://mcp.lork.cloud/health` 200
- `POST /webhooks/cursor` without HMAC → 401
- `POST /mcp` without token → 401
- `GET /system-guide` 200, no project names leaked
- SQLite `app.db` gained V2 tables (`agents`, `events`, `verifications`, …); `tasks.role` / `projects.goal` present
- Poller started (`poller_started`, 30000ms)
- Unauthenticated `/api/v2/agents` initially 302 because `app.use("/api", requireAuth)` stripped `req.path`; fixed to 401 JSON (`isApiRequest` uses `originalUrl` / `baseUrl`)

## Known limitations / risks

1. Cursor API v1 has no webhooks; polling is required for v1-only creates.
2. Interactive Telegram requires a one-time `setWebhook` outside this repo so we do not overwrite an existing bot.
3. `create_pr` is a no-op without `GITHUB_TOKEN` (explicit error).
4. Compose worker + API sharing SQLite WAL across containers is for portable installs only; production is one process.
5. Browser tests are not an automatic verifier unless a project `verify_json` says so.
6. `QUEUED`/`WAITING` are local names; Cursor does not send those strings.
7. Live Telegram `setWebhook` was not called (would overwrite any existing bot webhook). Inbound `POST /webhooks/telegram` is mounted; interactive buttons need a one-time setWebhook.

## Remaining

Dashboard UI for `/api/v2/*` is API-first (existing RTL dashboard still manages launch/memory). A dedicated orchestrator panel was not added to `public/app.html` in this pass.

Live Telegram outbound was exercised after deploy (broadcast test); inbound Telegram webhook secret remains empty until `setWebhook` is configured.
