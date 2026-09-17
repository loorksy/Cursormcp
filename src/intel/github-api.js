import { githubRequest, parseOwnerRepo } from "../github.js";
import { IntelError, wrapIntelError } from "./errors.js";
import { cacheGet, cacheSet } from "./cache.js";
import { assertRepoAllowed } from "./allowlist.js";

export function repoRef(owner, repo) {
  return `${owner}/${repo}`;
}

export async function resolveRepo(repository) {
  const parsed = parseOwnerRepo(repository);
  if (!parsed) {
    throw new IntelError("INVALID_REPOSITORY", "repository must be owner/repo or a github.com URL", {
      repository: String(repository || ""),
    });
  }
  await assertRepoAllowed(parsed.owner, parsed.repo);
  return parsed;
}

export async function getRepository(owner, repo) {
  const key = `meta|${owner}/${repo}`;
  const hit = cacheGet(key);
  if (hit) return hit.payload;
  try {
    const data = await githubRequest(`/repos/${owner}/${repo}`);
    const slim = {
      full_name: data.full_name,
      description: data.description || "",
      default_branch: data.default_branch,
      private: Boolean(data.private),
      html_url: data.html_url,
      language: data.language,
      pushed_at: data.pushed_at,
      defaultBranch: data.default_branch,
    };
    cacheSet(key, data.pushed_at || "", "meta", slim);
    return slim;
  } catch (err) {
    throw wrapIntelError(err, { repository: `${owner}/${repo}` });
  }
}

export async function resolveCommit(owner, repo, ref) {
  const want = ref || (await getRepository(owner, repo)).default_branch || "main";
  const key = `commit|${owner}/${repo}|${want}`;
  const hit = cacheGet(key);
  if (hit) return hit.payload;
  try {
    const data = await githubRequest(`/repos/${owner}/${repo}/commits/${encodeURIComponent(want)}`);
    const payload = {
      sha: data.sha,
      ref: want,
      message: data.commit?.message || "",
      author: data.commit?.author?.name || data.author?.login || "",
      date: data.commit?.author?.date || "",
      html_url: data.html_url,
      parents: (data.parents || []).map((p) => p.sha),
    };
    cacheSet(key, payload.sha, "commit", payload);
    return payload;
  } catch (err) {
    throw wrapIntelError(err, { repository: `${owner}/${repo}` });
  }
}

export async function getTree(owner, repo, sha, { recursive = true } = {}) {
  const key = `tree|${owner}/${repo}|${sha}|${recursive ? 1 : 0}`;
  const hit = cacheGet(key);
  if (hit) return hit.payload;
  const data = await githubRequest(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=${recursive ? 1 : 0}`,
  );
  const payload = {
    sha: data.sha,
    truncated: Boolean(data.truncated),
    tree: (data.tree || []).map((e) => ({
      path: e.path,
      type: e.type,
      size: e.size || 0,
      sha: e.sha,
      mode: e.mode,
    })),
  };
  cacheSet(key, sha, "tree", payload);
  return payload;
}

export async function getContents(owner, repo, path, ref) {
  try {
    return await githubRequest(
      `/repos/${owner}/${repo}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(ref)}`,
    );
  } catch (err) {
    throw wrapIntelError(err, { repository: `${owner}/${repo}`, path });
  }
}

export async function getBlob(owner, repo, sha) {
  const data = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`);
  if (data.encoding === "base64" && data.content) {
    return Buffer.from(data.content.replace(/\n/g, ""), "base64");
  }
  return Buffer.from(String(data.content || ""), "utf8");
}

export async function listBranches(owner, repo, { limit = 50 } = {}) {
  const data = await githubRequest(`/repos/${owner}/${repo}/branches?per_page=${Math.min(limit, 100)}`);
  return (Array.isArray(data) ? data : []).map((b) => ({
    name: b.name,
    sha: b.commit?.sha,
    protected: Boolean(b.protected),
  }));
}

export async function listCommits(owner, repo, { sha, path, limit = 30 } = {}) {
  const q = new URLSearchParams();
  if (sha) q.set("sha", sha);
  if (path) q.set("path", path);
  q.set("per_page", String(Math.min(limit, 100)));
  const data = await githubRequest(`/repos/${owner}/${repo}/commits?${q}`);
  return (Array.isArray(data) ? data : []).map((c) => ({
    sha: c.sha,
    message: c.commit?.message || "",
    author: c.commit?.author?.name || c.author?.login || "",
    date: c.commit?.author?.date || "",
    html_url: c.html_url,
  }));
}

export async function getCommit(owner, repo, ref) {
  const data = await githubRequest(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  return {
    sha: data.sha,
    message: data.commit?.message || "",
    author: data.commit?.author?.name || "",
    date: data.commit?.author?.date || "",
    html_url: data.html_url,
    stats: data.stats || {},
    files: (data.files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      previous_filename: f.previous_filename,
    })),
  };
}

export async function compare(owner, repo, base, head) {
  const data = await githubRequest(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  return {
    status: data.status,
    ahead_by: data.ahead_by,
    behind_by: data.behind_by,
    total_commits: data.total_commits,
    files: (data.files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      previous_filename: f.previous_filename,
      patch: f.patch || "",
    })),
    commits: (data.commits || []).slice(0, 20).map((c) => ({ sha: c.sha, message: c.commit?.message || "" })),
  };
}

export async function getDiff(owner, repo, base, head) {
  const { text } = await githubRequest(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { accept: "application/vnd.github.diff", raw: true },
  );
  return text;
}

export async function listPulls(owner, repo, { state = "open", limit = 20 } = {}) {
  const data = await githubRequest(
    `/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${Math.min(limit, 100)}`,
  );
  return (Array.isArray(data) ? data : []).map(slimPr);
}

export async function getPull(owner, repo, number) {
  return slimPr(await githubRequest(`/repos/${owner}/${repo}/pulls/${number}`), true);
}

export async function getPullFiles(owner, repo, number) {
  const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`);
  return (Array.isArray(data) ? data : []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    previous_filename: f.previous_filename,
    patch: f.patch || "",
  }));
}

export async function getPullDiff(owner, repo, number) {
  const { text } = await githubRequest(`/repos/${owner}/${repo}/pulls/${number}`, {
    accept: "application/vnd.github.diff",
    raw: true,
  });
  return text;
}

export async function getPullComments(owner, repo, number) {
  const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`);
  return (Array.isArray(data) ? data : []).map((c) => ({
    id: c.id,
    user: c.user?.login,
    path: c.path,
    line: c.line || c.original_line,
    original_line: c.original_line,
    side: c.side,
    commit_id: c.commit_id,
    original_commit_id: c.original_commit_id,
    body: c.body,
    created_at: c.created_at,
    html_url: c.html_url,
    in_reply_to_id: c.in_reply_to_id,
  }));
}

export async function getPullReviews(owner, repo, number) {
  const data = await githubRequest(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`);
  return (Array.isArray(data) ? data : []).map((r) => ({
    id: r.id,
    user: r.user?.login,
    state: r.state,
    body: r.body,
    commit_id: r.commit_id,
    submitted_at: r.submitted_at,
    html_url: r.html_url,
  }));
}

export async function getCheckRuns(owner, repo, sha) {
  const data = await githubRequest(`/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs`);
  return (data.check_runs || []).map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    html_url: r.html_url,
    started_at: r.started_at,
    completed_at: r.completed_at,
    output_title: r.output?.title || "",
    output_summary: r.output?.summary || "",
    sha,
  }));
}

export async function listIssues(owner, repo, { state = "open", limit = 20 } = {}) {
  const data = await githubRequest(
    `/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${Math.min(limit, 100)}`,
  );
  return (Array.isArray(data) ? data : [])
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user?.login,
      html_url: i.html_url,
      labels: (i.labels || []).map((l) => l.name || l),
    }));
}

export async function getIssue(owner, repo, number) {
  const i = await githubRequest(`/repos/${owner}/${repo}/issues/${number}`);
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    user: i.user?.login,
    body: i.body || "",
    html_url: i.html_url,
    pull_request: i.pull_request?.html_url || null,
    labels: (i.labels || []).map((l) => l.name || l),
  };
}

export async function getIssueComments(owner, repo, number) {
  const data = await githubRequest(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`);
  return (Array.isArray(data) ? data : []).map((c) => ({
    id: c.id,
    user: c.user?.login,
    body: c.body,
    created_at: c.created_at,
    html_url: c.html_url,
  }));
}

export async function listActions(owner, repo, { limit = 20 } = {}) {
  const data = await githubRequest(`/repos/${owner}/${repo}/actions/runs?per_page=${Math.min(limit, 50)}`);
  return (data.workflow_runs || []).map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    html_url: r.html_url,
    head_sha: r.head_sha,
    head_branch: r.head_branch,
    event: r.event,
    pull_requests: (r.pull_requests || []).map((p) => p.number),
  }));
}

export async function searchCode(owner, repo, query, { path, limit = 20 } = {}) {
  const parts = [`${query}`, `repo:${owner}/${repo}`];
  if (path) parts.push(`path:${path}`);
  try {
    const data = await githubRequest(
      `/search/code?q=${encodeURIComponent(parts.join(" "))}&per_page=${Math.min(limit, 50)}`,
      { accept: "application/vnd.github.text-match+json" },
    );
    return {
      source: "github_search",
      incomplete: Boolean(data.incomplete_results),
      items: (data.items || []).map((it) => ({
        path: it.path,
        sha: it.sha,
        html_url: it.html_url,
        matches: (it.text_matches || []).flatMap((m) =>
          (m.matches || []).map((hit) => ({ fragment: m.fragment, matched_text: hit.text })),
        ),
      })),
    };
  } catch (err) {
    if (err.status === 403 || err.status === 422) return { source: "github_search", unavailable: true, items: [] };
    throw wrapIntelError(err, { repository: `${owner}/${repo}` });
  }
}

export async function blameGraphql(owner, repo, sha, path) {
  const query = `query($owner:String!,$name:String!,$sha:GitObjectID!,$path:String!){
    repository(owner:$owner,name:$name){
      object(oid:$sha){ ... on Commit { blame(path:$path){ ranges { startingLine endingLine commit { oid message authoredDate author { name } } } } } }
    }}`;
  try {
    const data = await githubRequest("/graphql", {
      method: "POST",
      body: { query, variables: { owner, name: repo, sha, path } },
    });
    const ranges = data.data?.repository?.object?.blame?.ranges;
    if (!ranges) return { available: false, ranges: [], note: data.errors?.[0]?.message || "blame unavailable" };
    return {
      available: true,
      ranges: ranges.map((r) => ({
        line_start: r.startingLine,
        line_end: r.endingLine,
        commit: r.commit?.oid,
        message: r.commit?.message,
        author: r.commit?.author?.name,
        date: r.commit?.authoredDate,
      })),
    };
  } catch (err) {
    return { available: false, ranges: [], note: err.message };
  }
}

function slimPr(p, full = false) {
  const base = {
    number: p.number,
    title: p.title,
    state: p.state,
    user: p.user?.login,
    html_url: p.html_url,
    base: p.base?.ref,
    head: p.head?.ref,
    head_sha: p.head?.sha,
    draft: Boolean(p.draft),
    merged: Boolean(p.merged),
    mergeable_state: p.mergeable_state,
  };
  if (full) {
    base.body = p.body || "";
    base.commits = p.commits;
    base.additions = p.additions;
    base.deletions = p.deletions;
    base.changed_files = p.changed_files;
  }
  return base;
}
