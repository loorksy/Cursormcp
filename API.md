# HTTP API

Auth: dashboard session cookie on `/api/*`. MCP uses OAuth or `Authorization: Bearer`.

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | JSON or HTML |
| GET | `/ready` | SQLite ping, 503 if DB fails |
| GET | `/system-guide` | Instructional text, no project data |
| POST | `/webhooks/cursor-agent` | HMAC raw body (legacy path) |
| POST | `/webhooks/cursor` | Same gateway, provider-adaptable |
| POST | `/webhooks/telegram` | Allowlisted chat + optional secret header |

## Dashboard (existing)

`/api/agents`, `/api/agents/:id`, POST create/followup, settings, telegram copy, memory confirm/reject.

## V2 (session)

| Method | Path |
| --- | --- |
| GET/POST | `/api/v2/agents` |
| GET | `/api/v2/agents/:id` |
| POST | `/api/v2/agents/:id/stop` |
| GET | `/api/v2/events` |
| GET | `/api/v2/events/:id` |
| POST | `/api/v2/events/:id/retry` |
| POST | `/api/v2/events/drain` |
| POST | `/api/v2/projects/:id/orchestrate` body `{ execute, model }` |
| POST | `/api/v2/poll` |
| POST | `/api/v2/telegram/test` |

Stop maps to Cursor `POST /v1/agents/{id}/runs/{runId}/cancel`. Cursor returns `409 run_not_cancellable` if the run is already terminal — that error is propagated, not faked.
