import { getDb } from "./lib.js";

function columnNames(table) {
  return getDb()
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function addColumn(table, name, ddl) {
  if (!columnNames(table).includes(name)) {
    getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

export function ensureOrchestratorTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id INTEGER,
      task_id INTEGER,
      role TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      repository TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      pr_url TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'QUEUED',
      cursor_agent_status TEXT NOT NULL DEFAULT '',
      latest_run_id TEXT NOT NULL DEFAULT '',
      retry_count INTEGER NOT NULL DEFAULT 0,
      correlation_id TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      pr_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_state_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL DEFAULT '',
      project_id INTEGER,
      task_id INTEGER,
      previous_state TEXT NOT NULL,
      new_state TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      project_id INTEGER,
      task_id INTEGER,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      processed_at TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS event_dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      error TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id INTEGER NOT NULL,
      depends_on_task_id INTEGER NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id)
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      project_id INTEGER,
      task_id INTEGER,
      kind TEXT NOT NULL,
      passed INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'telegram',
      chat_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_receipts (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_notify_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed_at, attempts);
    CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state);
    CREATE TABLE IF NOT EXISTS intel_cache (
      cache_key TEXT PRIMARY KEY,
      sha TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS intel_access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      repository TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL DEFAULT '',
      status INTEGER NOT NULL,
      code TEXT NOT NULL DEFAULT ''
    );
  `);
  addColumn("tasks", "role", "TEXT NOT NULL DEFAULT ''");
  addColumn("tasks", "blocked_reason", "TEXT NOT NULL DEFAULT ''");
  addColumn("projects", "goal", "TEXT NOT NULL DEFAULT ''");
  addColumn("projects", "stack_json", "TEXT NOT NULL DEFAULT ''");
  addColumn("projects", "verify_json", "TEXT NOT NULL DEFAULT ''");
}
