# GitHub integration

Host: `GITHUB_API_BASE_URL` (default `https://api.github.com`). Token: `GITHUB_TOKEN` (Bearer). Paths must start with `/`; host cannot be overridden per request.

## Used endpoints

| Capability | API |
| --- | --- |
| Repo metadata | `GET /repos/{owner}/{repo}` |
| Languages | `GET /repos/{owner}/{repo}/languages` |
| Commit | `GET /repos/{owner}/{repo}/commits/{ref}` |
| Tree | `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` |
| Contents / blobs | `GET .../contents/{path}`, `GET .../git/blobs/{sha}` |
| Branches / commits | `GET .../branches`, `GET .../commits` |
| Compare / diff | `GET .../compare/{base}...{head}` (`Accept: diff` for unified) |
| Pulls | `GET .../pulls`, `.../pulls/{n}`, files, comments, reviews |
| Checks | `GET .../commits/{sha}/check-runs` |
| Issues | `GET .../issues`, comments |
| Actions | `GET .../actions/runs` |
| Code search | `GET /search/code` (often 403 → tree scan fallback) |
| Blame | GraphQL `blame` (REST has none) |
| Create PR | existing `POST .../pulls` (`create_pr` MCP tool) |

`get_pr` / `get_pr_status` / `create_pr` remain URL-based and unchanged.

Without `GITHUB_TOKEN`, public REST still rate-limits; private repos fail with `GITHUB_FORBIDDEN` / `NOT_FOUND`.
