-- statement
BEGIN IMMEDIATE;
-- statement
CREATE TABLE runs_p13 (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'provider' CHECK(kind IN ('provider','agent','subagent')),
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
  current_context_snapshot_id INTEGER REFERENCES context_snapshots(id) ON DELETE RESTRICT
    CHECK(current_context_snapshot_id IS NULL OR kind IN ('agent','subagent')),
  context_observations_json TEXT CHECK(context_observations_json IS NULL OR
    CASE WHEN json_valid(context_observations_json) THEN COALESCE(
      json_type(context_observations_json,'$.version')='integer'
      AND json_extract(context_observations_json,'$.version')=1
      AND length(CAST(context_observations_json AS BLOB))<=4194304,0) ELSE 0 END),
  parent_run_id INTEGER REFERENCES runs(id) ON DELETE RESTRICT,
  origin_tool_call_id INTEGER,
  plugin_agent_id TEXT CHECK(plugin_agent_id IS NULL OR length(plugin_agent_id) BETWEEN 1 AND 256),
  UNIQUE(id,session_id), UNIQUE(id,job_id),
  FOREIGN KEY(origin_tool_call_id,parent_run_id)
    REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT,
  CHECK((kind='provider' AND session_id IS NULL AND scope_json IS NULL AND job_id IS NULL)
    OR (kind IN ('agent','subagent') AND session_id IS NOT NULL AND scope_json IS NOT NULL)),
  CHECK((kind='subagent' AND parent_run_id IS NOT NULL AND origin_tool_call_id IS NOT NULL
      AND plugin_agent_id IS NOT NULL AND parent_run_id!=id)
    OR (kind!='subagent' AND parent_run_id IS NULL AND origin_tool_call_id IS NULL
      AND plugin_agent_id IS NULL)),
  CHECK((status IN ('created','running') AND ended_at IS NULL)
    OR (status IN ('completed','failed','cancelled') AND ended_at IS NOT NULL)),
  CHECK(status NOT IN ('completed','cancelled') OR stopped_at IS NOT NULL),
  CHECK(status!='completed' OR (output_json IS NOT NULL AND error_json IS NULL)),
  CHECK(status NOT IN ('failed','cancelled') OR error_json IS NOT NULL),
  CHECK(status!='cancelled' OR cancel_requested_at IS NOT NULL)
);
-- statement
INSERT INTO runs_p13 (
  id,kind,session_id,job_id,scope_json,status,goal,input_json,config_json,
  output_json,error_json,cleanup_json,usage_json,input_tokens,output_tokens,total_tokens,
  cost,duration_ms,tool_call_count,usage_complete,created_at,started_at,ended_at,
  cancel_requested_at,stopped_at,current_context_snapshot_id,context_observations_json
) SELECT id,kind,session_id,job_id,scope_json,status,goal,input_json,config_json,
  output_json,error_json,cleanup_json,usage_json,input_tokens,output_tokens,total_tokens,
  cost,duration_ms,tool_call_count,usage_complete,created_at,started_at,ended_at,
  cancel_requested_at,stopped_at,current_context_snapshot_id,context_observations_json FROM runs;
-- statement
DROP TABLE runs;
-- statement
ALTER TABLE runs_p13 RENAME TO runs;
-- statement
CREATE UNIQUE INDEX runs_one_active_root ON runs((1))
  WHERE kind IN ('provider','agent') AND status IN ('created','running');
-- statement
CREATE UNIQUE INDEX runs_one_active_child ON runs(parent_run_id)
  WHERE kind='subagent' AND status IN ('created','running');
-- statement
CREATE UNIQUE INDEX runs_subagent_origin ON runs(origin_tool_call_id) WHERE kind='subagent';
-- statement
CREATE UNIQUE INDEX runs_subagent_session ON runs(session_id) WHERE kind='subagent';
-- statement
CREATE UNIQUE INDEX runs_subagent_plugin ON runs(parent_run_id,plugin_agent_id) WHERE kind='subagent';
-- statement
CREATE INDEX runs_by_parent ON runs(parent_run_id,id DESC) WHERE parent_run_id IS NOT NULL;
-- statement
CREATE INDEX runs_recent ON runs(created_at DESC,id DESC);
-- statement
CREATE INDEX runs_by_session ON runs(session_id,id DESC) WHERE session_id IS NOT NULL;
-- statement
CREATE INDEX runs_by_job ON runs(job_id,id DESC) WHERE job_id IS NOT NULL;
-- statement
CREATE TRIGGER subagent_insert_guard BEFORE INSERT ON runs
WHEN NEW.kind='subagent' AND NOT EXISTS (
  SELECT 1 FROM runs p JOIN tool_calls t ON t.id=NEW.origin_tool_call_id AND t.run_id=p.id
  JOIN sessions s ON s.id=NEW.session_id
  WHERE p.id=NEW.parent_run_id AND p.kind='agent' AND p.status='running'
    AND p.cancel_requested_at IS NULL AND p.session_id!=NEW.session_id AND p.job_id IS NEW.job_id
    AND t.session_id=p.session_id AND t.tool_name='Agent' AND t.status='running'
    AND s.status='active')
BEGIN SELECT RAISE(ABORT,'subagent_origin_invalid'); END;
-- statement
CREATE TRIGGER subagent_identity_immutable BEFORE UPDATE OF
  kind,parent_run_id,origin_tool_call_id,plugin_agent_id,session_id,job_id ON runs
WHEN (OLD.kind='subagent' OR NEW.kind='subagent') AND (
  OLD.kind IS NOT NEW.kind OR OLD.parent_run_id IS NOT NEW.parent_run_id
  OR OLD.origin_tool_call_id IS NOT NEW.origin_tool_call_id
  OR OLD.plugin_agent_id IS NOT NEW.plugin_agent_id
  OR OLD.session_id IS NOT NEW.session_id OR OLD.job_id IS NOT NEW.job_id)
BEGIN SELECT RAISE(ABORT,'subagent_identity_immutable'); END;
-- statement
CREATE TRIGGER subagent_start_guard BEFORE UPDATE OF status ON runs
WHEN NEW.kind='subagent' AND NEW.status='running' AND NOT EXISTS (
  SELECT 1 FROM runs p JOIN tool_calls t ON t.id=NEW.origin_tool_call_id AND t.run_id=p.id
  WHERE p.id=NEW.parent_run_id AND p.kind='agent' AND p.status='running'
    AND p.cancel_requested_at IS NULL AND t.tool_name='Agent' AND t.status='running')
BEGIN SELECT RAISE(ABORT,'subagent_parent_closed'); END;
-- statement
CREATE TRIGGER subagent_parent_finish_guard BEFORE UPDATE OF status ON runs
WHEN NEW.kind='agent' AND NEW.status IN ('completed','failed','cancelled') AND EXISTS (
  SELECT 1 FROM runs c WHERE c.parent_run_id=NEW.id AND c.status IN ('created','running'))
BEGIN SELECT RAISE(ABORT,'subagent_active_child'); END;
-- statement
DROP TRIGGER context_snapshot_insert_guard;
-- statement
CREATE TRIGGER context_snapshot_insert_guard BEFORE INSERT ON context_snapshots
WHEN NOT EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.kind IN ('agent','subagent')
  AND r.session_id=NEW.session_id AND r.job_id IS NEW.job_id)
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_run_insert_guard BEFORE INSERT ON runs
WHEN NEW.current_context_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_snapshots c WHERE c.id=NEW.current_context_snapshot_id
  AND c.run_id=NEW.id AND c.session_id=NEW.session_id AND c.job_id IS NEW.job_id)
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_run_update_guard BEFORE UPDATE OF current_context_snapshot_id,session_id,job_id ON runs
WHEN NEW.current_context_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_snapshots c WHERE c.id=NEW.current_context_snapshot_id
  AND c.run_id=NEW.id AND c.session_id=NEW.session_id AND c.job_id IS NEW.job_id)
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(17,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
