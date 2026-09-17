import express from "express";
import { timingSafeEqual } from "node:crypto";
import {
  apiKeyConfigured,
  createAgent,
  createRun,
  CursorApiError,
  enrichAgent,
  getAgent,
  listAgents,
  listModels,
  listRepositories,
  me,
} from "./cursor-api.js";
import {
  createSession,
  decryptSecret,
  destroySession,
  encryptSecret,
  getSetting,
  listSettings,
  loadEnvFile,
  log,
  logRequest,
  maskSecret,
  parseCookie,
  paths,
  recentRequests,
  seedDefaultSettings,
  setSetting,
  validSession,
  verifyPassword,
  ensureDirs,
  safeJson,
  updateDotEnv,
} from "./lib.js";
import { handleMcpPost, handleMcpSession, mcpSessionCount } from "./mcp.js";
import { mountOAuth } from "./oauth.js";
import { sendTelegramMessage } from "./telegram-notify.js";
import { handleCursorWebhook, listTelegramNotifyLog } from "./webhook.js";

loadEnvFile();
ensureDirs();
seedDefaultSettings();

const startedAt = Date.now();
const PORT = Number(process.env.PORT || 18800);
const HOST = process.env.HOST || "127.0.0.1";
const COOKIE = "bridge_sid";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.post(
  "/webhooks/cursor-agent",
  express.raw({ type: "*/*", limit: "1mb" }),
  (req, res, next) => {
    handleCursorWebhook(req, res).catch(next);
  },
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path === "/health" && req.method === "GET") return;
    log("info", "http", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      source: req.path.startsWith("/mcp") ? "mcp" : "web",
    });
  });
  next();
});

function sessionIdFrom(req) {
  return parseCookie(req.headers.cookie, COOKIE);
}

function requireAuth(req, res, next) {
  if (validSession(sessionIdFrom(req))) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  return res.redirect("/login");
}

function timingSafeString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function mcpAuthorized(req) {
  const required = getSetting("mcp_require_token", "true") !== "false";
  if (!required) return true;
  const header = req.headers.authorization || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const expected = process.env.MCP_AUTH_TOKEN || "";
  return Boolean(expected) && timingSafeString(token, expected);
}

function publicHealth() {
  return {
    ok: true,
    service: "mcp-cursor-bridge",
    mcp: {
      listening: true,
      path: "/mcp",
      sessions: mcpSessionCount(),
      oauth: true,
    },
    apiKeyConfigured: apiKeyConfigured(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    port: PORT,
  };
}

app.get("/health", (req, res) => {
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml) return res.sendFile(paths.public + "/health.html");
  res.json(publicHealth());
});

app.get("/login", (req, res) => {
  if (validSession(sessionIdFrom(req))) return res.redirect("/");
  res.sendFile(paths.public + "/login.html");
});

app.post("/api/login", (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  const expectedUser = process.env.ADMIN_USERNAME || "admin";
  const expectedHash = process.env.ADMIN_PASSWORD_HASH || "";
  const userOk = timingSafeString(username, expectedUser);
  const passOk = verifyPassword(password, expectedHash);
  if (!userOk || !passOk) {
    logRequest({ source: "web", method: "POST", path: "/api/login", status: 401, detail: "invalid" });
    return res.status(401).json({ error: "invalid credentials" });
  }
  const session = createSession();
  res.cookie(COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    expires: new Date(session.expiresAt),
  });
  logRequest({ source: "web", method: "POST", path: "/api/login", status: 200, detail: "ok" });
  res.json({ ok: true });
});

app.post("/api/logout", requireAuth, (req, res) => {
  destroySession(sessionIdFrom(req));
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

const { oauthBearer } = mountOAuth(app, { timingSafeString });

function requireMcp(req, res, next) {
  if (mcpAuthorized(req)) return next();
  return oauthBearer(req, res, next);
}

app.post("/mcp", requireMcp, handleMcpPost);
app.get("/mcp", requireMcp, handleMcpSession);
app.delete("/mcp", requireMcp, handleMcpSession);

app.use("/api", requireAuth);

function handleApiError(res, err) {
  if (err.code === "NO_API_KEY") {
    return res.status(400).json({ error: "CURSOR_AGENTS_API_KEY is not set. Add it from Settings." });
  }
  if (err instanceof CursorApiError) {
    return res.status(err.status).json({ error: err.message, details: err.body });
  }
  log("error", "api_error", { error: err.message });
  return res.status(500).json({ error: err.message });
}

app.get("/api/me", (req, res) => {
  res.json({
    username: process.env.ADMIN_USERNAME || "admin",
    apiKeyConfigured: apiKeyConfigured(),
    apiKeyMasked: apiKeyConfigured() ? maskSecret(getApiKeySafe()) : "",
  });
});

function getApiKeySafe() {
  try {
    const enc = getSetting("cursor_api_key_enc");
    const fromDb = enc ? decryptSecret(enc, process.env.APP_SECRET) : "";
    return fromDb || process.env.CURSOR_AGENTS_API_KEY || "";
  } catch {
    return "";
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ...publicHealth(),
    recent: recentRequests(20),
  });
});

app.get("/api/settings", (req, res) => {
  const hidden = new Set(["cursor_api_key_enc", "telegram_notify_enabled"]);
  const items = listSettings()
    .filter((row) => !hidden.has(row.key))
    .map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  res.json({
    items,
    apiKeyMasked: apiKeyConfigured() ? maskSecret(getApiKeySafe()) : "",
    apiKeyConfigured: apiKeyConfigured(),
    mcpUrl: "https://mcp.lork.cloud/mcp",
    mcpTokenSet: Boolean(process.env.MCP_AUTH_TOKEN),
  });
});

app.put("/api/settings", (req, res) => {
  const entries = req.body?.settings;
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: "settings array required" });
  }
  const blocked = new Set(["cursor_api_key_enc", "telegram_notify_enabled"]);
  for (const entry of entries) {
    if (!entry?.key || blocked.has(entry.key)) continue;
    if (!/^[a-z0-9_]+$/.test(entry.key)) continue;
    setSetting(entry.key, entry.value ?? "");
  }
  res.json({ ok: true });
});

app.put("/api/settings/api-key", (req, res) => {
  const key = String(req.body?.apiKey || "").trim();
  if (!key) return res.status(400).json({ error: "apiKey is required" });
  setSetting("cursor_api_key_enc", encryptSecret(key, process.env.APP_SECRET));
  logRequest({ source: "web", method: "PUT", path: "/api/settings/api-key", status: 200, detail: maskSecret(key) });
  res.json({ ok: true, masked: maskSecret(key) });
});

app.get("/api/agents", async (req, res) => {
  try {
    const listed = await listAgents({ limit: Number(req.query.limit || 30) });
    const items = [];
    for (const agent of listed.items || []) {
      items.push(await enrichAgent(agent));
    }
    logRequest({ source: "web", method: "GET", path: "/api/agents", status: 200, detail: String(items.length) });
    res.json({ items, nextCursor: listed.nextCursor || null });
  } catch (err) {
    handleApiError(res, err);
  }
});

app.get("/api/agents/:id", async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    const enriched = await enrichAgent(agent);
    res.json(enriched);
  } catch (err) {
    handleApiError(res, err);
  }
});

app.post("/api/agents", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    const defaultRepos = safeJson(getSetting("default_repos") || "[]", []);
    const repository = String(req.body?.repository || defaultRepos[0] || "").trim();
    const created = await createAgent({
      prompt,
      repository,
      ref: req.body?.ref || getSetting("default_ref") || undefined,
      model: req.body?.model || getSetting("default_model") || undefined,
      autoCreatePR: req.body?.autoCreatePR ?? getSetting("auto_create_pr") === "true",
      name: req.body?.name,
    });
    logRequest({
      source: "web",
      method: "POST",
      path: "/api/agents",
      status: 200,
      detail: created?.agent?.id || "",
    });
    res.json(created);
  } catch (err) {
    handleApiError(res, err);
  }
});

app.post("/api/agents/:id/followup", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt is required" });
    const run = await createRun(req.params.id, { prompt, mode: req.body?.mode });
    logRequest({
      source: "web",
      method: "POST",
      path: "/api/agents/followup",
      status: 200,
      detail: req.params.id,
    });
    res.json(run);
  } catch (err) {
    handleApiError(res, err);
  }
});

app.get("/api/models", async (req, res) => {
  try {
    res.json(await listModels());
  } catch (err) {
    handleApiError(res, err);
  }
});

app.get("/api/telegram", (req, res) => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  res.json({
    enabled: getSetting("telegram_notify_enabled", "true") !== "false",
    botTokenConfigured: Boolean(token),
    botTokenMasked: token ? maskSecret(token) : "",
    chatIdConfigured: Boolean(chatId),
    chatIdMasked: chatId ? maskSecret(chatId) : "",
    webhookUrl: "https://mcp.lork.cloud/webhooks/cursor-agent",
    webhookSecret: (process.env.CURSOR_WEBHOOK_SECRET || "").trim(),
    recent: listTelegramNotifyLog(20),
  });
});

app.put("/api/telegram", (req, res) => {
  const updates = {};
  if (typeof req.body?.botToken === "string" && req.body.botToken.trim()) {
    updates.TELEGRAM_BOT_TOKEN = req.body.botToken.trim();
  }
  if (typeof req.body?.chatId === "string" && req.body.chatId.trim()) {
    updates.TELEGRAM_CHAT_ID = req.body.chatId.trim();
  }
  if (typeof req.body?.enabled === "boolean") {
    setSetting("telegram_notify_enabled", req.body.enabled ? "true" : "false");
  }
  if (Object.keys(updates).length) updateDotEnv(updates);
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  res.json({
    ok: true,
    botTokenMasked: token ? maskSecret(token) : "",
    enabled: getSetting("telegram_notify_enabled", "true") !== "false",
  });
});

app.post("/api/telegram/test", async (req, res) => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) {
    return res.status(400).json({ error: "التوكن غير مُعد بعد" });
  }
  if (getSetting("telegram_notify_enabled", "true") === "false") {
    return res.status(400).json({ error: "إشعارات تيليجرام معطّلة" });
  }
  try {
    await sendTelegramMessage(
      token,
      chatId,
      "رسالة اختبار من MCP Cursor Bridge — الربط يعمل.",
    );
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: "تعذر إرسال رسالة تيليجرام. تحقق من التوكن وChat ID." });
  }
});

app.get("/api/repos", async (req, res) => {
  try {
    res.json(await listRepositories());
  } catch (err) {
    handleApiError(res, err);
  }
});

app.get("/api/cursor-me", async (req, res) => {
  try {
    res.json(await me());
  } catch (err) {
    handleApiError(res, err);
  }
});

app.get("/", requireAuth, (req, res) => {
  res.sendFile(paths.public + "/app.html");
});

app.use(express.static(paths.public, { index: false, maxAge: "1h" }));

app.use((req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/mcp")) {
    return res.status(404).json({ error: "not found" });
  }
  res.status(404).send("Not found");
});

app.listen(PORT, HOST, () => {
  log("info", "listening", { host: HOST, port: PORT });
});
