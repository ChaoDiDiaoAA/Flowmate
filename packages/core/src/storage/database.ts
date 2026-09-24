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
  const file = version === 1 ? '001_provider.sql' : '002_agent_sessions.sql';
  return readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
}

function runMigration(db: Database, version: 1 | 2): void {
  try {
    db.exec(migrationSql(version));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error; caller closes the database */ }
    throw error;
  }
}

function migrateToLatest(db: Database): void {
  const migrationTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() as { name: string } | null;
  if (!migrationTable) runMigration(db, 1);

  const rows = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  const versions = rows.map((row) => row.version);
  if (versions.length === 1 && versions[0] === 1) runMigration(db, 2);
  else if (versions.length !== 2 || versions[0] !== 1 || versions[1] !== 2) throw new Error('unsupported_schema_version');
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
    migrateToLatest(db);
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
