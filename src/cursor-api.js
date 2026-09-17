import { getSetting, decryptSecret, log } from "./lib.js";
import { outboundWebhookConfig } from "./webhook.js";

function apiBase() {
  return (process.env.CURSOR_API_BASE_URL || "https://api.cursor.com").replace(/\/$/, "");
}

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

function authHeaders(basic = false) {
  const key = getApiKey();
  if (!key) {
    const err = new Error("CURSOR_AGENTS_API_KEY is not configured");
    err.code = "NO_API_KEY";
    throw err;
  }
  return {
    Authorization: basic
      ? `Basic ${Buffer.from(`${key}:`, "utf8").toString("base64")}`
      : `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function cursorFetch(method, path, { query, body, timeoutMs = 60000, basic = false } = {}) {
  const url = new URL(path, apiBase());
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
      headers: authHeaders(basic),
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
      ...(res.ok ? {} : { error: json }),
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

export function buildCreateAgentRequest(
  { prompt, repository, ref, model, autoCreatePR, name },
  webhook,
) {
  if (webhook?.url && webhook?.secret) {
    const payload = {
      prompt: { text: prompt },
      webhook: { url: webhook.url, secret: webhook.secret },
    };
    if (repository) {
      payload.source = { repository, ...(ref ? { ref } : {}) };
    }
    if (model) payload.model = String(model);
    if (autoCreatePR === true || autoCreatePR === "true") {
      payload.target = { autoCreatePr: true };
    }
    return { path: "/v0/agents", body: payload, basic: false };
  }
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
  return { path: "/v1/agents", body: payload, basic: false };
}

export function cursorErrorMessage(err) {
  const body = err?.body;
  if (typeof body?.error === "string") return body.error;
  if (body?.error?.message) return body.error.message;
  if (typeof body?.message === "string") return body.message;
  return err?.message || "";
}

function isInvalidModelError(err) {
  if (!(err instanceof CursorApiError) || err.status !== 400) return false;
  return /model/i.test(cursorErrorMessage(err));
}

async function postCreate(req) {
  try {
    return await cursorFetch("POST", req.path, { body: req.body, basic: req.basic });
  } catch (err) {
    if (err instanceof CursorApiError && err.status === 401 && req.basic === false) {
      return await cursorFetch("POST", req.path, { body: req.body, basic: true });
    }
    throw err;
  }
}

export async function createAgent(opts) {
  const webhook = outboundWebhookConfig();
  const req = buildCreateAgentRequest(opts, webhook);
  log("info", "cursor_create", {
    path: req.path,
    webhookAttached: Boolean(webhook),
    repository: opts.repository || "",
  });
  let created;
  let modelFallback = false;
  try {
    created = await postCreate(req);
  } catch (err) {
    if (webhook && opts.model && isInvalidModelError(err)) {
      const retry = buildCreateAgentRequest({ ...opts, model: undefined }, webhook);
      created = await postCreate(retry);
      modelFallback = true;
    } else {
      throw err;
    }
  }
  if (req.path === "/v0/agents" && created?.id && !created.agent) {
    return { agent: created, webhookAttached: true, modelFallback };
  }
  return { ...created, webhookAttached: Boolean(webhook), modelFallback };
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

export function listRuns(agentId, { limit = 20, cursor } = {}) {
  return cursorFetch("GET", `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
    query: { limit, cursor },
  });
}

export function cancelRun(agentId, runId) {
  return cursorFetch("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`, {
    body: {},
  });
}

export function archiveAgent(agentId) {
  return cursorFetch("POST", `/v1/agents/${encodeURIComponent(agentId)}/archive`, { body: {} });
}

export function unarchiveAgent(agentId) {
  return cursorFetch("POST", `/v1/agents/${encodeURIComponent(agentId)}/unarchive`, { body: {} });
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
