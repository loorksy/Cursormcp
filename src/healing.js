import { loadConfig } from "./config.js";
import { getDb, log } from "./lib.js";
import { ingestEvent } from "./events.js";
import { getAgentRecord, incrementRetry } from "./agents-store.js";
import { createRun } from "./cursor-api.js";
import { telegramService } from "./telegram-service.js";
import { addTask, updateTaskStatus } from "./memory.js";

export async function maybeHeal({ agentId, project, task, summary }) {
  const cfg = loadConfig();
  const agent = getAgentRecord(agentId);
  if (!agent) return { healed: false, reason: "unknown_agent" };
  if (agent.retry_count >= cfg.maxAgentRetries) {
    if (task?.id) {
      getDb()
        .prepare("UPDATE tasks SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?")
        .run(summary || "max retries exceeded", new Date().toISOString(), task.id);
      await telegramService.send_task_blocked({ id: task.id, title: task.title, blocked_reason: summary }, summary);
    }
    ingestEvent({
      type: "task.blocked",
      source: "healer",
      agent_id: agentId,
      project_id: project?.id,
      task_id: task?.id,
      payload: { reason: "max_retries", summary },
      idempotency_key: `heal:block:${agentId}:${agent.retry_count}`,
    });
    return { healed: false, blocked: true, retries: agent.retry_count };
  }
  const updated = incrementRetry(agentId);
  let fixTask = null;
  if (project?.id) {
    fixTask = addTask({
      project_id: project.id,
      title: `Fix: ${task?.title || agent.name || agentId}`,
      description: summary || "verification failed",
      proposed_by: "healer",
      agent_id: agentId,
    });
  }
  const prompt = [
    "Verification failed. Analyze the failure and fix it.",
    summary || "",
    "Re-run the relevant tests. Do not claim success without evidence.",
  ].join("\n");
  const run = await createRun(agentId, { prompt });
  ingestEvent({
    type: "agent.heal",
    source: "healer",
    agent_id: agentId,
    run_id: run?.id || "",
    project_id: project?.id,
    task_id: fixTask?.id || task?.id,
    payload: { retry_count: updated.retry_count, summary },
    idempotency_key: `heal:run:${agentId}:${updated.retry_count}`,
  });
  log("info", "heal_started", { agentId, retries: updated.retry_count });
  return { healed: true, retries: updated.retry_count, run, fixTask };
}

export { addTask };
