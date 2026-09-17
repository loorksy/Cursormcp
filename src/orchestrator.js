import { createAgent, createRun, cancelRun, getAgent, getRun } from "./cursor-api.js";
import { ingestEvent } from "./events.js";
import { applyCursorSnapshot, getAgentRecord, upsertAgentRecord, incrementRetry } from "./agents-store.js";
import { transitionAgentState } from "./state-machine.js";
import { withContext } from "./context.js";
import { newId } from "./config.js";
import { log } from "./lib.js";
import { addTask, getTask, listProjects, updateProject, updateTaskStatus, refreshTaskBlockers } from "./memory.js";
import { analyzeRepository } from "./github.js";
import { selectRoles, rolePrompt } from "./roles.js";
import { getDb } from "./lib.js";

export async function launchTrackedAgent({
  prompt,
  repository,
  ref,
  model,
  name,
  autoCreatePR,
  project_id,
  task_id,
  role,
}) {
  const correlationId = newId("corr");
  return withContext({ correlationId, projectId: project_id, taskId: task_id }, async () => {
    const created = await createAgent({ prompt, repository, ref, model, name, autoCreatePR });
    const agent = created.agent || created;
    const id = agent.id || agent.agent?.id;
    if (!id) throw new Error("cursor create returned no agent id");
    upsertAgentRecord({
      id,
      project_id,
      task_id,
      role: role || "",
      name: agent.name || name || "",
      repository: repository || "",
      ref: ref || "",
      model: model || "",
      url: agent.url || "",
      latest_run_id: created.run?.id || agent.latestRunId || "",
      correlation_id: correlationId,
      state: "QUEUED",
    });
    transitionAgentState({ agentId: id, newState: "CREATING", source: "launch", projectId: project_id, taskId: task_id });
    try {
      const live = await getAgent(id);
      const run = live.latestRunId ? await getRun(id, live.latestRunId).catch(() => created.run || null) : created.run || null;
      applyCursorSnapshot(live, run, { source: "launch", project_id, task_id });
    } catch (err) {
      log("error", "launch_snapshot", { error: err.message, agentId: id });
    }
    ingestEvent({
      type: "agent.created",
      source: "launch",
      agent_id: id,
      run_id: created.run?.id || "",
      project_id,
      task_id,
      payload: { webhookAttached: created.webhookAttached, modelFallback: created.modelFallback, correlationId },
      idempotency_key: `create:${id}`,
    });
    if (task_id) {
      getDb().prepare("UPDATE tasks SET agent_id = ?, updated_at = ? WHERE id = ?").run(id, new Date().toISOString(), task_id);
    }
    return { ...created, agent: getAgentRecord(id), correlationId };
  });
}

export async function stopTrackedAgent(agentId) {
  const rec = getAgentRecord(agentId);
  const live = await getAgent(agentId);
  const runId = rec?.latest_run_id || live.latestRunId;
  if (!runId) throw new Error("no active run to cancel");
  const cancelled = await cancelRun(agentId, runId);
  transitionAgentState({ agentId, runId, newState: "CANCELLED", source: "stop" });
  ingestEvent({
    type: "agent.cancelled",
    source: "stop",
    agent_id: agentId,
    run_id: runId,
    payload: cancelled,
    idempotency_key: `cancel:${agentId}:${runId}`,
  });
  return cancelled;
}

export async function orchestrateProject(projectId, { execute = false, model } = {}) {
  const project = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(Number(projectId));
  if (!project) throw new Error("project not found");
  const analysis = await analyzeRepository(project.repo_url);
  const roles = selectRoles({ languages: analysis.languages || {}, goal: project.goal || project.description || "" });
  updateProject(project.id, {
    stack_json: JSON.stringify({ languages: analysis.languages || {}, roles }),
  });
  const existing = getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?").get(project.id).n;
  const createdTasks = [];
  if (existing === 0) {
    const plan = [
      { role: "Planner", title: "Project plan", description: "Analyze repository and write an implementation plan." },
      { role: roles.includes("Backend") ? "Backend" : roles[0] || "Backend", title: "Core implementation", description: "Implement the goal on the repository." },
      { role: "QA", title: "Verification", description: "Run tests and record evidence." },
    ];
    let prev = null;
    for (const item of plan) {
      if (!roles.includes(item.role) && item.role !== "Planner" && item.role !== "QA") continue;
      const task = addTask({
        project_id: project.id,
        title: item.title,
        description: item.description,
        role: item.role,
        proposed_by: "orchestrator",
        depends_on: prev ? [prev] : [],
      });
      createdTasks.push(task);
      prev = task.id;
    }
  }
  refreshTaskBlockers(project.id);
  const launched = [];
  if (execute) {
    const ready = getDb()
      .prepare(
        "SELECT * FROM tasks WHERE project_id = ? AND status IN ('pending','in_progress') ORDER BY id",
      )
      .all(project.id);
    for (const task of ready) {
      const depsOk = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM task_dependencies d
           JOIN tasks t ON t.id = d.depends_on_task_id
           WHERE d.task_id = ? AND t.status != 'done_verified'`,
        )
        .get(task.id).n === 0;
      if (!depsOk) continue;
      if (task.agent_id) continue;
      updateTaskStatus({ task_id: task.id, new_status: "in_progress" });
      const launchedAgent = await launchTrackedAgent({
        prompt: rolePrompt(task.role || "Backend", {
          goal: project.goal || project.description,
          taskTitle: `${task.title}\n${task.description}`,
          repository: project.repo_url,
        }),
        repository: project.repo_url,
        name: `${task.role || "Agent"}: ${task.title}`.slice(0, 100),
        model,
        autoCreatePR: true,
        project_id: project.id,
        task_id: task.id,
        role: task.role,
      });
      launched.push(launchedAgent);
    }
  }
  log("info", "orchestrate", { projectId: project.id, tasks: createdTasks.length, launched: launched.length, execute });
  return {
    project,
    analysis,
    roles,
    tasks: createdTasks,
    launched,
  };
}

export { incrementRetry, listProjects, getTask };
