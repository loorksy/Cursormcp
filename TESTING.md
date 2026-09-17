# Testing

```bash
npm test
npm run lint
```

There is no TypeScript. `npm run typecheck` is syntax `node --check` on the server modules.

`node:test` with `--experimental-test-isolation=process`.

| File | Coverage |
| --- | --- |
| `test/state.test.js` | state machine mapping + transition history |
| `test/events-idempotency.test.js` | duplicate keys, retry, dead-letter |
| `test/tasks-deps.test.js` | blocked until `done_verified` |
| `test/e2e-lifecycle.test.js` | project → task → mock Cursor agent → HMAC webhook → events → Telegram authz |
| `test/failure-heal.test.js` | verifier failure; max retries → task `blocked` |

Live Cursor create is **not** invoked by CI. Set `E2E_CREATE_AGENT=1` only for a manual probe against a real key. Mock servers implement `/v0/agents`, `/v1/agents`, runs, and cancel.
