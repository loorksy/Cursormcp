import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bridge-evt-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.BRIDGE_TEST = "true";
process.env.DISABLE_POLLER = "true";
process.env.APP_SECRET = "unit-secret-unit-secret";
process.env.MAX_EVENT_ATTEMPTS = "2";

const { ensureMemoryTables } = await import("../src/memory.js");
ensureMemoryTables();
const { ingestEvent, drainEvents, listEvents, registerEventProcessor } = await import("../src/events.js");

test("duplicate idempotency keys do not insert twice", () => {
  const a = ingestEvent({ type: "t", source: "s", payload: { n: 1 }, idempotency_key: "k1" });
  const b = ingestEvent({ type: "t", source: "s", payload: { n: 1 }, idempotency_key: "k1" });
  assert.equal(a.inserted, true);
  assert.equal(b.duplicate, true);
  assert.equal(listEvents({ type: "t" }).length, 1);
});

test("failed processors retry then dead-letter", async () => {
  let hits = 0;
  registerEventProcessor(async (event) => {
    if (event.type === "boom") {
      hits += 1;
      throw new Error("nope");
    }
  });
  ingestEvent({ type: "boom", source: "s", idempotency_key: "boom-1" });
  await drainEvents();
  await drainEvents();
  const { getDb } = await import("../src/lib.js");
  const dlq = getDb().prepare("SELECT * FROM event_dead_letters").all();
  assert.ok(hits >= 2);
  assert.equal(dlq.length, 1);
});
