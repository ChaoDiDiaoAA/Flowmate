BEGIN IMMEDIATE;
ALTER TABLE sessions ADD COLUMN hidden_at TEXT;
ALTER TABLE documents ADD COLUMN hidden_at TEXT;
CREATE INDEX sessions_visible_recent ON sessions(updated_at DESC, id DESC) WHERE hidden_at IS NULL;
CREATE INDEX documents_visible_recent ON documents(id DESC) WHERE hidden_at IS NULL;
INSERT INTO schema_migrations(version, applied_at)
VALUES(7, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
