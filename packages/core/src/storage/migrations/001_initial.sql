-- Canonical P0 schema. The TypeScript migration runner keeps this same
-- definition inline so it can apply guarded upgrades to older development
-- databases; this file is the reviewable SQL artifact used for audits.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

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
