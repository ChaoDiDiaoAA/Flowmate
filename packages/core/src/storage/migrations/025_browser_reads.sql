BEGIN IMMEDIATE;
-- statement
CREATE TABLE invoice_work_browser_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES invoice_works(id),
  item_id INTEGER NOT NULL,
  item_revision INTEGER NOT NULL CHECK(item_revision BETWEEN 0 AND 9007199254740991),
  proposal_tool_call_id INTEGER NOT NULL UNIQUE REFERENCES tool_calls(id),
  target_json TEXT NOT NULL CHECK(json_valid(target_json)),
  status TEXT NOT NULL CHECK(status IN ('waiting','approved','rejected','claimed','completed','unknown','invalidated','revoked')),
  decision_request_id TEXT,
  decision_request_json TEXT CHECK(decision_request_json IS NULL OR json_valid(decision_request_json)),
  decision_receipt_json TEXT CHECK(decision_receipt_json IS NULL OR json_valid(decision_receipt_json)),
  execution_tool_call_id INTEGER UNIQUE REFERENCES tool_calls(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(item_id,work_id) REFERENCES invoice_work_items(id,work_id),
  UNIQUE(work_id,decision_request_id),
  CHECK((decision_request_id IS NULL)=(decision_request_json IS NULL)),
  CHECK((decision_request_id IS NULL)=(decision_receipt_json IS NULL)),
  CHECK((status IN ('claimed','completed','unknown','revoked'))=(execution_tool_call_id IS NOT NULL)),
  CHECK(status NOT IN ('approved','rejected','claimed','completed','unknown','revoked') OR decision_request_id IS NOT NULL),
  CHECK(status!='waiting' OR decision_request_id IS NULL)
);
-- statement
CREATE INDEX invoice_work_browser_reads_item ON invoice_work_browser_reads(work_id,item_id,id);
-- statement
CREATE UNIQUE INDEX invoice_work_browser_read_active ON invoice_work_browser_reads(work_id,item_id)
  WHERE status IN ('waiting','approved','claimed');
-- statement
CREATE TRIGGER invoice_work_browser_read_immutable BEFORE UPDATE ON invoice_work_browser_reads
WHEN NEW.id IS NOT OLD.id OR NEW.work_id IS NOT OLD.work_id OR NEW.item_id IS NOT OLD.item_id OR NEW.item_revision IS NOT OLD.item_revision
  OR NEW.proposal_tool_call_id IS NOT OLD.proposal_tool_call_id OR NEW.target_json IS NOT OLD.target_json OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.decision_request_id IS NOT NULL AND (NEW.decision_request_id IS NOT OLD.decision_request_id
    OR NEW.decision_request_json IS NOT OLD.decision_request_json OR NEW.decision_receipt_json IS NOT OLD.decision_receipt_json))
  OR (OLD.execution_tool_call_id IS NOT NULL AND NEW.execution_tool_call_id IS NOT OLD.execution_tool_call_id)
  OR (NEW.status IS NOT OLD.status AND NOT (
    (OLD.status='waiting' AND NEW.status IN ('approved','rejected','invalidated')) OR
    (OLD.status='approved' AND NEW.status IN ('claimed','invalidated')) OR
    (OLD.status='claimed' AND NEW.status IN ('completed','unknown')) OR
    (OLD.status='completed' AND NEW.status='revoked')))
BEGIN SELECT RAISE(ABORT,'invoice_work_browser_read_immutable'); END;
-- statement
CREATE TRIGGER invoice_work_browser_read_preserved BEFORE DELETE ON invoice_work_browser_reads
BEGIN SELECT RAISE(ABORT,'invoice_work_browser_read_preserved'); END;
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(25,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
