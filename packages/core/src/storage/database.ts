import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ProductPaths, Result } from '@flowmate/contracts';
import { validateProductPaths } from '@flowmate/shared';
import { createRunRepository, createSessionRepository, type RunRepository, type SessionRepository } from './repositories.ts';

export type DbHandle = {
  db: Database;
  runs: RunRepository;
  sessions: SessionRepository;
  close: () => void;
};

function migrationSql(version: 1 | 2): string {
  return readFileSync(new URL(`./migrations/00${version}_${version === 1 ? 'provider' : 'agent_sessions'}.sql`, import.meta.url), 'utf8');
}

function applyMigration(db: Database, version: 1 | 2): void {
  try { db.exec(migrationSql(version)); }
  catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
    throw error;
  }
}

export function openDatabase(paths: ProductPaths): Result<DbHandle> {
  const validated = validateProductPaths(paths);
  if (!validated.ok) return validated;

  let db: Database | undefined;
  try {
    mkdirSync(dirname(paths.databaseFile), { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });
    mkdirSync(paths.artifactsDir, { recursive: true });
    mkdirSync(paths.outputsDir, { recursive: true });
    mkdirSync(paths.runtimeDir, { recursive: true });
    db = new Database(paths.databaseFile, { create: true });
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE;');
    const migrationTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() as { name: string } | null;
    if (!migrationTable) {
      applyMigration(db, 1);
      applyMigration(db, 2);
    } else {
      const row = db.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version: number } | null;
      if (!row || (row.version !== 1 && row.version !== 2)) throw new Error('unsupported_schema_version');
      if (row.version === 1) applyMigration(db, 2);
    }
    const runs = createRunRepository(db);
    const sessions = createSessionRepository(db);
    const interrupted = runs.failInterrupted(new Date().toISOString());
    if (!interrupted.ok) throw new Error('interrupted_run_recovery_failed');
    return ok({ db, runs, sessions, close: () => db?.close() });
  } catch (error) {
    try { db?.close(); } catch { /* preserve original error */ }
    if (error instanceof Error && error.message === 'unsupported_schema_version') {
      return fail(appError('storage_schema_unsupported', 'storage', '数据库版本不受支持。'));
    }
    return fail(appError('storage_open_failed', 'storage', '数据库不可用。', true));
  }
}
