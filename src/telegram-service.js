import { allowedTelegramChatIds, loadConfig } from "./config.js";
import { getDb, log } from "./lib.js";

const MIN_INTERVAL_MS = 80;
let lastSendAt = 0;
const windowHits = [];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assertRateLimit() {
  const now = Date.now();
  while (windowHits.length && now - windowHits[0] > 60_000) windowHits.shift();
  if (windowHits.length >= 20) {
    const err = new Error("telegram_rate_limited");
    err.code = "TELEGRAM_RATE_LIMIT";
    throw err;
  }
}

async function telegramFetch(token, method, body, timeoutMs) {
  const root = (process.env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/$/, "");
  const url = `${root}/bot${token}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const err = new Error(json.description || "telegram_send_failed");
      err.code = "TELEGRAM_SEND_FAILED";
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export class TelegramService {
  constructor(opts = {}) {
    this.token = opts.token || loadConfig().telegramBotToken;
    this.timeoutMs = opts.timeoutMs || 8000;
    this.maxRetries = opts.maxRetries || 3;
  }

  configured() {
    return Boolean(this.token);
  }

  targets() {
    const ids = [...allowedTelegramChatIds()];
    const extras = getDb()
      .prepare("SELECT chat_id FROM notification_targets WHERE kind = 'telegram' AND enabled = 1")
      .all();
    for (const row of extras) ids.push(String(row.chat_id));
    return [...new Set(ids.filter(Boolean))];
  }

  isAuthorizedChat(chatId) {
    return allowedTelegramChatIds().has(String(chatId));
  }

  async send_message(chatId, text, extra = {}) {
    if (!this.token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    assertRateLimit();
    const wait = MIN_INTERVAL_MS - (Date.now() - lastSendAt);
    if (wait > 0) await sleep(wait);
    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await telegramFetch(
          this.token,
          "sendMessage",
          {
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
            ...extra,
          },
          this.timeoutMs,
        );
        lastSendAt = Date.now();
        windowHits.push(lastSendAt);
        log("info", "telegram_sent", { chatId: String(chatId).slice(0, 4) + "…", attempt });
        return result;
      } catch (err) {
        lastErr = err;
        if (err.code === "TELEGRAM_RATE_LIMIT") throw err;
        log("error", "telegram_send_retry", { attempt, error: err.message });
        await sleep(200 * attempt);
      }
    }
    throw lastErr;
  }

  async send_markdown_message(chatId, text) {
    try {
      return await this.send_message(chatId, text, { parse_mode: "Markdown" });
    } catch {
      return this.send_message(chatId, text);
    }
  }

  async broadcast(text, extra) {
    const targets = this.targets();
    if (!targets.length) {
      log("info", "telegram_skip", { reason: "no_targets" });
      return { sent: 0 };
    }
    let sent = 0;
    for (const chatId of targets) {
      await this.send_message(chatId, text, extra);
      sent += 1;
    }
    return { sent };
  }

  async send_event_notification(event) {
    const text = [
      "MCP Event",
      `type: ${event.type}`,
      event.agent_id ? `agent: ${event.agent_id}` : null,
      event.run_id ? `run: ${event.run_id}` : null,
      event.task_id ? `task: ${event.task_id}` : null,
      event.project_id ? `project: ${event.project_id}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    return this.broadcast(text);
  }

  send_agent_started(agent) {
    return this.broadcast(`Agent started: ${agent.name || agent.id}\nstate: ${agent.state || "RUNNING"}`);
  }

  send_agent_completed(agent) {
    return this.broadcast(
      `Agent completed: ${agent.name || agent.id}\nPR: ${agent.pr_url || "—"}\nbranch: ${agent.branch || "—"}`,
    );
  }

  send_agent_failed(agent, reason) {
    return this.broadcast(`Agent failed: ${agent.name || agent.id}\nreason: ${reason || "unknown"}`);
  }

  send_task_blocked(task, reason) {
    return this.broadcast(`Task blocked: #${task.id} ${task.title || ""}\nreason: ${reason || task.blocked_reason || ""}`);
  }

  send_pr_created(pr) {
    return this.broadcast(`PR recorded: ${pr.pr_url || pr.html_url || pr.url}`);
  }

  send_test_failure(summary) {
    return this.broadcast(`Verification failed\n${summary}`);
  }

  keyboardFor(agent) {
    const id = agent.id;
    return {
      inline_keyboard: [
        [
          { text: "View Result", callback_data: `view:${id}` },
          { text: "Continue Agent", callback_data: `continue:${id}` },
        ],
        [
          { text: "Retry", callback_data: `retry:${id}` },
          { text: "Stop Agent", callback_data: `stop:${id}` },
        ],
        [
          { text: "View PR", callback_data: `pr:${id}` },
          { text: "View Logs", callback_data: `logs:${id}` },
        ],
      ],
    };
  }

  async sendWithControls(agent, text) {
    const extra = { reply_markup: this.keyboardFor(agent) };
    return this.broadcast(text, extra);
  }
}

export const telegramService = new TelegramService();

export async function sendTelegramMessage(token, chatId, text, timeoutMs = 8000) {
  const svc = new TelegramService({ token, timeoutMs });
  return svc.send_message(chatId, text);
}
