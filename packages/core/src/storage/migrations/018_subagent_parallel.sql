-- statement
BEGIN IMMEDIATE;
-- statement
DROP INDEX runs_one_active_child;
-- statement
CREATE TRIGGER subagent_parallel_limit BEFORE INSERT ON runs
WHEN NEW.kind='subagent' AND (
  SELECT COUNT(*) FROM runs WHERE parent_run_id=NEW.parent_run_id
  AND (status IN ('created','running') OR stopped_at IS NULL)
) >= 4
BEGIN
  SELECT RAISE(ABORT, 'subagent_busy');
END;
-- statement
INSERT INTO schema_migrations(version, applied_at) VALUES (18, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
