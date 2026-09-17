import { IntelError } from "./errors.js";
import { openRef } from "./repo.js";
import { clipBytes } from "./paginate.js";
import { redactSecrets } from "./redact.js";
import { loadConfig } from "../config.js";
import {
  gitStatus,
  gitLog,
  gitDiff,
  gitChanged,
  gitBlame,
  gitHeadSha,
} from "./git-local.js";
import {
  listBranches,
  listCommits,
  getCommit,
  compare,
  getDiff,
  blameGraphql,
  getRepository,
} from "./github-api.js";

function refs(ctx, extra = {}) {
  return { repository: ctx.repository, commit: ctx.commit.sha, ref: ctx.ref, ...extra };
}

function githubSha(ctx, fallback) {
  if (ctx.useFilesystem || ctx.commit?.sha === "worktree") return fallback;
  return ctx.commit.sha;
}

export async function gitStatusIntel(args) {
  const ctx = await openRef(args.repository, args.ref);
  if (ctx.useLocal) {
    const items = await gitStatus(ctx.local);
    return { source: "local_worktree", repository: ctx.repository, commit: ctx.commit.sha, items, references: refs(ctx) };
  }
  if (ctx.useFilesystem) {
    return {
      source: "filesystem",
      note: "mapped checkout is not a git repository; porcelain status is unavailable",
      repository: ctx.repository,
      commit: ctx.commit.sha,
      items: [],
      references: refs(ctx),
    };
  }
  const meta = await getRepository(ctx.owner, ctx.repo);
  const base = args.base || meta.default_branch || "main";
  const cmp = await compare(ctx.owner, ctx.repo, base, ctx.commit.sha);
  return {
    source: "github_compare",
    note: "no working tree on the MCP host; status is compare(default_branch...ref)",
    repository: ctx.repository,
    base,
    head: ctx.commit.sha,
    items: (cmp.files || []).map((f) => ({
      path: f.filename,
      status: f.status,
      previous_filename: f.previous_filename,
      insertions: f.additions,
      deletions: f.deletions,
    })),
    references: refs(ctx, { base }),
  };
}

export async function gitBranchesIntel(args) {
  const ctx = await openRef(args.repository, args.ref);
  const items = await listBranches(ctx.owner, ctx.repo, { limit: args.limit || 50 });
  return { repository: ctx.repository, items, references: refs(ctx) };
}

export async function gitCommitsIntel(args) {
  const ctx = await openRef(args.repository, args.ref);
  if (ctx.useLocal && args.prefer_local !== false) {
    const items = await gitLog(ctx.local, { ref: args.ref || ctx.commit.sha, path: args.path || "", limit: args.limit || 30 });
    return { source: "local", repository: ctx.repository, items, references: refs(ctx) };
  }
  const items = await listCommits(ctx.owner, ctx.repo, {
    sha: args.ref || githubSha(ctx, undefined),
    path: args.path,
    limit: args.limit || 30,
  });
  return { source: "github", repository: ctx.repository, items, references: refs(ctx) };
}

export async function gitCommitGetIntel(args) {
  const ctx = await openRef(args.repository, args.sha || args.ref);
  const data = await getCommit(ctx.owner, ctx.repo, args.sha || githubSha(ctx, args.ref) || "HEAD");
  return { ...data, repository: ctx.repository, references: refs(ctx, { commit: data.sha }) };
}

export async function gitDiffIntel(args) {
  const ctx = await openRef(args.repository, args.head || args.ref);
  const base = args.base;
  const head = args.head || githubSha(ctx, args.ref);
  if (!base) throw new IntelError("INVALID_INPUT", "base is required for git_diff");
  let text;
  if (ctx.useLocal) {
    text = await gitDiff(ctx.local, base, head, args.path || "");
  } else {
    text = await getDiff(ctx.owner, ctx.repo, base, head);
  }
  const red = redactSecrets(text, { path: args.path || "" });
  const clipped = clipBytes(red.text, loadConfig().intelMaxResponseBytes);
  return {
    repository: ctx.repository,
    base,
    head,
    path: args.path || null,
    truncated: clipped.truncated,
    redacted: red.redacted,
    diff: clipped.text,
    references: { repository: ctx.repository, base, head, path: args.path },
  };
}

export async function gitDiffBetweenIntel(args) {
  return gitDiffIntel(args);
}

export async function gitChangedFilesIntel(args) {
  const ctx = await openRef(args.repository, args.head || args.ref);
  const base = args.base;
  const head = args.head || githubSha(ctx, args.ref);
  if (!base) throw new IntelError("INVALID_INPUT", "base is required");
  let files;
  if (ctx.useLocal) {
    files = await gitChanged(ctx.local, base, head);
  } else {
    const cmp = await compare(ctx.owner, ctx.repo, base, head);
    files = cmp.files || [];
  }
  const grouped = { modified: [], added: [], deleted: [], renamed: [] };
  for (const f of files) {
    const status = f.status || "modified";
    const key = status.startsWith("add") ? "added" : status.startsWith("del") ? "deleted" : status.startsWith("ren") ? "renamed" : "modified";
    grouped[key].push(f);
  }
  return {
    repository: ctx.repository,
    base,
    head,
    ...grouped,
    files,
    references: { repository: ctx.repository, base, head, commit: ctx.commit.sha },
  };
}

export async function gitFileHistoryIntel(args) {
  if (!args.path) throw new IntelError("INVALID_INPUT", "path is required");
  return gitCommitsIntel({ ...args, path: args.path });
}

export async function gitBlameIntel(args) {
  const ctx = await openRef(args.repository, args.ref);
  if (!args.path) throw new IntelError("INVALID_INPUT", "path is required");
  if (ctx.useFilesystem) {
    return {
      source: "filesystem",
      note: "mapped checkout is not a git repository; blame requires a git worktree or a pinned commit SHA",
      repository: ctx.repository,
      path: args.path,
      commit: ctx.commit.sha,
      ranges: [],
      references: refs(ctx, { path: args.path }),
    };
  }
  if (ctx.useLocal) {
    const ranges = await gitBlame(ctx.local, ctx.commit.sha, args.path);
    return {
      source: "local",
      repository: ctx.repository,
      path: args.path,
      commit: ctx.commit.sha,
      ranges: ranges.slice(0, 400).map((r) => ({
        line_start: r.line,
        line_end: r.line,
        commit: r.commit,
        author: r.author,
        date: r.date,
        text: redactSecrets(r.text, { path: args.path }).text,
      })),
      references: refs(ctx, { path: args.path }),
    };
  }
  const blamed = await blameGraphql(ctx.owner, ctx.repo, ctx.commit.sha, args.path);
  if (!blamed.available) {
    const history = await listCommits(ctx.owner, ctx.repo, { sha: ctx.commit.sha, path: args.path, limit: 20 });
    return {
      source: "commit_history_fallback",
      note: blamed.note || "GitHub REST has no blame; GraphQL unavailable. Returning path history.",
      repository: ctx.repository,
      path: args.path,
      commit: ctx.commit.sha,
      ranges: [],
      history,
      references: refs(ctx, { path: args.path }),
    };
  }
  return {
    source: "github_graphql",
    repository: ctx.repository,
    path: args.path,
    commit: ctx.commit.sha,
    ranges: blamed.ranges,
    references: refs(ctx, { path: args.path }),
  };
}

export async function localHeadSha(cwd) {
  return gitHeadSha(cwd, "HEAD");
}
