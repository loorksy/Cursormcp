import { getDb, log } from "./lib.js";
import { mapCursorToState, transitionAgentState } from "./state-machine.js";

export function upsertAgentRecord(input) {
  const ts = new Date().toISOString();
  const existing = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(input.id);
  const row = {
    id: input.id,
    project_id: input.project_id ?? existing?.project_id ?? null,
    task_id: input.task_id ?? existing?.task_id ?? null,
    role: input.role ?? existing?.role ?? "",
    name: input.name ?? existing?.name ?? "",
    repository: input.repository ?? existing?.repository ?? "",
    ref: input.ref ?? existing?.ref ?? "",
    model: input.model ?? existing?.model ?? "",
    branch: input.branch ?? existing?.branch ?? "",
    pr_url: input.pr_url ?? existing?.pr_url ?? "",
    state: existing?.state || input.state || "QUEUED",
    cursor_agent_status: input.cursor_agent_status ?? existing?.cursor_agent_status ?? "",
    latest_run_id: input.latest_run_id ?? existing?.latest_run_id ?? "",
    retry_count: input.retry_count ?? existing?.retry_count ?? 0,
    correlation_id: input.correlation_id ?? existing?.correlation_id ?? "",
    url: input.url ?? existing?.url ?? "",
    created_at: existing?.created_at || ts,
    updated_at: ts,
  };
  getDb()
    .prepare(
      `INSERT INTO agents (id, project_id, task_id, role, name, repository, ref, model, branch, pr_url, state, cursor_agent_status, latest_run_id, retry_count, correlation_id, url, created_at, updated_at)
       VALUES (@id, @project_id, @task_id, @role, @name, @repository, @ref, @model, @branch, @pr_url, @state, @cursor_agent_status, @latest_run_id, @retry_count, @correlation_id, @url, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         project_id = COALESCE(excluded.project_id, agents.project_id),
         task_id = COALESCE(excluded.task_id, agents.task_id),
         role = CASE WHEN excluded.role != '' THEN excluded.role ELSE agents.role END,
         name = CASE WHEN excluded.name != '' THEN excluded.name ELSE agents.name END,
         repository = CASE WHEN excluded.repository != '' THEN excluded.repository ELSE agents.repository END,
         ref = CASE WHEN excluded.ref != '' THEN excluded.ref ELSE agents.ref END,
         model = CASE WHEN excluded.model != '' THEN excluded.model ELSE agents.model END,
         branch = CASE WHEN excluded.branch != '' THEN excluded.branch ELSE agents.branch END,
         pr_url = CASE WHEN excluded.pr_url != '' THEN excluded.pr_url ELSE agents.pr_url END,
         cursor_agent_status = excluded.cursor_agent_status,
         latest_run_id = CASE WHEN excluded.latest_run_id != '' THEN excluded.latest_run_id ELSE agents.latest_run_id END,
         retry_count = excluded.retry_count,
         correlation_id = CASE WHEN excluded.correlation_id != '' THEN excluded.correlation_id ELSE agents.correlation_id END,
         url = CASE WHEN excluded.url != '' THEN excluded.url ELSE agents.url END,
         updated_at = excluded.updated_at`,
    )
    .run(row);
  return getAgentRecord(row.id);
}

export function getAgentRecord(id) {
  return getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) || null;
}

export function listAgentRecords({ project_id, state, limit = 50 } = {}) {
  if (project_id && state) {
    return getDb()
      .prepare("SELECT * FROM agents WHERE project_id = ? AND state = ? ORDER BY updated_at DESC LIMIT ?")
      .all(project_id, state, limit);
  }
  if (project_id) {
    return getDb().prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?").all(project_id, limit);
  }
  if (state) {
    return getDb().prepare("SELECT * FROM agents WHERE state = ? ORDER BY updated_at DESC LIMIT ?").all(state, limit);
  }
  return getDb().prepare("SELECT * FROM agents ORDER BY updated_at DESC LIMIT ?").all(limit);
}

export function listActiveAgentRecords() {
  return getDb()
    .prepare("SELECT * FROM agents WHERE state IN ('CREATING','QUEUED','RUNNING','WAITING') ORDER BY updated_at ASC")
    .all();
}

export function upsertRunRecord(input) {
  const ts = new Date().toISOString();
  const existing = getDb().prepare("SELECT * FROM agent_runs WHERE id = ?").get(input.id);
  getDb()
    .prepare(
      `INSERT INTO agent_runs (id, agent_id, status, prompt, result, branch, pr_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         result = CASE WHEN excluded.result != '' THEN excluded.result ELSE agent_runs.result END,
         branch = CASE WHEN excluded.branch != '' THEN excluded.branch ELSE agent_runs.branch END,
         pr_url = CASE WHEN excluded.pr_url != '' THEN excluded.pr_url ELSE agent_runs.pr_url END,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.agent_id,
      input.status || "UNKNOWN",
      input.prompt || existing?.prompt || "",
      input.result || existing?.result || "",
      input.branch || existing?.branch || "",
      input.pr_url || existing?.pr_url || "",
      existing?.created_at || ts,
      ts,
    );
  return getDb().prepare("SELECT * FROM agent_runs WHERE id = ?").get(input.id);
}

export function listRunRecords(agentId) {
  return getDb().prepare("SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY updated_at DESC").all(agentId);
}

export function applyCursorSnapshot(agent, run, { source, project_id, task_id } = {}) {
  if (!agent?.id) return null;
  const git = run?.git?.branches?.[0] || {};
  upsertAgentRecord({
    id: agent.id,
    name: agent.name,
    url: agent.url,
    repository: agent.repos?.[0]?.url || git.repoUrl || "",
    cursor_agent_status: agent.status,
    latest_run_id: run?.id || agent.latestRunId || "",
    branch: git.branch || "",
    pr_url: git.prUrl || "",
    project_id,
    task_id,
  });
  if (run?.id) {
    upsertRunRecord({
      id: run.id,
      agent_id: agent.id,
      status: run.status,
      result: typeof run.result === "string" ? run.result : JSON.stringify(run.result || ""),
      branch: git.branch || "",
      pr_url: git.prUrl || "",
    });
  }
  const next = mapCursorToState(agent.status, run?.status);
  const change = transitionAgentState({
    agentId: agent.id,
    runId: run?.id || agent.latestRunId || "",
    projectId: project_id,
    taskId: task_id,
    newState: next,
    source: source || "cursor_snapshot",
  });
  log("info", "agent_snapshot", { agentId: agent.id, state: next, source: source || "cursor_snapshot" });
  return { record: getAgentRecord(agent.id), change };
}

export function incrementRetry(agentId) {
  getDb().prepare("UPDATE agents SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    agentId,
  );
  return getAgentRecord(agentId);
}
