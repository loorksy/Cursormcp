import { loadConfig } from "./config.js";
import { log } from "./lib.js";

export function githubApiBase() {
  return (process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/$/, "");
}

export function parseGithubRepo(url) {
  const m = String(url || "").match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = String(m[2]).replace(/\.git$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

export function parseOwnerRepo(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const fromUrl = parseGithubRepo(raw);
  if (fromUrl) return fromUrl;
  const m = raw.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

export function parsePrUrl(url) {
  const m = String(url || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(m[1]) || !/^[A-Za-z0-9._-]+$/.test(m[2])) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]), url };
}

function assertGithubPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("://") || path.includes("@") || path.includes("\\")) {
    const err = new Error("invalid GitHub API path");
    err.code = "SSRF_REJECTED";
    throw err;
  }
}

export async function githubRequest(path, { method = "GET", body, accept, raw = false, timeoutMs = 25000 } = {}) {
  assertGithubPath(path);
  const token = loadConfig().githubToken;
  const headers = {
    Accept: accept || "application/vnd.github+json",
    "User-Agent": "mcp-cursor-bridge",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(githubApiBase() + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (raw) {
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`GitHub ${res.status}`);
        err.status = res.status;
        err.code = res.status === 404 ? "NOT_FOUND" : "GITHUB_ERROR";
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      return { text, status: res.status };
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message || `GitHub ${res.status}`);
      err.status = res.status;
      err.body = json;
      err.code = res.status === 404 ? "NOT_FOUND" : res.status === 403 ? "GITHUB_FORBIDDEN" : "GITHUB_ERROR";
      err.retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function githubFetch(path, opts) {
  return githubRequest(path, opts);
}

export async function inspectPullRequest(prUrl) {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return { exists: false, note: "رابط PR غير صالح" };
  try {
    const data = await githubFetch(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`);
    let checksNote = "";
    try {
      const checks = await githubFetch(
        `/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(data.head.sha)}/check-runs`,
      );
      const runs = checks.check_runs || [];
      const failed = runs.filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
      const pending = runs.filter((r) => !r.conclusion || r.status !== "completed");
      checksNote = `checks total=${runs.length} failed=${failed.length} pending=${pending.length}`;
      return {
        exists: true,
        checked: true,
        merged: Boolean(data.merged),
        state: data.state,
        htmlUrl: data.html_url,
        headSha: data.head?.sha,
        failedChecks: failed.length,
        pendingChecks: pending.length,
        note: `PR ${data.state}${data.merged ? ", merged" : ""}. ${checksNote}`,
        raw: { state: data.state, merged: data.merged },
      };
    } catch {
      return {
        exists: true,
        checked: true,
        merged: Boolean(data.merged),
        state: data.state,
        htmlUrl: data.html_url,
        failedChecks: 0,
        pendingChecks: 0,
        note: `PR ${data.state}${data.merged ? ", merged" : ""}. تعذر قراءة check-runs.`,
      };
    }
  } catch (err) {
    if (err.status === 404) return { exists: false, checked: true, note: "PR غير موجود على GitHub" };
    log("error", "github_pr_inspect", { error: err.message });
    return { exists: false, checked: false, note: `تعذر التحقق من GitHub: ${err.message}` };
  }
}

export async function getPullRequest(prUrl) {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) throw new Error("invalid PR url");
  return githubFetch(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`);
}

export async function createPullRequest({ repo_url, title, head, base, body }) {
  const parsed = parseGithubRepo(repo_url);
  if (!parsed) throw new Error("invalid repository url");
  if (!loadConfig().githubToken) {
    const err = new Error("GITHUB_TOKEN is required to create a pull request");
    err.code = "NO_GITHUB_TOKEN";
    throw err;
  }
  return githubFetch(`/repos/${parsed.owner}/${parsed.repo}/pulls`, {
    method: "POST",
    body: { title, head, base: base || "main", body: body || "" },
  });
}

export async function analyzeRepository(repo_url) {
  const parsed = parseGithubRepo(repo_url);
  if (!parsed) return { languages: {}, description: "", private: false, note: "not a github url" };
  try {
    const repo = await githubFetch(`/repos/${parsed.owner}/${parsed.repo}`);
    const languages = await githubFetch(`/repos/${parsed.owner}/${parsed.repo}/languages`);
    return {
      fullName: repo.full_name,
      description: repo.description || "",
      defaultBranch: repo.default_branch,
      languages,
      private: Boolean(repo.private),
      htmlUrl: repo.html_url,
    };
  } catch (err) {
    return { languages: {}, description: "", note: err.message };
  }
}
