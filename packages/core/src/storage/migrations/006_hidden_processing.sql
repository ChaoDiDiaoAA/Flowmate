BEGIN IMMEDIATE;
ALTER TABLE jobs ADD COLUMN hidden_at TEXT;
CREATE INDEX jobs_visible_recent ON jobs(id DESC) WHERE hidden_at IS NULL;
INSERT INTO schema_migrations(version, applied_at)
VALUES(6, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
