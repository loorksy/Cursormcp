import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { contextFields } from "./context.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnvFile(path = join(ROOT, ".env")) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

export const paths = {
  root: ROOT,
  data: process.env.DATA_DIR ? join(process.env.DATA_DIR) : join(ROOT, "data"),
  logs: process.env.LOG_DIR ? join(process.env.LOG_DIR) : join(ROOT, "logs"),
  public: join(ROOT, "public"),
};

export function ensureDirs() {
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
}

const SENSITIVE = /api[_-]?key|authorization|password|secret|token|cookie/i;

function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 8 && SENSITIVE.test(value)) return `${value.slice(0, 2)}…${value.slice(-4)}`;
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? maskSecret(String(v ?? "")) : redact(v);
    }
    return out;
  }
  return value;
}

export function maskSecret(secret) {
  if (!secret) return "";
  const last = secret.slice(-4);
  return `••••${last}`;
}

export function log(level, message, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...contextFields(),
    ...redact(extra),
  });
  const dest = level === "error" ? process.stderr : process.stdout;
  dest.write(line + "\n");
  try {
    appendFileSync(join(paths.logs, "bridge.log"), line + "\n", { mode: 0o600 });
  } catch {
    // logging must never crash the process
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !password || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function keyFromSecret(secret) {
  return createHash("sha256").update(String(secret || "")).digest();
}

export function encryptSecret(plain, secret) {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(payload, secret) {
  if (!payload) return "";
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) return "";
  const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

let db;

export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(join(paths.data, "app.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      method TEXT,
      path TEXT,
      tool TEXT,
      status INTEGER,
      detail TEXT
    );
  `);
  return db;
}

export function getSetting(key, fallback = "") {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, String(value ?? ""), now);
}

export function listSettings() {
  return getDb().prepare("SELECT key, value, updated_at FROM settings ORDER BY key").all();
}

export function seedDefaultSettings() {
  const defaults = {
    max_concurrent_agents: "5",
    default_repos: "[]",
    default_model: "",
    default_ref: "main",
    auto_create_pr: "false",
    mcp_require_token: "true",
    telegram_notify_enabled: "true",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (getSetting(key) === "") setSetting(key, value);
  }
}

export function createSession(ttlMs = 1000 * 60 * 60 * 12) {
  const id = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + ttlMs;
  getDb()
    .prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)")
    .run(id, new Date().toISOString(), expiresAt);
  return { id, expiresAt };
}

export function validSession(id) {
  if (!id) return false;
  const row = getDb().prepare("SELECT expires_at FROM sessions WHERE id = ?").get(id);
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return false;
  }
  return true;
}

export function destroySession(id) {
  if (!id) return;
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function logRequest({ source, method, path, tool, status, detail }) {
  getDb()
    .prepare(
      "INSERT INTO request_log (ts, source, method, path, tool, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(new Date().toISOString(), source, method || "", path || "", tool || "", status ?? null, detail || "");
}

export function recentRequests(limit = 50) {
  return getDb()
    .prepare("SELECT ts, source, method, path, tool, status, detail FROM request_log ORDER BY id DESC LIMIT ?")
    .all(limit);
}

export function parseCookie(header, name) {
  if (!header) return "";
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(name + "=")) return part.slice(name.length + 1);
  }
  return "";
}

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

export function updateDotEnv(updates) {
  const envPath = join(paths.root, ".env");
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    if (!ENV_KEY.test(key)) continue;
    const serialized = `${key}=${String(value ?? "")}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, serialized);
    else text = text.replace(/\s*$/, "\n") + serialized + "\n";
    process.env[key] = String(value ?? "");
  }
  writeFileSync(envPath, text, { mode: 0o600 });
}

export function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
