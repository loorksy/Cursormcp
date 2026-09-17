import { listProjects, getProjectFull, listApprovedRules } from "../memory.js";
import { openRef, repoTree, repoFileRead } from "./repo.js";
import { gitCommitsIntel } from "./git-intel.js";
import {
  resolveRepo,
  getRepository,
  listPulls,
  listIssues,
  listActions,
  getCheckRuns,
  getPullComments,
  getPullReviews,
  getPullFiles,
  getPull,
} from "./github-api.js";
import { languageOf, looksGeneratedPath } from "./paginate.js";
import { IntelError } from "./errors.js";

const ENTRY_CANDIDATES = [
  "package.json",
  "src/server.js",
  "src/main.js",
  "src/index.js",
  "main.py",
  "app.py",
  "Dockerfile",
  "docker-compose.yml",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
];

export async function detectInventory(ctx, treeItems) {
  const files = treeItems.filter((e) => e.type === "file" || e.type === "blob");
  const languages = {};
  const directories = new Set();
  for (const f of files) {
    if (looksGeneratedPath(f.path)) continue;
    const lang = languageOf(f.path);
    if (lang) languages[lang] = (languages[lang] || 0) + 1;
    const dir = f.path.includes("/") ? f.path.split("/")[0] : ".";
    directories.add(dir);
  }
  const entrypoints = ENTRY_CANDIDATES.filter((p) => files.some((f) => f.path === p));
  return {
    file_count: files.length,
    languages,
    directories: [...directories].sort(),
    entrypoints,
  };
}

export async function readJsonFile(repository, ref, path) {
  try {
    const file = await repoFileRead({ repository, ref, path, max_bytes: 80_000 });
    if (!file.content) return null;
    return JSON.parse(file.content);
  } catch {
    return null;
  }
}

export async function architectureMap(args) {
  const ctx = await openRef(args.repository, args.ref);
  const tree = await repoTree({ repository: args.repository, ref: args.ref, recursive: true, limit: 2000 });
  const inventory = await detectInventory(ctx, tree.items);
  const pkg = await readJsonFile(args.repository, args.ref, "package.json");
  const imports = [];
  const routes = [];
  const scan = tree.items
    .filter((f) => ["javascript", "typescript"].includes(f.language) && f.path.startsWith("src/") && !f.path.includes(".test."))
    .slice(0, 40);
  for (const f of scan) {
    const file = await repoFileRead({ repository: args.repository, ref: args.ref, path: f.path, max_bytes: 40_000 });
    if (!file.content) continue;
    for (const line of file.lines || []) {
      const im = line.text.match(/from\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/);
      if (im) imports.push({ path: f.path, line: line.number, spec: im[1] || im[2] });
      const rt = line.text.match(/\b(app|router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/i);
      if (rt) routes.push({ path: f.path, line: line.number, method: rt[2].toUpperCase(), route: rt[3] });
    }
  }
  const layers = {
    api: tree.items.filter((f) => /route|controller|http|api/i.test(f.path)).map((f) => f.path).slice(0, 30),
    services: tree.items.filter((f) => /service|orchestr|processor/i.test(f.path)).map((f) => f.path).slice(0, 30),
    models: tree.items.filter((f) => /model|schema|memory/i.test(f.path)).map((f) => f.path).slice(0, 30),
    workers: tree.items.filter((f) => /worker|queue|poll/i.test(f.path)).map((f) => f.path).slice(0, 20),
    tests: tree.items.filter((f) => /(^|\/)test[s]?\//.test(f.path) || /\.test\./.test(f.path)).map((f) => f.path).slice(0, 40),
  };
  return {
    repository: ctx.repository,
    commit: ctx.commit.sha,
    ref: ctx.ref,
    inventory,
    package: pkg
      ? {
          name: pkg.name,
          main: pkg.main,
          scripts: pkg.scripts || {},
          dependencies: Object.keys(pkg.dependencies || {}),
          devDependencies: Object.keys(pkg.devDependencies || {}),
        }
      : null,
    layers,
    routes: routes.slice(0, 80),
    imports: imports.slice(0, 120),
    flow: ["HTTP/MCP", "Controllers/Tools", "Services", "Store/SQLite", "External APIs"].join(" → "),
    references: { repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref },
  };
}

export async function projectSnapshot(args) {
  const repository = args.repository || (args.project_id ? listProjects().find((p) => p.id === Number(args.project_id))?.repo_url : "");
  if (!repository) throw new IntelError("INVALID_INPUT", "repository or project_id is required");
  const ctx = await openRef(repository, args.ref);
  const meta = await getRepository(ctx.owner, ctx.repo).catch(() => ({ full_name: ctx.repository, default_branch: ctx.ref }));
  const arch = await architectureMap({ repository, ref: args.ref });
  const recent = await gitCommitsIntel({ repository, ref: args.ref, limit: 8 });
  let open_prs = [];
  let issues = [];
  let ci_status = {};
  let actions = [];
  try {
    open_prs = await listPulls(ctx.owner, ctx.repo, { state: "open", limit: 10 });
  } catch {
    open_prs = [];
  }
  try {
    issues = await listIssues(ctx.owner, ctx.repo, { state: "open", limit: 10 });
  } catch {
    issues = [];
  }
  try {
    actions = await listActions(ctx.owner, ctx.repo, { limit: 8 });
    const latest = actions[0];
    ci_status = latest
      ? { name: latest.name, status: latest.status, conclusion: latest.conclusion, sha: latest.head_sha, html_url: latest.html_url }
      : {};
    if (ctx.commit.sha) {
      const checks = await getCheckRuns(ctx.owner, ctx.repo, ctx.commit.sha).catch(() => []);
      if (checks.length) ci_status = { ...ci_status, checks: checks.slice(0, 20) };
    }
  } catch {
    ci_status = { note: "GitHub Actions/checks not readable with this token" };
  }
  const memory = args.project_id ? getProjectFull(Number(args.project_id)) : null;
  return {
    repository: {
      full_name: meta.full_name || ctx.repository,
      description: meta.description || "",
      html_url: meta.html_url,
      private: meta.private,
    },
    branch: { name: ctx.ref, commit: ctx.commit.sha },
    commit: ctx.commit,
    technology: Object.keys(arch.inventory.languages),
    languages: arch.inventory.languages,
    directories: arch.inventory.directories,
    entrypoints: arch.inventory.entrypoints,
    services: arch.layers.services,
    apis: arch.routes,
    database: inferDatabase(arch),
    dependencies: arch.package?.dependencies || [],
    tests: { files: arch.layers.tests.slice(0, 20), count: arch.layers.tests.length },
    recent_changes: recent.items,
    open_prs,
    issues,
    ci_status,
    architecture: { flow: arch.flow, layers: arch.layers, package: arch.package },
    risks: inferRisks(arch, ci_status, memory),
    memory_capsule: memory
      ? { project: memory.project, verified_task_count: memory.verified?.tasks?.length, draft_task_count: memory.draft?.tasks?.length }
      : null,
    references: { repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref },
  };
}

function inferDatabase(arch) {
  const deps = new Set(arch.package?.dependencies || []);
  const files = [...arch.layers.models, ...arch.inventory.entrypoints];
  const kind = deps.has("pg") || files.some((f) => /postgres/i.test(f))
    ? "postgres"
    : files.some((f) => /sqlite|schema/i.test(f)) || deps.has("better-sqlite3")
      ? "sqlite"
      : files.some((f) => /\.sql$/.test(f))
        ? "sql"
        : "unknown";
  return { kind, evidence: files.filter((f) => /schema|sqlite|model/i.test(f)).slice(0, 10) };
}

function inferRisks(arch, ci, memory) {
  const risks = [];
  if (!arch.layers.tests.length) risks.push({ level: "medium", message: "no test files detected in tree" });
  if (ci?.conclusion === "failure") risks.push({ level: "high", message: "latest Actions run failed", evidence: ci });
  if (memory && memory.draft?.errors?.length) {
    risks.push({ level: "medium", message: "unresolved errors in project memory (draft — not verified truth)" });
  }
  if (!arch.package) risks.push({ level: "low", message: "no package.json at repository root" });
  return risks;
}

function claim(message, extra) {
  return { message, ...extra };
}

export async function projectAudit(args) {
  const snapshot = await projectSnapshot(args);
  const repository = snapshot.repository.full_name;
  const ref = snapshot.branch.name;
  const claims = [];
  claims.push(claim("Repository metadata loaded from GitHub/local git", { repository, commit: snapshot.commit.sha }));
  for (const [lang, n] of Object.entries(snapshot.languages || {})) {
    claims.push(claim(`Language ${lang}: ${n} files`, { repository, commit: snapshot.commit.sha }));
  }
  for (const ep of snapshot.entrypoints || []) {
    claims.push(claim(`Entrypoint ${ep}`, { repository, path: ep, commit: snapshot.commit.sha }));
  }
  for (const rt of (snapshot.apis || []).slice(0, 30)) {
    claims.push(claim(`${rt.method} ${rt.route}`, { repository, path: rt.path, line: rt.line, commit: snapshot.commit.sha }));
  }
  if (snapshot.tests.count === 0) {
    claims.push(claim("No automated tests detected in tree", { repository, commit: snapshot.commit.sha }));
  } else {
    claims.push(claim(`${snapshot.tests.count} test files`, { repository, path: snapshot.tests.files[0], commit: snapshot.commit.sha }));
  }
  for (const pr of snapshot.open_prs || []) {
    claims.push(claim(`Open PR #${pr.number}: ${pr.title}`, { repository, pr: pr.number, commit: pr.head_sha }));
  }
  let prReview = null;
  if (args.pull_number) {
    const [owner, repo] = repository.split("/");
    const pr = await getPull(owner, repo, args.pull_number);
    const files = await getPullFiles(owner, repo, args.pull_number);
    const comments = await getPullComments(owner, repo, args.pull_number);
    const reviews = await getPullReviews(owner, repo, args.pull_number);
    prReview = { pr, files, comments, reviews };
    for (const c of comments) {
      claims.push(
        claim(`Review comment on ${c.path}:${c.line} by ${c.user}`, {
          repository,
          pr: args.pull_number,
          path: c.path,
          line: c.line,
          commit: c.commit_id,
        }),
      );
    }
  }
  let memorySection = null;
  if (args.project_id) {
    const full = getProjectFull(Number(args.project_id));
    const rules = listApprovedRules(Number(args.project_id));
    memorySection = {
      note: "Memory is governed. Draft is not verified truth.",
      verified_tasks: full.verified?.tasks?.length || 0,
      draft_tasks: full.draft?.tasks?.length || 0,
      approved_rules: rules.length,
    };
  }
  return {
    snapshot,
    claims,
    pr_review: prReview,
    memory: memorySection,
    generated_at: new Date().toISOString(),
  };
}

export async function prReviewContext(args) {
  const { owner, repo } = await resolveRepo(args.repository);
  const number = Number(args.pull_number);
  const pr = await getPull(owner, repo, number);
  const files = await getPullFiles(owner, repo, number);
  const comments = await getPullComments(owner, repo, number);
  const reviews = await getPullReviews(owner, repo, number);
  const byFile = {};
  for (const f of files) {
    byFile[f.filename] = { file: f, comments: [], reviews: [] };
  }
  for (const c of comments) {
    const bucket = byFile[c.path] || (byFile[c.path] = { file: { filename: c.path }, comments: [], reviews: [] });
    bucket.comments.push(c);
  }
  return {
    repository: `${owner}/${repo}`,
    pr,
    files: Object.values(byFile).map((row) => ({
      path: row.file.filename,
      status: row.file.status,
      additions: row.file.additions,
      deletions: row.file.deletions,
      patch: row.file.patch,
      comments: row.comments.map((c) => ({
        id: c.id,
        user: c.user,
        line: c.line,
        commit: c.commit_id,
        body: c.body,
        html_url: c.html_url,
        references: { repository: `${owner}/${repo}`, pr: number, path: c.path, commit: c.commit_id, line: c.line },
      })),
    })),
    reviews,
    references: { repository: `${owner}/${repo}`, pr: number, commit: pr.head_sha },
  };
}
