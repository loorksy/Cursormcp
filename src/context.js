import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const store = new AsyncLocalStorage();

export function currentContext() {
  return store.getStore() || {};
}

export function withContext(extra, fn) {
  const parent = currentContext();
  const next = {
    ...parent,
    ...extra,
    correlationId: extra.correlationId || parent.correlationId || randomUUID(),
  };
  return store.run(next, fn);
}

export function contextFields() {
  const c = currentContext();
  const out = {};
  for (const key of [
    "correlationId",
    "agentId",
    "runId",
    "taskId",
    "projectId",
    "webhookId",
    "eventId",
  ]) {
    if (c[key] != null && c[key] !== "") out[key] = c[key];
  }
  return out;
}
