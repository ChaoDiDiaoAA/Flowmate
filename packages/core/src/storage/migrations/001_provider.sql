PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 1000;
PRAGMA journal_mode = DELETE;
PRAGMA locking_mode = EXCLUSIVE;
BEGIN EXCLUSIVE;
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE CHECK(version > 0),
  applied_at TEXT NOT NULL
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'provider' CHECK(kind = 'provider'),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK(status IN ('created','running','completed','failed','cancelled')),
  goal TEXT NOT NULL CHECK(length(trim(goal)) > 0),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  cleanup_json TEXT NOT NULL CHECK(json_valid(cleanup_json)),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
  cost TEXT,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_call_count = 0),
  usage_complete INTEGER NOT NULL DEFAULT 0 CHECK(usage_complete IN (0,1)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  cancel_requested_at TEXT,
  stopped_at TEXT,
  CHECK((status IN ('created','running') AND ended_at IS NULL)
     OR (status IN ('completed','failed','cancelled') AND ended_at IS NOT NULL)),
  CHECK(status NOT IN ('completed','cancelled') OR stopped_at IS NOT NULL),
  CHECK(status != 'completed' OR (output_json IS NOT NULL AND error_json IS NULL)),
  CHECK(status NOT IN ('failed','cancelled') OR error_json IS NOT NULL),
  CHECK(status != 'cancelled' OR cancel_requested_at IS NOT NULL)
);
CREATE UNIQUE INDEX runs_one_active ON runs((1))
  WHERE status IN ('created','running');
CREATE INDEX runs_recent ON runs(created_at DESC, id DESC);
INSERT INTO schema_migrations(version, applied_at)
VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
