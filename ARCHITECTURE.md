# Architecture

Single Node 22 process (systemd in production) serving HTTP, MCP, webhooks, an SQLite event bus, and an in-process poller.

```
Claude / dashboard / Telegram
        │
   Express (src/server.js)
        │
 ┌──────┼───────────────┐
 MCP    REST v1/v2     Webhook gateway
        │               (cursor_v0 HMAC)
        ▼
  Event table (idempotent)
        ▼
  Processors → state machine → verification → healer → Telegram
        ▲
   Poller (POLL_INTERVAL_SECONDS)

Intelligence (read-only source):
  MCP intel tools → allowlist → local git and/or GitHub REST
                 → redaction → pagination → MCP JSON
```

## Why SQLite, not Redis/Postgres

The live VPS already runs other Postgres/Redis services that this project is forbidden to touch. The event bus is a SQLite table with a unique `idempotency_key`. Compose can share the same DB file via a volume; production stays one systemd unit.

## Cursor API mapping

| Local state | Cursor |
| --- | --- |
| CREATING | run `CREATING` |
| RUNNING | run `RUNNING` / agent `ACTIVE` |
| WAITING | agent `IDLE` |
| COMPLETED | run `FINISHED` **and** verification passed |
| FAILED | run `ERROR` or verification failed |
| CANCELLED | `POST /v1/agents/{id}/runs/{runId}/cancel` |
| EXPIRED | run `EXPIRED` |
| QUEUED | local, before Cursor returns |

v1 webhooks are **not available**. Create uses v0 when `CURSOR_WEBHOOK_SECRET` is ≥32 characters so Cursor can POST HMAC events. Polling covers v1-only creates and missed deliveries.

## Memory governance (unchanged)

Models cannot write `done_verified` or approved `rules`. Capsules use verified facts only.
