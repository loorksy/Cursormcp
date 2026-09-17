import { getDb } from "./lib.js";
import { listAgentRecords, getAgentRecord, listRunRecords } from "./agents-store.js";
import { listTransitions } from "./state-machine.js";
import { listEvents, getEvent, retryEvent, drainEvents } from "./events.js";
import { launchTrackedAgent, stopTrackedAgent, orchestrateProject } from "./orchestrator.js";
import { pollOnce } from "./polling.js";
import { latestVerification } from "./verification.js";
import { telegramService } from "./telegram-service.js";
import { mcpSessionCount } from "./mcp.js";

export function publicReady() {
  try {
    getDb().prepare("SELECT 1 AS ok").get();
    return { ok: true, db: true, mcpSessions: mcpSessionCount() };
  } catch (err) {
    return { ok: false, db: false, error: err.message };
  }
}

export function mountV2Routes(app) {
  app.get("/api/v2/agents", (_req, res) => {
    res.json({ items: listAgentRecords({ limit: 100 }) });
  });
  app.get("/api/v2/agents/:id", (req, res) => {
    const record = getAgentRecord(req.params.id);
    if (!record) return res.status(404).json({ error: "not found" });
    res.json({
      record,
      runs: listRunRecords(req.params.id),
      transitions: listTransitions(req.params.id, 50),
      verifications: latestVerification(req.params.id),
    });
  });
  app.post("/api/v2/agents", async (req, res, next) => {
    try {
      res.json(await launchTrackedAgent(req.body || {}));
    } catch (err) {
      next(err);
    }
  });
  app.post("/api/v2/agents/:id/stop", async (req, res, next) => {
    try {
      res.json(await stopTrackedAgent(req.params.id));
    } catch (err) {
      next(err);
    }
  });
  app.get("/api/v2/events", (req, res) => {
    res.json({ items: listEvents({ limit: Number(req.query.limit || 50), type: req.query.type }) });
  });
  app.get("/api/v2/events/:id", (req, res) => {
    const row = getEvent(req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  });
  app.post("/api/v2/events/:id/retry", async (req, res, next) => {
    try {
      res.json(await retryEvent(req.params.id));
    } catch (err) {
      next(err);
    }
  });
  app.post("/api/v2/events/drain", async (_req, res, next) => {
    try {
      res.json({ items: await drainEvents(50) });
    } catch (err) {
      next(err);
    }
  });
  app.post("/api/v2/projects/:id/orchestrate", async (req, res, next) => {
    try {
      res.json(await orchestrateProject(Number(req.params.id), req.body || {}));
    } catch (err) {
      next(err);
    }
  });
  app.post("/api/v2/poll", async (_req, res, next) => {
    try {
      res.json(await pollOnce());
    } catch (err) {
      next(err);
    }
  });
  app.post("/api/v2/telegram/test", async (_req, res, next) => {
    try {
      res.json(await telegramService.broadcast("رسالة اختبار V2"));
    } catch (err) {
      next(err);
    }
  });
}
