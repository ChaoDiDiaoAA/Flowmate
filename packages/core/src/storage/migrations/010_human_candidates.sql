PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TABLE invoice_candidates_v10 (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  run_id INTEGER,
  tool_call_id INTEGER UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  origin TEXT NOT NULL CHECK(origin IN ('model','human_edit')),
  based_on_candidate_id INTEGER,
  status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated','accepted','rejected')),
  fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
  lines_json TEXT NOT NULL CHECK(json_valid(lines_json)),
  issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
  created_at TEXT NOT NULL, accepted_at TEXT,
  UNIQUE(job_id,sequence), UNIQUE(id,job_id),
  FOREIGN KEY(run_id,job_id) REFERENCES runs(id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(based_on_candidate_id,job_id) REFERENCES invoice_candidates(id,job_id) ON DELETE RESTRICT,
  CHECK((origin='model' AND run_id IS NOT NULL AND tool_call_id IS NOT NULL AND based_on_candidate_id IS NULL)
    OR (origin='human_edit' AND run_id IS NULL AND tool_call_id IS NULL AND based_on_candidate_id IS NOT NULL AND based_on_candidate_id!=id)),
  CHECK((status='accepted' AND accepted_at IS NOT NULL) OR (status!='accepted' AND accepted_at IS NULL))
);
INSERT INTO invoice_candidates_v10(id,job_id,run_id,tool_call_id,sequence,origin,status,fields_json,lines_json,issues_json,created_at,accepted_at)
SELECT id,job_id,run_id,tool_call_id,sequence,origin,status,fields_json,lines_json,issues_json,created_at,accepted_at FROM invoice_candidates;
DROP TABLE invoice_candidates;
ALTER TABLE invoice_candidates_v10 RENAME TO invoice_candidates;
CREATE UNIQUE INDEX candidate_one_accepted ON invoice_candidates(job_id) WHERE status='accepted';

CREATE TABLE artifacts_v10 (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('original','parsed','export')),
  relative_path TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL CHECK(bytes>0),
  mime_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
INSERT INTO artifacts_v10 SELECT * FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_v10 RENAME TO artifacts;

CREATE TABLE business_events_v10 (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('document_imported','task_started','candidate_generated','candidate_selected',
    'candidate_edited','candidate_accepted','candidate_rejected','candidate_exported')),
  occurred_at TEXT NOT NULL,
  actor_source TEXT NOT NULL CHECK(actor_source IN ('user','agent','system')),
  operation_ref TEXT NOT NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE RESTRICT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE RESTRICT,
  candidate_id INTEGER REFERENCES invoice_candidates(id) ON DELETE RESTRICT,
  artifact_id INTEGER REFERENCES artifacts(id) ON DELETE RESTRICT,
  run_id INTEGER REFERENCES runs(id) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK(result IN ('succeeded','failed')),
  safe_summary TEXT NOT NULL CHECK(length(safe_summary)<=512),
  error_code TEXT,
  UNIQUE(type,operation_ref,result),
  CHECK(document_id IS NOT NULL OR job_id IS NOT NULL OR candidate_id IS NOT NULL OR artifact_id IS NOT NULL),
  CHECK((result='succeeded' AND error_code IS NULL) OR (result='failed' AND error_code IS NOT NULL))
);
INSERT INTO business_events_v10 SELECT * FROM business_events;
DROP TABLE business_events;
ALTER TABLE business_events_v10 RENAME TO business_events;
CREATE INDEX activity_by_job ON business_events(job_id,id DESC);
CREATE INDEX activity_by_document ON business_events(document_id,id DESC);
INSERT INTO schema_migrations(version,applied_at) VALUES(10,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
