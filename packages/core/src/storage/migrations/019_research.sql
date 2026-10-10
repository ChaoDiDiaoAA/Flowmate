-- statement
BEGIN IMMEDIATE;
-- statement
CREATE TABLE research_tasks (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
  source_policy_json TEXT NOT NULL CHECK(json_valid(source_policy_json)),
  current_plan_id INTEGER,
  current_run_id INTEGER,
  current_report_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,session_id),
  FOREIGN KEY(current_plan_id,id) REFERENCES research_plans(id,research_id) ON DELETE RESTRICT,
  FOREIGN KEY(current_run_id,id) REFERENCES research_runs(run_id,research_id) ON DELETE RESTRICT,
  FOREIGN KEY(current_report_id,id) REFERENCES research_reports(id,research_id) ON DELETE RESTRICT
);
-- statement
CREATE TABLE research_runs (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  research_id INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE RESTRICT,
  session_id INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('planning','researching')),
  plan_id INTEGER, revision INTEGER CHECK(revision IS NULL OR revision>0),
  source_policy_json TEXT NOT NULL CHECK(json_valid(source_policy_json)),
  created_at TEXT NOT NULL,
  UNIQUE(run_id,research_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY(research_id,session_id) REFERENCES research_tasks(id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY(plan_id,research_id,revision) REFERENCES research_plans(id,research_id,revision) ON DELETE RESTRICT,
  CHECK((phase='planning' AND plan_id IS NULL AND revision IS NULL) OR (phase='researching' AND plan_id IS NOT NULL AND revision IS NOT NULL))
);
-- statement
CREATE TABLE research_plans (
  id INTEGER PRIMARY KEY,
  research_id INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0),
  run_id INTEGER NOT NULL, tool_call_id INTEGER NOT NULL UNIQUE,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), created_at TEXT NOT NULL,
  UNIQUE(id,research_id), UNIQUE(id,research_id,revision), UNIQUE(research_id,revision),
  FOREIGN KEY(run_id,research_id) REFERENCES research_runs(run_id,research_id) ON DELETE RESTRICT,
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT
);
-- statement
CREATE TABLE research_sources (
  id INTEGER PRIMARY KEY,
  research_id INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE RESTRICT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  tool_call_id INTEGER NOT NULL UNIQUE,
  artifact_id INTEGER REFERENCES artifacts(id) ON DELETE RESTRICT,
  document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), created_at TEXT NOT NULL,
  UNIQUE(id,research_id),
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT
);
-- statement
CREATE TABLE research_claims (
  id INTEGER PRIMARY KEY,
  research_id INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE RESTRICT,
  plan_id INTEGER NOT NULL, revision INTEGER NOT NULL,
  run_id INTEGER NOT NULL, tool_call_id INTEGER NOT NULL UNIQUE,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), created_at TEXT NOT NULL,
  UNIQUE(id,research_id),
  FOREIGN KEY(plan_id,research_id,revision) REFERENCES research_plans(id,research_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY(run_id,research_id) REFERENCES research_runs(run_id,research_id) ON DELETE RESTRICT,
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT
);
-- statement
CREATE TABLE research_reports (
  id INTEGER PRIMARY KEY,
  research_id INTEGER NOT NULL REFERENCES research_tasks(id) ON DELETE RESTRICT,
  plan_id INTEGER NOT NULL, revision INTEGER NOT NULL,
  run_id INTEGER NOT NULL, tool_call_id INTEGER NOT NULL UNIQUE,
  body_json TEXT NOT NULL CHECK(json_valid(body_json)), created_at TEXT NOT NULL,
  UNIQUE(id,research_id),
  FOREIGN KEY(plan_id,research_id,revision) REFERENCES research_plans(id,research_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY(run_id,research_id) REFERENCES research_runs(run_id,research_id) ON DELETE RESTRICT,
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT
);
-- statement
CREATE INDEX research_tasks_recent ON research_tasks(id DESC);
-- statement
CREATE INDEX research_sources_by_task ON research_sources(research_id,id DESC);
-- statement
CREATE INDEX research_claims_by_plan ON research_claims(research_id,plan_id,id DESC);
-- statement
CREATE INDEX research_reports_by_task ON research_reports(research_id,id DESC);
-- statement
CREATE TRIGGER research_runs_immutable_update BEFORE UPDATE ON research_runs BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_runs_immutable_delete BEFORE DELETE ON research_runs BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_plans_immutable_update BEFORE UPDATE ON research_plans BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_plans_immutable_delete BEFORE DELETE ON research_plans BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_sources_immutable_update BEFORE UPDATE ON research_sources BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_sources_immutable_delete BEFORE DELETE ON research_sources BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_claims_immutable_update BEFORE UPDATE ON research_claims BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_claims_immutable_delete BEFORE DELETE ON research_claims BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_reports_immutable_update BEFORE UPDATE ON research_reports BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
CREATE TRIGGER research_reports_immutable_delete BEFORE DELETE ON research_reports BEGIN SELECT RAISE(ABORT,'research_immutable'); END;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES (19,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
