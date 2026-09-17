import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bridge-auth-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.BRIDGE_TEST = "true";
process.env.DISABLE_POLLER = "true";
process.env.APP_SECRET = "unit-secret-unit-secret";
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";

const { app } = await import("../src/server.js");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;

after(() => {
  server.close();
});

test("unauthenticated /api/v2 returns 401 JSON, not a login redirect", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/v2/agents`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("location"), null);
  const body = await res.json();
  assert.equal(body.error, "unauthorized");
});

test("GET /ready is public", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
});
