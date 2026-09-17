import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startJsonServer, mockCursorState, cursorHandler, telegramHandler } from "./mocks.js";

const dir = mkdtempSync(join(tmpdir(), "bridge-fail-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.BRIDGE_TEST = "true";
process.env.DISABLE_POLLER = "true";
process.env.APP_SECRET = "unit-secret-unit-secret";
process.env.CURSOR_WEBHOOK_SECRET = "";
process.env.CURSOR_AGENTS_API_KEY = "key_test";
process.env.MAX_AGENT_RETRIES = "1";
process.env.TELEGRAM_BOT_TOKEN = "123:abc";
process.env.TELEGRAM_CHAT_ID = "42";

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

const mem = await import("../src/memory.js");
mem.ensureMemoryTables();
const { verifyAgentCompletion } = await import("../src/verification.js");
const { maybeHeal } = await import("../src/healing.js");
const { upsertAgentRecord, getAgentRecord } = await import("../src/agents-store.js");
const { launchTrackedAgent } = await import("../src/orchestrator.js");
const { runWithActor } = mem;

test("local verifier failure is FAILED not COMPLETED", async () => {
  const project = runWithActor("user", () =>
    mem.createProject({
      name: "fail-demo",
      repo_url: "https://github.com/octocat/Hello-World",
    }),
  );
  mem.updateProject(project.id, {
    verify_json: JSON.stringify({ commands: [["node", "-e", "process.exit(2)"]] }),
  });
  const result = await verifyAgentCompletion({
    agent: { id: "bc-x", pr_url: "" },
    run: { id: "run-x", status: "FINISHED" },
    project: mem.listProjects().find((p) => p.id === project.id),
  });
  assert.equal(result.passed, false);
  assert.ok(result.verifications.some((v) => v.kind === "local_commands" && !v.passed));
});

test("heal stops after MAX_AGENT_RETRIES and blocks the task", async () => {
  const ctx = runWithActor("user", () => {
    const project = mem.createProject({ name: "heal-demo", repo_url: "https://github.com/octocat/Hello-World" });
    const task = mem.addTask({ project_id: project.id, title: "work" });
    return { project, task };
  });
  const launched = await launchTrackedAgent({
    prompt: "work",
    repository: ctx.project.repo_url,
    project_id: ctx.project.id,
    task_id: ctx.task.id,
  });
  upsertAgentRecord({ id: launched.agent.id, retry_count: 1, project_id: ctx.project.id, task_id: ctx.task.id });
  const out = await maybeHeal({
    agentId: launched.agent.id,
    project: ctx.project,
    task: mem.getTask(ctx.task.id),
    summary: "tests failed",
  });
  assert.equal(out.blocked, true);
  assert.equal(mem.getTask(ctx.task.id).status, "blocked");
  assert.equal(getAgentRecord(launched.agent.id).retry_count, 1);
});
