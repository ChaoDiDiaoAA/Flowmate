BEGIN IMMEDIATE;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  native_session_id TEXT NOT NULL UNIQUE CHECK(length(native_session_id) BETWEEN 1 AND 128),
  title TEXT NOT NULL DEFAULT 'New Session' CHECK(length(trim(title)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sessions_recent ON sessions(updated_at DESC, id DESC);

CREATE TABLE runs_v2 (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'provider' CHECK(kind IN ('provider','agent')),
  session_id INTEGER REFERENCES sessions(id) ON DELETE RESTRICT,
  scope_json TEXT CHECK(scope_json IS NULL OR json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','running','completed','failed','cancelled')),
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
  CHECK((kind='provider' AND session_id IS NULL AND scope_json IS NULL)
     OR (kind='agent' AND session_id IS NOT NULL AND scope_json IS NOT NULL)),
  CHECK((status IN ('created','running') AND ended_at IS NULL)
     OR (status IN ('completed','failed','cancelled') AND ended_at IS NOT NULL)),
  CHECK(status NOT IN ('completed','cancelled') OR stopped_at IS NOT NULL),
  CHECK(status != 'completed' OR (output_json IS NOT NULL AND error_json IS NULL)),
  CHECK(status NOT IN ('failed','cancelled') OR error_json IS NOT NULL),
  CHECK(status != 'cancelled' OR cancel_requested_at IS NOT NULL)
);

INSERT INTO runs_v2 (
  id,kind,session_id,scope_json,status,goal,input_json,config_json,output_json,
  error_json,cleanup_json,usage_json,input_tokens,output_tokens,total_tokens,
  cost,duration_ms,tool_call_count,usage_complete,created_at,started_at,ended_at,
  cancel_requested_at,stopped_at
)
SELECT id,kind,NULL,NULL,status,goal,input_json,config_json,output_json,
  error_json,cleanup_json,usage_json,input_tokens,output_tokens,total_tokens,
  cost,duration_ms,tool_call_count,usage_complete,created_at,started_at,ended_at,
  cancel_requested_at,stopped_at
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;
CREATE UNIQUE INDEX runs_one_active ON runs((1)) WHERE status IN ('created','running');
CREATE INDEX runs_recent ON runs(created_at DESC, id DESC);
CREATE INDEX runs_by_session ON runs(session_id, id DESC) WHERE session_id IS NOT NULL;
INSERT INTO schema_migrations(version, applied_at) VALUES(2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
