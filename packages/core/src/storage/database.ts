import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "./migrate.js";

export type SqliteDatabase = InstanceType<typeof Database>;

export function openDatabase(root: string): SqliteDatabase {
  mkdirSync(root, { recursive: true });
  const db = new Database(join(root, "flowmate.sqlite"));
  db.pragma("foreign_keys = ON");
  migrate(db);
  recoverActiveRuns(db);
  return db;
}

function recoverActiveRuns(db: SqliteDatabase): void {
  const active = db.prepare("SELECT run_id, job_id FROM agent_runs WHERE status IN ('created', 'running', 'cancelling')").all() as Array<{ run_id: string; job_id: string }>;
  if (active.length === 0) return;
  db.exec("BEGIN IMMEDIATE;");
  try {
    const markRun = db.prepare("UPDATE agent_runs SET status = 'interrupted', cleanup_status = 'incomplete', finished_at = ? WHERE run_id = ?");
    const markJob = db.prepare("UPDATE jobs SET status = 'interrupted', updated_at = ? WHERE id = ? AND status <> 'candidate_ready'");
    const now = new Date().toISOString();
    for (const run of active) {
      markRun.run(now, run.run_id);
      markJob.run(now, run.job_id);
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
