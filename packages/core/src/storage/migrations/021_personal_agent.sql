-- statement
BEGIN IMMEDIATE;
-- statement
CREATE TABLE sessions_p18 (
  id INTEGER PRIMARY KEY,
  native_session_id TEXT UNIQUE CHECK(native_session_id IS NULL OR length(native_session_id) BETWEEN 1 AND 128),
  title TEXT NOT NULL DEFAULT 'New Session' CHECK(length(trim(title)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{"version":1,"model_use_blocked":null}' CHECK(json_valid(metadata_json)),
  hidden_at TEXT,
  runtime_kind TEXT NOT NULL DEFAULT 'agent_session' CHECK(runtime_kind IN ('agent_session','durable')),
  durable_conversation_id INTEGER UNIQUE CHECK(durable_conversation_id IS NULL OR
    (typeof(durable_conversation_id)='integer' AND durable_conversation_id BETWEEN 1 AND 9007199254740991)),
  CHECK((runtime_kind='agent_session' AND native_session_id IS NOT NULL AND durable_conversation_id IS NULL)
    OR (runtime_kind='durable' AND native_session_id IS NULL))
);
-- statement
INSERT INTO sessions_p18(id,native_session_id,title,status,created_at,updated_at,metadata_json,hidden_at)
SELECT id,native_session_id,title,status,created_at,updated_at,metadata_json,hidden_at FROM sessions;
-- statement
DROP TABLE sessions;
-- statement
ALTER TABLE sessions_p18 RENAME TO sessions;
-- statement
CREATE INDEX sessions_recent ON sessions(updated_at DESC, id DESC);
-- statement
CREATE INDEX sessions_visible_recent ON sessions(updated_at DESC, id DESC) WHERE hidden_at IS NULL;
-- statement
CREATE TRIGGER session_runtime_immutable BEFORE UPDATE OF runtime_kind ON sessions
WHEN NEW.runtime_kind IS NOT OLD.runtime_kind
BEGIN SELECT RAISE(ABORT,'session_runtime_immutable'); END;
-- statement
DROP INDEX runs_one_active_root;
-- statement
CREATE TRIGGER runs_engine_active_insert BEFORE INSERT ON runs
WHEN NEW.kind!='subagent' AND NEW.status IN ('created','running') AND EXISTS (
  SELECT 1 FROM runs r LEFT JOIN sessions s ON s.id=r.session_id
  WHERE r.kind!='subagent' AND r.status IN ('created','running')
    AND CASE WHEN r.kind='provider' THEN 'agent_session' ELSE s.runtime_kind END
      = CASE WHEN NEW.kind='provider' THEN 'agent_session' ELSE (SELECT runtime_kind FROM sessions WHERE id=NEW.session_id) END)
BEGIN SELECT RAISE(ABORT,'runs_one_active_root'); END;
-- statement
CREATE TRIGGER runs_engine_active_update BEFORE UPDATE OF status,kind,session_id ON runs
WHEN NEW.kind!='subagent' AND NEW.status IN ('created','running') AND EXISTS (
  SELECT 1 FROM runs r LEFT JOIN sessions s ON s.id=r.session_id
  WHERE r.id!=NEW.id AND r.kind!='subagent' AND r.status IN ('created','running')
    AND CASE WHEN r.kind='provider' THEN 'agent_session' ELSE s.runtime_kind END
      = CASE WHEN NEW.kind='provider' THEN 'agent_session' ELSE (SELECT runtime_kind FROM sessions WHERE id=NEW.session_id) END)
BEGIN SELECT RAISE(ABORT,'runs_one_active_root'); END;
-- statement
CREATE TABLE personal_agents (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- statement
CREATE TABLE invoice_works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personal_agent_id INTEGER NOT NULL REFERENCES personal_agents(id),
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
  agent_revision INTEGER NOT NULL CHECK(agent_revision BETWEEN 0 AND 9007199254740991),
  configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
  budget_json TEXT NOT NULL CHECK(json_valid(budget_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  goal TEXT NOT NULL CHECK(length(CAST(goal AS BLOB)) BETWEEN 1 AND 22000),
  status TEXT NOT NULL CHECK(status IN ('open','completed','cancelled')),
  source_json TEXT CHECK(source_json IS NULL OR json_valid(source_json)),
  current_attempt_id INTEGER REFERENCES invoice_work_attempts(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK((status='open' AND ended_at IS NULL) OR (status!='open' AND ended_at IS NOT NULL))
);
-- statement
CREATE TABLE invoice_work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  document_version TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id),
  candidate_id INTEGER REFERENCES invoice_candidates(id),
  candidate_sequence INTEGER,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  disposition TEXT NOT NULL DEFAULT 'unresolved' CHECK(disposition IN ('unresolved','accepted','rejected','excluded')),
  decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
  disposed_at TEXT,
  latest_input_id INTEGER REFERENCES invoice_work_inputs(id) DEFERRABLE INITIALLY DEFERRED,
  updated_at TEXT NOT NULL,
  UNIQUE(work_id,document_id),
  UNIQUE(id,work_id),
  CHECK((candidate_id IS NULL)=(candidate_sequence IS NULL)),
  CHECK((disposition='unresolved' AND decision_json IS NULL AND disposed_at IS NULL)
    OR (disposition!='unresolved' AND decision_json IS NOT NULL AND disposed_at IS NOT NULL))
);
-- statement
CREATE TABLE invoice_work_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personal_agent_id INTEGER NOT NULL REFERENCES personal_agents(id),
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  kind TEXT NOT NULL CHECK(kind IN ('create','continueWork','supplement','disposeItem','cancelWork')),
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  received_at TEXT NOT NULL,
  UNIQUE(work_id,kind,request_id)
);
-- statement
CREATE UNIQUE INDEX invoice_work_create_request ON invoice_work_operations(personal_agent_id,request_id) WHERE kind='create';
-- statement
CREATE TABLE invoice_work_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  previous_attempt_id INTEGER,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('create','continueWork','supplement')),
  trigger_request_id TEXT NOT NULL,
  run_id INTEGER UNIQUE REFERENCES runs(id),
  created_at TEXT NOT NULL,
  stop_requested_at TEXT,
  stopped_at TEXT,
  UNIQUE(id,work_id),
  FOREIGN KEY(previous_attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id),
  FOREIGN KEY(work_id,trigger_kind,trigger_request_id)
    REFERENCES invoice_work_operations(work_id,kind,request_id) DEFERRABLE INITIALLY DEFERRED
);
-- statement
CREATE TABLE invoice_work_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  item_id INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id),
  UNIQUE(id,item_id,work_id)
);
-- statement
CREATE TABLE invoice_work_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  item_id INTEGER NOT NULL,
  todo_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=22000),
  materials_json TEXT NOT NULL CHECK(json_valid(materials_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id),
  FOREIGN KEY(todo_id,item_id,work_id) REFERENCES invoice_work_todos(id,item_id,work_id),
  UNIQUE(work_id,request_id)
);
-- statement
CREATE TABLE invoice_work_phases (
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
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id),
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id),
  UNIQUE(attempt_id,request_id),
  UNIQUE(native_conversation_id,native_submission_id),
  CHECK((native_conversation_id IS NULL)=(native_submission_id IS NULL)),
  CHECK(native_conversation_id IS NULL OR native_conversation_id BETWEEN 1 AND 9007199254740991),
  CHECK(native_submission_id IS NULL OR native_submission_id BETWEEN 1 AND 9007199254740991),
  CHECK(consumed_at IS NULL OR native_submission_id IS NOT NULL)
);
-- statement
CREATE INDEX invoice_works_admission ON invoice_works(status,created_at,id);
-- statement
CREATE INDEX invoice_work_items_page ON invoice_work_items(work_id,id);
-- statement
CREATE INDEX invoice_work_todos_page ON invoice_work_todos(work_id,item_id,id);
-- statement
CREATE INDEX invoice_work_attempts_page ON invoice_work_attempts(work_id,id DESC);
-- statement
CREATE TRIGGER invoice_work_operation_immutable BEFORE UPDATE ON invoice_work_operations
BEGIN SELECT RAISE(ABORT,'invoice_work_operation_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_operation_preserved BEFORE DELETE ON invoice_work_operations
BEGIN SELECT RAISE(ABORT,'invoice_work_operation_preserved'); END;
-- statement
CREATE TRIGGER invoice_work_input_immutable BEFORE UPDATE ON invoice_work_inputs
BEGIN SELECT RAISE(ABORT,'invoice_work_input_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_phase_basis_immutable
BEFORE UPDATE OF work_id,attempt_id,item_id,request_id,kind,basis_json,created_at ON invoice_work_phases
BEGIN SELECT RAISE(ABORT,'invoice_work_phase_basis_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_phase_result_preserved BEFORE UPDATE ON invoice_work_phases
WHEN (OLD.native_submission_id IS NOT NULL AND
  (NEW.native_conversation_id IS NOT OLD.native_conversation_id OR NEW.native_submission_id IS NOT OLD.native_submission_id))
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
  OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at)
BEGIN SELECT RAISE(ABORT,'invoice_work_phase_result_preserved'); END;
-- statement
CREATE TABLE invoice_work_context_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id INTEGER NOT NULL UNIQUE REFERENCES invoice_work_phases(id) ON DELETE RESTRICT,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id) ON DELETE RESTRICT,
  attempt_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK(length(trim(request_id)) BETWEEN 1 AND 128),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(CAST(context_json AS BLOB))<=8388608),
  created_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id) ON DELETE RESTRICT,
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id) ON DELETE RESTRICT,
  UNIQUE(work_id,attempt_id,request_id)
);
-- statement
CREATE TRIGGER invoice_work_context_owner BEFORE INSERT ON invoice_work_context_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM invoice_work_phases p JOIN invoice_works w ON w.id=p.work_id JOIN sessions s ON s.id=w.session_id
  WHERE p.id=NEW.phase_id AND p.work_id=NEW.work_id AND p.attempt_id=NEW.attempt_id AND p.item_id=NEW.item_id
    AND p.request_id=NEW.request_id AND p.kind='prompt' AND w.session_id=NEW.session_id AND s.runtime_kind='durable'
    AND json_extract(NEW.context_json,'$.work.workId')=NEW.work_id
    AND json_extract(NEW.context_json,'$.work.personalAgentId')=w.personal_agent_id
    AND json_extract(NEW.context_json,'$.work.sessionId')=NEW.session_id
    AND json_extract(NEW.context_json,'$.item.workId')=NEW.work_id
    AND json_extract(NEW.context_json,'$.item.itemId')=NEW.item_id
    AND json_extract(NEW.context_json,'$.phase.phaseId')=NEW.phase_id
    AND json_extract(NEW.context_json,'$.phase.attemptId')=NEW.attempt_id
    AND json_extract(NEW.context_json,'$.phase.requestId')=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'invoice_work_context_owner_invalid'); END;
-- statement
CREATE TRIGGER invoice_work_context_immutable BEFORE UPDATE ON invoice_work_context_snapshots
BEGIN SELECT RAISE(ABORT,'invoice_work_context_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_context_preserved BEFORE DELETE ON invoice_work_context_snapshots
BEGIN SELECT RAISE(ABORT,'invoice_work_context_preserved'); END;
-- statement
CREATE TABLE invoice_work_model_reservations (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  count INTEGER NOT NULL CHECK(count>=0)
);
-- statement
CREATE UNIQUE INDEX invoice_work_attempt_successor ON invoice_work_attempts(previous_attempt_id) WHERE previous_attempt_id IS NOT NULL;
-- statement
CREATE TABLE invoice_work_attempt_stop_requests (
  work_id INTEGER NOT NULL,
  attempt_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  received_at TEXT NOT NULL,
  PRIMARY KEY(work_id,attempt_id,request_id),
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id) ON DELETE RESTRICT
);
-- statement
CREATE TRIGGER invoice_work_attempt_stop_immutable BEFORE UPDATE ON invoice_work_attempt_stop_requests
BEGIN SELECT RAISE(ABORT,'invoice_work_attempt_stop_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_attempt_stop_preserved BEFORE DELETE ON invoice_work_attempt_stop_requests
BEGIN SELECT RAISE(ABORT,'invoice_work_attempt_stop_preserved'); END;
-- statement
CREATE TABLE invoice_work_model_bindings (
  work_id INTEGER PRIMARY KEY REFERENCES invoice_works(id) ON DELETE RESTRICT,
  attempt_id INTEGER,
  model_id TEXT NOT NULL,
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id) ON DELETE RESTRICT
);
-- statement
CREATE TRIGGER invoice_work_model_binding_immutable BEFORE UPDATE ON invoice_work_model_bindings
BEGIN SELECT RAISE(ABORT,'invoice_work_model_binding_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_model_binding_preserved BEFORE DELETE ON invoice_work_model_bindings
BEGIN SELECT RAISE(ABORT,'invoice_work_model_binding_preserved'); END;
-- statement
CREATE TABLE invoice_work_tool_calls (
  tool_call_id INTEGER PRIMARY KEY REFERENCES tool_calls(id) ON DELETE RESTRICT,
  phase_id INTEGER NOT NULL REFERENCES invoice_work_phases(id) ON DELETE RESTRICT,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  feedback_native_entry_id INTEGER CHECK(feedback_native_entry_id BETWEEN 1 AND 9007199254740991),
  feedback_bytes INTEGER CHECK(feedback_bytes BETWEEN 1 AND 9007199254740991),
  parent_received_model_task_id INTEGER CHECK(parent_received_model_task_id IS NULL OR
    (typeof(parent_received_model_task_id)='integer' AND parent_received_model_task_id BETWEEN 1 AND 9007199254740991)),
  parent_received_at TEXT CHECK(parent_received_at IS NULL OR length(trim(parent_received_at))>0),
  CHECK((feedback_native_entry_id IS NULL)=(feedback_bytes IS NULL)),
  CHECK((parent_received_model_task_id IS NULL)=(parent_received_at IS NULL)),
  CHECK(parent_received_model_task_id IS NULL OR feedback_native_entry_id IS NOT NULL)
);
-- statement
CREATE TRIGGER invoice_work_tool_call_owner BEFORE INSERT ON invoice_work_tool_calls
WHEN NOT EXISTS (
  SELECT 1 FROM tool_calls t JOIN runs r ON r.id=t.run_id AND r.session_id=t.session_id JOIN sessions s ON s.id=r.session_id
  JOIN invoice_work_attempts a ON a.run_id=CASE WHEN r.kind='subagent' THEN r.parent_run_id ELSE r.id END
  JOIN invoice_work_phases p ON p.attempt_id=a.id AND p.work_id=a.work_id
  JOIN invoice_work_items i ON i.id=p.item_id AND i.work_id=p.work_id
  JOIN invoice_work_context_snapshots c ON c.phase_id=p.id AND c.item_id=i.id
  WHERE t.id=NEW.tool_call_id AND p.id=NEW.phase_id AND s.runtime_kind='durable' AND r.job_id IS NULL
    AND (r.kind='agent' OR (r.kind='subagent' AND json_extract(r.scope_json,'$.version')=5
      AND json_extract(r.scope_json,'$.workId')=p.work_id AND json_extract(r.scope_json,'$.attemptId')=p.attempt_id
      AND json_extract(r.scope_json,'$.phaseId')=p.id AND json_extract(r.scope_json,'$.itemId')=i.id
      AND EXISTS (SELECT 1 FROM tool_calls origin JOIN invoice_work_tool_calls original ON original.tool_call_id=origin.id
        JOIN runs parent ON parent.id=origin.run_id AND parent.kind='agent'
        WHERE origin.id=r.origin_tool_call_id AND origin.run_id=r.parent_run_id AND origin.tool_name='Agent'
          AND original.phase_id=p.id AND r.plugin_agent_id=origin.native_tool_call_id)))
    AND json_extract(NEW.scope_json,'$.version')=2
    AND json_extract(NEW.scope_json,'$.invoiceWork.workId')=p.work_id
    AND json_extract(NEW.scope_json,'$.invoiceWork.attemptId')=p.attempt_id
    AND json_extract(NEW.scope_json,'$.invoiceWork.phaseId')=p.id
    AND json_extract(NEW.scope_json,'$.invoiceWork.itemId')=i.id)
BEGIN SELECT RAISE(ABORT,'invoice_work_tool_call_owner_invalid'); END;
-- statement
CREATE TRIGGER invoice_work_tool_call_preserved BEFORE DELETE ON invoice_work_tool_calls
BEGIN SELECT RAISE(ABORT,'invoice_work_tool_call_preserved'); END;
-- statement
CREATE TRIGGER invoice_work_tool_call_immutable BEFORE UPDATE ON invoice_work_tool_calls
WHEN NEW.tool_call_id IS NOT OLD.tool_call_id OR NEW.phase_id IS NOT OLD.phase_id OR NEW.scope_json IS NOT OLD.scope_json
  OR OLD.feedback_native_entry_id IS NOT NULL AND (NEW.feedback_native_entry_id IS NOT OLD.feedback_native_entry_id OR NEW.feedback_bytes IS NOT OLD.feedback_bytes)
  OR OLD.parent_received_model_task_id IS NOT NULL AND (NEW.parent_received_model_task_id IS NOT OLD.parent_received_model_task_id OR NEW.parent_received_at IS NOT OLD.parent_received_at)
BEGIN SELECT RAISE(ABORT,'invoice_work_tool_call_immutable'); END;
-- statement
ALTER TABLE invoice_candidates RENAME TO invoice_candidates_p18_previous;
-- statement
CREATE TABLE invoice_candidates (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  run_id INTEGER REFERENCES runs(id) ON DELETE RESTRICT,
  tool_call_id INTEGER UNIQUE,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  origin TEXT NOT NULL CHECK(origin IN ('model','human_edit')),
  based_on_candidate_id INTEGER,
  status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated','accepted','rejected')),
  fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
  lines_json TEXT NOT NULL CHECK(json_valid(lines_json)),
  issues_json TEXT NOT NULL CHECK(json_valid(issues_json)),
  created_at TEXT NOT NULL, accepted_at TEXT,
  context_snapshot_id INTEGER REFERENCES context_snapshots(id) ON DELETE RESTRICT,
  request_sequence INTEGER CHECK((context_snapshot_id IS NULL)=(request_sequence IS NULL)
    AND (request_sequence IS NULL OR (typeof(request_sequence)='integer'
      AND request_sequence BETWEEN 1 AND 9007199254740991))
    AND (origin='model' OR context_snapshot_id IS NULL)),
  UNIQUE(job_id,sequence), UNIQUE(id,job_id),
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(based_on_candidate_id,job_id) REFERENCES invoice_candidates(id,job_id) ON DELETE RESTRICT,
  CHECK((origin='model' AND run_id IS NOT NULL AND tool_call_id IS NOT NULL AND based_on_candidate_id IS NULL)
    OR (origin='human_edit' AND run_id IS NULL AND tool_call_id IS NULL AND based_on_candidate_id IS NOT NULL AND based_on_candidate_id!=id)),
  CHECK((status='accepted' AND accepted_at IS NOT NULL) OR (status!='accepted' AND accepted_at IS NULL))
);
-- statement
INSERT INTO invoice_candidates SELECT * FROM invoice_candidates_p18_previous;
-- statement
DROP TABLE invoice_candidates_p18_previous;
-- statement
CREATE UNIQUE INDEX candidate_one_accepted ON invoice_candidates(job_id) WHERE status='accepted';
-- statement
CREATE TRIGGER context_candidate_insert_guard BEFORE INSERT ON invoice_candidates
WHEN (NEW.origin='human_edit' AND (NEW.context_snapshot_id IS NOT NULL OR NEW.request_sequence IS NOT NULL)) OR
  (NEW.origin='model' AND NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_snapshots c JOIN tool_calls t ON t.id=NEW.tool_call_id
    WHERE c.id=NEW.context_snapshot_id AND c.run_id=NEW.run_id AND c.job_id IS NEW.job_id
      AND t.run_id=NEW.run_id AND t.context_snapshot_id=NEW.context_snapshot_id
      AND t.request_sequence=NEW.request_sequence)) OR
  (NEW.origin='model' AND NEW.context_snapshot_id IS NULL AND EXISTS (
    SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.context_observations_json IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_candidate_owner_guard BEFORE UPDATE OF context_snapshot_id,request_sequence,run_id,job_id,tool_call_id,origin ON invoice_candidates
WHEN (NEW.origin='human_edit' AND (NEW.context_snapshot_id IS NOT NULL OR NEW.request_sequence IS NOT NULL)) OR
  (NEW.origin='model' AND NEW.context_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_snapshots c JOIN tool_calls t ON t.id=NEW.tool_call_id
    WHERE c.id=NEW.context_snapshot_id AND c.run_id=NEW.run_id AND c.job_id IS NEW.job_id
      AND t.run_id=NEW.run_id AND t.context_snapshot_id=NEW.context_snapshot_id
      AND t.request_sequence=NEW.request_sequence))
BEGIN SELECT RAISE(ABORT,'context_identity_invalid'); END;
-- statement
CREATE TRIGGER context_candidate_immutable_guard BEFORE UPDATE OF context_snapshot_id,request_sequence ON invoice_candidates
WHEN OLD.context_snapshot_id IS NOT NEW.context_snapshot_id OR OLD.request_sequence IS NOT NEW.request_sequence
BEGIN SELECT RAISE(ABORT,'context_binding_immutable'); END;
-- statement
CREATE TRIGGER invoice_candidate_insert_owner BEFORE INSERT ON invoice_candidates
WHEN NEW.origin='model' AND NOT EXISTS (
  SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=NEW.run_id AND (
    (s.runtime_kind='agent_session' AND r.job_id=NEW.job_id) OR
    (s.runtime_kind='durable' AND r.job_id IS NULL AND r.kind='agent' AND r.status='running' AND r.cancel_requested_at IS NULL AND EXISTS (
      SELECT 1 FROM invoice_work_tool_calls b JOIN tool_calls t ON t.id=b.tool_call_id AND t.run_id=r.id AND t.session_id=r.session_id
      JOIN invoice_work_phases p ON p.id=b.phase_id JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.run_id=r.id AND a.work_id=p.work_id
      JOIN invoice_works w ON w.id=p.work_id AND w.session_id=r.session_id AND w.current_attempt_id=a.id
      JOIN invoice_work_items i ON i.id=p.item_id AND i.work_id=w.id
      WHERE t.id=NEW.tool_call_id AND i.job_id=NEW.job_id AND i.disposition='unresolved' AND w.status='open'
        AND p.closed_at IS NULL AND a.stop_requested_at IS NULL AND a.stopped_at IS NULL))))
BEGIN SELECT RAISE(ABORT,'invoice_candidate_owner_invalid'); END;
-- statement
CREATE TRIGGER invoice_candidate_update_owner BEFORE UPDATE OF run_id,job_id,tool_call_id,origin ON invoice_candidates
WHEN NEW.origin='model' AND NOT EXISTS (
  SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=NEW.run_id AND (
    (s.runtime_kind='agent_session' AND r.job_id=NEW.job_id) OR
    (s.runtime_kind='durable' AND r.job_id IS NULL AND EXISTS (
      SELECT 1 FROM invoice_work_tool_calls b JOIN tool_calls t ON t.id=b.tool_call_id AND t.run_id=r.id AND t.session_id=r.session_id
      JOIN invoice_work_phases p ON p.id=b.phase_id JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.run_id=r.id AND a.work_id=p.work_id
      JOIN invoice_work_items i ON i.id=p.item_id AND i.work_id=p.work_id WHERE t.id=NEW.tool_call_id AND i.job_id=NEW.job_id))))
BEGIN SELECT RAISE(ABORT,'invoice_candidate_owner_invalid'); END;
-- statement
CREATE TRIGGER invoice_candidate_run_owner BEFORE UPDATE OF job_id,session_id ON runs
WHEN (NEW.job_id IS NOT OLD.job_id OR NEW.session_id IS NOT OLD.session_id)
  AND EXISTS(SELECT 1 FROM invoice_candidates c WHERE c.run_id=OLD.id AND c.origin='model')
BEGIN SELECT RAISE(ABORT,'invoice_candidate_owner_invalid'); END;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(21,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
