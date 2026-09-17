import { createHash } from "node:crypto";
import { getDb, log } from "./lib.js";
import { ingestEvent, drainEvents } from "./events.js";
import { verifyCursorWebhookSignature, getCursorWebhookSecret } from "./webhook.js";

export function cursorV0Adapter() {
  return {
    name: "cursor_v0",
    verify(req, rawBody) {
      const secret = getCursorWebhookSecret();
      const signature = req.get("x-webhook-signature") || "";
      return verifyCursorWebhookSignature(secret, rawBody, signature);
    },
    parse(req, payload, rawBody) {
      const webhookId = req.get("x-webhook-id") || createHash("sha256").update(rawBody).digest("hex");
      const event = payload.event || req.get("x-webhook-event") || "statusChange";
      const agentId = payload.id || payload.agent?.id || "";
      const runId = payload.latestRunId || payload.run?.id || "";
      const status = payload.status || payload.run?.status || "";
      return {
        webhookId,
        type: "cursor.webhook",
        source: "cursor_v0",
        agent_id: agentId,
        run_id: runId,
        payload: {
          event,
          status,
          name: payload.name,
          summary: payload.summary,
          target: payload.target || {},
          timestamp: payload.timestamp,
        },
        idempotency_key: `cursor:${webhookId}:${event}:${status}`,
      };
    },
  };
}

export function rememberReceipt(id, source, payloadHash) {
  const result = getDb()
    .prepare(
      "INSERT OR IGNORE INTO webhook_receipts (id, source, received_at, payload_hash) VALUES (?, ?, ?, ?)",
    )
    .run(id, source, new Date().toISOString(), payloadHash);
  return result.changes > 0;
}

export async function handleWebhookGateway(req, res, adapter = cursorV0Adapter()) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
  if (!adapter.verify(req, rawBody)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid json" });
  }
  const parsed = adapter.parse(req, payload, rawBody);
  const hash = createHash("sha256").update(rawBody).digest("hex");
  rememberReceipt(parsed.webhookId, adapter.name, hash);
  const ingested = ingestEvent({
    type: parsed.type,
    source: parsed.source,
    agent_id: parsed.agent_id,
    run_id: parsed.run_id,
    payload: parsed.payload,
    idempotency_key: parsed.idempotency_key,
  });
  log("info", "webhook_accepted", {
    webhookId: parsed.webhookId,
    inserted: ingested.inserted,
    source: parsed.source,
  });
  if (process.env.BRIDGE_TEST !== "true") {
    setImmediate(() => {
      drainEvents().catch((err) => log("error", "webhook_drain", { error: err.message }));
    });
  }
  return res.status(200).json({ ok: true, duplicate: ingested.duplicate, event_id: ingested.event?.id });
}
