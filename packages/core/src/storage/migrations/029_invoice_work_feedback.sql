BEGIN IMMEDIATE;
-- statement
CREATE TABLE invoice_work_feedback (
  candidate_id INTEGER PRIMARY KEY REFERENCES invoice_candidates(id) ON DELETE RESTRICT,
  candidate_sequence INTEGER NOT NULL CHECK(candidate_sequence > 0),
  work_id INTEGER NOT NULL REFERENCES invoice_works(id) ON DELETE RESTRICT,
  item_id INTEGER NOT NULL REFERENCES invoice_work_items(id) ON DELETE RESTRICT,
  helpful INTEGER NOT NULL CHECK(helpful IN (0, 1)),
  saved_at TEXT NOT NULL,
  attempt_id INTEGER REFERENCES invoice_work_attempts(id) ON DELETE RESTRICT,
  phase_id INTEGER REFERENCES invoice_work_phases(id) ON DELETE RESTRICT,
  run_id INTEGER REFERENCES runs(id) ON DELETE RESTRICT,
  tool_call_id INTEGER REFERENCES tool_calls(id) ON DELETE RESTRICT,
  CHECK((attempt_id IS NULL) = (phase_id IS NULL)
    AND (attempt_id IS NULL) = (run_id IS NULL)
    AND (attempt_id IS NULL) = (tool_call_id IS NULL))
) STRICT;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(29,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
