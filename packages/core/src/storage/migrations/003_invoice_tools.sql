BEGIN IMMEDIATE;
ALTER TABLE sessions ADD COLUMN metadata_json TEXT NOT NULL
  DEFAULT '{"version":1,"model_use_blocked":null}' CHECK(json_valid(metadata_json));

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  goal TEXT NOT NULL CHECK(length(trim(goal))>0),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','waiting','completed','failed','cancelled')),
  status_reason TEXT,
  current_candidate_id INTEGER,
  accepted_candidate_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,document_id),
  FOREIGN KEY(current_candidate_id,id) REFERENCES invoice_candidates(id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY(accepted_candidate_id,id) REFERENCES invoice_candidates(id,job_id) ON DELETE RESTRICT,
  CHECK((status='completed' AND accepted_candidate_id IS NOT NULL)
     OR (status!='completed' AND accepted_candidate_id IS NULL))
);
CREATE INDEX jobs_recent ON jobs(id DESC);
CREATE INDEX jobs_status ON jobs(status,id DESC);

CREATE TABLE runs_v3 (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'provider' CHECK(kind IN ('provider','agent')),
  session_id INTEGER REFERENCES sessions(id) ON DELETE RESTRICT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE RESTRICT,
  scope_json TEXT CHECK(scope_json IS NULL OR json_valid(scope_json)),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK(status IN ('created','running','completed','failed','cancelled')),
  goal TEXT NOT NULL CHECK(length(trim(goal))>0),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  cleanup_json TEXT NOT NULL CHECK(json_valid(cleanup_json)),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0),
  cost TEXT,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms>=0),
  tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK(tool_call_count>=0),
  usage_complete INTEGER NOT NULL DEFAULT 0 CHECK(usage_complete IN (0,1)),
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT,
  cancel_requested_at TEXT, stopped_at TEXT,
  UNIQUE(id,session_id), UNIQUE(id,job_id),
  CHECK((kind='provider' AND session_id IS NULL AND scope_json IS NULL AND job_id IS NULL)
     OR (kind='agent' AND session_id IS NOT NULL AND scope_json IS NOT NULL)),
  CHECK((status IN ('created','running') AND ended_at IS NULL)
     OR (status IN ('completed','failed','cancelled') AND ended_at IS NOT NULL)),
  CHECK(status NOT IN ('completed','cancelled') OR stopped_at IS NOT NULL),
  CHECK(status!='completed' OR (output_json IS NOT NULL AND error_json IS NULL)),
  CHECK(status NOT IN ('failed','cancelled') OR error_json IS NOT NULL),
  CHECK(status!='cancelled' OR cancel_requested_at IS NOT NULL)
);
INSERT INTO runs_v3 (
  id,kind,session_id,scope_json,status,goal,input_json,config_json,output_json,
  error_json,cleanup_json,usage_json,input_tokens,output_tokens,total_tokens,cost,
  duration_ms,tool_call_count,usage_complete,created_at,started_at,ended_at,
  cancel_requested_at,stopped_at
) SELECT id,kind,session_id,scope_json,status,goal,input_json,config_json,output_json,
  error_json,cleanup_json,usage_json,input_tokens,output_tokens,total_tokens,cost,
  duration_ms,tool_call_count,usage_complete,created_at,started_at,ended_at,
  cancel_requested_at,stopped_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_v3 RENAME TO runs;
CREATE UNIQUE INDEX runs_one_active ON runs((1)) WHERE status IN ('created','running');
CREATE INDEX runs_recent ON runs(created_at DESC,id DESC);
CREATE INDEX runs_by_session ON runs(session_id,id DESC) WHERE session_id IS NOT NULL;
CREATE INDEX runs_by_job ON runs(job_id,id DESC) WHERE job_id IS NOT NULL;

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('original','parsed')),
  relative_path TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL CHECK(bytes>0),
  mime_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL, source_record_id TEXT NOT NULL, version TEXT NOT NULL,
  original_artifact_id INTEGER NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
  parsed_artifact_id INTEGER NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
  parser_name TEXT NOT NULL, parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','unavailable')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(source_key,source_record_id,version),
  CHECK(original_artifact_id!=parsed_artifact_id)
);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL, session_id INTEGER NOT NULL,
  native_tool_call_id TEXT NOT NULL CHECK(length(native_tool_call_id) BETWEEN 1 AND 256),
  tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 128),
  tool_version TEXT,
  effect TEXT CHECK(effect IS NULL OR effect IN ('PURE','READ','LOCAL_WRITE')),
  args_json TEXT NOT NULL CHECK(json_valid(args_json)),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','running','succeeded','failed','cancelled')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  delivery_json TEXT NOT NULL CHECK(json_valid(delivery_json)),
  cleanup_json TEXT NOT NULL CHECK(json_valid(cleanup_json)),
  requested_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, stopped_at TEXT,
  UNIQUE(session_id,native_tool_call_id), UNIQUE(id,run_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) ON DELETE RESTRICT,
  CHECK((tool_version IS NULL AND effect IS NULL AND status IN ('requested','failed','cancelled'))
     OR (tool_version IS NOT NULL AND effect IS NOT NULL)),
  CHECK((status IN ('requested','running') AND ended_at IS NULL)
     OR (status IN ('succeeded','failed','cancelled') AND ended_at IS NOT NULL AND result_json IS NOT NULL)),
  CHECK(status NOT IN ('running','succeeded') OR started_at IS NOT NULL),
  CHECK(status!='succeeded' OR stopped_at IS NOT NULL)
);
CREATE INDEX tool_calls_by_run ON tool_calls(run_id,id);

CREATE TABLE invoice_candidates (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  run_id INTEGER NOT NULL,
  tool_call_id INTEGER NOT NULL UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  origin TEXT NOT NULL CHECK(origin='model'),
  status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated','accepted','rejected')),
  fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
  lines_json TEXT NOT NULL CHECK(json_valid(lines_json)),
  issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
  created_at TEXT NOT NULL, accepted_at TEXT,
  UNIQUE(job_id,sequence), UNIQUE(id,job_id),
  FOREIGN KEY(run_id,job_id) REFERENCES runs(id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT,
  CHECK((status='accepted' AND accepted_at IS NOT NULL)
     OR (status!='accepted' AND accepted_at IS NULL))
);
CREATE UNIQUE INDEX candidate_one_accepted ON invoice_candidates(job_id) WHERE status='accepted';

CREATE TABLE workspace (
  id INTEGER PRIMARY KEY CHECK(id=1),
  active_document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT,
  active_job_id INTEGER,
  active_session_id INTEGER REFERENCES sessions(id) ON DELETE RESTRICT,
  active_view TEXT NOT NULL DEFAULT 'original' CHECK(active_view IN ('original','parsed','candidate')),
  selection_json TEXT CHECK(selection_json IS NULL),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(active_job_id,active_document_id) REFERENCES jobs(id,document_id) ON DELETE RESTRICT,
  CHECK(active_job_id IS NULL OR active_document_id IS NOT NULL)
);

CREATE TABLE business_events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('document_imported','task_started','candidate_generated','candidate_selected')),
  occurred_at TEXT NOT NULL,
  actor_source TEXT NOT NULL CHECK(actor_source IN ('user','agent','system')),
  operation_ref TEXT NOT NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE RESTRICT,
  candidate_id INTEGER REFERENCES invoice_candidates(id) ON DELETE RESTRICT,
  artifact_id INTEGER REFERENCES artifacts(id) ON DELETE RESTRICT,
  run_id INTEGER REFERENCES runs(id) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK(result IN ('succeeded','failed')),
  safe_summary TEXT NOT NULL CHECK(length(safe_summary)<=512),
  error_code TEXT,
  UNIQUE(type,operation_ref,result),
  CHECK(document_id IS NOT NULL OR job_id IS NOT NULL OR candidate_id IS NOT NULL OR artifact_id IS NOT NULL),
  CHECK((result='succeeded' AND error_code IS NULL) OR (result='failed' AND error_code IS NOT NULL))
);
CREATE INDEX activity_by_job ON business_events(job_id,id DESC);
CREATE INDEX activity_by_document ON business_events(document_id,id DESC);
INSERT INTO schema_migrations(version,applied_at) VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;