import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGithubMock } from "./github-mock.js";

const dir = mkdtempSync(join(tmpdir(), "intel-fs-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.GITHUB_ALLOWED_REPOS = "acme/plain";
process.env.INTEL_LOCAL_REPOS = `acme/plain:${dir}/checkout`;
process.env.INTEL_ALLOW_CURSOR_REPOS = "false";
process.env.GITHUB_TOKEN = "test-token";
process.env.APP_SECRET = "unit-secret-unit-secret";

const checkout = join(dir, "checkout");
mkdirSync(join(checkout, "src", "intel"), { recursive: true });
mkdirSync(join(checkout, "node_modules", "left-pad"), { recursive: true });
writeFileSync(join(checkout, ".gitignore"), "node_modules\n.env\n");
writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "plain", main: "src/intel-mcp.js" }));
writeFileSync(
  join(checkout, "src", "intel-mcp.js"),
  `export const INTEL_TOOL_NAMES = ["repo_tree", "repo_file_read"];\nexport function authenticate() { return true; }\n`,
);
writeFileSync(join(checkout, "src", "intel", "repo.js"), "export async function repoTree() { return { items: [] }; }\n");
writeFileSync(join(checkout, "node_modules", "left-pad", "index.js"), "module.exports=s=>s;\n");

const ghSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const gh = await startGithubMock({
  repo: "acme/plain",
  sha: ghSha,
  defaultBranch: "main",
  tree: [{ path: "README.md", type: "blob", size: 12, sha: "1" }],
  contents: {
    "README.md": { content: "hello github", sha: "1" },
  },
  searchForbidden: true,
});
process.env.GITHUB_API_BASE_URL = gh.origin;

const { ensureMemoryTables } = await import("../src/memory.js");
ensureMemoryTables();

const repo = await import("../src/intel/repo.js");
const gitIntel = await import("../src/intel/git-intel.js");

after(() => {
  gh.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("non-git mapped checkout uses filesystem even when GitHub main is empty", async () => {
  const meta = await repo.repoGet({ repository: "acme/plain" });
  assert.equal(meta.source, "filesystem");
  assert.equal(meta.commit, "worktree");

  const tree = await repo.repoTree({ repository: "acme/plain", ref: "main", recursive: true, limit: 50 });
  assert.equal(tree.source, "filesystem");
  const paths = tree.items.map((i) => i.path);
  assert.ok(paths.includes("src/intel-mcp.js"));
  assert.ok(paths.includes("src/intel/repo.js"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules")));
  assert.ok(!paths.includes("README.md"));
});

test("filesystem file read of deployed source", async () => {
  const file = await repo.repoFileRead({ repository: "acme/plain", ref: "main", path: "src/intel-mcp.js" });
  assert.equal(file.binary, false);
  assert.match(file.content, /INTEL_TOOL_NAMES/);
  assert.equal(file.commit, "worktree");
});

test("search scans the filesystem checkout", async () => {
  const hits = await repo.repoSearch({ repository: "acme/plain", query: "authenticate" });
  assert.ok(hits.items.some((h) => h.file === "src/intel-mcp.js" && h.line >= 1));
});

test("pinned SHA still uses GitHub, not the deploy tree", async () => {
  const tree = await repo.repoTree({ repository: "acme/plain", ref: ghSha, recursive: true, limit: 20 });
  const paths = tree.items.map((i) => i.path);
  assert.ok(paths.includes("README.md"));
  assert.ok(!paths.includes("src/intel-mcp.js"));
  const file = await repo.repoFileRead({ repository: "acme/plain", ref: ghSha, path: "README.md" });
  assert.match(file.content, /hello github/);
  await assert.rejects(
    () => repo.repoFileRead({ repository: "acme/plain", ref: ghSha, path: "src/intel-mcp.js" }),
    /Not Found|FILE_NOT_FOUND|file not found/i,
  );
});

test("path traversal is rejected on filesystem checkout", async () => {
  await assert.rejects(() => repo.repoFileRead({ repository: "acme/plain", path: "../.env" }), /traversal|PATH/);
});

test("git status on filesystem checkout does not invent a worktree", async () => {
  const st = await gitIntel.gitStatusIntel({ repository: "acme/plain" });
  assert.equal(st.source, "filesystem");
  assert.equal(st.items.length, 0);
});
