import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startGithubMock } from "./github-mock.js";

const dir = mkdtempSync(join(tmpdir(), "intel-git-"));
process.env.DATA_DIR = dir;
process.env.LOG_DIR = dir;
process.env.GITHUB_ALLOWED_REPOS = "acme/demo";
process.env.INTEL_LOCAL_REPOS = `acme/demo:${dir}/repo`;
process.env.INTEL_ALLOW_CURSOR_REPOS = "false";
process.env.GITHUB_TOKEN = "test-token";
process.env.APP_SECRET = "unit-secret-unit-secret";

const repoDir = join(dir, "repo");
mkdirSync(repoDir);

function git(args, cwd = repoDir) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || args.join(" "));
  return r.stdout.trim();
}

git(["init", "-b", "main"]);
git(["config", "user.email", "dev@example.com"]);
git(["config", "user.name", "Dev"]);
mkdirSync(join(repoDir, "src", "auth"), { recursive: true });
mkdirSync(join(repoDir, "node_modules", "left-pad"), { recursive: true });
writeFileSync(join(repoDir, ".gitignore"), "node_modules\n.env\n");
writeFileSync(join(repoDir, ".env"), "API_KEY=super-secret-live-key\n");
writeFileSync(
  join(repoDir, "package.json"),
  JSON.stringify({ name: "demo", main: "src/server.js", dependencies: { express: "^4.0.0" } }, null, 2),
);
writeFileSync(
  join(repoDir, "src", "server.js"),
  `import express from "express";\nconst app = express();\napp.get("/login", (req, res) => res.send("ok"));\napp.listen(3000);\n`,
);
writeFileSync(
  join(repoDir, "src", "auth", "service.js"),
  `export function authenticate(user, password) {\n  return user === "admin";\n}\n`,
);
writeFileSync(join(repoDir, "src", "auth", "models.js"), `export const User = { id: 1 };\n`);
writeFileSync(join(repoDir, "node_modules", "left-pad", "index.js"), "module.exports=s=>s;\n");
git(["add", "."]);
git(["commit", "-m", "init auth"]);
git(["checkout", "-b", "feature/auth"]);
writeFileSync(join(repoDir, "src", "auth", "service.js"), `export function authenticate(user, password) {\n  const token = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";\n  return user === "admin" && Boolean(token);\n}\n`);
git(["add", "src/auth/service.js"]);
git(["commit", "-m", "add token accidentally"]);
const head = git(["rev-parse", "HEAD"]);
const main = git(["rev-parse", "main"]);

const { ensureMemoryTables } = await import("../src/memory.js");
ensureMemoryTables();

const gh = await startGithubMock({
  repo: "acme/demo",
  sha: head,
  defaultBranch: "main",
  tree: [
    { path: "src/server.js", type: "blob", size: 20, sha: "1" },
    { path: "src/auth/service.js", type: "blob", size: 20, sha: "2" },
  ],
  contents: {
    "src/server.js": { content: "app.get('/login')", sha: "1" },
  },
  pulls: [{ number: 7, title: "Auth", state: "open", user: { login: "dev" }, html_url: "https://github.com/acme/demo/pull/7", base: { ref: "main" }, head: { ref: "feature/auth", sha: head } }],
  pull: {
    number: 7,
    title: "Auth",
    state: "open",
    user: { login: "dev" },
    html_url: "https://github.com/acme/demo/pull/7",
    base: { ref: "main" },
    head: { ref: "feature/auth", sha: head },
    body: "add login",
    commits: 1,
    additions: 4,
    deletions: 0,
    changed_files: 1,
    draft: false,
    merged: false,
  },
  prFiles: [
    {
      filename: "src/auth/service.js",
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: "@@ -1,3 +1,4 @@\n export function authenticate",
    },
  ],
  prComments: [
    {
      id: 11,
      user: { login: "reviewer" },
      path: "src/auth/service.js",
      line: 2,
      original_line: 2,
      side: "RIGHT",
      commit_id: head,
      body: "Do not hardcode tokens",
      created_at: "2026-01-02T00:00:00Z",
      html_url: "https://github.com/acme/demo/pull/7#discussion_r11",
    },
  ],
  prReviews: [{ id: 1, user: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "fix secrets", commit_id: head, submitted_at: "2026-01-02T00:00:00Z" }],
  checks: [{ name: "test", status: "completed", conclusion: "failure", html_url: "https://example/check", output: { title: "fail", summary: "1 failed" } }],
  issues: [{ number: 3, title: "Login 500", state: "open", user: { login: "qa" }, html_url: "https://github.com/acme/demo/issues/3", labels: [{ name: "bug" }] }],
  issue: { number: 3, title: "Login 500", state: "open", user: { login: "qa" }, body: "repro", html_url: "https://github.com/acme/demo/issues/3", labels: [] },
  issueComments: [{ id: 4, user: { login: "qa" }, body: "still broken", created_at: "2026-01-03T00:00:00Z", html_url: "https://x" }],
  actions: [{ id: 9, name: "CI", status: "completed", conclusion: "failure", html_url: "https://x", head_sha: head, head_branch: "feature/auth", event: "pull_request", pull_requests: [{ number: 7 }] }],
  compareFiles: [{ filename: "src/auth/service.js", status: "modified", additions: 2, deletions: 1, patch: "+token" }],
  commits: [{ sha: head, commit: { message: "add token accidentally", author: { name: "Dev", date: "2026-01-01T00:00:00Z" } }, html_url: "https://x" }],
  searchForbidden: true,
  branches: [{ name: "main", commit: { sha: main }, protected: false }, { name: "feature/auth", commit: { sha: head }, protected: false }],
});
process.env.GITHUB_API_BASE_URL = gh.origin;

after(() => {
  gh.server.close();
  rmSync(dir, { recursive: true, force: true });
});

const repo = await import("../src/intel/repo.js");
const gitIntel = await import("../src/intel/git-intel.js");
const snap = await import("../src/intel/snapshot.js");
const ghApi = await import("../src/intel/github-api.js");
const { assertRepoAllowed } = await import("../src/intel/allowlist.js");

test("local tree hides node_modules and can paginate", async () => {
  const tree = await repo.repoTree({ repository: "acme/demo", recursive: true, limit: 50 });
  assert.equal(tree.repository, "acme/demo");
  assert.match(tree.commit, /^[0-9a-f]{40}$/);
  const paths = tree.items.map((i) => i.path);
  assert.ok(paths.includes("src/auth/service.js"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules")));
});

test("read file with line numbers and secret redaction", async () => {
  const file = await repo.repoFileRead({ repository: "acme/demo", path: "src/auth/service.js" });
  assert.equal(file.language, "javascript");
  assert.equal(file.redacted, true);
  assert.equal(file.content.includes("ghp_"), false);
  assert.equal(file.lines[0].number, 1);
});

test("batch read and search authentication", async () => {
  const batch = await repo.repoFileBatchRead({
    repository: "acme/demo",
    paths: ["src/auth/service.js", "src/auth/models.js", "src/server.js"],
  });
  assert.equal(batch.items.length, 3);
  const hits = await repo.repoSearch({ repository: "acme/demo", query: "authenticate", path: "src/" });
  assert.ok(hits.items.some((h) => h.file === "src/auth/service.js" && h.line >= 1));
});

test("path traversal is rejected", async () => {
  await assert.rejects(() => repo.repoFileRead({ repository: "acme/demo", path: "../.env" }), /traversal|PATH/);
});

test("unallowlisted repo is forbidden", async () => {
  await assert.rejects(() => assertRepoAllowed("evil", "exfil"), /allowlist|FORBIDDEN/);
});

test("git changed files between main and feature", async () => {
  const changed = await gitIntel.gitChangedFilesIntel({
    repository: "acme/demo",
    base: "main",
    head: "feature/auth",
  });
  assert.ok(changed.modified.length + changed.added.length >= 1);
  assert.ok(changed.files.some((f) => f.filename === "src/auth/service.js"));
});

test("git diff and blame from local git", async () => {
  const diff = await gitIntel.gitDiffIntel({ repository: "acme/demo", base: "main", head: "HEAD" });
  assert.ok(diff.diff.length > 0);
  assert.equal(diff.diff.includes("ghp_"), false);
  const blame = await gitIntel.gitBlameIntel({ repository: "acme/demo", path: "src/auth/service.js" });
  assert.equal(blame.source, "local");
  assert.ok(blame.ranges.length >= 1);
});

test("git status sees worktree", async () => {
  writeFileSync(join(repoDir, "src", "auth", "models.js"), "export const User = { id: 2 };\n");
  const st = await gitIntel.gitStatusIntel({ repository: "acme/demo" });
  assert.equal(st.source, "local_worktree");
  assert.ok(st.items.some((i) => i.path.includes("models.js")));
});

test("github PR files comments reviews checks issues actions", async () => {
  const { owner, repo: r } = await ghApi.resolveRepo("acme/demo");
  const pr = await ghApi.getPull(owner, r, 7);
  assert.equal(pr.number, 7);
  const files = await ghApi.getPullFiles(owner, r, 7);
  assert.equal(files[0].filename, "src/auth/service.js");
  const comments = await ghApi.getPullComments(owner, r, 7);
  assert.match(comments[0].body, /hardcode/);
  const reviews = await ghApi.getPullReviews(owner, r, 7);
  assert.equal(reviews[0].state, "CHANGES_REQUESTED");
  const checks = await ghApi.getCheckRuns(owner, r, head);
  assert.equal(checks[0].conclusion, "failure");
  const issues = await ghApi.listIssues(owner, r);
  assert.equal(issues[0].number, 3);
  const ic = await ghApi.getIssueComments(owner, r, 3);
  assert.equal(ic[0].id, 4);
  const actions = await ghApi.listActions(owner, r);
  assert.equal(actions[0].conclusion, "failure");
});

test("snapshot and audit are evidence-based", async () => {
  const shot = await snap.projectSnapshot({ repository: "acme/demo" });
  assert.ok(shot.languages.javascript >= 1);
  assert.ok(shot.entrypoints.includes("package.json"));
  assert.ok(shot.open_prs.some((p) => p.number === 7));
  assert.equal(shot.ci_status.conclusion, "failure");
  const audit = await snap.projectAudit({ repository: "acme/demo", pull_number: 7 });
  assert.ok(audit.claims.some((c) => c.pr === 7 && c.path === "src/auth/service.js"));
  const ctx = await snap.prReviewContext({ repository: "acme/demo", pull_number: 7 });
  assert.equal(ctx.files[0].comments[0].line, 2);
});

test("e2e model workflow: tree → search → read → git → PR → CI", async () => {
  const tree = await repo.repoTree({ repository: "acme/demo" });
  const found = await repo.repoSearch({ repository: "acme/demo", query: "login", path: "src/" });
  const files = await repo.repoFileBatchRead({
    repository: "acme/demo",
    paths: ["src/server.js", "src/auth/service.js", "src/auth/models.js"],
  });
  const history = await gitIntel.gitCommitsIntel({ repository: "acme/demo", path: "src/auth/service.js", limit: 5 });
  const pr = await ghApi.getPull("acme", "demo", 7);
  const comments = await ghApi.getPullComments("acme", "demo", 7);
  const checks = await ghApi.getCheckRuns("acme", "demo", pr.head_sha);
  const audit = await snap.projectAudit({ repository: "acme/demo", pull_number: 7 });
  assert.ok(tree.items.length >= 3);
  assert.ok(found.items.length >= 1);
  assert.equal(files.items.length, 3);
  assert.ok(history.items.length >= 1);
  assert.equal(comments[0].path, "src/auth/service.js");
  assert.equal(checks[0].conclusion, "failure");
  assert.ok(audit.snapshot.architecture.flow);
});
