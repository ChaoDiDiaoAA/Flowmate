BEGIN IMMEDIATE;
ALTER TABLE session_native_entries
  ADD COLUMN run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;

INSERT INTO schema_migrations(version, applied_at)
VALUES(8, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
