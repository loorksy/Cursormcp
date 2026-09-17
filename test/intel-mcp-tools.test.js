import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "intel-mcp-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.BRIDGE_TEST = "true";
process.env.DISABLE_POLLER = "true";
process.env.APP_SECRET = "unit-secret-unit-secret";
process.env.INTEL_ALLOW_CURSOR_REPOS = "false";

const { INTEL_TOOL_NAMES } = await import("../src/intel-mcp.js");
const { createBridgeMcpServer } = await import("../src/mcp.js");

test("intel MCP tools are registered on the live server", () => {
  assert.ok(INTEL_TOOL_NAMES.includes("repo_tree"));
  assert.ok(INTEL_TOOL_NAMES.includes("github_pull_request_comments"));
  assert.ok(INTEL_TOOL_NAMES.includes("project_snapshot"));
  const server = createBridgeMcpServer();
  assert.ok(server);
  const listed = server._registeredTools || server.tools || {};
  const names = listed instanceof Map ? [...listed.keys()] : Object.keys(listed);
  if (names.length) {
    for (const n of ["repo_tree", "repo_file_read", "git_diff", "project_audit"]) {
      assert.ok(names.includes(n), `missing ${n} in ${names.slice(0, 12)}`);
    }
  }
});
