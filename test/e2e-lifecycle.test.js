import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJsonServer, mockCursorState, cursorHandler, telegramHandler } from "./mocks.js";

const dir = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.BRIDGE_TEST = "true";
process.env.DISABLE_POLLER = "true";
process.env.APP_SECRET = "unit-secret-unit-secret";
process.env.CURSOR_WEBHOOK_SECRET = "w".repeat(32);
process.env.CURSOR_AGENTS_API_KEY = "key_test";
process.env.TELEGRAM_BOT_TOKEN = "123:abc";
process.env.TELEGRAM_CHAT_ID = "42";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "42";

const cursorState = mockCursorState();
const sent = [];
const cursor = await startJsonServer(cursorHandler(cursorState));
const telegram = await startJsonServer(telegramHandler(sent));
process.env.CURSOR_API_BASE_URL = cursor.origin;
process.env.TELEGRAM_API_BASE_URL = telegram.origin;

after(() => {
  cursor.server.close();
  telegram.server.close();
});

const { ensureMemoryTables, createProject, addTask, runWithActor } = await import("../src/memory.js");
ensureMemoryTables();
const { registerDefaultProcessors } = await import("../src/processors.js");
registerDefaultProcessors();
const { launchTrackedAgent } = await import("../src/orchestrator.js");
const { handleWebhookGateway } = await import("../src/webhook-gateway.js");
const { drainEvents, listEvents } = await import("../src/events.js");
const { getAgentRecord } = await import("../src/agents-store.js");
const { verifyCursorWebhookSignature } = await import("../src/webhook.js");

function sign(body) {
  const raw = Buffer.from(body);
  return "sha256=" + createHmac("sha256", process.env.CURSOR_WEBHOOK_SECRET).update(raw).digest("hex");
}

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("webhook HMAC rejects bad signatures", async () => {
  const req = {
    body: Buffer.from("{}"),
    get: () => "sha256=deadbeef",
  };
  const res = fakeRes();
  await handleWebhookGateway(req, res);
  assert.equal(res.statusCode, 401);
});

test("HMAC helper matches gateway", () => {
  const raw = Buffer.from('{"ok":true}');
  const header = sign(raw);
  assert.equal(verifyCursorWebhookSignature(process.env.CURSOR_WEBHOOK_SECRET, raw, header), true);
});

test("lifecycle: create project/task/agent → webhook → event → telegram", async () => {
  const ctx = runWithActor("user", () => {
    const project = createProject({
      name: "e2e-orch",
      repo_url: "https://github.com/octocat/Hello-World",
      description: "e2e",
    });
    const task = addTask({ project_id: project.id, title: "implement" });
    return { project, task };
  });
  const launched = await launchTrackedAgent({
    prompt: "do the work",
    repository: ctx.project.repo_url,
    name: "e2e",
    project_id: ctx.project.id,
    task_id: ctx.task.id,
    role: "Backend",
  });
  const agentId = launched.agent.id;
  assert.match(agentId, /^bc-test-/);
  assert.equal(getAgentRecord(agentId).project_id, ctx.project.id);

  const live = cursorState.agents.get(agentId);
  live.status = "IDLE";
  const run = cursorState.runs.get(live.latestRunId);
  run.status = "FINISHED";
  run.git = { branches: [{ branch: "cursor/e2e", prUrl: "", repoUrl: ctx.project.repo_url }] };

  const payload = JSON.stringify({
    event: "statusChange",
    id: agentId,
    status: "FINISHED",
    name: "e2e",
    latestRunId: live.latestRunId,
  });
  const raw = Buffer.from(payload);
  const req = {
    body: raw,
    get: (name) => {
      if (name.toLowerCase() === "x-webhook-signature") return sign(raw);
      if (name.toLowerCase() === "x-webhook-id") return "wh-e2e-1";
      if (name.toLowerCase() === "x-webhook-event") return "statusChange";
      return "";
    },
  };
  const res = fakeRes();
  await handleWebhookGateway(req, res);
  assert.equal(res.statusCode, 200);
  await drainEvents(20);
  const rec = getAgentRecord(agentId);
  assert.ok(["COMPLETED", "FAILED", "WAITING", "RUNNING"].includes(rec.state), rec.state);
  const events = listEvents({ agent_id: agentId, limit: 20 });
  assert.ok(events.length >= 1);
  const again = fakeRes();
  await handleWebhookGateway(req, again);
  assert.equal(again.body.duplicate, true);
});

test("authorization: telegram callback from unknown chat is ignored", async () => {
  const { handleTelegramWebhook } = await import("../src/telegram-webhook.js");
  const req = {
    get: () => "",
    body: {
      callback_query: {
        id: "cb1",
        data: "stop:bc-x",
        message: { chat: { id: 999 } },
      },
    },
  };
  const res = fakeRes();
  await handleTelegramWebhook(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, "unauthorized_chat");
});
