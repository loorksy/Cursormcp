import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bridge-task-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.BRIDGE_TEST = "true";
process.env.APP_SECRET = "unit-secret-unit-secret";

const mem = await import("../src/memory.js");
mem.ensureMemoryTables();
const { runWithActor } = mem;

test("dependent task stays blocked until parent is verified", () => {
  const created = runWithActor("user", () => {
    const project = mem.createProject({ name: "dep-demo", repo_url: "https://github.com/octocat/Hello-World" });
    const a = mem.addTask({ project_id: project.id, title: "API" });
    const b = mem.addTask({ project_id: project.id, title: "Frontend", depends_on: [a.id] });
    return { project, a, b: mem.getTask(b.id) };
  });
  assert.equal(created.b.status, "blocked");
  assert.throws(() => mem.updateTaskStatus({ task_id: created.b.id, new_status: "in_progress" }));
  runWithActor("user", () => {
    mem.updateTaskStatus({ task_id: created.a.id, new_status: "in_progress" });
  });
  // still blocked: parent not verified
  assert.equal(mem.getTask(created.b.id).status, "blocked");
});
