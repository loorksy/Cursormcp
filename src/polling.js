import { loadConfig } from "./config.js";
import { log } from "./lib.js";
import { ingestEvent, drainEvents } from "./events.js";
import { listActiveAgentRecords, applyCursorSnapshot } from "./agents-store.js";
import { getAgent, getRun, listAgents } from "./cursor-api.js";

let timer = null;
let running = false;

async function snapshotAgent(id, meta = {}) {
  const agent = await getAgent(id);
  let run = null;
  const runId = agent.latestRunId;
  if (runId) {
    try {
      run = await getRun(id, runId);
    } catch (err) {
      run = { id: runId, status: "UNKNOWN", error: err.message };
    }
  }
  const before = meta.beforeState;
  const applied = applyCursorSnapshot(agent, run, {
    source: "poller",
    project_id: meta.project_id,
    task_id: meta.task_id,
  });
  if (applied?.change?.changed) {
    ingestEvent({
      type: "agent.status_changed",
      source: "poller",
      agent_id: agent.id,
      run_id: run?.id || "",
      project_id: meta.project_id,
      task_id: meta.task_id,
      payload: {
        previous_state: applied.change.previous_state,
        new_state: applied.change.new_state,
        cursor_agent_status: agent.status,
        run_status: run?.status || null,
      },
      idempotency_key: `agent-state:${agent.id}:${run?.id || "none"}:${applied.change.new_state}`,
    });
  }
  return { agent, run, applied, before };
}

export async function pollOnce() {
  if (running) return { skipped: true };
  running = true;
  const stats = { local: 0, remote: 0, events: 0 };
  try {
    const local = listActiveAgentRecords();
    for (const row of local) {
      try {
        await snapshotAgent(row.id, {
          project_id: row.project_id,
          task_id: row.task_id,
          beforeState: row.state,
        });
        stats.local += 1;
      } catch (err) {
        log("error", "poll_agent", { agentId: row.id, error: err.message });
      }
    }
    try {
      const listed = await listAgents({ limit: 20, includeArchived: false });
      for (const agent of listed.items || []) {
        if (local.some((r) => r.id === agent.id)) continue;
        await snapshotAgent(agent.id, {});
        stats.remote += 1;
      }
    } catch (err) {
      log("error", "poll_list", { error: err.message });
    }
    const drained = await drainEvents();
    stats.events = drained.length;
  } finally {
    running = false;
  }
  log("info", "poll_cycle", stats);
  return stats;
}

export function startPolling() {
  if (timer) return;
  const ms = Math.max(5, loadConfig().pollIntervalSec) * 1000;
  timer = setInterval(() => {
    pollOnce().catch((err) => log("error", "poll_loop", { error: err.message }));
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  log("info", "poller_started", { intervalMs: ms });
}

export function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
