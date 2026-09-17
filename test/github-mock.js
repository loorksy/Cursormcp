import { createServer } from "node:http";

export function startGithubMock(state) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://github.local");
    const path = url.pathname;
    const send = (code, body, type = "application/json") => {
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const auth = req.headers.authorization || "";
    if (state.requireAuth && !auth.startsWith("Bearer ")) return send(401, { message: "requires authentication" });

    if (path === "/graphql" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return send(200, { data: { repository: { object: { blame: { ranges: state.blameRanges || [] } } } } });
    }

    const repo = state.repo || "acme/demo";
    const [owner, name] = repo.split("/");
    const prefix = `/repos/${owner}/${name}`;

    if (path === prefix) {
      return send(200, {
        full_name: repo,
        description: "demo",
        default_branch: state.defaultBranch || "main",
        private: false,
        html_url: `https://github.com/${repo}`,
        language: "JavaScript",
        pushed_at: "2026-01-01T00:00:00Z",
      });
    }
    if (path === `${prefix}/languages`) return send(200, { JavaScript: 1000 });
    if (path.startsWith(`${prefix}/git/trees/`)) {
      return send(200, { sha: state.sha, truncated: false, tree: state.tree || [] });
    }
    if (path.startsWith(`${prefix}/git/blobs/`)) {
      const sha = decodeURIComponent(path.split("/").pop());
      const blob = (state.blobs || {})[sha];
      if (!blob) return send(404, { message: "Not Found" });
      return send(200, { encoding: "base64", content: Buffer.from(blob).toString("base64"), sha });
    }
    if (path.startsWith(`${prefix}/contents/`)) {
      const filePath = decodeURIComponent(path.slice(`${prefix}/contents/`.length));
      const entry = (state.contents || {})[filePath];
      if (!entry) return send(404, { message: "Not Found" });
      if (entry.dir) return send(200, entry.dir);
      return send(200, {
        encoding: "base64",
        content: Buffer.from(entry.content).toString("base64"),
        sha: entry.sha || "abc",
        size: entry.content.length,
        path: filePath,
      });
    }
    if (path.startsWith(`${prefix}/commits/`) && path.endsWith("/check-runs")) {
      return send(200, { check_runs: state.checks || [] });
    }
    if (path.startsWith(`${prefix}/commits/`) && !url.searchParams.get("per_page")) {
      const ref = decodeURIComponent(path.slice(`${prefix}/commits/`.length));
      const commit = state.commit || {
        sha: state.sha || "deadbeef",
        html_url: "https://github.com/x",
        commit: { message: "init", author: { name: "bot", date: "2026-01-01T00:00:00Z" } },
        files: state.commitFiles || [],
        stats: { additions: 1, deletions: 0 },
        parents: [],
        author: { login: "bot" },
      };
      if (ref === "missing") return send(404, { message: "Not Found" });
      return send(200, commit);
    }
    if (path === `${prefix}/commits`) {
      return send(200, state.commits || []);
    }
    if (path === `${prefix}/branches`) {
      return send(200, state.branches || [{ name: "main", commit: { sha: state.sha }, protected: false }]);
    }
    if (path.startsWith(`${prefix}/compare/`)) {
      const accept = req.headers.accept || "";
      if (accept.includes("diff")) return send(200, state.diff || "diff --git a/x b/x\n+hello", "text/plain");
      return send(200, {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        files: state.compareFiles || [],
        commits: state.commits || [],
      });
    }
    if (path === `${prefix}/pulls`) return send(200, state.pulls || []);
    if (/\/pulls\/\d+$/.test(path)) {
      const accept = req.headers.accept || "";
      if (accept.includes("diff")) return send(200, state.prDiff || "diff --git a/f b/f\n+x", "text/plain");
      return send(200, state.pull || { number: 1, title: "PR", state: "open", user: { login: "a" }, html_url: "https://github.com/acme/demo/pull/1", base: { ref: "main" }, head: { ref: "feat", sha: state.sha }, body: "hi", commits: 1, additions: 2, deletions: 0, changed_files: 1, draft: false, merged: false });
    }
    if (/\/pulls\/\d+\/files$/.test(path)) return send(200, state.prFiles || []);
    if (/\/pulls\/\d+\/comments$/.test(path)) return send(200, state.prComments || []);
    if (/\/pulls\/\d+\/reviews$/.test(path)) return send(200, state.prReviews || []);
    if (path === `${prefix}/issues`) return send(200, state.issues || []);
    if (/\/issues\/\d+$/.test(path)) return send(200, state.issue || { number: 1, title: "bug", state: "open", user: { login: "a" }, body: "x", html_url: "https://github.com/acme/demo/issues/1", labels: [] });
    if (/\/issues\/\d+\/comments$/.test(path)) return send(200, state.issueComments || []);
    if (path === `${prefix}/actions/runs`) return send(200, { workflow_runs: state.actions || [] });
    if (path === "/search/code") {
      if (state.searchForbidden) return send(403, { message: "API rate limit exceeded" });
      return send(200, { incomplete_results: false, items: state.searchItems || [] });
    }
    return send(404, { message: "not mocked " + path });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, port });
    });
  });
}
