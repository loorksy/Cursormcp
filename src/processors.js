import { ingestEvent, registerEventProcessor } from "./events.js";
import { applyCursorSnapshot, getAgentRecord, upsertAgentRecord } from "./agents-store.js";
import { getAgent, getRun } from "./cursor-api.js";
import { telegramService } from "./telegram-service.js";
import { getDb, log } from "./lib.js";
import { verifyAgentCompletion } from "./verification.js";
import { maybeHeal } from "./healing.js";
import { transitionAgentState } from "./state-machine.js";
import { listProjects } from "./memory.js";

function projectById(id) {
  if (!id) return null;
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id);
}

function taskById(id) {
  if (!id) return null;
  return getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

function recordNotify(agentId, status, sent, detail) {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS telegram_notify_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT ''
    );
  `);
  getDb()
    .prepare(
      "INSERT INTO telegram_notify_log (ts, agent_id, status, sent, detail) VALUES (?, ?, ?, ?, ?)",
    )
    .run(new Date().toISOString(), agentId || "", status || "", sent ? 1 : 0, detail || "");
}

async function loadCursor(agentId, runId) {
  const agent = await getAgent(agentId);
  let run = null;
  const id = runId || agent.latestRunId;
  if (id) {
    try {
      run = await getRun(agentId, id);
    } catch {
      run = { id, status: "UNKNOWN" };
    }
  }
  return { agent, run };
}

async function handleCursorWebhookEvent(event) {
  const status = event.payload.status || "";
  const agentId = event.agent_id;
  if (!agentId) return;
  upsertAgentRecord({ id: agentId, name: event.payload.name || "" });
  let agent = null;
  let run = null;
  try {
    ({ agent, run } = await loadCursor(agentId, event.run_id));
  } catch (err) {
    log("error", "webhook_cursor_fetch", { error: err.message, agentId });
  }
  const rec = getAgentRecord(agentId);
  if (agent) {
    applyCursorSnapshot(agent, run, {
      source: "webhook",
      project_id: rec?.project_id,
      task_id: rec?.task_id,
    });
  } else if (status) {
    const mapped =
      status === "FINISHED"
        ? "COMPLETED"
        : status === "ERROR"
          ? "FAILED"
          : status === "CANCELLED"
            ? "CANCELLED"
            : null;
    if (mapped) {
      transitionAgentState({
        agentId,
        runId: event.run_id,
        newState: mapped,
        source: "webhook",
      });
    }
  }
    ingestEvent({
      type: "agent.status_changed",
      source: "webhook",
      agent_id: agentId,
      run_id: event.run_id,
      project_id: rec?.project_id,
      task_id: rec?.task_id,
      payload: { status, event: event.payload.event },
      idempotency_key: `agent-state:${agentId}:${event.run_id || "none"}:${getAgentRecord(agentId)?.state || status}`,
    });
}

function alreadyNotified(agentId, status) {
  const row = getDb()
    .prepare("SELECT id FROM telegram_notify_log WHERE agent_id = ? AND status = ? AND sent = 1 LIMIT 1")
    .get(agentId, status);
  return Boolean(row);
}

async function handleStatusChanged(event) {
  const rec = getAgentRecord(event.agent_id);
  const newState = rec?.state || event.payload.new_state;
  const notify = async (status, fn) => {
    if (alreadyNotified(event.agent_id, status)) return;
    if (!telegramService.configured() || telegramService.targets().length === 0) {
      recordNotify(event.agent_id, status, 0, "telegram_not_configured");
      return;
    }
    try {
      await fn();
      recordNotify(event.agent_id, status, 1, "sent");
    } catch (err) {
      recordNotify(event.agent_id, status, 0, err.message || "telegram_send_failed");
    }
  };
  if (newState === "RUNNING" || newState === "CREATING") {
    await notify("STARTED", () => telegramService.send_agent_started(rec || { id: event.agent_id }));
  }
  if (newState === "FAILED" || newState === "EXPIRED") {
    await notify(newState, () => telegramService.send_agent_failed(rec || { id: event.agent_id }, newState));
  }
  if (newState !== "COMPLETED") return;

  const project = projectById(rec?.project_id);
  const task = taskById(rec?.task_id);
  let run = { id: rec?.latest_run_id, status: "FINISHED", pr_url: rec?.pr_url };
  try {
    const live = await loadCursor(event.agent_id, rec?.latest_run_id);
    run = live.run || run;
    if (live.agent) applyCursorSnapshot(live.agent, live.run, { source: "verify", project_id: rec?.project_id, task_id: rec?.task_id });
  } catch {
    // verification still runs on stored snapshot
  }
  const result = await verifyAgentCompletion({
    agent: getAgentRecord(event.agent_id),
    run,
    project,
    task,
  });
  if (!result.passed) {
    transitionAgentState({
      agentId: event.agent_id,
      runId: run?.id,
      newState: "FAILED",
      source: "verification",
    });
    await notify("FAILED", () =>
      telegramService.send_test_failure(result.verifications.map((v) => v.summary).join("\n")),
    );
    await maybeHeal({
      agentId: event.agent_id,
      project,
      task,
      summary: result.verifications.map((v) => v.summary).join("\n"),
    });
    return;
  }
  await notify("FINISHED", () =>
    telegramService.send_agent_completed(getAgentRecord(event.agent_id) || { id: event.agent_id }),
  );
  if (rec?.pr_url) {
    ingestEvent({
      type: "pr.created",
      source: "verification",
      agent_id: event.agent_id,
      project_id: rec.project_id,
      task_id: rec.task_id,
      payload: { pr_url: rec.pr_url },
      idempotency_key: `pr:${rec.pr_url}`,
    });
  }
}

async function handlePrCreated(event) {
  await telegramService.send_pr_created({ pr_url: event.payload.pr_url });
}

let registered = false;

export function registerDefaultProcessors() {
  if (registered) return;
  registered = true;
  registerEventProcessor(async (event) => {
    if (event.type === "cursor.webhook") await handleCursorWebhookEvent(event);
    if (event.type === "agent.status_changed") await handleStatusChanged(event);
    if (event.type === "pr.created") await handlePrCreated(event);
    if (event.type === "task.blocked") {
      const task = taskById(event.task_id);
      if (task) await telegramService.send_task_blocked(task, event.payload.reason);
    }
  });
}

export { listProjects };
