BEGIN IMMEDIATE;

CREATE TABLE session_native_history (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  storage_version INTEGER NOT NULL CHECK(storage_version = 1),
  header_json TEXT NOT NULL CHECK(json_valid(header_json)),
  leaf_id TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK(entry_count >= 0),
  unusable INTEGER NOT NULL DEFAULT 0 CHECK(unusable IN (0,1))
);

CREATE TABLE session_native_entries (
  session_id INTEGER NOT NULL REFERENCES session_native_history(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  entry_id TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  PRIMARY KEY(session_id, sequence),
  UNIQUE(session_id, entry_id)
);

INSERT INTO schema_migrations(version, applied_at)
VALUES(5, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
COMMIT;
