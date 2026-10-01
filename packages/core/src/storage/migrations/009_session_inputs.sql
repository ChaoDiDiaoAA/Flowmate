BEGIN IMMEDIATE;
CREATE TABLE session_inputs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_sequence INTEGER NOT NULL CHECK(client_sequence BETWEEN 1 AND 9007199254740991),
  mode TEXT NOT NULL CHECK(mode='prompt'),
  goal_mode TEXT NOT NULL CHECK(goal_mode='fill-form'),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  status TEXT NOT NULL CHECK(status IN ('queued','consumed','failed','cancelled','delivery_unknown')),
  processing_status TEXT NOT NULL CHECK(processing_status IN ('pending','completed','failed','cancelled')),
  native_entry_id TEXT,
  dispatched_at TEXT,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id,client_sequence),
  UNIQUE(session_id,native_entry_id),
  FOREIGN KEY(session_id,native_entry_id) REFERENCES session_native_entries(session_id,entry_id) ON DELETE RESTRICT,
  CHECK((status='consumed' AND native_entry_id IS NOT NULL) OR (status!='consumed' AND native_entry_id IS NULL)),
  CHECK(processing_status!='completed' OR status='consumed')
);
CREATE INDEX session_inputs_by_run ON session_inputs(run_id,id);
INSERT INTO schema_migrations(version,applied_at) VALUES(9,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
