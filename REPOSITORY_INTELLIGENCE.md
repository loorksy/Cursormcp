# Repository Intelligence

The MCP server can read **real** Git repositories and GitHub data. It does not substitute project memory for source.

## Sources of truth

1. **Local git** when `INTEL_LOCAL_REPOS=owner/repo:/absolute/path` or `INTEL_LOCAL_ROOT` whose `origin` is allowlisted.
2. **Filesystem checkout** when that mapped path exists but is **not** a git repository (typical VPS deploy copy). `source` is `filesystem` and `commit` is `worktree`. Named refs such as `main` still read the files on disk. A 7–40 character commit SHA uses GitHub instead.
3. **GitHub REST** (and GraphQL blame) at `GITHUB_API_BASE_URL` (default `https://api.github.com`) using `GITHUB_TOKEN`.
4. **Commit SHA** is resolved for every git/GitHub read. Cache keys are `repo|sha|kind`. A new SHA does not reuse another commit's tree.

## Authorization

A repository is allowed only if it appears in:

- `GITHUB_ALLOWED_REPOS` (if set, this list is exclusive plus local mappings), else
- `projects.repo_url` in SQLite, Cursor `GET /v1/repositories` (unless `INTEL_ALLOW_CURSOR_REPOS=false`), and local mappings.

Owner/repo must match `^[A-Za-z0-9._-]+$`. GitHub requests are path-only to `GITHUB_API_BASE_URL` (SSRF).

## Size limits

| Env | Default |
| --- | --- |
| INTEL_MAX_TREE_ITEMS | 500 |
| INTEL_MAX_FILE_BYTES | 100000 |
| INTEL_MAX_BATCH_FILES | 20 |
| INTEL_MAX_SEARCH_RESULTS | 50 |
| INTEL_MAX_RESPONSE_BYTES | 400000 |

Large results set `has_more` and `next_cursor`.

## Ignore / binary

`node_modules`, `.venv`, `dist`, `build`, `vendor`, `.git`, coverage, and `.gitignore` rules are skipped. Binary files return `binary: true` and no text.

## Secrets

File bodies, diffs, and blame lines pass through redaction before MCP output. Keys, PEM, JWTs, GitHub/Telegram tokens, and connection URLs become `********`. Access logs store tool/repo/path/ref/status, not bodies.

## Limitations

- Cursor Cloud Agents API does **not** provide file trees. GitHub/local git does.
- GitHub code search often returns 403; the tool then scans a bounded tree.
- REST has **no blame**. `git_blame` uses local `git blame`, else GraphQL, else path history.
- `git_status` without a local worktree is `compare(default_branch...ref)`, not porcelain status. A non-git mapped checkout returns `source: filesystem` and an empty status list.
- Clone-on-demand is **not** enabled by default (no surprise git clones on the VPS).
- A deploy directory without `.git` cannot blame or diff locally; those tools use GitHub (or return an explicit filesystem limitation).
