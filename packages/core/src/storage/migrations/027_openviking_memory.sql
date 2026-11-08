BEGIN IMMEDIATE;
-- statement
CREATE TABLE memory_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  provider TEXT NOT NULL DEFAULT 'native' CHECK(provider IN ('native','openviking')),
  recall_enabled INTEGER NOT NULL DEFAULT 0 CHECK(recall_enabled IN (0,1)),
  capture_mode TEXT NOT NULL DEFAULT 'off' CHECK(capture_mode IN ('off','explicit','auto')),
  endpoint TEXT,
  updated_at TEXT NOT NULL
);
-- statement
INSERT INTO memory_config(id,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
-- statement
CREATE TABLE memory_identities (
  id INTEGER PRIMARY KEY,
  environment TEXT NOT NULL CHECK(environment IN ('local','cloud')),
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 128),
  account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 128),
  peer_id TEXT NOT NULL CHECK(length(peer_id) BETWEEN 1 AND 256),
  credential_ref TEXT NOT NULL CHECK(length(credential_ref) BETWEEN 16 AND 128),
  state TEXT NOT NULL CHECK(state IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(environment,owner_id,account_id,user_id,peer_id)
);
-- statement
CREATE TABLE memory_bindings (
  id INTEGER PRIMARY KEY,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('agent_session','durable')),
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  work_id INTEGER REFERENCES invoice_works(id) ON DELETE CASCADE,
  item_id INTEGER,
  branch INTEGER NOT NULL DEFAULT 0 CHECK(branch BETWEEN 0 AND 9007199254740991),
  provider TEXT NOT NULL CHECK(provider IN ('native','openviking')),
  identity_id INTEGER REFERENCES memory_identities(id),
  remote_session_id TEXT,
  endpoint TEXT,
  remote_state TEXT CHECK(remote_state IN ('pending','creating','ready','unknown')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id) ON DELETE CASCADE,
  CHECK((runtime_kind='agent_session' AND work_id IS NULL AND item_id IS NULL)
    OR (runtime_kind='durable' AND work_id IS NOT NULL AND item_id IS NOT NULL)),
  CHECK((provider='native' AND identity_id IS NULL AND remote_session_id IS NULL AND endpoint IS NULL AND remote_state IS NULL)
    OR (provider='openviking' AND identity_id IS NOT NULL AND remote_session_id IS NOT NULL AND length(remote_session_id) BETWEEN 1 AND 128 AND endpoint IS NOT NULL AND remote_state IS NOT NULL))
);
-- statement
CREATE UNIQUE INDEX memory_binding_session ON memory_bindings(session_id,branch) WHERE runtime_kind='agent_session';
-- statement
CREATE UNIQUE INDEX memory_binding_item ON memory_bindings(work_id,item_id,branch) WHERE runtime_kind='durable';
-- statement
CREATE UNIQUE INDEX memory_binding_remote ON memory_bindings(identity_id,remote_session_id) WHERE provider='openviking';
-- statement
CREATE TRIGGER memory_binding_owner BEFORE INSERT ON memory_bindings
WHEN NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND s.runtime_kind=NEW.runtime_kind)
  OR (NEW.runtime_kind='durable' AND NOT EXISTS (SELECT 1 FROM invoice_works w WHERE w.id=NEW.work_id AND w.session_id=NEW.session_id))
BEGIN SELECT RAISE(ABORT,'memory_binding_owner_invalid'); END;
-- statement
INSERT INTO memory_bindings(runtime_kind,session_id,branch,provider,created_at)
SELECT 'agent_session',s.id,0,'native',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM sessions s
WHERE s.runtime_kind='agent_session' AND (EXISTS (SELECT 1 FROM session_inputs i WHERE i.session_id=s.id)
  OR EXISTS (SELECT 1 FROM session_native_entries e WHERE e.session_id=s.id));
-- statement
INSERT INTO memory_bindings(runtime_kind,session_id,work_id,item_id,branch,provider,created_at)
SELECT 'durable',w.session_id,w.id,i.id,0,'native',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM invoice_work_items i JOIN invoice_works w ON w.id=i.work_id JOIN sessions s ON s.id=w.session_id
WHERE s.runtime_kind='durable';
-- statement
CREATE TABLE memory_input_bindings (
  input_id INTEGER PRIMARY KEY REFERENCES session_inputs(id) ON DELETE CASCADE,
  binding_id INTEGER NOT NULL REFERENCES memory_bindings(id) ON DELETE CASCADE
);
-- statement
CREATE TRIGGER memory_input_binding_owner BEFORE INSERT ON memory_input_bindings
WHEN NOT EXISTS (SELECT 1 FROM session_inputs i JOIN memory_bindings b ON b.session_id=i.session_id
  WHERE i.id=NEW.input_id AND b.id=NEW.binding_id AND b.runtime_kind='agent_session')
BEGIN SELECT RAISE(ABORT,'memory_input_binding_owner_invalid'); END;
-- statement
CREATE TRIGGER memory_input_binding_immutable BEFORE UPDATE ON memory_input_bindings
BEGIN SELECT RAISE(ABORT,'memory_input_binding_immutable'); END;
-- statement
INSERT INTO memory_input_bindings(input_id,binding_id)
SELECT i.id,b.id FROM session_inputs i JOIN memory_bindings b ON b.session_id=i.session_id
WHERE b.runtime_kind='agent_session' AND b.branch=0;
-- statement
CREATE TABLE memory_recalls (
  id INTEGER PRIMARY KEY,
  binding_id INTEGER NOT NULL REFERENCES memory_bindings(id) ON DELETE CASCADE,
  input_id INTEGER REFERENCES session_inputs(id) ON DELETE CASCADE,
  phase_id INTEGER REFERENCES invoice_work_phases(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','disabled','empty','ready','unavailable')),
  entries_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(entries_json)),
  created_at TEXT NOT NULL,
  CHECK((input_id IS NULL)!=(phase_id IS NULL))
);
-- statement
CREATE UNIQUE INDEX memory_recall_input ON memory_recalls(binding_id,input_id) WHERE input_id IS NOT NULL;
-- statement
CREATE UNIQUE INDEX memory_recall_phase ON memory_recalls(binding_id,phase_id) WHERE phase_id IS NOT NULL;
-- statement
CREATE TABLE memory_sync (
  id INTEGER PRIMARY KEY,
  binding_id INTEGER NOT NULL REFERENCES memory_bindings(id) ON DELETE CASCADE,
  input_id INTEGER REFERENCES session_inputs(id) ON DELETE CASCADE,
  phase_id INTEGER REFERENCES invoice_work_phases(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','unknown','appended','commit_pending','accepted','running','completed','failed','cancelled','abandoned')),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor BETWEEN 0 AND 9007199254740991),
  remote_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((input_id IS NULL)!=(phase_id IS NULL))
);
-- statement
CREATE UNIQUE INDEX memory_sync_input ON memory_sync(binding_id,input_id) WHERE input_id IS NOT NULL;
-- statement
CREATE UNIQUE INDEX memory_sync_phase ON memory_sync(binding_id,phase_id) WHERE phase_id IS NOT NULL;
-- statement
CREATE TABLE memory_entries (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES memory_identities(id),
  endpoint TEXT NOT NULL,
  uri TEXT NOT NULL CHECK(length(uri) BETWEEN 1 AND 4096),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('active','forgotten')),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(identity_id,endpoint,uri)
);
-- statement
CREATE TABLE memory_grants (
  entry_id INTEGER NOT NULL REFERENCES memory_entries(id),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('personal','session','work','workspace')),
  scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(entry_id,scope_kind,scope_id)
);
-- statement
CREATE TRIGGER memory_grants_remove_session AFTER DELETE ON sessions
BEGIN DELETE FROM memory_grants WHERE scope_kind='session' AND scope_id=CAST(OLD.id AS TEXT); END;
-- statement
CREATE TABLE memory_forget_requests (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES memory_identities(id),
  entry_id INTEGER NOT NULL REFERENCES memory_entries(id),
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
  expected_revision INTEGER NOT NULL CHECK(expected_revision BETWEEN 1 AND 9007199254740990),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','unknown','completed','conflict')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(identity_id,request_id)
);
-- statement
CREATE TABLE memory_remember_requests (
  id INTEGER PRIMARY KEY,
  identity_id INTEGER NOT NULL REFERENCES memory_identities(id),
  binding_id INTEGER NOT NULL REFERENCES memory_bindings(id) ON DELETE CASCADE,
  input_id INTEGER REFERENCES session_inputs(id) ON DELETE CASCADE,
  phase_id INTEGER REFERENCES invoice_work_phases(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
  uri TEXT NOT NULL CHECK(length(uri) BETWEEN 1 AND 4096),
  content TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('personal','session','work')),
  scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK(state IN ('pending','sending','unknown','completed','failed','forgotten')),
  content_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(content_confirmed IN (0,1)),
  entry_id INTEGER REFERENCES memory_entries(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(identity_id,request_id),
  CHECK((input_id IS NULL)!=(phase_id IS NULL)),
  CHECK((state='forgotten' AND content='') OR (state!='forgotten' AND length(content)>0))
);
-- statement
CREATE TRIGGER memory_forget_owner BEFORE INSERT ON memory_forget_requests
WHEN NOT EXISTS (SELECT 1 FROM memory_entries e WHERE e.id=NEW.entry_id AND e.identity_id=NEW.identity_id)
BEGIN SELECT RAISE(ABORT,'memory_forget_owner_invalid'); END;
-- statement
CREATE TRIGGER memory_forget_identity_immutable BEFORE UPDATE OF identity_id,entry_id,request_id,expected_revision ON memory_forget_requests
BEGIN SELECT RAISE(ABORT,'memory_forget_identity_immutable'); END;
-- statement
CREATE TRIGGER memory_remember_owner BEFORE INSERT ON memory_remember_requests
WHEN NOT EXISTS (SELECT 1 FROM memory_bindings b WHERE b.id=NEW.binding_id AND b.identity_id=NEW.identity_id AND (
  (b.runtime_kind='agent_session' AND NEW.input_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM session_inputs i JOIN memory_input_bindings m ON m.input_id=i.id AND m.binding_id=b.id
      WHERE i.id=NEW.input_id AND i.session_id=b.session_id)) OR
  (b.runtime_kind='durable' AND NEW.phase_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM invoice_work_phases p WHERE p.id=NEW.phase_id AND p.work_id=b.work_id AND p.item_id=b.item_id))))
BEGIN SELECT RAISE(ABORT,'memory_remember_owner_invalid'); END;
-- statement
CREATE TRIGGER memory_entry_revision BEFORE UPDATE OF source_json ON memory_entries
WHEN NEW.source_json!=OLD.source_json AND NEW.revision<=OLD.revision
BEGIN SELECT RAISE(ABORT,'memory_entry_revision_required'); END;
-- statement
CREATE TRIGGER memory_entry_identity_immutable BEFORE UPDATE OF identity_id,endpoint,uri ON memory_entries
BEGIN SELECT RAISE(ABORT,'memory_entry_identity_immutable'); END;
-- statement
CREATE TRIGGER memory_binding_identity_immutable BEFORE UPDATE OF runtime_kind,session_id,work_id,item_id,branch,provider,identity_id,remote_session_id,endpoint ON memory_bindings
BEGIN SELECT RAISE(ABORT,'memory_binding_identity_immutable'); END;
-- statement
CREATE TRIGGER memory_recall_owner BEFORE INSERT ON memory_recalls
WHEN NOT EXISTS (SELECT 1 FROM memory_bindings b WHERE b.id=NEW.binding_id AND (
  (b.runtime_kind='agent_session' AND NEW.input_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM session_inputs i JOIN memory_input_bindings m ON m.input_id=i.id AND m.binding_id=b.id
      WHERE i.id=NEW.input_id AND i.session_id=b.session_id)) OR
  (b.runtime_kind='durable' AND NEW.phase_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM invoice_work_phases p WHERE p.id=NEW.phase_id AND p.work_id=b.work_id AND p.item_id=b.item_id))))
BEGIN SELECT RAISE(ABORT,'memory_recall_owner_invalid'); END;
-- statement
CREATE TRIGGER memory_recall_identity_immutable BEFORE UPDATE OF binding_id,input_id,phase_id ON memory_recalls
BEGIN SELECT RAISE(ABORT,'memory_recall_identity_immutable'); END;
-- statement
CREATE TRIGGER memory_sync_owner BEFORE INSERT ON memory_sync
WHEN NOT EXISTS (SELECT 1 FROM memory_bindings b WHERE b.id=NEW.binding_id AND (
  (b.runtime_kind='agent_session' AND NEW.input_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM session_inputs i JOIN memory_input_bindings m ON m.input_id=i.id AND m.binding_id=b.id
      WHERE i.id=NEW.input_id AND i.session_id=b.session_id)) OR
  (b.runtime_kind='durable' AND NEW.phase_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM invoice_work_phases p WHERE p.id=NEW.phase_id AND p.work_id=b.work_id AND p.item_id=b.item_id))))
BEGIN SELECT RAISE(ABORT,'memory_sync_owner_invalid'); END;
-- statement
CREATE TRIGGER memory_sync_identity_immutable BEFORE UPDATE OF binding_id,input_id,phase_id ON memory_sync
BEGIN SELECT RAISE(ABORT,'memory_sync_identity_immutable'); END;
-- statement
CREATE TRIGGER memory_sync_unresolved_preserved BEFORE DELETE ON memory_sync
WHEN OLD.state IN ('sending','unknown','accepted','running')
BEGIN SELECT RAISE(ABORT,'memory_operation_unresolved'); END;
-- statement
CREATE TRIGGER memory_remember_unresolved_preserved BEFORE DELETE ON memory_remember_requests
WHEN OLD.state IN ('sending','unknown')
BEGIN SELECT RAISE(ABORT,'memory_operation_unresolved'); END;
-- statement
CREATE TRIGGER memory_binding_unresolved_preserved BEFORE DELETE ON memory_bindings
WHEN OLD.remote_state IN ('creating','unknown')
BEGIN SELECT RAISE(ABORT,'memory_operation_unresolved'); END;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(27,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
