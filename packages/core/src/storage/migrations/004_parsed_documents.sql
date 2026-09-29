BEGIN IMMEDIATE;
UPDATE documents
SET metadata_json = json_set(json_remove(metadata_json, '$.parserConfiguration'), '$.version', 2);
ALTER TABLE documents DROP COLUMN parser_name;
ALTER TABLE documents DROP COLUMN parser_version;
INSERT INTO schema_migrations(version,applied_at)
VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
