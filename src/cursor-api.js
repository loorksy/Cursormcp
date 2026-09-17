import { getSetting, decryptSecret, log } from "./lib.js";

const API_BASE = "https://api.cursor.com";

export class CursorApiError extends Error {
  constructor(status, body, path) {
    super(`Cursor API ${status} on ${path}`);
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export function getApiKey() {
  const fromEnv = (process.env.CURSOR_AGENTS_API_KEY || "").trim();
  const enc = getSetting("cursor_api_key_enc");
  const fromDb = enc ? decryptSecret(enc, process.env.APP_SECRET) : "";
  return fromDb || fromEnv;
}

export function apiKeyConfigured() {
  return Boolean(getApiKey());
}

function authHeaders() {
  const key = getApiKey();
  if (!key) {
    const err = new Error("CURSOR_AGENTS_API_KEY is not configured");
    err.code = "NO_API_KEY";
    throw err;
  }
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function cursorFetch(method, path, { query, body, timeoutMs = 60000 } = {}) {
  const url = new URL(path, API_BASE);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: authHeaders(),
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 500) };
      }
    }
    log("info", "cursor_api", {
      method,
      path,
      status: res.status,
      ms: Date.now() - started,
    });
    if (!res.ok) throw new CursorApiError(res.status, json, path);
    return json;
  } catch (err) {
    if (err instanceof CursorApiError) throw err;
    log("error", "cursor_api_error", { method, path, error: err.message });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createAgent({ prompt, repository, ref, model, autoCreatePR, name }) {
  const payload = {
    prompt: { text: prompt },
  };
  if (name) payload.name = name;
  if (repository) {
    payload.repos = [
      {
        url: repository,
        ...(ref ? { startingRef: ref } : {}),
      },
    ];
  }
  if (model) payload.model = { id: model };
  if (autoCreatePR === true || autoCreatePR === "true") payload.autoCreatePR = true;
  return cursorFetch("POST", "/v1/agents", { body: payload });
}

export function listAgents({ limit = 50, cursor, includeArchived = true } = {}) {
  return cursorFetch("GET", "/v1/agents", {
    query: { limit, cursor, includeArchived },
  });
}

export function getAgent(id) {
  return cursorFetch("GET", `/v1/agents/${encodeURIComponent(id)}`);
}

export function createRun(id, { prompt, mode }) {
  const payload = { prompt: { text: prompt } };
  if (mode) payload.mode = mode;
  return cursorFetch("POST", `/v1/agents/${encodeURIComponent(id)}/runs`, { body: payload });
}

export function getRun(agentId, runId) {
  return cursorFetch(
    "GET",
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
  );
}

export function listModels() {
  return cursorFetch("GET", "/v1/models");
}

export function listRepositories() {
  return cursorFetch("GET", "/v1/repositories", { timeoutMs: 45000 });
}

export function me() {
  return cursorFetch("GET", "/v1/me", { timeoutMs: 15000 });
}

export function simplifyStatus(agent, run) {
  const runStatus = run?.status || "";
  if (["ERROR", "EXPIRED", "CANCELLED"].includes(runStatus)) return "failed";
  if (runStatus === "FINISHED") return "finished";
  if (["CREATING", "RUNNING"].includes(runStatus)) return "running";
  if (agent?.status === "ARCHIVED") return "failed";
  if (agent?.status === "ACTIVE") return "running";
  if (agent?.status === "IDLE") return "finished";
  return (agent?.status || "unknown").toLowerCase();
}

export function gitInfo(run) {
  const branches = run?.git?.branches || [];
  const first = branches[0] || {};
  return {
    branch: first.branch || "",
    prUrl: first.prUrl || "",
    repoUrl: first.repoUrl || "",
    branches,
  };
}

export async function enrichAgent(agent) {
  let run = null;
  if (agent?.latestRunId) {
    try {
      run = await getRun(agent.id, agent.latestRunId);
    } catch (err) {
      run = { error: err.message, status: "unknown" };
    }
  }
  const git = gitInfo(run);
  return {
    id: agent.id,
    name: agent.name,
    status: simplifyStatus(agent, run),
    agentStatus: agent.status,
    runStatus: run?.status || null,
    url: agent.url,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    latestRunId: agent.latestRunId || null,
    result: run?.result || null,
    branch: git.branch,
    prUrl: git.prUrl,
    repoUrl: git.repoUrl || (agent.repos?.[0]?.url || ""),
    repos: agent.repos || [],
  };
}
