import { randomUUID } from "node:crypto";

export const AGENT_STATES = Object.freeze([
  "CREATING",
  "QUEUED",
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

export const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);

export const TASK_STATES = Object.freeze([
  "pending",
  "blocked",
  "in_progress",
  "partial",
  "failed",
  "done_proposed",
  "done_verified",
]);

export const AGENT_ROLES = Object.freeze([
  "Planner",
  "Architect",
  "Backend",
  "Frontend",
  "Database",
  "DevOps",
  "Security",
  "QA",
  "Testing",
  "UI/UX",
  "Code Reviewer",
  "Documentation",
]);

export function loadConfig() {
  const num = (key, fallback) => {
    const n = Number(process.env[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const list = (key) =>
    String(process.env[key] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    port: Number(process.env.PORT || 18800),
    host: process.env.HOST || "127.0.0.1",
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "https://mcp.lork.cloud").replace(/\/$/, ""),
    cursorApiBase: (process.env.CURSOR_API_BASE_URL || "https://api.cursor.com").replace(/\/$/, ""),
    pollIntervalSec: num("POLL_INTERVAL_SECONDS", 30),
    maxAgentRetries: num("MAX_AGENT_RETRIES", 2),
    maxEventAttempts: num("MAX_EVENT_ATTEMPTS", 5),
    githubToken: (process.env.GITHUB_TOKEN || "").trim(),
    githubAllowedRepos: list("GITHUB_ALLOWED_REPOS"),
    intelLocalRoot: (process.env.INTEL_LOCAL_ROOT || "").trim(),
    intelLocalRepos: list("INTEL_LOCAL_REPOS"),
    intelMaxTreeItems: num("INTEL_MAX_TREE_ITEMS", 500),
    intelMaxFileBytes: num("INTEL_MAX_FILE_BYTES", 100000),
    intelMaxBatchFiles: num("INTEL_MAX_BATCH_FILES", 20),
    intelMaxSearch: num("INTEL_MAX_SEARCH_RESULTS", 50),
    intelMaxResponseBytes: num("INTEL_MAX_RESPONSE_BYTES", 400000),
    intelCacheTtlSec: num("INTEL_CACHE_TTL_SECONDS", 300),
    telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    telegramChatId: (process.env.TELEGRAM_CHAT_ID || "").trim(),
    telegramAllowedChatIds: list("TELEGRAM_ALLOWED_CHAT_IDS"),
    telegramWebhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim(),
    cursorWebhookSecret: (process.env.CURSOR_WEBHOOK_SECRET || "").trim(),
  };
}

export function allowedTelegramChatIds() {
  const cfg = loadConfig();
  const ids = new Set(cfg.telegramAllowedChatIds);
  if (cfg.telegramChatId) ids.add(cfg.telegramChatId);
  return ids;
}

export function newId(prefix = "") {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
