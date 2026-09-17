import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.BRIDGE_TEST = "true";
process.env.DISABLE_POLLER = "true";
process.env.APP_SECRET = "unit-secret-unit-secret";

const { ensureMemoryTables } = await import("../src/memory.js");
ensureMemoryTables();
const { upsertAgentRecord } = await import("../src/agents-store.js");
const { transitionAgentState, mapCursorToState, listTransitions } = await import("../src/state-machine.js");

test("maps Cursor run statuses onto the local machine", () => {
  assert.equal(mapCursorToState("ACTIVE", "RUNNING"), "RUNNING");
  assert.equal(mapCursorToState("IDLE", "FINISHED"), "COMPLETED");
  assert.equal(mapCursorToState("IDLE", "ERROR"), "FAILED");
  assert.equal(mapCursorToState("IDLE", "CANCELLED"), "CANCELLED");
  assert.equal(mapCursorToState("IDLE", "EXPIRED"), "EXPIRED");
  assert.equal(mapCursorToState("IDLE", ""), "WAITING");
});

test("records previous_state, new_state, source, timestamp", () => {
  upsertAgentRecord({ id: "bc-1", name: "n", state: "QUEUED" });
  const first = transitionAgentState({ agentId: "bc-1", newState: "RUNNING", source: "test", runId: "run-1" });
  assert.equal(first.changed, true);
  assert.equal(first.previous_state, "QUEUED");
  assert.equal(first.new_state, "RUNNING");
  assert.ok(first.timestamp);
  const again = transitionAgentState({ agentId: "bc-1", newState: "RUNNING", source: "test" });
  assert.equal(again.changed, false);
  const rows = listTransitions("bc-1");
  assert.equal(rows[0].source, "test");
  assert.equal(rows[0].run_id, "run-1");
});
