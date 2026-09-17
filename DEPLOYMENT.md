# Deployment

## Production VPS (this repo)

Do **not** run Docker/Postgres/Redis on the existing VPS for this service.

- Unit: `mcp-cursor-bridge`
- User: `mcpbridge`
- Bind: `127.0.0.1:18800`
- Write paths: `/opt/mcp-cursor-bridge/data`, `logs`, `.env`
- Reverse proxy: existing nginx site `mcp.lork.cloud` only

Deploy: copy tree, `chown mcpbridge`, `systemctl restart mcp-cursor-bridge` only. Poller and event drain run in-process.

## Portable Docker (optional)

```bash
cp .env.example .env
docker compose up --build
```

`api` disables the in-process poller (`DISABLE_POLLER=true`); `worker` runs `node src/worker.js` against the same SQLite volume. Do not publish extra ports on the locked-down VPS.
