import { AGENT_STATES, TERMINAL_STATES } from "./config.js";
import { getDb } from "./lib.js";
import { log } from "./lib.js";

export class InvalidStateError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_STATE";
  }
}

export function mapCursorToState(agentStatus, runStatus) {
  const run = String(runStatus || "").toUpperCase();
  const agent = String(agentStatus || "").toUpperCase();
  if (run === "CREATING") return "CREATING";
  if (run === "RUNNING") return "RUNNING";
  if (run === "FINISHED") return "COMPLETED";
  if (run === "ERROR") return "FAILED";
  if (run === "CANCELLED") return "CANCELLED";
  if (run === "EXPIRED") return "EXPIRED";
  if (agent === "IDLE") return "WAITING";
  if (agent === "ACTIVE") return "RUNNING";
  if (agent === "ARCHIVED") return "CANCELLED";
  return "QUEUED";
}

export function transitionAgentState({
  agentId,
  runId = "",
  projectId = null,
  taskId = null,
  newState,
  source,
}) {
  if (!AGENT_STATES.includes(newState)) {
    throw new InvalidStateError(`unknown state ${newState}`);
  }
  const db = getDb();
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  const previous = row?.state || "QUEUED";
  if (previous === newState) {
    return { changed: false, previous_state: previous, new_state: newState };
  }
  const ts = new Date().toISOString();
  if (row) {
    db.prepare("UPDATE agents SET state = ?, latest_run_id = CASE WHEN ? != '' THEN ? ELSE latest_run_id END, updated_at = ? WHERE id = ?").run(
      newState,
      runId,
      runId,
      ts,
      agentId,
    );
  }
  db.prepare(
    `INSERT INTO agent_state_transitions
      (agent_id, run_id, project_id, task_id, previous_state, new_state, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    runId || row?.latest_run_id || "",
    projectId ?? row?.project_id ?? null,
    taskId ?? row?.task_id ?? null,
    previous,
    newState,
    source,
    ts,
  );
  log("info", "agent_state", {
    agentId,
    runId,
    previous_state: previous,
    new_state: newState,
    source,
  });
  return {
    changed: true,
    previous_state: previous,
    new_state: newState,
    timestamp: ts,
    source,
    agent_id: agentId,
    run_id: runId || row?.latest_run_id || "",
    project_id: projectId ?? row?.project_id ?? null,
    task_id: taskId ?? row?.task_id ?? null,
    terminal: TERMINAL_STATES.has(newState),
  };
}

export function listTransitions(agentId, limit = 50) {
  return getDb()
    .prepare(
      "SELECT * FROM agent_state_transitions WHERE agent_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(agentId, limit);
}
