import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getSetting, paths } from "./lib.js";
import { sendTelegramMessage } from "./telegram-notify.js";

export function getCursorWebhookUrl() {
  const base = (process.env.PUBLIC_BASE_URL || "https://mcp.lork.cloud").replace(/\/$/, "");
  return `${base}/webhooks/cursor-agent`;
}

export function getCursorWebhookSecret() {
  return (process.env.CURSOR_WEBHOOK_SECRET || "").trim();
}

export function outboundWebhookConfig() {
  const secret = getCursorWebhookSecret();
  if (secret.length < 32) return null;
  return { url: getCursorWebhookUrl(), secret };
}

function webhookSecret() {
  return getCursorWebhookSecret();
}

export function verifyCursorWebhookSignature(secret, rawBody, signatureHeader) {
  if (!secret || !signatureHeader || rawBody == null) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const left = Buffer.from(String(signatureHeader));
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function ensureNotifyLogTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS telegram_notify_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT ''
    );
  `);
}

export function listTelegramNotifyLog(limit = 20) {
  ensureNotifyLogTable();
  return getDb()
    .prepare(
      "SELECT ts, agent_id, status, sent, detail FROM telegram_notify_log ORDER BY id DESC LIMIT ?",
    )
    .all(limit);
}

function recordNotify(agentId, status, sent, detail) {
  ensureNotifyLogTable();
  getDb()
    .prepare(
      "INSERT INTO telegram_notify_log (ts, agent_id, status, sent, detail) VALUES (?, ?, ?, ?, ?)",
    )
    .run(new Date().toISOString(), agentId || "", status || "", sent ? 1 : 0, detail || "");
}

function logWebhookLine(entry) {
  try {
    appendFileSync(join(paths.logs, "webhooks.log"), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // never throw from logging
  }
}

function statusLabel(status) {
  if (status === "FINISHED") return "انتهى بنجاح";
  if (status === "ERROR") return "فشل";
  return status || "غير معروف";
}

function buildTelegramText(payload) {
  const name = payload.name || payload.id || "agent";
  const status = statusLabel(payload.status);
  const summary = payload.summary ? String(payload.summary) : "—";
  const prUrl = payload.target?.prUrl || "—";
  const followUrl = payload.target?.url || "—";
  const finishedAt = payload.timestamp || new Date().toISOString();
  return [
    "إشعار Cursor Agent",
    `الاسم: ${name}`,
    `الحالة: ${status}`,
    `الملخص: ${summary}`,
    `رابط PR: ${prUrl}`,
    `متابعة الـ agent: ${followUrl}`,
    `وقت الانتهاء: ${finishedAt}`,
  ].join("\n");
}

export async function handleCursorWebhook(req, res) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  const signature = req.get("x-webhook-signature") || "";
  const secret = webhookSecret();

  if (!verifyCursorWebhookSignature(secret, rawBody, signature)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid json" });
  }

  const event = payload.event || req.get("x-webhook-event") || "";
  const agentId = payload.id || "";
  const status = payload.status || "";
  const webhookId = req.get("x-webhook-id") || "";

  logWebhookLine({
    ts: new Date().toISOString(),
    webhookId,
    event,
    agentId,
    status,
  });

  const enabled = getSetting("telegram_notify_enabled", "true") !== "false";
  const shouldNotify =
    enabled && event === "statusChange" && (status === "FINISHED" || status === "ERROR");

  if (!shouldNotify) {
    if (enabled && event === "statusChange") {
      recordNotify(agentId, status, 0, "ignored");
    }
    return res.status(200).json({ ok: true });
  }

  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    recordNotify(agentId, status, 0, "telegram_not_configured");
    return res.status(200).json({ ok: true });
  }

  try {
    await sendTelegramMessage(token, chatId, buildTelegramText(payload));
    recordNotify(agentId, status, 1, "sent");
  } catch (err) {
    recordNotify(agentId, status, 0, "telegram_send_failed");
  }

  return res.status(200).json({ ok: true });
}
