import { AsyncLocalStorage } from "node:async_hooks";
import { getDb } from "./lib.js";
import { createRun } from "./cursor-api.js";
import { PROMPT_INJECTION_WARNING, systemGuideText } from "./memory-guide.js";

export { PROMPT_INJECTION_WARNING, systemGuideText };

const actorStore = new AsyncLocalStorage();
export const MAX_CONSECUTIVE_STEPS = 3;
const TASK_STATUSES = new Set([
  "pending",
  "in_progress",
  "done_proposed",
  "done_verified",
  "partial",
  "failed",
]);

export class MemoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.code = "MEMORY";
  }
}

export function currentActor() {
  return actorStore.getStore()?.actor || "غير معروف";
}

export function runWithActor(actor, fn) {
  return actorStore.run({ actor: actor || "غير معروف" }, fn);
}

export function resolveActorFromRequest(req) {
  const header = req?.headers?.authorization || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return "غير معروف";
  const expected = process.env.MCP_AUTH_TOKEN || "";
  if (expected && token === expected) return "mcp-token";
  const row = getDb()
    .prepare(
      `SELECT t.client_id, c.client_json
       FROM oauth_tokens t
       LEFT JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.token = ?`,
    )
    .get(token);
  if (!row) return "غير معروف";
  try {
    const meta = JSON.parse(row.client_json || "{}");
    return meta.client_name || meta.client_id || row.client_id || "غير معروف";
  } catch {
    return row.client_id || "غير معروف";
  }
}

export function ensureMemoryTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      repo_url TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      proposed_by TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      verified_by_user INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT,
      agent_id TEXT NOT NULL DEFAULT '',
      consecutive_steps INTEGER NOT NULL DEFAULT 0,
      auto_check_note TEXT NOT NULL DEFAULT '',
      review_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      task_id INTEGER,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      root_cause TEXT NOT NULL DEFAULT '',
      resolved INTEGER NOT NULL DEFAULT 0,
      resolution_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS plan_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      verified_by_user INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS ui_ux_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL,
      verified_by_user INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS ux_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      flow_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      verified_by_user INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      rule_text TEXT NOT NULL,
      is_critical INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'approved',
      proposed_by TEXT NOT NULL DEFAULT 'user',
      approved_by_user INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS rules_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      suggested_rule_text TEXT NOT NULL,
      suggested_by TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS pr_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      task_id INTEGER,
      pr_url TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      branch_name TEXT NOT NULL DEFAULT '',
      auto_check_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      actor TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function bool(v) {
  return Boolean(v);
}

function rowTask(row) {
  if (!row) return null;
  return { ...row, verified_by_user: bool(row.verified_by_user) };
}

export function writeAudit(projectId, actionType, details) {
  getDb()
    .prepare(
      "INSERT INTO audit_log (project_id, actor, action_type, action_details, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(projectId ?? null, currentActor(), actionType, String(details || ""), nowIso());
}

function requireProject(id) {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id);
  if (!row) throw new MemoryError("المشروع غير موجود", 404);
  return row;
}

function requireTask(id) {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!row) throw new MemoryError("المهمة غير موجودة", 404);
  return rowTask(row);
}

function findProject(projectId, projectName) {
  if (projectId) return requireProject(Number(projectId));
  const name = String(projectName || "").trim();
  if (!name) throw new MemoryError("project_id أو project_name مطلوب");
  const row = getDb().prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE").get(name);
  if (!row) throw new MemoryError("المشروع غير موجود", 404);
  return row;
}

function assertStepBudget(task) {
  if ((task.consecutive_steps || 0) >= MAX_CONSECUTIVE_STEPS) {
    throw new MemoryError(
      `وصل الحد الأقصى (${MAX_CONSECUTIVE_STEPS}) لخطوات الكتابة المتتالية على هذه المهمة. تحتاج مراجعة بشرية من لوحة التحكم أولاً (تأكيد أو رفض أو طلب إصلاح).`,
    );
  }
}

function bumpSteps(taskId) {
  getDb()
    .prepare("UPDATE tasks SET consecutive_steps = consecutive_steps + 1, updated_at = ? WHERE id = ?")
    .run(nowIso(), taskId);
}

export function resetTaskSteps(taskId) {
  getDb()
    .prepare("UPDATE tasks SET consecutive_steps = 0, updated_at = ? WHERE id = ?")
    .run(nowIso(), taskId);
}

export function parsePrUrl(url) {
  const m = String(url || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, ""), number: m[3] };
}

export async function inspectPullRequest(prUrl) {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) {
    return { checked: false, note: "لا يوجد رابط PR صالح في الدليل." };
  }
  const api = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
  try {
    const res = await fetch(api, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "mcp-cursor-bridge",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return {
        checked: false,
        note: "تعذر التحقق بدون توكن",
        httpStatus: res.status,
      };
    }
    if (!res.ok) {
      return { checked: false, note: `تعذر التحقق من GitHub (HTTP ${res.status})`, httpStatus: res.status };
    }
    const data = await res.json();
    const merged = Boolean(data.merged);
    const state = merged ? "merged" : data.state || "unknown";
    return {
      checked: true,
      exists: true,
      state,
      merged,
      note: `فحص آلي: الـ PR موجود. الحالة: ${state}.`,
      htmlUrl: data.html_url || prUrl,
    };
  } catch (err) {
    return { checked: false, note: `تعذر التحقق من GitHub: ${err.message}` };
  }
}

function firstPrUrl(text) {
  const m = String(text || "").match(/https?:\/\/github\.com\/[^\s]+\/pull\/\d+/i);
  return m ? m[0] : "";
}

export function listProjects() {
  return getDb().prepare("SELECT * FROM projects ORDER BY id").all();
}

export function createProject({ name, repo_url, description }) {
  const title = String(name || "").trim();
  if (!title) throw new MemoryError("اسم المشروع مطلوب");
  const ts = nowIso();
  const info = getDb()
    .prepare(
      "INSERT INTO projects (name, repo_url, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(title, String(repo_url || "").trim(), String(description || "").trim(), ts, ts);
  writeAudit(info.lastInsertRowid, "project_create", title);
  return requireProject(info.lastInsertRowid);
}

export function addTask({ project_id, title, description, proposed_by, agent_id }) {
  const project = requireProject(Number(project_id));
  const heading = String(title || "").trim();
  if (!heading) throw new MemoryError("عنوان المهمة مطلوب");
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO tasks (project_id, title, description, status, proposed_by, evidence, verified_by_user, agent_id, consecutive_steps, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, '', 0, ?, 0, ?, ?)`,
    )
    .run(
      project.id,
      heading,
      String(description || "").trim(),
      String(proposed_by || currentActor()),
      String(agent_id || "").trim(),
      ts,
      ts,
    );
  writeAudit(project.id, "task_add", `task#${info.lastInsertRowid} ${heading}`);
  return requireTask(info.lastInsertRowid);
}

export function updateTaskStatus({ task_id, new_status, notes }) {
  const task = requireTask(Number(task_id));
  const status = String(new_status || "").trim();
  if (!TASK_STATUSES.has(status)) throw new MemoryError("حالة غير صالحة");
  if (status === "done_verified" || status === "done_proposed") {
    throw new MemoryError(
      "لا يمكن تعيين done_proposed أو done_verified من task_update_status. استخدم task_propose_done للدليل، والتأكيد من اللوحة فقط.",
    );
  }
  assertStepBudget(task);
  const ts = nowIso();
  getDb()
    .prepare(
      "UPDATE tasks SET status = ?, review_notes = ?, verified_by_user = 0, verified_at = NULL, updated_at = ? WHERE id = ?",
    )
    .run(status, String(notes || task.review_notes || ""), ts, task.id);
  bumpSteps(task.id);
  writeAudit(task.project_id, "task_update_status", `task#${task.id} -> ${status}`);
  return requireTask(task.id);
}

export async function proposeTaskDone({ task_id, evidence }) {
  const task = requireTask(Number(task_id));
  const proof = String(evidence || "").trim();
  if (!proof) {
    throw new MemoryError("لا يمكن اقتراح الإنجاز بدون دليل (evidence). أرفق رابط PR أو نتيجة اختبار أو وصف دليل واضح.");
  }
  assertStepBudget(task);
  let autoNote = task.auto_check_note || "";
  const prUrl = firstPrUrl(proof);
  if (prUrl) {
    const check = await inspectPullRequest(prUrl);
    autoNote = check.note;
  }
  const ts = nowIso();
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'done_proposed', evidence = ?, auto_check_note = ?, verified_by_user = 0, verified_at = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(proof, autoNote, ts, task.id);
  bumpSteps(task.id);
  writeAudit(task.project_id, "task_propose_done", `task#${task.id}`);
  return requireTask(task.id);
}

export function confirmTask(taskId) {
  const task = requireTask(Number(taskId));
  if (task.status !== "done_proposed") {
    throw new MemoryError("لا يمكن التأكيد إلا لمهمة بحالة done_proposed");
  }
  const ts = nowIso();
  getDb()
    .prepare(
      "UPDATE tasks SET status = 'done_verified', verified_by_user = 1, verified_at = ?, consecutive_steps = 0, updated_at = ? WHERE id = ?",
    )
    .run(ts, ts, task.id);
  writeAudit(task.project_id, "task_confirm", `task#${task.id}`);
  return requireTask(task.id);
}

export function rejectTask(taskId, reason) {
  const task = requireTask(Number(taskId));
  const why = String(reason || "").trim();
  if (!why) throw new MemoryError("سبب الرفض إلزامي");
  const ts = nowIso();
  getDb()
    .prepare(
      "UPDATE tasks SET status = 'in_progress', verified_by_user = 0, verified_at = NULL, review_notes = ?, consecutive_steps = 0, updated_at = ? WHERE id = ?",
    )
    .run(why, ts, task.id);
  writeAudit(task.project_id, "task_reject", `task#${task.id}: ${why}`);
  return requireTask(task.id);
}

export async function requestTaskFix(taskId, reason) {
  const task = requireTask(Number(taskId));
  const why = String(reason || "").trim();
  if (!why) throw new MemoryError("سبب طلب الإصلاح إلزامي");
  const ts = nowIso();
  getDb()
    .prepare(
      "UPDATE tasks SET status = 'in_progress', verified_by_user = 0, verified_at = NULL, review_notes = ?, consecutive_steps = 0, updated_at = ? WHERE id = ?",
    )
    .run(why, ts, task.id);
  let followup = null;
  if (task.agent_id) {
    try {
      followup = await createRun(task.agent_id, { prompt: why });
    } catch (err) {
      followup = { error: err.message };
    }
  }
  writeAudit(
    task.project_id,
    "task_request_fix",
    `task#${task.id}: ${why}${task.agent_id ? ` agent=${task.agent_id}` : ""}`,
  );
  return { task: requireTask(task.id), followup };
}

export function logError({ project_id, title, description, root_cause, task_id }) {
  const project = requireProject(Number(project_id));
  const heading = String(title || "").trim();
  if (!heading) throw new MemoryError("عنوان الخطأ مطلوب");
  let task = null;
  if (task_id) {
    task = requireTask(Number(task_id));
    if (task.project_id !== project.id) throw new MemoryError("المهمة لا تنتمي لهذا المشروع");
    assertStepBudget(task);
  }
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO errors (project_id, task_id, title, description, root_cause, resolved, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      project.id,
      task ? task.id : null,
      heading,
      String(description || "").trim(),
      String(root_cause || "").trim(),
      ts,
    );
  if (task) bumpSteps(task.id);
  writeAudit(project.id, "error_log", `error#${info.lastInsertRowid} ${heading}`);
  return getDb().prepare("SELECT * FROM errors WHERE id = ?").get(info.lastInsertRowid);
}

export function resolveError({ error_id, resolution_notes }) {
  const row = getDb().prepare("SELECT * FROM errors WHERE id = ?").get(Number(error_id));
  if (!row) throw new MemoryError("الخطأ غير موجود", 404);
  const notes = String(resolution_notes || "").trim();
  if (!notes) throw new MemoryError("ملاحظات الحل مطلوبة");
  const ts = nowIso();
  getDb()
    .prepare("UPDATE errors SET resolved = 1, resolution_notes = ?, resolved_at = ? WHERE id = ?")
    .run(notes, ts, row.id);
  writeAudit(row.project_id, "error_resolve", `error#${row.id}`);
  return getDb().prepare("SELECT * FROM errors WHERE id = ?").get(row.id);
}

export function savePlanPrompt({ project_id, prompt_text }) {
  const project = requireProject(Number(project_id));
  const text = String(prompt_text || "").trim();
  if (!text) throw new MemoryError("نص الخطة مطلوب");
  const version =
    (getDb()
      .prepare("SELECT COALESCE(MAX(version_number), 0) AS v FROM plan_prompts WHERE project_id = ?")
      .get(project.id).v || 0) + 1;
  const ts = nowIso();
  const info = getDb()
    .prepare(
      "INSERT INTO plan_prompts (project_id, prompt_text, version_number, verified_by_user, created_at) VALUES (?, ?, ?, 0, ?)",
    )
    .run(project.id, text, version, ts);
  writeAudit(project.id, "plan_prompt_save", `v${version}`);
  return getDb().prepare("SELECT * FROM plan_prompts WHERE id = ?").get(info.lastInsertRowid);
}

export function latestPlanPrompt(projectId, { verifiedOnly = false } = {}) {
  const project = requireProject(Number(projectId));
  if (verifiedOnly) {
    return getDb()
      .prepare(
        "SELECT * FROM plan_prompts WHERE project_id = ? AND verified_by_user = 1 ORDER BY version_number DESC LIMIT 1",
      )
      .get(project.id);
  }
  return getDb()
    .prepare("SELECT * FROM plan_prompts WHERE project_id = ? ORDER BY version_number DESC LIMIT 1")
    .get(project.id);
}

export function verifyPlanPrompt(id) {
  const row = getDb().prepare("SELECT * FROM plan_prompts WHERE id = ?").get(Number(id));
  if (!row) throw new MemoryError("برومبت الخطة غير موجود", 404);
  getDb().prepare("UPDATE plan_prompts SET verified_by_user = 1 WHERE id = ?").run(row.id);
  writeAudit(row.project_id, "plan_prompt_verify", `plan#${row.id}`);
  return getDb().prepare("SELECT * FROM plan_prompts WHERE id = ?").get(row.id);
}

export function saveUiUx({ project_id, category, notes }) {
  const project = requireProject(Number(project_id));
  const text = String(notes || "").trim();
  if (!text) throw new MemoryError("الملاحظات مطلوبة");
  const ts = nowIso();
  const info = getDb()
    .prepare(
      "INSERT INTO ui_ux_notes (project_id, category, notes, verified_by_user, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(project.id, String(category || "").trim(), text, ts, ts);
  writeAudit(project.id, "ui_ux_save", `note#${info.lastInsertRowid}`);
  return getDb().prepare("SELECT * FROM ui_ux_notes WHERE id = ?").get(info.lastInsertRowid);
}

export function saveUxNote({ project_id, flow_name, description }) {
  const project = requireProject(Number(project_id));
  const flow = String(flow_name || "").trim();
  if (!flow) throw new MemoryError("اسم التدفق مطلوب");
  const ts = nowIso();
  const info = getDb()
    .prepare(
      "INSERT INTO ux_notes (project_id, flow_name, description, verified_by_user, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
    )
    .run(project.id, flow, String(description || "").trim(), ts, ts);
  writeAudit(project.id, "ux_notes_save", `ux#${info.lastInsertRowid}`);
  return getDb().prepare("SELECT * FROM ux_notes WHERE id = ?").get(info.lastInsertRowid);
}

export function verifyUiUx(id) {
  const row = getDb().prepare("SELECT * FROM ui_ux_notes WHERE id = ?").get(Number(id));
  if (!row) throw new MemoryError("ملاحظة UI/UX غير موجودة", 404);
  const ts = nowIso();
  getDb().prepare("UPDATE ui_ux_notes SET verified_by_user = 1, updated_at = ? WHERE id = ?").run(ts, row.id);
  writeAudit(row.project_id, "ui_ux_verify", `note#${row.id}`);
  return getDb().prepare("SELECT * FROM ui_ux_notes WHERE id = ?").get(row.id);
}

export function verifyUxNote(id) {
  const row = getDb().prepare("SELECT * FROM ux_notes WHERE id = ?").get(Number(id));
  if (!row) throw new MemoryError("ملاحظة تجربة المستخدم غير موجودة", 404);
  const ts = nowIso();
  getDb().prepare("UPDATE ux_notes SET verified_by_user = 1, updated_at = ? WHERE id = ?").run(ts, row.id);
  writeAudit(row.project_id, "ux_notes_verify", `ux#${row.id}`);
  return getDb().prepare("SELECT * FROM ux_notes WHERE id = ?").get(row.id);
}

export function suggestRule({ project_id, suggested_rule_text, reason, proposed_by }) {
  const project = requireProject(Number(project_id));
  const text = String(suggested_rule_text || "").trim();
  if (!text) throw new MemoryError("نص القاعدة المقترحة مطلوب");
  const ts = nowIso();
  const info = getDb()
    .prepare(
      "INSERT INTO rules_suggestions (project_id, suggested_rule_text, suggested_by, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    )
    .run(project.id, text, String(proposed_by || currentActor()), String(reason || "").trim(), ts);
  writeAudit(project.id, "rules_suggest", `suggestion#${info.lastInsertRowid}`);
  return getDb().prepare("SELECT * FROM rules_suggestions WHERE id = ?").get(info.lastInsertRowid);
}

export function listApprovedRules(projectId) {
  const project = requireProject(Number(projectId));
  return getDb()
    .prepare("SELECT * FROM rules WHERE project_id = ? AND status = 'approved' ORDER BY id")
    .all(project.id);
}

export function acceptRuleSuggestion(id) {
  const row = getDb().prepare("SELECT * FROM rules_suggestions WHERE id = ?").get(Number(id));
  if (!row) throw new MemoryError("الاقتراح غير موجود", 404);
  if (row.status !== "pending") throw new MemoryError("الاقتراح ليس بانتظار المراجعة");
  const ts = nowIso();
  getDb().prepare("UPDATE rules_suggestions SET status = 'accepted' WHERE id = ?").run(row.id);
  const info = getDb()
    .prepare(
      `INSERT INTO rules (project_id, rule_text, is_critical, status, proposed_by, approved_by_user, created_at)
       VALUES (?, ?, 0, 'approved', ?, 1, ?)`,
    )
    .run(row.project_id, row.suggested_rule_text, row.suggested_by, ts);
  writeAudit(row.project_id, "rules_accept", `suggestion#${row.id} -> rule#${info.lastInsertRowid}`);
  return {
    suggestion: getDb().prepare("SELECT * FROM rules_suggestions WHERE id = ?").get(row.id),
    rule: getDb().prepare("SELECT * FROM rules WHERE id = ?").get(info.lastInsertRowid),
  };
}

export function rejectRuleSuggestion(id, reason) {
  const row = getDb().prepare("SELECT * FROM rules_suggestions WHERE id = ?").get(Number(id));
  if (!row) throw new MemoryError("الاقتراح غير موجود", 404);
  getDb().prepare("UPDATE rules_suggestions SET status = 'rejected' WHERE id = ?").run(row.id);
  writeAudit(row.project_id, "rules_reject", `suggestion#${row.id}: ${String(reason || "").trim()}`);
  return getDb().prepare("SELECT * FROM rules_suggestions WHERE id = ?").get(row.id);
}

export async function addPrLink({ project_id, pr_url, comment, branch_name, task_id }) {
  const project = requireProject(Number(project_id));
  const url = String(pr_url || "").trim();
  if (!url) throw new MemoryError("رابط PR مطلوب");
  let task = null;
  if (task_id) {
    task = requireTask(Number(task_id));
    if (task.project_id !== project.id) throw new MemoryError("المهمة لا تنتمي لهذا المشروع");
    assertStepBudget(task);
  }
  const check = await inspectPullRequest(url);
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO pr_links (project_id, task_id, pr_url, comment, branch_name, auto_check_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      task ? task.id : null,
      url,
      String(comment || "").trim(),
      String(branch_name || "").trim(),
      check.note,
      ts,
    );
  if (task) bumpSteps(task.id);
  writeAudit(project.id, "pr_link_add", url);
  return getDb().prepare("SELECT * FROM pr_links WHERE id = ?").get(info.lastInsertRowid);
}

export function listPrLinks(projectId) {
  const project = requireProject(Number(projectId));
  return getDb().prepare("SELECT * FROM pr_links WHERE project_id = ? ORDER BY id DESC").all(project.id);
}

export function listAudit(projectId, limit = 50) {
  const project = requireProject(Number(projectId));
  return getDb()
    .prepare("SELECT * FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT ?")
    .all(project.id, limit);
}

export function getProjectFull(projectId, projectName) {
  const project = findProject(projectId, projectName);
  const tasks = getDb()
    .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY id")
    .all(project.id)
    .map(rowTask);
  const ui = getDb()
    .prepare("SELECT * FROM ui_ux_notes WHERE project_id = ? ORDER BY id")
    .all(project.id);
  const ux = getDb().prepare("SELECT * FROM ux_notes WHERE project_id = ? ORDER BY id").all(project.id);
  const plans = getDb()
    .prepare("SELECT * FROM plan_prompts WHERE project_id = ? ORDER BY version_number")
    .all(project.id);
  const errors = getDb().prepare("SELECT * FROM errors WHERE project_id = ? ORDER BY id").all(project.id);
  const verifiedTasks = tasks.filter((t) => t.status === "done_verified" && t.verified_by_user);
  const draftTasks = tasks.filter((t) => !(t.status === "done_verified" && t.verified_by_user));
  return {
    project,
    verified: {
      tasks: verifiedTasks,
      ui_ux_notes: ui.filter((r) => r.verified_by_user),
      ux_notes: ux.filter((r) => r.verified_by_user),
      plan_prompts: plans.filter((r) => r.verified_by_user),
      rules: listApprovedRules(project.id),
    },
    draft: {
      tasks: draftTasks,
      ui_ux_notes: ui.filter((r) => !r.verified_by_user),
      ux_notes: ux.filter((r) => !r.verified_by_user),
      plan_prompts: plans.filter((r) => !r.verified_by_user),
      rules_suggestions: getDb()
        .prepare("SELECT * FROM rules_suggestions WHERE project_id = ? ORDER BY id DESC")
        .all(project.id),
    },
    errors: {
      open: errors.filter((e) => !e.resolved),
      resolved: errors.filter((e) => e.resolved),
    },
    pr_links: listPrLinks(project.id),
    audit_log: listAudit(project.id, 50),
  };
}

function linesFor(items, empty, fmt) {
  if (!items.length) return empty;
  return items.map(fmt).join("\n");
}

export function getProjectCapsule(projectId, projectName) {
  const project = findProject(projectId, projectName);
  const verifiedTasks = getDb()
    .prepare(
      "SELECT * FROM tasks WHERE project_id = ? AND status = 'done_verified' AND verified_by_user = 1 ORDER BY id",
    )
    .all(project.id);
  const inFlight = getDb()
    .prepare(
      "SELECT * FROM tasks WHERE project_id = ? AND status IN ('pending','in_progress','partial','done_proposed') ORDER BY id",
    )
    .all(project.id);
  const openErrors = getDb()
    .prepare("SELECT * FROM errors WHERE project_id = ? AND resolved = 0 ORDER BY id")
    .all(project.id);
  const rules = listApprovedRules(project.id);
  const audit = getDb()
    .prepare("SELECT * FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 5")
    .all(project.id);
  const nextPlan = latestPlanPrompt(project.id, { verifiedOnly: true });

  const body = [
    "الهدف الحالي للمشروع",
    project.description || "—",
    "",
    "ما تم إنجازه فعليًا (done_verified فقط)",
    linesFor(verifiedTasks, "لا يوجد إنجاز معتمد بعد.", (t) => `- ${t.title}`),
    "",
    "ما هو قيد التنفيذ الآن",
    linesFor(inFlight, "لا مهام قيد التنفيذ.", (t) => `- [${t.status}] ${t.title}`),
    "",
    "المشاكل المعروفة غير المحلولة",
    linesFor(openErrors, "لا مشاكل مفتوحة مسجّلة.", (e) => `- ${e.title}`),
    "",
    "القواعد المعتمدة (rules بحالة approved فقط)",
    linesFor(rules, "لا قواعد معتمدة.", (r) => `- ${r.rule_text}`),
    "",
    "آخر 5 إجراءات من audit_log",
    linesFor(audit, "لا إجراءات بعد.", (a) => `- ${a.created_at} | ${a.actor} | ${a.action_type} | ${a.action_details}`),
    "",
    "الخطوة التالية المقترحة (من آخر plan_prompt معتمد إن وُجد)",
    nextPlan ? nextPlan.prompt_text : "لا توجد خطة معتمدة بعد.",
    "",
    PROMPT_INJECTION_WARNING,
  ].join("\n");

  return { project_id: project.id, project_name: project.name, text: body };
}

export function tryDeleteAudit(id) {
  getDb().prepare("DELETE FROM audit_log WHERE id = ?").run(id);
}

export function tryUpdateAudit(id, details) {
  getDb().prepare("UPDATE audit_log SET action_details = ? WHERE id = ?").run(details, id);
}

export function seedMemory() {
  const existing = getDb().prepare("SELECT id FROM projects WHERE name = ?").get("mcp-cursor-bridge");
  if (existing) return existing.id;
  return actorStore.run({ actor: "user" }, () => {
    const project = createProject({
      name: "mcp-cursor-bridge",
      repo_url: "https://github.com/loorksy/Cursormcp",
      description:
        "جسر MCP ولوحة تحكم لوكلاء Cursor Cloud Agents على mcp.lork.cloud، مع ذاكرة مشاريع محكومة وإشعارات تيليجرام.",
    });
    const rules = [
      "لا تلمس nginx / docker / pm2-root / postgresql / redis-server / nanoagent-gateway / wakeed-platform أو أي مشروع آخر قائم على السيرفر.",
      "استخدم نفس systemd service الحالي (mcp-cursor-bridge) فقط، وأعد تشغيله بعد كل تعديل.",
      "لا بورتات جديدة؛ كل شيء على نفس التطبيق والبورت 18800.",
      "لا تُخزَّن أي أسرار فعلية (توكنات، كلمات مرور) داخل جداول الذاكرة.",
      "كل أدوات MCP تتطلب مصادقة OAuth/Bearer الحالية، ما عدا نص GET /system-guide العام (إرشادي فقط بلا بيانات مشاريع).",
    ];
    const ts = nowIso();
    for (const rule_text of rules) {
      getDb()
        .prepare(
          `INSERT INTO rules (project_id, rule_text, is_critical, status, proposed_by, approved_by_user, created_at)
           VALUES (?, ?, 1, 'approved', 'user', 1, ?)`,
        )
        .run(project.id, rule_text, ts);
      writeAudit(project.id, "rules_seed", rule_text.slice(0, 80));
    }
    const tasks = [
      {
        title: "نشر جسر MCP ولوحة التحكم على VPS",
        description: "تطبيق Node معزول، مستخدم mcpbridge، systemd، nginx لموقع mcp.lork.cloud فقط.",
        evidence: "https://github.com/loorksy/Cursormcp/pull/1",
      },
      {
        title: "OAuth لاكتشاف Claude.ai وربط MCP",
        description: "مسارات well-known وتسجيل ديناميكي وصفحة تفويض بنفس دخول اللوحة.",
        evidence: "https://github.com/loorksy/Cursormcp/pull/1 — commit b5115b9",
      },
      {
        title: "Webhook HMAC وإشعار تيليجرام عند انتهاء الـ agent",
        description: "POST /webhooks/cursor-agent مع التحقق من التوقيع، بدون تنفيذ تلقائي.",
        evidence: "https://github.com/loorksy/Cursormcp/pull/1 — commit bb67586",
      },
      {
        title: "عرض رابط الـ webhook والسر الكامل داخل اللوحة بعد الدخول",
        description: "نسخ من المتصفح دون SSH، والحقل محمي بتسجيل الدخول.",
        evidence: "https://github.com/loorksy/Cursormcp/pull/2",
      },
      {
        title: "إرفاق الـ webhook تلقائيًا عند إطلاق agent من اللوحة",
        description: "إنشاء عبر API v0 مع السر الحالي، وإعادة المحاولة بدون النماذج غير المدعومة على v0.",
        evidence: "https://github.com/loorksy/Cursormcp/pull/3",
      },
    ];
    for (const item of tasks) {
      const ts2 = nowIso();
      const info = getDb()
        .prepare(
          `INSERT INTO tasks (project_id, title, description, status, proposed_by, evidence, verified_by_user, consecutive_steps, created_at, updated_at)
           VALUES (?, ?, ?, 'done_proposed', 'user', ?, 0, 0, ?, ?)`,
        )
        .run(project.id, item.title, item.description, item.evidence, ts2, ts2);
      writeAudit(project.id, "task_seed_proposed", `task#${info.lastInsertRowid}`);
    }
    return project.id;
  });
}
