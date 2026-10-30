BEGIN IMMEDIATE;
CREATE TABLE research_step_executions (
  id INTEGER PRIMARY KEY,
  research_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  step_id TEXT NOT NULL CHECK(length(step_id) BETWEEN 1 AND 64),
  run_id INTEGER NOT NULL,
  tool_call_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY(plan_id,research_id,revision) REFERENCES research_plans(id,research_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT
);
CREATE INDEX research_step_latest ON research_step_executions(plan_id,step_id,id DESC);
INSERT INTO schema_migrations(version,applied_at) VALUES(22,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
