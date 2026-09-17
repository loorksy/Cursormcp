# Telegram

Env:

- `TELEGRAM_BOT_TOKEN` (file mode 600 via systemd EnvironmentFile — not stored plaintext in SQLite)
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_ALLOWED_CHAT_IDS` comma list
- `TELEGRAM_WEBHOOK_SECRET` optional inbound verification

`TelegramService` (`src/telegram-service.js`): timeout, 3 retries, 20 messages/minute, structured logs with redaction. Extra chat ids can be stored in `notification_targets` (chat ids only, no bot token).

Notifications:

- agent started / completed / failed
- verification failed
- task blocked after `MAX_AGENT_RETRIES`
- PR recorded

Inline keyboard (authorized chats only): View Result, Continue, Retry, Stop, View PR, View Logs.

Set the Telegram webhook (once) to `https://mcp.lork.cloud/webhooks/telegram` with `secret_token` matching `TELEGRAM_WEBHOOK_SECRET`. This project does not call `setWebhook` automatically so a misconfigured token cannot rewrite an existing bot webhook.
