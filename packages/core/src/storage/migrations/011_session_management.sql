BEGIN IMMEDIATE;
CREATE TABLE session_inputs_v2 (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_sequence INTEGER NOT NULL CHECK(client_sequence BETWEEN 1 AND 9007199254740991),
  mode TEXT NOT NULL CHECK(mode IN ('prompt','steer','followUp')),
  goal_mode TEXT NOT NULL CHECK(goal_mode IN ('answer','save-candidate','fill-form')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  status TEXT NOT NULL CHECK(status IN ('queued','consumed','failed','cancelled','delivery_unknown')),
  processing_status TEXT NOT NULL CHECK(processing_status IN ('pending','completed','failed','cancelled')),
  native_entry_id TEXT,
  result_entry_id TEXT,
  dispatched_at TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id,client_sequence),
  UNIQUE(session_id,native_entry_id),
  FOREIGN KEY(session_id,native_entry_id) REFERENCES session_native_entries(session_id,entry_id) ON DELETE RESTRICT,
  FOREIGN KEY(session_id,result_entry_id) REFERENCES session_native_entries(session_id,entry_id) ON DELETE RESTRICT,
  CHECK((status='consumed' AND native_entry_id IS NOT NULL) OR (status!='consumed' AND native_entry_id IS NULL)),
  CHECK(processing_status!='completed' OR status='consumed'),
  CHECK(json_extract(content_json,'$.version') IN (1,2)),
  CHECK(json_extract(content_json,'$.version')!=2 OR processing_status!='completed' OR result_entry_id IS NOT NULL),
  CHECK(result_entry_id IS NULL OR status='consumed'),
  CHECK(mode='prompt' OR goal_mode!='fill-form')
);
INSERT INTO session_inputs_v2(id,session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,native_entry_id,result_entry_id,dispatched_at,error_json,created_at,updated_at)
SELECT id,session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,native_entry_id,NULL,dispatched_at,error_json,created_at,updated_at FROM session_inputs;
DROP TABLE session_inputs;
ALTER TABLE session_inputs_v2 RENAME TO session_inputs;
CREATE INDEX session_inputs_by_run ON session_inputs(run_id,id);
UPDATE sessions SET metadata_json=json_set(metadata_json,'$.delete_pending',json('true'))
WHERE status='archived' AND hidden_at IS NULL;
INSERT INTO schema_migrations(version,applied_at) VALUES(11,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
