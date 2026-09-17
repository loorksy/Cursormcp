# MCP tools — repository intelligence

Existing agent/memory/orchestrator tools are unchanged. New tools (underscore names; dotted aliases in descriptions):

## Repository

| Tool | Purpose |
| --- | --- |
| `repo_get` | Resolve repo + commit SHA for a ref |
| `repo_tree` | Paginated tree at that SHA |
| `repo_directory_list` | One directory |
| `repo_file_read` | File body, line numbers, redaction |
| `repo_file_batch_read` | Several files with byte/file caps |
| `repo_file_metadata` | Size/language/SHA without body |
| `repo_search` | Text/regex search with context |
| `repo_glob` | Path glob |

Inputs typically: `repository` (owner/repo or github.com URL), `ref`, plus path/query/limit/cursor.

Errors: `{ error: { code, message, repository, path, retryable } }` e.g. `FORBIDDEN`, `FILE_NOT_FOUND`, `PATH_TRAVERSAL`, `NOT_FOUND`.

## Git

`git_status`, `git_branches`, `git_commits`, `git_commit_get`, `git_diff`, `git_diff_between`, `git_changed_files`, `git_file_history`, `git_blame`

`git_diff` / `git_changed_files` require `base` (and optional `head`).

## GitHub

`github_repository`, `github_branches`, `github_commits`, `github_pull_requests`, `github_pull_request`, `github_pull_request_files`, `github_pull_request_diff`, `github_pull_request_comments`, `github_pull_request_reviews`, `github_pull_request_checks`, `github_pr_review_context`, `github_issues`, `github_issue`, `github_issue_comments`, `github_actions`

PR tools take `pull_number`. Issue tools take `issue_number`.

## Project

`project_snapshot` — languages, entrypoints, deps, recent commits, PRs, issues, CI.  
`project_architecture` — layers, routes, imports.  
`project_audit` — evidence claims with file/line/commit/PR; optional `pull_number`.

## Suggested Claude workflow

1. `repo_get` / `repo_tree`
2. `project_snapshot`
3. `repo_search` for the feature (auth, login, …)
4. `repo_file_batch_read` on the hits
5. `git_commits` / `git_changed_files`
6. `github_pull_requests` + `github_pr_review_context`
7. `github_pull_request_checks` / `github_actions`
8. `project_audit` then a plan grounded in those paths

Permissions: MCP bearer/OAuth **and** repo allowlist **and** GitHub token scope.
