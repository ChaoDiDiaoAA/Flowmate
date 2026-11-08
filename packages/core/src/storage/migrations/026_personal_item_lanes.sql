BEGIN IMMEDIATE;
-- statement
ALTER TABLE invoice_work_phases ADD COLUMN scheduler_state TEXT NOT NULL DEFAULT 'legacy'
  CHECK(scheduler_state IN ('legacy','active','waiting_approval','ready'))
  CHECK(scheduler_state='legacy' OR item_id IS NOT NULL);
-- statement
CREATE UNIQUE INDEX invoice_work_phase_one_active ON invoice_work_phases(attempt_id)
  WHERE closed_at IS NULL AND scheduler_state='active';
-- statement
CREATE UNIQUE INDEX invoice_work_phase_one_item ON invoice_work_phases(attempt_id,item_id)
  WHERE closed_at IS NULL AND scheduler_state!='legacy';
-- statement
INSERT INTO schema_migrations(version,applied_at) VALUES(26,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
