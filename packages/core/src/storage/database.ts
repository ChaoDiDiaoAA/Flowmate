import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { appError, fail, ok } from '@flowmate/contracts';
import type { CandidateRepository, ProductPaths, Result } from '@flowmate/contracts';
import { validateProductPaths } from '@flowmate/shared';
import {
  createDocumentRepository,
  createToolCallRepository,
  createBusinessEventRepository,
  createCandidateRepository,
  createJobRepository,
  createRunRepository,
  createSessionRepository,
  createWorkspaceRepository,
  type DocumentRepository,
  type ToolCallRepository,
  type BusinessEventRepository,
  type JobRepository,
  type RunRepository,
  type SessionRepository,
  type WorkspaceRepository,
} from './repositories.ts';

export type DbHandle = {
  db: Database;
  runs: RunRepository;
  sessions: SessionRepository;
  documents: DocumentRepository;
  workspace: WorkspaceRepository;
  jobs: JobRepository;
  toolCalls: ToolCallRepository;
  businessEvents: BusinessEventRepository;
  candidates: CandidateRepository;
  close: () => void;
};

function migrationSql(version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): string {
  const file = ['001_provider.sql', '002_agent_sessions.sql', '003_invoice_tools.sql', '004_parsed_documents.sql', '005_native_session_history.sql', '006_hidden_processing.sql', '007_hidden_chats_invoices.sql', '008_native_entry_runs.sql'][version - 1];
  if (!file) throw new Error('unsupported_schema_version');
  return readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
}

function runMigration(db: Database, version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): void {
  try {
    if (version === 4) {
      for (const statement of migrationSql(version).split(';').map((sql) => sql.trim()).filter(Boolean)) {
        db.exec(statement);
      }
      if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('migration_foreign_key_violation');
      db.exec('COMMIT');
    } else if (version === 8) {
      // Bun/SQLite can suppress a statement error in an ALTER + multi-statement exec.
      // Execute this small migration statement by statement so the outer catch rolls back.
      for (const statement of migrationSql(version).split(';').map((sql) => sql.trim()).filter(Boolean)) db.exec(statement);
    } else db.exec(migrationSql(version));
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
  if (versions.some((version, index) => version !== index + 1) || versions.length < 1 || versions.length > 8) {
    throw new Error('unsupported_schema_version');
  }
  for (let version = versions.length + 1; version <= 8; version += 1) runMigration(db, version as 2 | 3 | 4 | 5 | 6 | 7 | 8);
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
    const documents = createDocumentRepository(db);
    const workspace = createWorkspaceRepository(db);
    const jobs = createJobRepository(db);
    const toolCalls = createToolCallRepository(db);
    const businessEvents = createBusinessEventRepository(db);
    const candidates = createCandidateRepository(db);
    const interrupted = runs.failInterrupted(new Date().toISOString());
    if (!interrupted.ok) throw new Error('interrupted_run_recovery_failed');
    return ok({ db, runs, sessions, documents, workspace, jobs, toolCalls, businessEvents, candidates, close: () => db?.close() });
  } catch (error) {
    try { db?.close(); } catch { /* preserve original error */ }
    if (error instanceof Error && error.message === 'unsupported_schema_version') {
      return fail(appError('storage_schema_unsupported', 'storage', '数据库版本不受支持。'));
    }
    return fail(appError('storage_open_failed', 'storage', '数据库不可用。', true));
  }
}
