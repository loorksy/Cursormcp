import { getDb } from "../lib.js";
import { loadConfig } from "../config.js";

export function cacheGet(key) {
  const row = getDb().prepare("SELECT payload, sha, expires_at FROM intel_cache WHERE cache_key = ?").get(key);
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    getDb().prepare("DELETE FROM intel_cache WHERE cache_key = ?").run(key);
    return null;
  }
  try {
    return { sha: row.sha, payload: JSON.parse(row.payload) };
  } catch {
    return null;
  }
}

export function cacheSet(key, sha, kind, payload) {
  const ttl = loadConfig().intelCacheTtlSec * 1000;
  const now = new Date();
  const expires = new Date(now.getTime() + ttl).toISOString();
  getDb()
    .prepare(
      `INSERT INTO intel_cache (cache_key, sha, kind, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET sha = excluded.sha, payload = excluded.payload, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    )
    .run(key, sha || "", kind, JSON.stringify(payload), now.toISOString(), expires);
}

export function cacheInvalidateSha(repo, sha) {
  getDb().prepare("DELETE FROM intel_cache WHERE cache_key LIKE ? AND sha != ?").run(`${repo}|%`, sha);
}

export function accessLog({ actor, tool, repository, path, ref, requestId, status, code }) {
  getDb()
    .prepare(
      `INSERT INTO intel_access_log (ts, actor, tool, repository, path, ref, request_id, status, code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      actor || "",
      tool || "",
      repository || "",
      path || "",
      ref || "",
      requestId || "",
      status ?? 0,
      code || "",
    );
}
