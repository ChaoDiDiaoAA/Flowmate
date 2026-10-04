-- statement
BEGIN IMMEDIATE;
-- statement
ALTER TABLE session_native_history ADD COLUMN commit_revision INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(commit_revision)='integer' AND commit_revision BETWEEN 0 AND 9007199254740991);
-- statement
CREATE TABLE session_forks (
  target_session_id INTEGER UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  source_session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  source_commit_revision INTEGER NOT NULL CHECK(typeof(source_commit_revision)='integer' AND source_commit_revision BETWEEN 0 AND 9007199254740991),
  source_entry_count INTEGER NOT NULL CHECK(typeof(source_entry_count)='integer' AND source_entry_count>=0),
  source_leaf_id TEXT,
  selected_entry_id TEXT NOT NULL,
  inherited_entry_count INTEGER NOT NULL CHECK(typeof(inherited_entry_count)='integer' AND inherited_entry_count>0),
  client_operation_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  created_at TEXT NOT NULL,
  CHECK(target_session_id IS NULL OR target_session_id<>source_session_id),
  PRIMARY KEY(source_session_id,client_operation_id)
);
-- statement
CREATE INDEX session_forks_source ON session_forks(source_session_id);
-- statement
CREATE TRIGGER session_forks_initial_target
BEFORE INSERT ON session_forks WHEN NEW.target_session_id IS NULL
BEGIN
  SELECT RAISE(ABORT,'session_fork_target_required');
END;
-- statement
CREATE TRIGGER session_forks_immutable
BEFORE UPDATE ON session_forks
WHEN NOT (
  OLD.target_session_id IS NOT NULL AND NEW.target_session_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM sessions WHERE id=OLD.target_session_id)
  AND NEW.source_session_id IS OLD.source_session_id
  AND NEW.source_commit_revision IS OLD.source_commit_revision
  AND NEW.source_entry_count IS OLD.source_entry_count
  AND NEW.source_leaf_id IS OLD.source_leaf_id
  AND NEW.selected_entry_id IS OLD.selected_entry_id
  AND NEW.inherited_entry_count IS OLD.inherited_entry_count
  AND NEW.client_operation_id IS OLD.client_operation_id
  AND NEW.request_json IS OLD.request_json
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT,'session_fork_immutable');
END;

-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(16,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
