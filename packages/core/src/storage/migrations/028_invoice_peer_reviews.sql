BEGIN IMMEDIATE;
-- statement
CREATE TABLE invoice_work_peer_reviews (
  attempt_id INTEGER PRIMARY KEY,
  phase_id INTEGER NOT NULL UNIQUE REFERENCES invoice_work_phases(id),
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  item_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL REFERENCES invoice_candidates(id),
  candidate_sequence INTEGER NOT NULL,
  item_revision INTEGER NOT NULL,
  source_phase_id INTEGER NOT NULL REFERENCES invoice_work_phases(id),
  shared TEXT NOT NULL CHECK(json_valid(shared) AND length(CAST(shared AS BLOB)) BETWEEN 1 AND 8192),
  UNIQUE(work_id,item_id,candidate_id,candidate_sequence),
  FOREIGN KEY(attempt_id,work_id) REFERENCES invoice_work_attempts(id,work_id),
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id)
);
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(28,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
