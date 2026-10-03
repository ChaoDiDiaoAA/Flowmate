BEGIN IMMEDIATE;
CREATE TABLE runtime_events (
  id INTEGER PRIMARY KEY CHECK(id > 0 AND id <= 9007199254740991),
  run_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0 AND sequence <= 9007199254740991),
  session_id INTEGER,
  tool_call_id INTEGER,
  dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 2048),
  source_connection TEXT,
  source_sequence INTEGER CHECK(source_sequence IS NULL OR
    (source_sequence > 0 AND source_sequence <= 9007199254740991)),
  type TEXT NOT NULL CHECK(type IN (
    'run_created','run_started','run_completed','run_failed','run_cancelled',
    'run_cancel_requested','run_usage_updated',
    'tool_requested','tool_started','tool_succeeded','tool_failed','tool_cancelled',
    'input_state_changed'
  )),
  payload_json TEXT NOT NULL CHECK(CASE WHEN json_valid(payload_json) THEN
    COALESCE(json_type(payload_json,'$.version')='integer' AND
      json_extract(payload_json,'$.version')=1,0) ELSE 0 END),
  occurred_at TEXT NOT NULL CHECK(length(occurred_at) > 0),
  received_at TEXT NOT NULL CHECK(length(received_at) > 0),
  UNIQUE(run_id,sequence),
  UNIQUE(run_id,dedupe_key),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY(run_id,session_id) REFERENCES runs(id,session_id),
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(tool_call_id,run_id) REFERENCES tool_calls(id,run_id),
  CHECK(tool_call_id IS NULL OR session_id IS NOT NULL),
  CHECK(source_sequence IS NULL OR source_connection IS NOT NULL)
);
INSERT INTO schema_migrations(version,applied_at)
VALUES(13,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
