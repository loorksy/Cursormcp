import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.js";
import { log } from "./lib.js";
import { telegramService } from "./telegram-service.js";
import { getAgentRecord } from "./agents-store.js";
import { listTransitions } from "./state-machine.js";
import { createRun } from "./cursor-api.js";
import { stopTrackedAgent } from "./orchestrator.js";
import { maybeHeal } from "./healing.js";

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyTelegramWebhook(req) {
  const cfg = loadConfig();
  if (!cfg.telegramWebhookSecret) return true;
  const header = req.get("x-telegram-bot-api-secret-token") || "";
  return safeEqual(header, cfg.telegramWebhookSecret);
}

async function answer(token, callbackId, text) {
  const root = (process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/$/, "");
  await fetch(`${root}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: text.slice(0, 180), show_alert: true }),
  });
}

export async function handleTelegramWebhook(req, res) {
  if (!verifyTelegramWebhook(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const update = req.body || {};
  const callback = update.callback_query;
  const message = update.message;
  const fromChat = String(callback?.message?.chat?.id || message?.chat?.id || "");
  if (!telegramService.isAuthorizedChat(fromChat)) {
    log("info", "telegram_unauthorized", { chat: fromChat.slice(0, 3) + "…" });
    return res.status(200).json({ ok: true, ignored: "unauthorized_chat" });
  }

  if (callback?.data) {
    const [action, agentId] = String(callback.data).split(":");
    const agent = getAgentRecord(agentId);
    let text = "unknown action";
    try {
      if (!agent && action !== "view") text = "agent not tracked";
      else if (action === "view") {
        text = agent
          ? `${agent.name || agent.id} state=${agent.state} run=${agent.latest_run_id}`
          : "not found";
      } else if (action === "continue") {
        await createRun(agentId, { prompt: "Continue from the last result. Do not repeat finished work." });
        text = "follow-up sent";
      } else if (action === "retry") {
        await maybeHeal({
          agentId,
          project: agent.project_id ? { id: agent.project_id } : null,
          task: agent.task_id ? { id: agent.task_id } : null,
          summary: "manual retry from Telegram",
        });
        text = "retry launched";
      } else if (action === "stop") {
        await stopTrackedAgent(agentId);
        text = "cancel requested";
      } else if (action === "pr") {
        text = agent.pr_url || "no PR yet";
      } else if (action === "logs") {
        const rows = listTransitions(agentId, 5);
        text = rows.map((r) => `${r.created_at} ${r.previous_state}->${r.new_state}`).join("\n") || "no transitions";
      }
    } catch (err) {
      text = err.message || "action failed";
    }
    if (telegramService.token) {
      await answer(telegramService.token, callback.id, text).catch(() => {});
    }
    return res.status(200).json({ ok: true, action, agentId });
  }

  if (message?.text === "/status") {
    await telegramService.send_message(fromChat, "Use the dashboard at the public URL for live status.");
  }
  return res.status(200).json({ ok: true });
}
