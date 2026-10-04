-- statement
BEGIN IMMEDIATE;
-- statement
CREATE TABLE context_snapshots (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE RESTRICT,
  session_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer'
    AND sequence BETWEEN 1 AND 9007199254740991),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)
    AND length(CAST(snapshot_json AS BLOB))<=262144),
  created_at TEXT NOT NULL,
  UNIQUE(run_id,sequence), UNIQUE(id,run_id),
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id,job_id) REFERENCES runs(id,job_id) ON DELETE RESTRICT
);
-- statement
ALTER TABLE runs ADD COLUMN current_context_snapshot_id INTEGER
  REFERENCES context_snapshots(id) ON DELETE RESTRICT
  CHECK(current_context_snapshot_id IS NULL OR kind='agent');
-- statement
ALTER TABLE runs ADD COLUMN context_observations_json TEXT
  CHECK(context_observations_json IS NULL OR CASE WHEN json_valid(context_observations_json)
    THEN COALESCE(json_type(context_observations_json,'$.version')='integer'
      AND json_extract(context_observations_json,'$.version')=1
      AND length(CAST(context_observations_json AS BLOB))<=4194304,0) ELSE 0 END);
-- statement
ALTER TABLE session_inputs ADD COLUMN context_snapshot_id INTEGER
  REFERENCES context_snapshots(id) ON DELETE RESTRICT;
-- statement
ALTER TABLE tool_calls ADD COLUMN context_snapshot_id INTEGER
  REFERENCES context_snapshots(id) ON DELETE RESTRICT;
-- statement
ALTER TABLE tool_calls ADD COLUMN request_sequence INTEGER
  CHECK((context_snapshot_id IS NULL)=(request_sequence IS NULL)
    AND (request_sequence IS NULL OR (typeof(request_sequence)='integer'
      AND request_sequence BETWEEN 1 AND 9007199254740991)));
-- statement
ALTER TABLE invoice_candidates ADD COLUMN context_snapshot_id INTEGER
  REFERENCES context_snapshots(id) ON DELETE RESTRICT;
-- statement
ALTER TABLE invoice_candidates ADD COLUMN request_sequence INTEGER
  CHECK((context_snapshot_id IS NULL)=(request_sequence IS NULL)
    AND (request_sequence IS NULL OR (typeof(request_sequence)='integer'
      AND request_sequence BETWEEN 1 AND 9007199254740991))
    AND (origin='model' OR context_snapshot_id IS NULL));
-- statement
CREATE INDEX context_snapshots_by_session ON context_snapshots(session_id,id DESC);
-- statement
CREATE UNIQUE INDEX session_inputs_by_context ON session_inputs(context_snapshot_id)
  WHERE context_snapshot_id IS NOT NULL;
-- statement
CREATE TRIGGER context_snapshot_insert_guard BEFORE INSERT ON context_snapshots
WHEN NOT EXISTS (SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.kind='agent'
  AND r.session_id=NEW.session_id AND r.job_id IS NEW.job_id)
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_snapshot_update_guard BEFORE UPDATE ON context_snapshots
BEGIN SELECT RAISE(ABORT,'context_snapshot_immutable'); END;
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
CREATE TRIGGER context_input_insert_guard BEFORE INSERT ON session_inputs
WHEN (NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_snapshots c WHERE c.id=NEW.context_snapshot_id
  AND c.run_id=NEW.run_id AND c.session_id=NEW.session_id)) OR
  (NEW.context_snapshot_id IS NULL AND EXISTS (
  SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.context_observations_json IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_input_owner_guard BEFORE UPDATE OF context_snapshot_id,run_id,session_id ON session_inputs
WHEN NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_snapshots c WHERE c.id=NEW.context_snapshot_id
  AND c.run_id=NEW.run_id AND c.session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_input_immutable_guard BEFORE UPDATE OF context_snapshot_id ON session_inputs
WHEN OLD.context_snapshot_id IS NOT NEW.context_snapshot_id AND NOT (
  OLD.context_snapshot_id IS NOT NULL AND NEW.context_snapshot_id IS NULL
  AND EXISTS (SELECT 1 FROM sessions s WHERE s.id=OLD.session_id AND s.status='archived'
    AND json_extract(s.metadata_json,'$.delete_pending')=1)
  AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id=OLD.session_id AND r.job_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.session_id=OLD.session_id)
  AND NOT EXISTS (SELECT 1 FROM business_events b JOIN runs r ON r.id=b.run_id WHERE r.session_id=OLD.session_id)
  AND NOT EXISTS (SELECT 1 FROM invoice_candidates c JOIN runs r ON r.id=c.run_id WHERE r.session_id=OLD.session_id))
BEGIN SELECT RAISE(ABORT,'context_binding_immutable'); END;
-- statement
CREATE TRIGGER context_tool_insert_guard BEFORE INSERT ON tool_calls
WHEN (NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_snapshots c WHERE c.id=NEW.context_snapshot_id
  AND c.run_id=NEW.run_id AND c.session_id=NEW.session_id)) OR
  (NEW.context_snapshot_id IS NULL AND EXISTS (
  SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.context_observations_json IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_tool_owner_guard BEFORE UPDATE OF context_snapshot_id,request_sequence,run_id,session_id ON tool_calls
WHEN NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM context_snapshots c WHERE c.id=NEW.context_snapshot_id
  AND c.run_id=NEW.run_id AND c.session_id=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_tool_immutable_guard BEFORE UPDATE OF context_snapshot_id,request_sequence ON tool_calls
WHEN OLD.context_snapshot_id IS NOT NEW.context_snapshot_id OR OLD.request_sequence IS NOT NEW.request_sequence
BEGIN SELECT RAISE(ABORT,'context_binding_immutable'); END;
-- statement
CREATE TRIGGER context_candidate_insert_guard BEFORE INSERT ON invoice_candidates
WHEN (NEW.origin='human_edit' AND (NEW.context_snapshot_id IS NOT NULL OR NEW.request_sequence IS NOT NULL)) OR
  (NEW.origin='model' AND NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_snapshots c JOIN tool_calls t ON t.id=NEW.tool_call_id
    WHERE c.id=NEW.context_snapshot_id AND c.run_id=NEW.run_id AND c.job_id IS NEW.job_id
      AND t.run_id=NEW.run_id AND t.context_snapshot_id=NEW.context_snapshot_id
      AND t.request_sequence=NEW.request_sequence)) OR
  (NEW.origin='model' AND NEW.context_snapshot_id IS NULL AND EXISTS (
    SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.context_observations_json IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_candidate_owner_guard BEFORE UPDATE OF context_snapshot_id,request_sequence,run_id,job_id,tool_call_id,origin ON invoice_candidates
WHEN (NEW.origin='human_edit' AND (NEW.context_snapshot_id IS NOT NULL OR NEW.request_sequence IS NOT NULL)) OR
  (NEW.origin='model' AND NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_snapshots c JOIN tool_calls t ON t.id=NEW.tool_call_id
    WHERE c.id=NEW.context_snapshot_id AND c.run_id=NEW.run_id AND c.job_id IS NEW.job_id
      AND t.run_id=NEW.run_id AND t.context_snapshot_id=NEW.context_snapshot_id
      AND t.request_sequence=NEW.request_sequence))
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_candidate_immutable_guard BEFORE UPDATE OF context_snapshot_id,request_sequence ON invoice_candidates
WHEN OLD.context_snapshot_id IS NOT NEW.context_snapshot_id OR OLD.request_sequence IS NOT NEW.request_sequence
BEGIN SELECT RAISE(ABORT,'context_binding_immutable'); END;
-- statement
INSERT INTO schema_migrations(version,applied_at)
VALUES(15,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
