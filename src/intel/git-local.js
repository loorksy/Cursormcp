import { spawn } from "node:child_process";
import { IntelError } from "./errors.js";

const GIT_SUB = new Set([
  "status",
  "branch",
  "log",
  "show",
  "diff",
  "rev-parse",
  "blame",
  "ls-tree",
  "cat-file",
  "remote",
  "name-rev",
  "rev-list",
]);

export function runGit(cwd, args, { timeoutMs = 20000, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const sub = args[0];
    if (!GIT_SUB.has(sub)) {
      reject(new IntelError("FORBIDDEN", `git ${sub} is not allowed`));
      return;
    }
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      stdout = Buffer.concat([stdout, d]);
      if (stdout.length > maxBytes) stdout = stdout.subarray(0, maxBytes);
    });
    child.stderr.on("data", (d) => {
      stderr = Buffer.concat([stderr, d]);
      if (stderr.length > 20_000) stderr = stderr.subarray(-20_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdoutBuf: stdout,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new IntelError("GIT_UNAVAILABLE", err.message, { retryable: false }));
    });
  });
}

export async function gitOk(cwd) {
  const r = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  return r?.code === 0 && r.stdout.trim() === "true";
}

export async function gitOrigin(cwd) {
  const r = await runGit(cwd, ["remote", "get-url", "origin"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

export async function gitHeadSha(cwd, ref = "HEAD") {
  const r = await runGit(cwd, ["rev-parse", ref]);
  if (r.code !== 0) throw new IntelError("NOT_FOUND", r.stderr.trim() || `unknown ref ${ref}`);
  return r.stdout.trim();
}

export async function gitLsTree(cwd, ref, { recursive = true, path = "" } = {}) {
  const args = ["ls-tree", "-l"];
  if (recursive) args.push("-r");
  args.push(ref);
  if (path) args.push("--", path);
  const r = await runGit(cwd, args, { maxBytes: 8_000_000 });
  if (r.code !== 0) throw new IntelError("GIT_ERROR", r.stderr.trim() || "ls-tree failed");
  const tree = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/);
    if (!m) continue;
    tree.push({
      mode: m[1],
      type: m[2] === "tree" ? "tree" : "blob",
      sha: m[3],
      size: m[4] === "-" ? 0 : Number(m[4]),
      path: m[5],
    });
  }
  return tree;
}

export async function gitShowFile(cwd, ref, path) {
  const r = await runGit(cwd, ["show", `${ref}:${path}`], { maxBytes: 2_000_000 });
  if (r.code !== 0) {
    throw new IntelError("FILE_NOT_FOUND", r.stderr.trim() || "file not found", { path });
  }
  return r.stdoutBuf;
}

export async function gitStatus(cwd) {
  const r = await runGit(cwd, ["status", "--porcelain=v1", "-uall"]);
  if (r.code !== 0) throw new IntelError("GIT_ERROR", r.stderr.trim() || "status failed");
  const items = [];
  for (const line of r.stdout.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    let path = rest;
    let previous;
    if (rest.includes(" -> ")) {
      const [a, b] = rest.split(" -> ");
      previous = a;
      path = b;
    }
    items.push({
      xy: code,
      path,
      previous_filename: previous,
      status: porcelainStatus(code),
    });
  }
  return items;
}

function porcelainStatus(xy) {
  if (xy.includes("?")) return "untracked";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("A")) return "added";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("M")) return "modified";
  return "changed";
}

export async function gitLog(cwd, { ref = "HEAD", path = "", limit = 30 } = {}) {
  const args = ["log", `--max-count=${limit}`, "--pretty=format:%H%x09%an%x09%aI%x09%s", ref];
  if (path) args.push("--", path);
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new IntelError("GIT_ERROR", r.stderr.trim() || "log failed");
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, ...msg] = line.split("\t");
      return { sha, author, date, message: msg.join("\t") };
    });
}

export async function gitDiff(cwd, base, head, path) {
  const args = ["diff", `${base}...${head}`];
  if (path) args.push("--", path);
  const r = await runGit(cwd, args, { maxBytes: 2_000_000 });
  if (r.code !== 0) throw new IntelError("GIT_ERROR", r.stderr.trim() || "diff failed");
  return r.stdout;
}

export async function gitChanged(cwd, base, head) {
  const names = await runGit(cwd, ["diff", "--name-status", `${base}...${head}`]);
  const stats = await runGit(cwd, ["diff", "--numstat", `${base}...${head}`]);
  const statMap = new Map();
  for (const line of stats.stdout.split("\n")) {
    const p = line.split("\t");
    if (p.length >= 3) statMap.set(p[2], { insertions: Number(p[0]) || 0, deletions: Number(p[1]) || 0 });
  }
  const files = [];
  for (const line of names.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split("\t");
    const filename = b || a;
    const st = statMap.get(filename) || { insertions: 0, deletions: 0 };
    files.push({
      filename,
      status: status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : status.startsWith("R") ? "renamed" : "modified",
      previous_filename: b ? a : undefined,
      additions: st.insertions,
      deletions: st.deletions,
    });
  }
  return files;
}

export async function gitBlame(cwd, ref, path) {
  const r = await runGit(cwd, ["blame", "-l", "--date=iso", ref, "--", path], { maxBytes: 2_000_000 });
  if (r.code !== 0) throw new IntelError("NOT_FOUND", r.stderr.trim() || "blame failed", { path });
  const ranges = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]+)\s+\((.+?)\s+(\d{4}-\d{2}-\d{2}[^\)]*)\s+(\d+)\)\s?(.*)$/);
    if (!m) continue;
    ranges.push({
      commit: m[1],
      author: m[2].trim(),
      date: m[3].trim(),
      line: Number(m[4]),
      text: m[5],
    });
  }
  return ranges;
}
