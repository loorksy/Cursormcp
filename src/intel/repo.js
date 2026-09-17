import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { loadConfig } from "../config.js";
import { IntelError } from "./errors.js";
import { localRootFor } from "./allowlist.js";
import {
  resolveRepo,
  getRepository,
  resolveCommit,
  getTree,
  getContents,
  getBlob,
  searchCode,
} from "./github-api.js";
import {
  gitOk,
  gitHeadSha,
  gitLsTree,
  gitShowFile,
} from "./git-local.js";
import { redactSecrets } from "./redact.js";
import {
  paginate,
  clipBytes,
  numbered,
  languageOf,
  isProbablyBinary,
  looksGeneratedPath,
  safeRelPath,
  decodeCursor,
  encodeCursor,
} from "./paginate.js";

function isPinnedSha(ref) {
  return typeof ref === "string" && /^[0-9a-f]{7,40}$/i.test(ref.trim());
}

function containedAbs(root, rel) {
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new IntelError("PATH_TRAVERSAL", "path traversal rejected", { path: rel });
  }
  return abs;
}

export async function openRef(repository, ref) {
  const { owner, repo } = await resolveRepo(repository);
  const local = await localRootFor(owner, repo);
  const useLocal = Boolean(local && (await gitOk(local).catch(() => false)));
  const useFilesystem = Boolean(local && existsSync(local) && !useLocal && !isPinnedSha(ref));
  let commit;
  if (useLocal) {
    try {
      const sha = await gitHeadSha(local, ref || "HEAD");
      commit = { sha, ref: ref || "HEAD", source: "local" };
    } catch {
      commit = await resolveCommit(owner, repo, ref);
      commit.source = "github";
    }
  } else if (useFilesystem) {
    commit = { sha: "worktree", ref: ref || "worktree", source: "filesystem" };
  } else {
    commit = await resolveCommit(owner, repo, ref);
    commit.source = "github";
  }
  return {
    owner,
    repo,
    repository: `${owner}/${repo}`,
    local,
    useLocal,
    useFilesystem,
    commit,
    ref: commit.ref || ref || commit.sha,
  };
}

async function walkFilesystem(root, prefix = "", state = { n: 0, truncated: false, cap: 2000 }) {
  if (state.n >= state.cap) {
    state.truncated = true;
    return [];
  }
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (state.n >= state.cap) {
      state.truncated = true;
      break;
    }
    if (e.isSymbolicLink() || e.name === ".git" || looksGeneratedPath(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (looksGeneratedPath(rel)) continue;
    if (e.isDirectory()) {
      state.n += 1;
      out.push({ path: rel, type: "tree", size: 0, sha: "" });
      out.push(...(await walkFilesystem(root, rel, state)));
    } else if (e.isFile()) {
      state.n += 1;
      const s = await stat(join(root, rel));
      out.push({ path: rel, type: "blob", size: s.size, sha: "" });
    }
  }
  return out;
}

async function loadTree(ctx, { recursive = true, path = "" } = {}) {
  if (ctx.useLocal) {
    const tree = await gitLsTree(ctx.local, ctx.commit.sha, { recursive, path });
    return { sha: ctx.commit.sha, truncated: false, tree };
  }
  if (ctx.useFilesystem) {
    const state = { n: 0, truncated: false, cap: Math.max(500, loadConfig().intelMaxTreeItems * 4) };
    let tree = await walkFilesystem(ctx.local, "", state);
    if (path) {
      const prefix = path.replace(/\/$/, "");
      tree = tree.filter((e) => e.path === prefix || e.path.startsWith(prefix + "/"));
    }
    return { sha: "worktree", truncated: state.truncated, tree };
  }
  const data = await getTree(ctx.owner, ctx.repo, ctx.commit.sha, { recursive });
  if (path) {
    const prefix = path.replace(/\/$/, "");
    data.tree = data.tree.filter((e) => e.path === prefix || e.path.startsWith(prefix + "/"));
  }
  return data;
}

function parseGitignore(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function gitignoreMatch(path, rules) {
  for (const rule of rules) {
    const neg = rule.startsWith("!");
    const body = neg ? rule.slice(1) : rule;
    const dirOnly = body.endsWith("/");
    const pat = body.replace(/\/$/, "");
    const re = globToRegExp(pat);
    if (re.test(path) || re.test(path.split("/").pop())) {
      if (!neg && dirOnly && !path.includes("/")) continue;
      if (neg) return false;
      return true;
    }
  }
  return looksGeneratedPath(path);
}

function globToRegExp(glob) {
  let g = glob.replace(/^\//, "");
  const esc = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ":::GLOBSTAR:::")
    .replace(/\*/g, "[^/]*")
    .replace(/:::GLOBSTAR:::/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`(^|/)${esc}($|/)`);
}

async function ignoreRules(ctx) {
  try {
    const file = await readRaw(ctx, ".gitignore");
    if (file.binary) return [];
    return parseGitignore(file.text);
  } catch {
    return [];
  }
}

async function readRaw(ctx, path) {
  const rel = safeRelPath(path);
  if (ctx.useLocal) {
    const buf = await gitShowFile(ctx.local, ctx.commit.sha, rel);
    return { buf, binary: isProbablyBinary(rel, buf), text: buf.toString("utf8") };
  }
  if (ctx.useFilesystem) {
    const abs = containedAbs(ctx.local, rel);
    if (!existsSync(abs)) {
      throw new IntelError("FILE_NOT_FOUND", "file not found", { repository: ctx.repository, path: rel });
    }
    const st = await stat(abs);
    if (st.isDirectory()) {
      throw new IntelError("IS_DIRECTORY", "path is a directory; use repo_directory_list", {
        repository: ctx.repository,
        path: rel,
      });
    }
    const buf = await readFile(abs);
    return { buf, binary: isProbablyBinary(rel, buf), text: buf.toString("utf8") };
  }
  let data;
  try {
    data = await getContents(ctx.owner, ctx.repo, rel, ctx.commit.sha);
  } catch (err) {
    throw new IntelError("FILE_NOT_FOUND", err.message || "file not found", {
      repository: ctx.repository,
      path: rel,
    });
  }
  if (Array.isArray(data)) {
    throw new IntelError("IS_DIRECTORY", "path is a directory; use repo_directory_list", {
      repository: ctx.repository,
      path: rel,
    });
  }
  let buf;
  if (data.encoding === "base64" && data.content) {
    buf = Buffer.from(data.content.replace(/\n/g, ""), "base64");
  } else if (data.sha) {
    buf = await getBlob(ctx.owner, ctx.repo, data.sha);
  } else {
    buf = Buffer.from(String(data.content || ""), "utf8");
  }
  return { buf, binary: isProbablyBinary(rel, buf) || data.encoding === "none", text: buf.toString("utf8"), size: data.size };
}

export async function repoGet(args) {
  const ctx = await openRef(args.repository, args.ref);
  const meta = await getRepository(ctx.owner, ctx.repo).catch(() => ({
    full_name: ctx.repository,
    default_branch: ctx.ref,
  }));
  return {
    repository: ctx.repository,
    ref: ctx.ref,
    commit: ctx.commit.sha,
    source: ctx.commit.source,
    default_branch: meta.default_branch,
    description: meta.description || "",
    html_url: meta.html_url,
    private: meta.private,
    references: { repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref },
  };
}

export async function repoTree(args) {
  const ctx = await openRef(args.repository, args.ref);
  const data = await loadTree(ctx, { recursive: true, path: args.path || "" });
  const rules = await ignoreRules(ctx);
  let entries = data.tree.filter((e) => args.include_ignored || !gitignoreMatch(e.path, rules));
  if (args.path) {
    const prefix = safeRelPath(args.path).replace(/\/$/, "");
    entries = entries.filter((e) => e.path === prefix || e.path.startsWith(prefix + "/"));
  }
  if (args.recursive === false) {
    const prefix = args.path ? safeRelPath(args.path).replace(/\/$/, "") : "";
    entries = entries.filter((e) => {
      if (prefix) {
        if (e.path === prefix) return false;
        if (!e.path.startsWith(prefix + "/")) return false;
        return !e.path.slice(prefix.length + 1).includes("/");
      }
      return !e.path.includes("/");
    });
  }
  const page = paginate(entries, {
    limit: args.limit,
    cursor: args.cursor,
    max: loadConfig().intelMaxTreeItems,
  });
  return {
    repository: ctx.repository,
    ref: ctx.ref,
    commit: ctx.commit.sha,
    source: ctx.commit.source,
    truncated_upstream: data.truncated,
    ...page,
    items: page.items.map((e) => ({
      path: e.path,
      type: e.type === "tree" || e.type === "dir" ? "dir" : "file",
      size: e.size || 0,
      sha: e.sha,
      language: languageOf(e.path),
    })),
    references: { repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref },
  };
}

export async function repoDirectoryList(args) {
  const path = args.path ? safeRelPath(args.path) : "";
  const tree = await repoTree({ ...args, recursive: false, path });
  const prefix = path ? path.replace(/\/$/, "") + "/" : "";
  const items = tree.items
    .map((e) => {
      const rel = prefix && e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path;
      if (!rel || rel.includes("/")) return null;
      return { ...e, name: rel };
    })
    .filter(Boolean);
  return { ...tree, items, path: path || "/" };
}

export async function repoFileRead(args) {
  const ctx = await openRef(args.repository, args.ref);
  const path = safeRelPath(args.path);
  const raw = await readRaw(ctx, path);
  if (raw.binary) {
    return {
      path,
      repository: ctx.repository,
      ref: ctx.ref,
      commit: ctx.commit.sha,
      source: ctx.commit.source,
      language: languageOf(path),
      size: raw.buf.length,
      binary: true,
      content: null,
      note: "binary file omitted",
      references: { path, repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref },
    };
  }
  const max = Math.min(Number(args.max_bytes) || loadConfig().intelMaxFileBytes, loadConfig().intelMaxFileBytes);
  let text = raw.text;
  const start = Number(args.line_start) || 1;
  const end = Number(args.line_end) || Infinity;
  const numberedLines = numbered(text, start, end);
  const joined = numberedLines.lines.map((l) => l.text).join("\n");
  const clipped = clipBytes(joined, max);
  const red = redactSecrets(clipped.text, { path });
  return {
    path,
    repository: ctx.repository,
    ref: ctx.ref,
    commit: ctx.commit.sha,
    source: ctx.commit.source,
    language: languageOf(path),
    size: raw.buf.length,
    binary: false,
    truncated: clipped.truncated,
    redacted: red.redacted,
    redacted_kinds: red.kinds,
    content: red.text,
    lines: numbered(red.text, numberedLines.line_start, numberedLines.line_end).lines,
    line_start: numberedLines.line_start,
    line_end: numberedLines.line_end,
    total_lines: numberedLines.total_lines,
    references: {
      path,
      repository: ctx.repository,
      commit: ctx.commit.sha,
      ref: ctx.ref,
      line_start: numberedLines.line_start,
      line_end: numberedLines.line_end,
    },
  };
}

export async function repoFileBatchRead(args) {
  const paths = args.paths || [];
  const maxFiles = Math.min(paths.length, args.max_files || loadConfig().intelMaxBatchFiles);
  const items = [];
  let bytes = 0;
  const cap = args.max_bytes || loadConfig().intelMaxResponseBytes;
  for (let i = 0; i < maxFiles; i += 1) {
    const file = await repoFileRead({ ...args, path: paths[i], max_bytes: Math.min(loadConfig().intelMaxFileBytes, cap - bytes) });
    const add = Buffer.byteLength(file.content || "", "utf8");
    if (bytes + add > cap && items.length) break;
    items.push(file);
    bytes += add;
  }
  return {
    items,
    has_more: items.length < paths.length,
    next_cursor: items.length < paths.length ? String(items.length) : null,
    bytes,
  };
}

export async function repoFileMetadata(args) {
  const ctx = await openRef(args.repository, args.ref);
  const path = safeRelPath(args.path);
  const tree = await loadTree(ctx, { recursive: true });
  const hit = tree.tree.find((e) => e.path === path);
  if (!hit) throw new IntelError("FILE_NOT_FOUND", "path not in tree", { repository: ctx.repository, path });
  return {
    path,
    type: hit.type === "tree" ? "dir" : "file",
    size: hit.size || 0,
    sha: hit.sha,
    language: languageOf(path),
    generated: looksGeneratedPath(path),
    repository: ctx.repository,
    commit: ctx.commit.sha,
    ref: ctx.ref,
    references: { path, repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref },
  };
}

export async function repoGlob(args) {
  const ctx = await openRef(args.repository, args.ref);
  const tree = await loadTree(ctx, { recursive: true, path: args.path || "" });
  const re = globToRegExp(args.pattern || "*");
  const matches = tree.tree.filter((e) => e.type !== "tree" && re.test(e.path) && !looksGeneratedPath(e.path));
  const page = paginate(matches, { limit: args.limit, cursor: args.cursor, max: loadConfig().intelMaxTreeItems });
  return {
    repository: ctx.repository,
    commit: ctx.commit.sha,
    ref: ctx.ref,
    ...page,
    items: page.items.map((e) => ({ path: e.path, size: e.size, sha: e.sha, language: languageOf(e.path) })),
  };
}

export async function repoSearch(args) {
  const ctx = await openRef(args.repository, args.ref);
  const query = String(args.query || "");
  if (!query) throw new IntelError("INVALID_INPUT", "query is required");
  const pathFilter = args.path ? safeRelPath(args.path) : "";
  const caseSensitive = Boolean(args.case_sensitive);
  let regex;
  try {
    regex = args.regex ? new RegExp(query, caseSensitive ? "g" : "gi") : null;
  } catch {
    throw new IntelError("INVALID_INPUT", "invalid regular expression");
  }
  if (!args.regex && !pathFilter) {
    const remote = await searchCode(ctx.owner, ctx.repo, query, { path: args.path, limit: args.limit || 20 });
    if (!remote.unavailable && remote.items?.length) {
      return {
        repository: ctx.repository,
        commit: ctx.commit.sha,
        ref: ctx.ref,
        source: remote.source,
        has_more: false,
        next_cursor: null,
        items: remote.items.flatMap((it) =>
          (it.matches.length ? it.matches : [{ fragment: "", matched_text: query }]).map((m) => ({
            file: it.path,
            line: null,
            matched_text: m.matched_text,
            context: m.fragment,
            references: { path: it.path, repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref },
          })),
        ),
      };
    }
  }
  const tree = await loadTree(ctx, { recursive: true, path: pathFilter });
  const rules = await ignoreRules(ctx);
  const files = tree.tree.filter((e) => {
    if (e.type === "tree") return false;
    if (looksGeneratedPath(e.path) || gitignoreMatch(e.path, rules)) return false;
    if (args.language && languageOf(e.path) !== String(args.language).toLowerCase()) return false;
    if (isProbablyBinary(e.path)) return false;
    return true;
  });
  const { o } = decodeCursor(args.cursor);
  const limit = Math.min(Number(args.limit) || loadConfig().intelMaxSearch, loadConfig().intelMaxSearch);
  const hits = [];
  let scanned = 0;
  let bytes = 0;
  const cap = loadConfig().intelMaxResponseBytes;
  const needle = caseSensitive ? query : query.toLowerCase();
  for (let i = o; i < files.length; i += 1) {
    scanned = i + 1;
    let raw;
    try {
      raw = await readRaw(ctx, files[i].path);
    } catch {
      continue;
    }
    if (raw.binary) continue;
    bytes += raw.buf.length;
    const lines = raw.text.split("\n");
    for (let n = 0; n < lines.length; n += 1) {
      const line = lines[n];
      let matched = false;
      let matched_text = query;
      if (regex) {
        regex.lastIndex = 0;
        const m = regex.exec(line);
        if (m) {
          matched = true;
          matched_text = m[0];
        }
      } else {
        const hay = caseSensitive ? line : line.toLowerCase();
        matched = hay.includes(needle);
      }
      if (!matched) continue;
      const red = redactSecrets(line, { path: files[i].path });
      const prev = n > 0 ? redactSecrets(lines[n - 1], { path: files[i].path }).text : "";
      const next = n + 1 < lines.length ? redactSecrets(lines[n + 1], { path: files[i].path }).text : "";
      hits.push({
        file: files[i].path,
        line: n + 1,
        matched_text,
        context: [prev, red.text, next].filter((x, idx) => idx === 1 || x).join("\n"),
        references: {
          path: files[i].path,
          repository: ctx.repository,
          commit: ctx.commit.sha,
          ref: ctx.ref,
          line_start: n + 1,
          line_end: n + 1,
        },
      });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit || bytes > cap) break;
  }
  const has_more = scanned < files.length && hits.length >= limit;
  return {
    repository: ctx.repository,
    commit: ctx.commit.sha,
    ref: ctx.ref,
    source: "tree_scan",
    scanned_files: scanned - o,
    has_more,
    next_cursor: has_more ? encodeCursor({ o: scanned }) : null,
    items: hits,
  };
}
