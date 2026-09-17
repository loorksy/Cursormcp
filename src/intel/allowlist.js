import { loadConfig } from "../config.js";
import { parseOwnerRepo, parseGithubRepo } from "../github.js";
import { listProjects } from "../memory.js";
import { listRepositories } from "../cursor-api.js";
import { IntelError } from "./errors.js";
import { gitOrigin } from "./git-local.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let cursorRepoCache = { at: 0, items: [] };
let localOriginCache = { at: 0, full: "" };

function addParsed(set, raw) {
  const parsed = parseOwnerRepo(raw) || parseGithubRepo(raw);
  if (parsed) set.add(`${parsed.owner}/${parsed.repo}`.toLowerCase());
}

export function localRepoMap() {
  const map = new Map();
  const cfg = loadConfig();
  for (const entry of cfg.intelLocalRepos) {
    const idx = entry.indexOf(":");
    if (idx < 1) continue;
    const repo = entry.slice(0, idx);
    const root = entry.slice(idx + 1);
    const parsed = parseOwnerRepo(repo);
    if (parsed && root) map.set(`${parsed.owner}/${parsed.repo}`.toLowerCase(), resolve(root));
  }
  if (cfg.intelLocalRoot && existsSync(cfg.intelLocalRoot)) {
    map.set("__local_root__", resolve(cfg.intelLocalRoot));
  }
  return map;
}

async function originFullName() {
  const root = loadConfig().intelLocalRoot;
  if (!root || !existsSync(root)) return "";
  const now = Date.now();
  if (now - localOriginCache.at < 30_000) return localOriginCache.full;
  try {
    const url = await gitOrigin(root);
    const parsed = parseGithubRepo(url) || parseOwnerRepo(url);
    localOriginCache = { at: now, full: parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : "" };
  } catch {
    localOriginCache = { at: now, full: "" };
  }
  return localOriginCache.full;
}

export async function allowedRepoSet() {
  const set = new Set();
  const cfg = loadConfig();
  const exclusive = cfg.githubAllowedRepos.length > 0;
  for (const r of cfg.githubAllowedRepos) addParsed(set, r);
  if (!exclusive) {
    try {
      for (const p of listProjects()) addParsed(set, p.repo_url);
    } catch {
      // db may not be ready in isolated unit tests
    }
    if (process.env.INTEL_ALLOW_CURSOR_REPOS !== "false") {
      const now = Date.now();
      if (now - cursorRepoCache.at > 60_000) {
        try {
          const listed = await listRepositories();
          cursorRepoCache = { at: now, items: listed.items || [] };
        } catch {
          // Cursor key may be unset
        }
      }
      for (const item of cursorRepoCache.items) addParsed(set, item.url || item);
    }
  }
  for (const key of localRepoMap().keys()) {
    if (key !== "__local_root__") set.add(key);
  }
  const origin = await originFullName();
  if (origin) set.add(origin);
  return set;
}

export async function assertRepoAllowed(owner, repo) {
  const full = `${owner}/${repo}`.toLowerCase();
  const allowed = await allowedRepoSet();
  if (allowed.has(full)) return true;
  if (allowed.size === 0) {
    throw new IntelError("FORBIDDEN", "no repositories are allowlisted for intelligence tools", {
      repository: full,
      status: 403,
    });
  }
  throw new IntelError("FORBIDDEN", `repository ${full} is not in the MCP allowlist`, {
    repository: full,
    status: 403,
  });
}

export async function localRootFor(owner, repo) {
  const map = localRepoMap();
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = map.get(key);
  if (hit && existsSync(hit)) return hit;
  const fallback = map.get("__local_root__");
  if (fallback && existsSync(fallback)) {
    const origin = await originFullName();
    if (origin === key) return fallback;
  }
  return "";
}
