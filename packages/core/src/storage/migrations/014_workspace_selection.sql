BEGIN IMMEDIATE;
CREATE TABLE workspace_p7 (
  id INTEGER PRIMARY KEY CHECK(id=1),
  active_document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT,
  active_job_id INTEGER,
  active_session_id INTEGER REFERENCES sessions(id) ON DELETE RESTRICT,
  active_view TEXT NOT NULL DEFAULT 'original' CHECK(active_view IN ('original','parsed','candidate')),
  selection_json TEXT CHECK(selection_json IS NULL OR CASE WHEN json_valid(selection_json) THEN
    COALESCE(json_type(selection_json)='object' AND json_extract(selection_json,'$.formatVersion')=1,0) ELSE 0 END),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(active_job_id,active_document_id) REFERENCES jobs(id,document_id) ON DELETE RESTRICT,
  CHECK(active_job_id IS NULL OR active_document_id IS NOT NULL)
);
INSERT INTO workspace_p7(id,active_document_id,active_job_id,active_session_id,active_view,selection_json,revision,created_at,updated_at)
SELECT id,active_document_id,active_job_id,active_session_id,active_view,selection_json,revision,created_at,updated_at FROM workspace;
DROP TABLE workspace;
ALTER TABLE workspace_p7 RENAME TO workspace;
INSERT INTO schema_migrations(version,applied_at) VALUES(14,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
