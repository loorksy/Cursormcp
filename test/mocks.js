import { createServer } from "node:http";

export function startJsonServer(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const result = await handler({ method: req.method, url, pathname: url.pathname, body, headers: req.headers });
    const status = result.status || 200;
    const payload = result.body || {};
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

export function mockCursorState() {
  return {
    agents: new Map(),
    runs: new Map(),
  };
}

export function cursorHandler(state) {
  return async ({ method, pathname, body }) => {
    if (method === "POST" && pathname === "/v0/agents") {
      const id = `bc-test-${state.agents.size + 1}`;
      const runId = `run-test-${state.agents.size + 1}`;
      const agent = {
        id,
        name: "test-agent",
        status: "ACTIVE",
        latestRunId: runId,
        url: "https://cursor.com/agents/" + id,
        repos: body.source?.repository ? [{ url: body.source.repository }] : [],
      };
      const run = { id: runId, status: "RUNNING", git: { branches: [] } };
      state.agents.set(id, agent);
      state.runs.set(runId, run);
      return { body: agent };
    }
    if (method === "POST" && pathname === "/v1/agents") {
      const id = `bc-test-${state.agents.size + 1}`;
      const runId = `run-test-${state.agents.size + 1}`;
      const agent = {
        id,
        name: body.name || "test-agent",
        status: "ACTIVE",
        latestRunId: runId,
        url: "https://cursor.com/agents/" + id,
        repos: body.repos || [],
      };
      const run = { id: runId, status: "RUNNING", git: { branches: [] } };
      state.agents.set(id, agent);
      state.runs.set(runId, run);
      return { body: { agent, run } };
    }
    const getAgent = pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (method === "GET" && getAgent) {
      const agent = state.agents.get(getAgent[1]);
      if (!agent) return { status: 404, body: { error: "not found" } };
      return { body: agent };
    }
    const getRun = pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)$/);
    if (method === "GET" && getRun) {
      const run = state.runs.get(getRun[2]);
      if (!run) return { status: 404, body: { error: "not found" } };
      return { body: run };
    }
    const listRuns = pathname.match(/^\/v1\/agents\/([^/]+)\/runs$/);
    if (method === "GET" && listRuns) {
      const items = [...state.runs.values()].filter((r) => true);
      return { body: { items } };
    }
    const cancel = pathname.match(/^\/v1\/agents\/([^/]+)\/runs\/([^/]+)\/cancel$/);
    if (method === "POST" && cancel) {
      const run = state.runs.get(cancel[2]);
      if (!run) return { status: 409, body: { error: "run_not_cancellable" } };
      run.status = "CANCELLED";
      const agent = state.agents.get(cancel[1]);
      if (agent) agent.status = "IDLE";
      return { body: run };
    }
    if (method === "POST" && pathname.match(/^\/v1\/agents\/[^/]+\/runs$/)) {
      const agentId = pathname.split("/")[3];
      const runId = `run-test-f-${state.runs.size + 1}`;
      const run = { id: runId, status: "RUNNING", git: { branches: [] } };
      state.runs.set(runId, run);
      const agent = state.agents.get(agentId);
      if (agent) {
        agent.latestRunId = runId;
        agent.status = "ACTIVE";
      }
      return { body: run };
    }
    if (method === "GET" && pathname === "/v1/agents") {
      return { body: { items: [...state.agents.values()] } };
    }
    return { status: 404, body: { error: "mock unmatched " + method + pathname } };
  };
}

export function telegramHandler(sent) {
  return async ({ pathname, body }) => {
    if (pathname.endsWith("/sendMessage")) {
      sent.push(body);
      return { body: { ok: true, result: { message_id: sent.length } } };
    }
    if (pathname.endsWith("/answerCallbackQuery")) {
      sent.push({ callback: body });
      return { body: { ok: true } };
    }
    return { status: 404, body: { ok: false } };
  };
}
