type MigrationDatabase = { exec(source: string): void; prepare(source: string): { get<T = Record<string, unknown>>(...params: unknown[]): T | undefined; all<T = Record<string, unknown>>(...params: unknown[]): T[]; run(...params: unknown[]): unknown } };

export const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  current_run_id TEXT,
  status TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  candidate_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  cleanup_status TEXT NOT NULL,
  cancel_reason TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_job_idx ON agent_runs(job_id, generation);
CREATE TABLE IF NOT EXISTS artifacts (
  asset_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  request_id TEXT NOT NULL,
  raw_asset_id TEXT NOT NULL REFERENCES artifacts(asset_id),
  candidate_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, request_id)
);
CREATE TABLE IF NOT EXISTS runtime_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT,
  delegation_id TEXT,
  payload_asset_id TEXT REFERENCES artifacts(asset_id),
  at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);
CREATE TABLE IF NOT EXISTS tool_calls (
  call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  status TEXT NOT NULL,
  request_asset_id TEXT REFERENCES artifacts(asset_id),
  result_asset_id TEXT REFERENCES artifacts(asset_id),
  at TEXT NOT NULL,
  UNIQUE(run_id, request_id, request_hash)
);
CREATE TABLE IF NOT EXISTS delegations (
  delegation_id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  child_run_id TEXT REFERENCES agent_runs(run_id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_candidates (
  candidate_id TEXT PRIMARY KEY,
  candidate_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** Add fields introduced after the first P0 database was created. */
export const MIGRATION_002 = `
-- 002_runtime_evidence is applied by the guarded migration below so it can
-- upgrade both a fresh database and the first P0 development database.
`;

export function migrate(db: MigrationDatabase): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
  const existing = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("001_initial");
  if (!existing) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(MIGRATION_001);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("001_initial", new Date().toISOString());
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  // 001_initial in the current source already contains these columns. The
  // guarded ALTERs keep a database made by an earlier P0 checkout readable.
  const applied002 = db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get("002_runtime_evidence");
  if (applied002) return;
  const columnNames = (table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).flatMap((column) => typeof column.name === "string" ? [column.name] : []));
  db.exec("BEGIN IMMEDIATE;");
  try {
    const eventColumns = columnNames("runtime_events");
    if (!eventColumns.has("session_id")) db.exec("ALTER TABLE runtime_events ADD COLUMN session_id TEXT;");
    if (!eventColumns.has("delegation_id")) db.exec("ALTER TABLE runtime_events ADD COLUMN delegation_id TEXT;");
    const toolColumns = columnNames("tool_calls");
    if (!toolColumns.has("request_hash")) db.exec("ALTER TABLE tool_calls ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';");

    // The first development schema keyed tool calls by (run_id, request_id).
    // Keep that database usable when a client retries the same request id with
    // a different payload: the request digest is part of the idempotency key.
    const uniqueIndexes = db.prepare("PRAGMA index_list(tool_calls)").all() as Array<{ name?: string; unique?: number }>;
    const hasLegacyRequestIndex = uniqueIndexes.some((index) => {
      if (index.unique !== 1 || typeof index.name !== "string") return false;
      const columns = (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name?: string; seqno?: number }>)
        .sort((left, right) => (left.seqno ?? 0) - (right.seqno ?? 0))
        .map((column) => column.name);
      return columns.length === 2 && columns[0] === "run_id" && columns[1] === "request_id";
    });
    if (hasLegacyRequestIndex) {
        db.exec(`
          CREATE TABLE tool_calls_v2 (
            call_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
            request_id TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            tool_version TEXT NOT NULL,
            status TEXT NOT NULL,
            request_asset_id TEXT REFERENCES artifacts(asset_id),
            result_asset_id TEXT REFERENCES artifacts(asset_id),
            at TEXT NOT NULL,
            UNIQUE(run_id, request_id, request_hash)
          );
          INSERT INTO tool_calls_v2 (call_id, run_id, request_id, request_hash, tool_name, tool_version, status, request_asset_id, result_asset_id, at)
            SELECT call_id, run_id, request_id, request_hash, tool_name, tool_version, status, request_asset_id, result_asset_id, at FROM tool_calls;
          DROP TABLE tool_calls;
          ALTER TABLE tool_calls_v2 RENAME TO tool_calls;
        `);
      }
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("002_runtime_evidence", new Date().toISOString());
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
