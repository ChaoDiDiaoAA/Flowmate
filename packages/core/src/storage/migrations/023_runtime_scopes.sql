-- statement
BEGIN IMMEDIATE;
-- statement
CREATE TABLE sessions_p23 (
  id INTEGER PRIMARY KEY,
  native_session_id TEXT UNIQUE CHECK(native_session_id IS NULL OR length(native_session_id) BETWEEN 1 AND 128),
  title TEXT NOT NULL DEFAULT 'New Session' CHECK(length(trim(title)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{"version":1,"model_use_blocked":null}' CHECK(json_valid(metadata_json)),
  hidden_at TEXT,
  runtime_kind TEXT NOT NULL DEFAULT 'agent_session' CHECK(runtime_kind IN ('agent_session','durable')),
  durable_conversation_id INTEGER CHECK(durable_conversation_id IS NULL OR
    (typeof(durable_conversation_id)='integer' AND durable_conversation_id BETWEEN 1 AND 9007199254740991)),
  durable_runtime_id TEXT NOT NULL DEFAULT 'local' CHECK(length(durable_runtime_id) BETWEEN 1 AND 128),
  cloud_workspace_id TEXT CHECK(cloud_workspace_id IS NULL OR length(cloud_workspace_id)=36),
  UNIQUE(durable_runtime_id,durable_conversation_id),
  CHECK((durable_runtime_id='local' AND cloud_workspace_id IS NULL) OR (durable_runtime_id!='local' AND cloud_workspace_id IS NOT NULL)),
  CHECK((runtime_kind='agent_session' AND native_session_id IS NOT NULL AND durable_conversation_id IS NULL AND durable_runtime_id='local')
    OR (runtime_kind='durable' AND native_session_id IS NULL))
);
-- statement
INSERT INTO sessions_p23(id,native_session_id,title,status,created_at,updated_at,metadata_json,hidden_at,runtime_kind,durable_conversation_id,durable_runtime_id)
SELECT id,native_session_id,title,status,created_at,updated_at,metadata_json,hidden_at,runtime_kind,durable_conversation_id,'local' FROM sessions;
-- statement
DROP TABLE sessions;
-- statement
ALTER TABLE sessions_p23 RENAME TO sessions;
-- statement
CREATE INDEX sessions_recent ON sessions(updated_at DESC, id DESC);
-- statement
CREATE INDEX sessions_visible_recent ON sessions(updated_at DESC, id DESC) WHERE hidden_at IS NULL;
-- statement
CREATE TRIGGER session_runtime_immutable BEFORE UPDATE OF runtime_kind ON sessions
WHEN NEW.runtime_kind IS NOT OLD.runtime_kind
BEGIN SELECT RAISE(ABORT,'session_runtime_immutable'); END;
-- statement
CREATE TRIGGER session_runtime_owner_immutable BEFORE UPDATE OF durable_runtime_id,cloud_workspace_id ON sessions
WHEN NEW.durable_runtime_id IS NOT OLD.durable_runtime_id OR NEW.cloud_workspace_id IS NOT OLD.cloud_workspace_id
BEGIN SELECT RAISE(ABORT,'session_runtime_owner_immutable'); END;
-- statement
CREATE TRIGGER session_runtime_workspace_owner BEFORE INSERT ON sessions
WHEN NEW.durable_runtime_id!='local' AND EXISTS (SELECT 1 FROM sessions s
  WHERE s.durable_runtime_id=NEW.durable_runtime_id AND s.cloud_workspace_id IS NOT NEW.cloud_workspace_id)
BEGIN SELECT RAISE(ABORT,'session_runtime_workspace_owner'); END;
-- statement
CREATE TABLE invoice_work_phases_p23 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  attempt_id INTEGER NOT NULL,
  item_id INTEGER,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind='prompt'),
  basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  native_conversation_id INTEGER,
  native_submission_id INTEGER,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  closed_at TEXT,
  durable_runtime_id TEXT NOT NULL CHECK(length(durable_runtime_id) BETWEEN 1 AND 128),
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id),
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id),
  UNIQUE(attempt_id,request_id),
  UNIQUE(durable_runtime_id,native_conversation_id,native_submission_id),
  CHECK((native_conversation_id IS NULL)=(native_submission_id IS NULL)),
  CHECK(native_conversation_id IS NULL OR native_conversation_id BETWEEN 1 AND 9007199254740991),
  CHECK(native_submission_id IS NULL OR native_submission_id BETWEEN 1 AND 9007199254740991),
  CHECK(consumed_at IS NULL OR native_submission_id IS NOT NULL)
);
-- statement
INSERT INTO invoice_work_phases_p23(id,work_id,attempt_id,item_id,request_id,kind,basis_json,native_conversation_id,native_submission_id,created_at,consumed_at,closed_at,durable_runtime_id)
SELECT p.id,p.work_id,p.attempt_id,p.item_id,p.request_id,p.kind,p.basis_json,p.native_conversation_id,p.native_submission_id,p.created_at,p.consumed_at,p.closed_at,s.durable_runtime_id
FROM invoice_work_phases p JOIN invoice_works w ON w.id=p.work_id JOIN sessions s ON s.id=w.session_id;
-- statement
DROP TABLE invoice_work_phases;
-- statement
ALTER TABLE invoice_work_phases_p23 RENAME TO invoice_work_phases;
-- statement
CREATE TRIGGER invoice_work_phase_basis_immutable
BEFORE UPDATE OF work_id,attempt_id,item_id,request_id,kind,basis_json,created_at ON invoice_work_phases
BEGIN SELECT RAISE(ABORT,'invoice_work_phase_basis_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_phase_runtime_immutable BEFORE UPDATE OF durable_runtime_id ON invoice_work_phases
WHEN NEW.durable_runtime_id IS NOT OLD.durable_runtime_id
BEGIN SELECT RAISE(ABORT,'invoice_work_phase_runtime_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_phase_result_preserved BEFORE UPDATE ON invoice_work_phases
WHEN (OLD.native_submission_id IS NOT NULL AND
  (NEW.native_conversation_id IS NOT OLD.native_conversation_id OR NEW.native_submission_id IS NOT OLD.native_submission_id))
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at)
BEGIN SELECT RAISE(ABORT,'invoice_work_phase_result_preserved'); END;
-- statement
CREATE TRIGGER invoice_work_phase_runtime_owner BEFORE INSERT ON invoice_work_phases
WHEN NOT EXISTS (SELECT 1 FROM invoice_works w JOIN sessions s ON s.id=w.session_id
  WHERE w.id=NEW.work_id AND s.runtime_kind='durable' AND s.durable_runtime_id=NEW.durable_runtime_id)
BEGIN SELECT RAISE(ABORT,'invoice_work_phase_runtime_owner_invalid'); END;
-- statement
CREATE TRIGGER invoice_work_runtime_owner_immutable BEFORE UPDATE OF session_id ON invoice_works
WHEN NEW.session_id IS NOT OLD.session_id
BEGIN SELECT RAISE(ABORT,'invoice_work_runtime_owner_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_runtime_unique BEFORE INSERT ON invoice_works
WHEN EXISTS (SELECT 1 FROM sessions target JOIN sessions existing ON existing.durable_runtime_id=target.durable_runtime_id
  JOIN invoice_works w ON w.session_id=existing.id WHERE target.id=NEW.session_id AND target.durable_runtime_id!='local')
BEGIN SELECT RAISE(ABORT,'invoice_work_runtime_unique'); END;
-- statement
DROP TRIGGER runs_engine_active_insert;
-- statement
DROP TRIGGER runs_engine_active_update;
-- statement
CREATE TRIGGER runs_engine_active_insert BEFORE INSERT ON runs
WHEN NEW.kind!='subagent' AND NEW.status IN ('created','running') AND CASE
  WHEN NEW.kind='provider' OR (SELECT runtime_kind FROM sessions WHERE id=NEW.session_id)='agent_session' THEN EXISTS (
    SELECT 1 FROM runs r LEFT JOIN sessions s ON s.id=r.session_id WHERE r.kind!='subagent' AND r.status IN ('created','running')
      AND (r.kind='provider' OR s.runtime_kind='agent_session'))
  WHEN (SELECT durable_runtime_id FROM sessions WHERE id=NEW.session_id)='local' THEN EXISTS (
    SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.kind!='subagent' AND r.status IN ('created','running')
      AND s.runtime_kind='durable' AND s.durable_runtime_id='local')
  ELSE EXISTS (SELECT 1 FROM runs r WHERE r.kind!='subagent' AND r.status IN ('created','running') AND r.session_id=NEW.session_id)
    OR (SELECT COUNT(*) FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.kind!='subagent' AND r.status IN ('created','running')
      AND s.runtime_kind='durable' AND s.durable_runtime_id!='local')>=2 END
BEGIN SELECT RAISE(ABORT,'runs_one_active_root'); END;
-- statement
CREATE TRIGGER runs_engine_active_update BEFORE UPDATE OF status,kind,session_id ON runs
WHEN NEW.kind!='subagent' AND NEW.status IN ('created','running') AND CASE
  WHEN NEW.kind='provider' OR (SELECT runtime_kind FROM sessions WHERE id=NEW.session_id)='agent_session' THEN EXISTS (
    SELECT 1 FROM runs r LEFT JOIN sessions s ON s.id=r.session_id WHERE r.id!=NEW.id AND r.kind!='subagent' AND r.status IN ('created','running')
      AND (r.kind='provider' OR s.runtime_kind='agent_session'))
  WHEN (SELECT durable_runtime_id FROM sessions WHERE id=NEW.session_id)='local' THEN EXISTS (
    SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id!=NEW.id AND r.kind!='subagent' AND r.status IN ('created','running')
      AND s.runtime_kind='durable' AND s.durable_runtime_id='local')
  ELSE EXISTS (SELECT 1 FROM runs r WHERE r.id!=NEW.id AND r.kind!='subagent' AND r.status IN ('created','running') AND r.session_id=NEW.session_id)
    OR (SELECT COUNT(*) FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id!=NEW.id AND r.kind!='subagent' AND r.status IN ('created','running')
      AND s.runtime_kind='durable' AND s.durable_runtime_id!='local')>=2 END
BEGIN SELECT RAISE(ABORT,'runs_one_active_root'); END;
-- statement
CREATE TABLE cloud_model_attempts (
  model_attempt_id TEXT PRIMARY KEY,
  durable_runtime_id TEXT NOT NULL,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  attempt_id INTEGER NOT NULL,
  phase_id INTEGER NOT NULL REFERENCES invoice_work_phases(id),
  native_task_id INTEGER NOT NULL CHECK(native_task_id>0),
  checkpoint_entry_id INTEGER NOT NULL CHECK(checkpoint_entry_id>0),
  transport_ordinal INTEGER NOT NULL CHECK(transport_ordinal BETWEEN 0 AND 3),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  state TEXT NOT NULL CHECK(state IN ('reserved','sending','confirmed','uncertain')),
  http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id),
  UNIQUE(durable_runtime_id,native_task_id,checkpoint_entry_id,transport_ordinal),
  CHECK((state='confirmed' AND http_status IS NOT NULL) OR (state!='confirmed' AND http_status IS NULL))
);
-- statement
CREATE TRIGGER cloud_model_attempt_identity_immutable BEFORE UPDATE OF model_attempt_id,durable_runtime_id,work_id,attempt_id,phase_id,native_task_id,checkpoint_entry_id,transport_ordinal,request_json,created_at ON cloud_model_attempts
BEGIN SELECT RAISE(ABORT,'cloud_model_attempt_identity_immutable'); END;
-- statement
CREATE TRIGGER cloud_model_attempt_preserved BEFORE DELETE ON cloud_model_attempts
BEGIN SELECT RAISE(ABORT,'cloud_model_attempt_preserved'); END;
-- statement
CREATE TABLE cloud_native_result_receipts (
  receipt_id TEXT PRIMARY KEY,
  durable_runtime_id TEXT NOT NULL,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  attempt_id INTEGER NOT NULL,
  native_conversation_id INTEGER NOT NULL,
  native_submission_id INTEGER NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  received_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id),
  UNIQUE(durable_runtime_id,native_conversation_id,native_submission_id)
);
-- statement
CREATE TRIGGER cloud_native_result_receipt_immutable BEFORE UPDATE ON cloud_native_result_receipts
BEGIN SELECT RAISE(ABORT,'cloud_native_result_receipt_immutable'); END;
-- statement
CREATE TRIGGER cloud_native_result_receipt_preserved BEFORE DELETE ON cloud_native_result_receipts
BEGIN SELECT RAISE(ABORT,'cloud_native_result_receipt_preserved'); END;
-- statement
CREATE TABLE cloud_workspace_documents (
  workspace_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  document_version TEXT NOT NULL,
  PRIMARY KEY(workspace_id,document_id,document_version),
  UNIQUE(workspace_id,upload_id)
);
-- statement
CREATE TRIGGER cloud_workspace_document_owner BEFORE INSERT ON cloud_workspace_documents
WHEN NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=NEW.document_id AND d.version=NEW.document_version)
BEGIN SELECT RAISE(ABORT,'cloud_workspace_document_owner'); END;
-- statement
CREATE TRIGGER cloud_workspace_document_immutable BEFORE UPDATE ON cloud_workspace_documents
BEGIN SELECT RAISE(ABORT,'cloud_workspace_document_immutable'); END;
-- statement
CREATE TRIGGER cloud_workspace_document_preserved BEFORE DELETE ON cloud_workspace_documents
BEGIN SELECT RAISE(ABORT,'cloud_workspace_document_preserved'); END;
-- statement
CREATE TABLE cloud_material_uploads (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  state TEXT NOT NULL CHECK(state IN ('receiving','completed')), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,upload_id),
  CHECK((state='receiving' AND receipt_json IS NULL) OR (state='completed' AND receipt_json IS NOT NULL))
);
-- statement
CREATE TABLE cloud_material_chunks (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('original','parsed')),
  name TEXT NOT NULL, byte_offset INTEGER NOT NULL CHECK(byte_offset>=0), content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 262144),
  PRIMARY KEY(workspace_id,upload_id,kind,name,byte_offset),
  FOREIGN KEY(workspace_id,upload_id) REFERENCES cloud_material_uploads(workspace_id,upload_id)
);
-- statement
CREATE TRIGGER cloud_material_upload_identity_immutable BEFORE UPDATE OF workspace_id,upload_id,manifest_json,created_at ON cloud_material_uploads
BEGIN SELECT RAISE(ABORT,'cloud_material_upload_identity_immutable'); END;
-- statement
CREATE TRIGGER cloud_material_chunk_immutable BEFORE UPDATE ON cloud_material_chunks
BEGIN SELECT RAISE(ABORT,'cloud_material_chunk_immutable'); END;
-- statement
CREATE TRIGGER cloud_material_chunk_preserved BEFORE DELETE ON cloud_material_chunks
BEGIN SELECT RAISE(ABORT,'cloud_material_chunk_preserved'); END;
-- statement
CREATE TABLE cloud_desktop_material_uploads (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, document_id INTEGER NOT NULL REFERENCES documents(id),
  document_version TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,upload_id), UNIQUE(workspace_id,document_id,document_version)
);
-- statement
CREATE TRIGGER cloud_desktop_material_identity_immutable BEFORE UPDATE OF workspace_id,upload_id,document_id,document_version,manifest_json,created_at ON cloud_desktop_material_uploads
BEGIN SELECT RAISE(ABORT,'cloud_desktop_material_identity_immutable'); END;
-- statement
CREATE TABLE cloud_queue_controls (
  id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, work_id INTEGER NOT NULL REFERENCES invoice_works(id), session_id INTEGER NOT NULL REFERENCES sessions(id),
  attempt_id INTEGER NOT NULL REFERENCES invoice_work_attempts(id), control_request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL, UNIQUE(work_id,control_request_id)
);
-- statement
CREATE TRIGGER cloud_queue_control_identity_immutable BEFORE UPDATE OF id,workspace_id,work_id,session_id,attempt_id,control_request_id,request_json,created_at ON cloud_queue_controls
BEGIN SELECT RAISE(ABORT,'cloud_queue_control_identity_immutable'); END;
-- statement
CREATE TRIGGER cloud_queue_control_preserved BEFORE DELETE ON cloud_queue_controls
BEGIN SELECT RAISE(ABORT,'cloud_queue_control_preserved'); END;
-- statement
CREATE TABLE cloud_resource_uploads (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  state TEXT NOT NULL CHECK(state IN ('receiving','completed')), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,upload_id),
  CHECK((state='receiving' AND receipt_json IS NULL) OR (state='completed' AND receipt_json IS NOT NULL))
);
-- statement
CREATE TABLE cloud_resource_chunks (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, path TEXT NOT NULL, byte_offset INTEGER NOT NULL CHECK(byte_offset>=0),
  content BLOB NOT NULL CHECK(length(content) BETWEEN 1 AND 262144), PRIMARY KEY(workspace_id,upload_id,path,byte_offset),
  FOREIGN KEY(workspace_id,upload_id) REFERENCES cloud_resource_uploads(workspace_id,upload_id)
);
-- statement
CREATE TRIGGER cloud_resource_upload_identity_immutable BEFORE UPDATE OF workspace_id,upload_id,manifest_json,created_at ON cloud_resource_uploads
BEGIN SELECT RAISE(ABORT,'cloud_resource_upload_identity_immutable'); END;
-- statement
CREATE TRIGGER cloud_resource_receipt_immutable BEFORE UPDATE OF state,receipt_json ON cloud_resource_uploads
WHEN OLD.receipt_json IS NOT NULL AND (NEW.receipt_json IS NOT OLD.receipt_json OR NEW.state IS NOT OLD.state)
BEGIN SELECT RAISE(ABORT,'cloud_resource_receipt_immutable'); END;
-- statement
CREATE TRIGGER cloud_resource_upload_preserved BEFORE DELETE ON cloud_resource_uploads
BEGIN SELECT RAISE(ABORT,'cloud_resource_upload_preserved'); END;
-- statement
CREATE TRIGGER cloud_resource_chunk_immutable BEFORE UPDATE ON cloud_resource_chunks
BEGIN SELECT RAISE(ABORT,'cloud_resource_chunk_immutable'); END;
-- statement
CREATE TRIGGER cloud_resource_chunk_preserved BEFORE DELETE ON cloud_resource_chunks
BEGIN SELECT RAISE(ABORT,'cloud_resource_chunk_preserved'); END;
-- statement
CREATE TABLE cloud_desktop_resource_uploads (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('prompt','skill')),
  resource_id TEXT NOT NULL, resource_version TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,upload_id), UNIQUE(workspace_id,kind,resource_id,resource_version)
);
-- statement
CREATE TRIGGER cloud_desktop_resource_identity_immutable BEFORE UPDATE OF workspace_id,upload_id,kind,resource_id,resource_version,manifest_json,created_at ON cloud_desktop_resource_uploads
BEGIN SELECT RAISE(ABORT,'cloud_desktop_resource_identity_immutable'); END;
-- statement
CREATE TRIGGER cloud_desktop_resource_receipt_immutable BEFORE UPDATE OF receipt_json ON cloud_desktop_resource_uploads
WHEN OLD.receipt_json IS NOT NULL AND NEW.receipt_json IS NOT OLD.receipt_json
BEGIN SELECT RAISE(ABORT,'cloud_desktop_resource_receipt_immutable'); END;
-- statement
CREATE TRIGGER cloud_desktop_resource_upload_preserved BEFORE DELETE ON cloud_desktop_resource_uploads
BEGIN SELECT RAISE(ABORT,'cloud_desktop_resource_upload_preserved'); END;
-- statement
CREATE TABLE cloud_workspace_resources (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('prompt','skill')),
  resource_id TEXT NOT NULL, resource_version TEXT NOT NULL, PRIMARY KEY(workspace_id,upload_id)
);
-- statement
CREATE INDEX cloud_workspace_resource_ref ON cloud_workspace_resources(workspace_id,kind,resource_id,resource_version);
-- statement
CREATE TRIGGER cloud_workspace_resource_immutable BEFORE UPDATE ON cloud_workspace_resources
BEGIN SELECT RAISE(ABORT,'cloud_workspace_resource_immutable'); END;
-- statement
CREATE TRIGGER cloud_workspace_resource_preserved BEFORE DELETE ON cloud_workspace_resources
BEGIN SELECT RAISE(ABORT,'cloud_workspace_resource_preserved'); END;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(23,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
