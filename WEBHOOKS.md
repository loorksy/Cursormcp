# Webhooks

## Cursor (v0)

Cursor Cloud Agents API **v1 does not accept a webhook field** (docs: “Webhooks are coming soon”). This bridge attaches `{ url, secret }` only on `POST /v0/agents`.

Inbound:

- `POST /webhooks/cursor-agent`
- `POST /webhooks/cursor` (alias, same adapter)

Verification: `X-Webhook-Signature: sha256=<hex>` HMAC-SHA256 of the **raw** body with `CURSOR_WEBHOOK_SECRET`. Invalid → 401.

Processing:

1. Store `webhook_receipts` by `X-Webhook-Id` or body hash.
2. Insert `events` with idempotency `cursor:{id}:{event}:{status}`.
3. Return 200 immediately.
4. Drain the event bus asynchronously (retry + dead-letter).

Duplicates do not create extra agent rows or extra Telegram sends (`telegram_notify_log` + event keys).

To swap providers later, add an adapter next to `cursorV0Adapter()` in `src/webhook-gateway.js` without changing processors.

## Telegram

`POST /webhooks/telegram`

If `TELEGRAM_WEBHOOK_SECRET` is set, require header `X-Telegram-Bot-Api-Secret-Token`. Chat id must be in `TELEGRAM_CHAT_ID` or `TELEGRAM_ALLOWED_CHAT_IDS`. Unknown chats are ignored (200, no agent control).
