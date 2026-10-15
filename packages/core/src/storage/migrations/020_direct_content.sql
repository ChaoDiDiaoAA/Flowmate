-- statement
BEGIN IMMEDIATE;
-- statement
ALTER TABLE session_inputs DROP COLUMN request_hash;
-- statement
ALTER TABLE session_inputs ADD COLUMN request_identity_json TEXT CHECK(request_identity_json IS NULL OR json_valid(request_identity_json));
-- statement
ALTER TABLE tool_calls ADD COLUMN evidence_revision INTEGER NOT NULL DEFAULT 0 CHECK(evidence_revision>=0);
-- statement
CREATE TABLE managed_file_contents (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(owner_kind,owner_id,relative_path)
);
-- statement
CREATE TRIGGER managed_file_contents_immutable BEFORE UPDATE ON managed_file_contents
BEGIN SELECT RAISE(ABORT,'managed_file_content_immutable'); END;
-- statement
CREATE TRIGGER tool_evidence_revision AFTER UPDATE ON tool_calls
WHEN NEW.evidence_revision=OLD.evidence_revision AND (
  NEW.args_json IS NOT OLD.args_json OR NEW.result_json IS NOT OLD.result_json OR
  NEW.status IS NOT OLD.status OR NEW.delivery_json IS NOT OLD.delivery_json OR
  NEW.cleanup_json IS NOT OLD.cleanup_json OR NEW.runtime_observation_json IS NOT OLD.runtime_observation_json OR
  NEW.started_at IS NOT OLD.started_at OR NEW.ended_at IS NOT OLD.ended_at OR NEW.stopped_at IS NOT OLD.stopped_at)
BEGIN UPDATE tool_calls SET evidence_revision=OLD.evidence_revision+1 WHERE id=NEW.id; END;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(20,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
