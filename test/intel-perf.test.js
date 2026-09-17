import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { paginate } from "../src/intel/paginate.js";

test("tree pagination handles 1000+ synthetic files", () => {
  const items = Array.from({ length: 1500 }, (_, i) => ({ path: `f/file-${String(i).padStart(4, "0")}.js` }));
  const page = paginate(items, { limit: 200, max: 500 });
  assert.equal(page.items.length, 200);
  assert.equal(page.has_more, true);
  let seen = page.items.length;
  let cursor = page.next_cursor;
  while (cursor) {
    const next = paginate(items, { limit: 200, cursor, max: 500 });
    seen += next.items.length;
    cursor = next.next_cursor;
  }
  assert.equal(seen, 1500);
});

test("local git repo with 120 files still trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "intel-many-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b.c"], { cwd: root });
  spawnSync("git", ["config", "user.name", "A"], { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < 120; i += 1) {
    writeFileSync(join(root, "src", `f${i}.js`), `export const n=${i};\n`);
  }
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-m", "many"], { cwd: root });
  process.env.DATA_DIR = root;
  process.env.LOG_DIR = root;
  process.env.GITHUB_ALLOWED_REPOS = "acme/many";
  process.env.INTEL_LOCAL_REPOS = `acme/many:${root}`;
  process.env.INTEL_ALLOW_CURSOR_REPOS = "false";
  process.env.APP_SECRET = "unit-secret-unit-secret";
  const { ensureMemoryTables } = await import("../src/memory.js");
  ensureMemoryTables();
  const { repoTree } = await import("../src/intel/repo.js");
  const tree = await repoTree({ repository: "acme/many", limit: 50 });
  assert.equal(tree.items.length, 50);
  assert.equal(tree.has_more, true);
  assert.ok(tree.total >= 120);
});
