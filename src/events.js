import { createHash } from "node:crypto";
import { loadConfig, newId } from "./config.js";
import { withContext } from "./context.js";
import { getDb, log, safeJson } from "./lib.js";

const processors = [];

export function registerEventProcessor(fn) {
  processors.push(fn);
}

export function hashPayload(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function ingestEvent({
  type,
  source,
  agent_id = "",
  run_id = "",
  project_id = null,
  task_id = null,
  payload = {},
  idempotency_key,
  id,
}) {
  const key = idempotency_key || `${source}:${type}:${agent_id}:${run_id}:${hashPayload(payload).slice(0, 16)}`;
  const eventId = id || newId("evt");
  const ts = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO events
        (id, type, source, agent_id, run_id, project_id, task_id, timestamp, payload, idempotency_key, attempts, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')`,
    )
    .run(
      eventId,
      type,
      source,
      agent_id || "",
      run_id || "",
      project_id,
      task_id,
      ts,
      JSON.stringify(payload || {}),
      key,
    );
  const inserted = result.changes > 0;
  const row = getDb().prepare("SELECT * FROM events WHERE idempotency_key = ?").get(key);
  log("info", "event_ingest", {
    eventId: row?.id,
    type,
    source,
    inserted,
    idempotency_key: key,
  });
  return { inserted, event: row, duplicate: !inserted };
}

export function getEvent(id) {
  return getDb().prepare("SELECT * FROM events WHERE id = ?").get(id);
}

export function listEvents({ limit = 50, type, agent_id } = {}) {
  if (type && agent_id) {
    return getDb()
      .prepare("SELECT * FROM events WHERE type = ? AND agent_id = ? ORDER BY timestamp DESC LIMIT ?")
      .all(type, agent_id, limit);
  }
  if (type) {
    return getDb().prepare("SELECT * FROM events WHERE type = ? ORDER BY timestamp DESC LIMIT ?").all(type, limit);
  }
  if (agent_id) {
    return getDb()
      .prepare("SELECT * FROM events WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?")
      .all(agent_id, limit);
  }
  return getDb().prepare("SELECT * FROM events ORDER BY timestamp DESC LIMIT ?").all(limit);
}

async function processOne(row) {
  const payload = safeJson(row.payload, {});
  await withContext(
    {
      eventId: row.id,
      agentId: row.agent_id,
      runId: row.run_id,
      taskId: row.task_id,
      projectId: row.project_id,
      correlationId: payload.correlationId || row.id,
    },
    async () => {
      for (const fn of processors) {
        await fn({ ...row, payload });
      }
    },
  );
}

export async function processEventById(id) {
  const row = getEvent(id);
  if (!row) throw new Error("event not found");
  await processOne(row);
  getDb()
    .prepare("UPDATE events SET processed_at = ?, last_error = '' WHERE id = ?")
    .run(new Date().toISOString(), row.id);
  return getEvent(id);
}

export async function drainEvents(limit = 20) {
  const cfg = loadConfig();
  const rows = getDb()
    .prepare(
      "SELECT * FROM events WHERE processed_at IS NULL AND attempts < ? ORDER BY timestamp ASC LIMIT ?",
    )
    .all(cfg.maxEventAttempts, limit);
  const results = [];
  for (const row of rows) {
    getDb().prepare("UPDATE events SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    try {
      await processOne(row);
      getDb()
        .prepare("UPDATE events SET processed_at = ?, last_error = '' WHERE id = ?")
        .run(new Date().toISOString(), row.id);
      results.push({ id: row.id, ok: true });
    } catch (err) {
      const message = err.message || "process_failed";
      getDb().prepare("UPDATE events SET last_error = ? WHERE id = ?").run(message, row.id);
      const fresh = getEvent(row.id);
      if (fresh.attempts >= cfg.maxEventAttempts) {
        getDb()
          .prepare(
            "INSERT INTO event_dead_letters (event_id, error, payload, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(row.id, message, row.payload, new Date().toISOString());
        getDb()
          .prepare("UPDATE events SET processed_at = ? WHERE id = ?")
          .run(new Date().toISOString(), row.id);
        log("error", "event_dead_letter", { eventId: row.id, error: message });
      } else {
        log("error", "event_retry", { eventId: row.id, error: message, attempts: fresh.attempts });
      }
      results.push({ id: row.id, ok: false, error: message });
    }
  }
  return results;
}

export async function retryEvent(id) {
  getDb().prepare("UPDATE events SET processed_at = NULL, attempts = 0, last_error = '' WHERE id = ?").run(id);
  return processEventById(id);
}

let drainTimer = null;

export function startEventLoop() {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    drainEvents().catch((err) => log("error", "event_drain", { error: err.message }));
  }, 1500);
  if (typeof drainTimer.unref === "function") drainTimer.unref();
}

export function stopEventLoop() {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}
