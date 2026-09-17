import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, log, paths, safeJson } from "./lib.js";
import { inspectPullRequest } from "./github.js";

const ALLOWED_BINS = new Set(["npm", "node", "npx"]);

function recordVerification(row) {
  const ts = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO verifications (agent_id, run_id, project_id, task_id, kind, passed, summary, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.agent_id || "",
      row.run_id || "",
      row.project_id ?? null,
      row.task_id ?? null,
      row.kind,
      row.passed ? 1 : 0,
      row.summary || "",
      row.details || "",
      ts,
    );
  return getDb().prepare("SELECT * FROM verifications WHERE id = ?").get(info.lastInsertRowid);
}

function runCommand(bin, args, { cwd, timeoutMs = 120000 }) {
  return new Promise((resolvePromise) => {
    if (!ALLOWED_BINS.has(bin)) {
      resolvePromise({ code: 127, stdout: "", stderr: `binary not allowed: ${bin}` });
      return;
    }
    const child = spawn(bin, args, { cwd, env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 20_000) stdout = stdout.slice(-20_000);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: 127, stdout, stderr: err.message });
    });
  });
}

export async function runLocalVerification(project) {
  const spec = safeJson(project?.verify_json || "", null);
  const commands = spec?.commands;
  if (!Array.isArray(commands) || !commands.length) return null;
  const cwd = spec?.cwd ? resolve(paths.root, spec.cwd) : paths.root;
  if (!existsSync(cwd) || !cwd.startsWith(paths.root)) {
    return { passed: false, summary: "verifier cwd rejected", details: cwd };
  }
  const details = [];
  for (const cmd of commands) {
    const bin = cmd[0];
    const args = cmd.slice(1);
    const result = await runCommand(bin, args, { cwd, timeoutMs: spec.timeoutMs || 120000 });
    details.push({ bin, args, code: result.code, stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000) });
    if (result.code !== 0) {
      return { passed: false, summary: `${bin} ${args.join(" ")} exited ${result.code}`, details: JSON.stringify(details) };
    }
  }
  return { passed: true, summary: "local verification passed", details: JSON.stringify(details) };
}

export async function verifyAgentCompletion({ agent, run, project, task }) {
  const checks = [];
  const runStatus = String(run?.status || "").toUpperCase();
  if (runStatus && runStatus !== "FINISHED") {
    const row = recordVerification({
      agent_id: agent?.id,
      run_id: run?.id,
      project_id: project?.id,
      task_id: task?.id,
      kind: "cursor_run",
      passed: false,
      summary: `Cursor run status ${runStatus} is not FINISHED`,
    });
    return { passed: false, verifications: [row] };
  }

  checks.push(
    recordVerification({
      agent_id: agent?.id,
      run_id: run?.id,
      project_id: project?.id,
      task_id: task?.id,
      kind: "cursor_run",
      passed: true,
      summary: "Cursor run FINISHED",
    }),
  );

  const prUrl = agent?.pr_url || run?.pr_url || task?.evidence || "";
  if (/github\.com\/.+\/pull\/\d+/i.test(prUrl)) {
    const pr = await inspectPullRequest(prUrl.match(/https?:\/\/github\.com\/[^\s]+\/pull\/\d+/i)[0]);
    const passed = Boolean(pr.exists) && Number(pr.failedChecks || 0) === 0;
    checks.push(
      recordVerification({
        agent_id: agent?.id,
        run_id: run?.id,
        project_id: project?.id,
        task_id: task?.id,
        kind: "github_pr",
        passed,
        summary: pr.note,
        details: JSON.stringify({ exists: pr.exists, failedChecks: pr.failedChecks, pendingChecks: pr.pendingChecks }),
      }),
    );
    if (!passed) return { passed: false, verifications: checks, pr };
  }

  if (project) {
    const local = await runLocalVerification(project);
    if (local) {
      checks.push(
        recordVerification({
          agent_id: agent?.id,
          run_id: run?.id,
          project_id: project.id,
          task_id: task?.id,
          kind: "local_commands",
          passed: local.passed,
          summary: local.summary,
          details: local.details,
        }),
      );
      if (!local.passed) return { passed: false, verifications: checks };
    }
  }

  const failed = checks.filter((c) => !c.passed);
  log("info", "verification", { agentId: agent?.id, passed: failed.length === 0, count: checks.length });
  return { passed: failed.length === 0, verifications: checks };
}

export function latestVerification(agentId) {
  return getDb()
    .prepare("SELECT * FROM verifications WHERE agent_id = ? ORDER BY id DESC LIMIT 20")
    .all(agentId);
}

export function latestBuildStatus(projectId) {
  return getDb()
    .prepare("SELECT * FROM verifications WHERE project_id = ? ORDER BY id DESC LIMIT 20")
    .all(projectId);
}
