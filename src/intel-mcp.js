import { z } from "zod";
import { currentActor } from "./memory.js";
import { currentContext, withContext } from "./context.js";
import { newId } from "./config.js";
import { logRequest } from "./lib.js";
import { IntelError } from "./intel/errors.js";
import { redactValue } from "./intel/redact.js";
import { accessLog } from "./intel/cache.js";
import {
  repoGet,
  repoTree,
  repoDirectoryList,
  repoFileRead,
  repoFileBatchRead,
  repoFileMetadata,
  repoGlob,
  repoSearch,
} from "./intel/repo.js";
import {
  gitStatusIntel,
  gitBranchesIntel,
  gitCommitsIntel,
  gitCommitGetIntel,
  gitDiffIntel,
  gitDiffBetweenIntel,
  gitChangedFilesIntel,
  gitFileHistoryIntel,
  gitBlameIntel,
} from "./intel/git-intel.js";
import {
  resolveRepo,
  getRepository,
  listBranches,
  listCommits,
  listPulls,
  getPull,
  getPullFiles,
  getPullDiff,
  getPullComments,
  getPullReviews,
  getCheckRuns,
  listIssues,
  getIssue,
  getIssueComments,
  listActions,
} from "./intel/github-api.js";
import { architectureMap, projectSnapshot, projectAudit, prReviewContext } from "./intel/snapshot.js";
import { clipBytes } from "./intel/paginate.js";
import { loadConfig } from "./config.js";
import { redactSecrets } from "./intel/redact.js";

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(redactValue(data), null, 2) }] };
}

function errorResult(err) {
  const wrapped = err instanceof IntelError ? err : new IntelError(err.code || "INTEL_ERROR", err.message, err);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(wrapped.toJSON(), null, 2) }],
  };
}

const repoIn = {
  repository: z
    .string()
    .describe("GitHub repository as owner/repo or https://github.com/owner/repo. Must be allowlisted."),
  ref: z.string().describe("Branch, tag, or commit SHA. Defaults to the repository default branch.").optional(),
};

function wrap(tool, fn) {
  return async (args = {}) => {
    const requestId = currentContext().correlationId || newId("intel");
    return withContext({ correlationId: requestId }, async () => {
      try {
        const data = await fn(args);
        accessLog({
          actor: currentActor(),
          tool,
          repository: args.repository || "",
          path: args.path || "",
          ref: args.ref || args.sha || "",
          requestId,
          status: 200,
          code: "ok",
        });
        logRequest({ source: "mcp", tool, status: 200, detail: `${args.repository || ""} ${args.path || ""}`.trim() });
        return jsonResult(data);
      } catch (err) {
        const code = err.code || "INTEL_ERROR";
        accessLog({
          actor: currentActor(),
          tool,
          repository: args.repository || "",
          path: args.path || "",
          ref: args.ref || "",
          requestId,
          status: err.status || 500,
          code,
        });
        logRequest({ source: "mcp", tool, status: err.status || 500, detail: code });
        return errorResult(err);
      }
    });
  };
}

export const INTEL_TOOL_NAMES = [
  "repo_get",
  "repo_tree",
  "repo_directory_list",
  "repo_file_read",
  "repo_file_batch_read",
  "repo_search",
  "repo_glob",
  "repo_file_metadata",
  "git_status",
  "git_branches",
  "git_commits",
  "git_commit_get",
  "git_diff",
  "git_diff_between",
  "git_changed_files",
  "git_file_history",
  "git_blame",
  "github_repository",
  "github_branches",
  "github_commits",
  "github_pull_requests",
  "github_pull_request",
  "github_pull_request_files",
  "github_pull_request_diff",
  "github_pull_request_comments",
  "github_pull_request_reviews",
  "github_pull_request_checks",
  "github_issues",
  "github_issue",
  "github_issue_comments",
  "github_actions",
  "github_pr_review_context",
  "project_snapshot",
  "project_audit",
  "project_architecture",
];

export function registerIntelMcpTools(server) {
  server.registerTool(
    "repo_get",
    {
      title: "Get repository",
      description:
        "Resolve an allowlisted GitHub repository and the commit SHA for a ref. Use this first when a user names a repo. Does not load file contents. Alias: repo.get",
      inputSchema: repoIn,
    },
    wrap("repo_get", (a) => repoGet(a)),
  );

  server.registerTool(
    "repo_tree",
    {
      title: "Repository tree",
      description:
        "Return a real file/directory tree at a commit SHA (not a summary). Supports path, recursive, limit, cursor pagination. Skips gitignored/generated paths. Use to discover layout before reading files. Alias: repo.tree",
      inputSchema: {
        ...repoIn,
        path: z.string().optional(),
        recursive: z.boolean().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
        include_ignored: z.boolean().optional(),
      },
    },
    wrap("repo_tree", (a) => repoTree(a)),
  );

  server.registerTool(
    "repo_directory_list",
    {
      title: "List directory",
      description: "List one directory (non-recursive) at path. Alias: repo.directory.list",
      inputSchema: { ...repoIn, path: z.string().optional(), limit: z.number().int().optional(), cursor: z.string().optional() },
    },
    wrap("repo_directory_list", (a) => repoDirectoryList(a)),
  );

  server.registerTool(
    "repo_file_read",
    {
      title: "Read file",
      description:
        "Read a real file at path@ref with optional line_start/line_end/max_bytes. Secrets are redacted. Binary files return binary=true and no content. Alias: repo.file.read",
      inputSchema: {
        ...repoIn,
        path: z.string().describe("Repository-relative path"),
        line_start: z.number().int().optional(),
        line_end: z.number().int().optional(),
        max_bytes: z.number().int().optional(),
      },
    },
    wrap("repo_file_read", (a) => repoFileRead(a)),
  );

  server.registerTool(
    "repo_file_batch_read",
    {
      title: "Batch read files",
      description: "Read several source files in one call. Stops at max_files / max_bytes so the context window is not flooded. Alias: repo.file.batch_read",
      inputSchema: {
        ...repoIn,
        paths: z.array(z.string()),
        max_files: z.number().int().optional(),
        max_bytes: z.number().int().optional(),
      },
    },
    wrap("repo_file_batch_read", (a) => repoFileBatchRead(a)),
  );

  server.registerTool(
    "repo_file_metadata",
    {
      title: "File metadata",
      description: "Size, language, blob SHA, generated-path flag without file body. Alias: repo.file.metadata",
      inputSchema: { ...repoIn, path: z.string() },
    },
    wrap("repo_file_metadata", (a) => repoFileMetadata(a)),
  );

  server.registerTool(
    "repo_search",
    {
      title: "Search repository",
      description:
        "Search file contents. Tries GitHub code search, then a bounded tree scan. Supports regex, path, language, case_sensitive, pagination. Returns file, line, matched_text, context. Alias: repo.search",
      inputSchema: {
        ...repoIn,
        query: z.string(),
        path: z.string().optional(),
        language: z.string().optional(),
        regex: z.boolean().optional(),
        case_sensitive: z.boolean().optional(),
        limit: z.number().int().optional(),
        cursor: z.string().optional(),
      },
    },
    wrap("repo_search", (a) => repoSearch(a)),
  );

  server.registerTool(
    "repo_glob",
    {
      title: "Glob paths",
      description: "Match file paths (not contents) with a glob, e.g. src/**/*.js. Alias: repo.glob",
      inputSchema: { ...repoIn, pattern: z.string(), path: z.string().optional(), limit: z.number().int().optional(), cursor: z.string().optional() },
    },
    wrap("repo_glob", (a) => repoGlob(a)),
  );

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description:
        "Working-tree status when INTEL_LOCAL_ROOT is mapped; otherwise GitHub compare(default...ref). Alias: git.status",
      inputSchema: { ...repoIn, base: z.string().optional() },
    },
    wrap("git_status", (a) => gitStatusIntel(a)),
  );

  server.registerTool(
    "git_branches",
    {
      title: "Git branches",
      description: "List branches from GitHub. Alias: git.branches",
      inputSchema: { ...repoIn, limit: z.number().int().optional() },
    },
    wrap("git_branches", (a) => gitBranchesIntel(a)),
  );

  server.registerTool(
    "git_commits",
    {
      title: "Commit history",
      description: "Recent commits for a ref, optionally filtered by path. Alias: git.commits",
      inputSchema: { ...repoIn, path: z.string().optional(), limit: z.number().int().optional() },
    },
    wrap("git_commits", (a) => gitCommitsIntel(a)),
  );

  server.registerTool(
    "git_commit_get",
    {
      title: "Get commit",
      description: "One commit plus changed files. Alias: git.commit.get",
      inputSchema: { ...repoIn, sha: z.string().optional() },
    },
    wrap("git_commit_get", (a) => gitCommitGetIntel(a)),
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description: "Unified diff between base and head, optional path. Secrets redacted. Alias: git.diff",
      inputSchema: { ...repoIn, base: z.string(), head: z.string().optional(), path: z.string().optional() },
    },
    wrap("git_diff", (a) => gitDiffIntel(a)),
  );

  server.registerTool(
    "git_diff_between",
    {
      title: "Diff two refs",
      description: "Same as git_diff. Alias: git.diff_between",
      inputSchema: { ...repoIn, base: z.string(), head: z.string().optional(), path: z.string().optional() },
    },
    wrap("git_diff_between", (a) => gitDiffBetweenIntel(a)),
  );

  server.registerTool(
    "git_changed_files",
    {
      title: "Changed files",
      description: "Added/modified/deleted/renamed files with insertion/deletion counts for base...head. Alias: git.changed_files",
      inputSchema: { ...repoIn, base: z.string(), head: z.string().optional() },
    },
    wrap("git_changed_files", (a) => gitChangedFilesIntel(a)),
  );

  server.registerTool(
    "git_file_history",
    {
      title: "File history",
      description: "Commits that touched a path. Alias: git.file_history",
      inputSchema: { ...repoIn, path: z.string(), limit: z.number().int().optional() },
    },
    wrap("git_file_history", (a) => gitFileHistoryIntel(a)),
  );

  server.registerTool(
    "git_blame",
    {
      title: "Git blame",
      description:
        "Line blame via local git, GitHub GraphQL, or path commit history if GraphQL is unavailable (REST has no blame). Alias: git.blame",
      inputSchema: { ...repoIn, path: z.string() },
    },
    wrap("git_blame", (a) => gitBlameIntel(a)),
  );

  server.registerTool(
    "github_repository",
    {
      title: "GitHub repository",
      description: "Live GitHub repo metadata. Alias: github.repository",
      inputSchema: repoIn,
    },
    wrap("github_repository", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return getRepository(owner, repo);
    }),
  );

  server.registerTool(
    "github_branches",
    {
      title: "GitHub branches",
      description: "Alias: github.branches",
      inputSchema: { ...repoIn, limit: z.number().int().optional() },
    },
    wrap("github_branches", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await listBranches(owner, repo, a) };
    }),
  );

  server.registerTool(
    "github_commits",
    {
      title: "GitHub commits",
      description: "Alias: github.commits",
      inputSchema: { ...repoIn, path: z.string().optional(), limit: z.number().int().optional() },
    },
    wrap("github_commits", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await listCommits(owner, repo, { sha: a.ref, path: a.path, limit: a.limit }) };
    }),
  );

  server.registerTool(
    "github_pull_requests",
    {
      title: "List pull requests",
      description: "Live PRs. Alias: github.pull_requests",
      inputSchema: { ...repoIn, state: z.string().optional(), limit: z.number().int().optional() },
    },
    wrap("github_pull_requests", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await listPulls(owner, repo, a) };
    }),
  );

  server.registerTool(
    "github_pull_request",
    {
      title: "Get pull request",
      description: "PR metadata, body, base/head, SHAs. Alias: github.pull_request",
      inputSchema: { ...repoIn, pull_number: z.coerce.number().int() },
    },
    wrap("github_pull_request", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return getPull(owner, repo, a.pull_number);
    }),
  );

  server.registerTool(
    "github_pull_request_files",
    {
      title: "PR files",
      description: "Changed files and patches. Alias: github.pull_request.files",
      inputSchema: { ...repoIn, pull_number: z.coerce.number().int() },
    },
    wrap("github_pull_request_files", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await getPullFiles(owner, repo, a.pull_number) };
    }),
  );

  server.registerTool(
    "github_pull_request_diff",
    {
      title: "PR diff",
      description: "Unified PR diff. Alias: github.pull_request.diff",
      inputSchema: { ...repoIn, pull_number: z.coerce.number().int() },
    },
    wrap("github_pull_request_diff", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      const diff = await getPullDiff(owner, repo, a.pull_number);
      const red = redactSecrets(diff);
      const clipped = clipBytes(red.text, loadConfig().intelMaxResponseBytes);
      return { diff: clipped.text, truncated: clipped.truncated, redacted: red.redacted };
    }),
  );

  server.registerTool(
    "github_pull_request_comments",
    {
      title: "PR review comments",
      description: "Line comments with path, line, commit. Alias: github.pull_request.comments",
      inputSchema: { ...repoIn, pull_number: z.coerce.number().int() },
    },
    wrap("github_pull_request_comments", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await getPullComments(owner, repo, a.pull_number) };
    }),
  );

  server.registerTool(
    "github_pull_request_reviews",
    {
      title: "PR reviews",
      description: "Review decisions. Alias: github.pull_request.reviews",
      inputSchema: { ...repoIn, pull_number: z.coerce.number().int() },
    },
    wrap("github_pull_request_reviews", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await getPullReviews(owner, repo, a.pull_number) };
    }),
  );

  server.registerTool(
    "github_pull_request_checks",
    {
      title: "PR checks",
      description: "Check runs on the PR head SHA. Alias: github.pull_request.checks",
      inputSchema: { ...repoIn, pull_number: z.coerce.number().int() },
    },
    wrap("github_pull_request_checks", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      const pr = await getPull(owner, repo, a.pull_number);
      return { head_sha: pr.head_sha, items: await getCheckRuns(owner, repo, pr.head_sha) };
    }),
  );

  server.registerTool(
    "github_pr_review_context",
    {
      title: "PR review context",
      description: "Join PR files, diffs, and line comments so a model can see why a line changed and whether review comments remain.",
      inputSchema: { ...repoIn, pull_number: z.coerce.number().int() },
    },
    wrap("github_pr_review_context", (a) => prReviewContext(a)),
  );

  server.registerTool(
    "github_issues",
    {
      title: "List issues",
      description: "GitHub issues (PRs excluded). Alias: github.issues",
      inputSchema: { ...repoIn, state: z.string().optional(), limit: z.number().int().optional() },
    },
    wrap("github_issues", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await listIssues(owner, repo, a) };
    }),
  );

  server.registerTool(
    "github_issue",
    {
      title: "Get issue",
      description: "Alias: github.issue",
      inputSchema: { ...repoIn, issue_number: z.coerce.number().int() },
    },
    wrap("github_issue", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return getIssue(owner, repo, a.issue_number);
    }),
  );

  server.registerTool(
    "github_issue_comments",
    {
      title: "Issue comments",
      description: "Alias: github.issue.comments",
      inputSchema: { ...repoIn, issue_number: z.coerce.number().int() },
    },
    wrap("github_issue_comments", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await getIssueComments(owner, repo, a.issue_number) };
    }),
  );

  server.registerTool(
    "github_actions",
    {
      title: "GitHub Actions",
      description: "Recent workflow runs (CI). Alias: github.actions",
      inputSchema: { ...repoIn, limit: z.number().int().optional() },
    },
    wrap("github_actions", async (a) => {
      const { owner, repo } = await resolveRepo(a.repository);
      return { items: await listActions(owner, repo, a) };
    }),
  );

  server.registerTool(
    "project_snapshot",
    {
      title: "Project snapshot",
      description:
        "Evidence-based snapshot: languages, entrypoints, deps, recent commits, open PRs, issues, CI. Extracted from the repo/GitHub, not hardcoded. Alias: project.snapshot",
      inputSchema: {
        repository: z.string().optional(),
        project_id: z.coerce.number().int().optional(),
        ref: z.string().optional(),
      },
    },
    wrap("project_snapshot", (a) => projectSnapshot(a)),
  );

  server.registerTool(
    "project_architecture",
    {
      title: "Architecture map",
      description: "Entry points, layers, Express/MCP routes, imports, dependency list from real files.",
      inputSchema: repoIn,
    },
    wrap("project_architecture", (a) => architectureMap(a)),
  );

  server.registerTool(
    "project_audit",
    {
      title: "Project audit",
      description:
        "Evidence-based audit of architecture, tests, CI, PRs, memory. Every important claim includes repository/file/line/commit/PR when known. Alias: project.audit",
      inputSchema: {
        repository: z.string().optional(),
        project_id: z.coerce.number().int().optional(),
        ref: z.string().optional(),
        pull_number: z.coerce.number().int().optional(),
      },
    },
    wrap("project_audit", (a) => projectAudit(a)),
  );
}
