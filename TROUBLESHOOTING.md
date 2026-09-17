# Troubleshooting

| Symptom | Check |
| --- | --- |
| `/ready` 503 | SQLite file permissions under `DATA_DIR`; systemd `ReadWritePaths` |
| Webhook 401 | Raw body HMAC; nginx must not decode/re-encode JSON; `CURSOR_WEBHOOK_SECRET` ≥ 32 |
| No Telegram | Empty token/chat; `telegram_notify_enabled`; look at `telegram_notify_log` |
| Duplicate Telegram | Should not happen; inspect `events.idempotency_key` and notify log |
| Agent stays RUNNING | v1 create has no webhook — wait for poller (`POLL_INTERVAL_SECONDS`) or POST `/api/v2/poll` |
| `409 run_not_cancellable` | Run already terminal; expected Cursor API behavior |
| Grok/other model 400 on launch | v0 rejects some v1 model ids; create retries without model and keeps webhook |
| Orchestrator created no agents | `execute: true` required; tasks may be `blocked` on dependencies |
| Docker on VPS | Do not. Use systemd. |
