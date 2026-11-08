BEGIN IMMEDIATE;
-- statement
CREATE TABLE personal_model_observations (
  observation_id TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json))
) STRICT;
-- statement
CREATE INDEX personal_model_observations_run ON personal_model_observations(run_id, started_at);
-- statement
CREATE INDEX personal_model_observations_retention ON personal_model_observations(started_at);
-- statement
CREATE TABLE personal_tool_model_sources (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  native_tool_call_id TEXT NOT NULL,
  phase_id INTEGER NOT NULL REFERENCES invoice_work_phases(id) ON DELETE CASCADE,
  generation_task_id INTEGER NOT NULL,
  assistant_entry_id INTEGER NOT NULL,
  observation_id TEXT,
  PRIMARY KEY(run_id, native_tool_call_id)
) STRICT;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(30,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
