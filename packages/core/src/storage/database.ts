import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { createMemoryStore } from '../memory/persistence.ts';
import type { MemoryStore } from '@flowmate/contracts';
import { appError, fail, ok } from '@flowmate/contracts';
import type { AppError, ProductPaths, Result } from '@flowmate/contracts';
import { validateProductPaths } from '@flowmate/shared';
import { createSessionInputLedger, type SessionInputLedger } from '../sessions/input-ledger.ts';
import { createRuntimeEventStore, type RuntimeEventStore } from '../events/store.ts';
import { createEventService, type EventService } from '../events/service.ts';
import { createContextRepository, type ContextRepository } from '../context/repository.ts';
import {
  createDocumentRepository,
  createToolCallRepository,
  createBusinessEventRepository,
  createCandidateRepository,
  createJobRepository,
  createRunRepository,
  createSessionRepository,
  createWorkspaceRepository,
  inspectRuntimeRecovery,
  type DocumentRepository,
  type ToolCallRepository,
  type BusinessEventRepository,
  type JobRepository,
  type RunRepository,
  type SessionRepository,
  type WorkspaceRepository,
  type InvoiceEditRepository,
} from './repositories.ts';

export type DbHandle = {
  db: Database;
  memory: Pick<MemoryStore, 'load' | 'commit'>;
  runs: RunRepository;
  sessions: SessionRepository;
  sessionInputs: SessionInputLedger;
  documents: DocumentRepository;
  workspace: WorkspaceRepository;
  jobs: JobRepository;
  toolCalls: ToolCallRepository;
  businessEvents: BusinessEventRepository;
  candidates: InvoiceEditRepository;
  context: ContextRepository;
  runtimeEventStore: RuntimeEventStore;
  runtimeEvents: EventService;
  /** Required historical stop gaps; diagnostics and Session-local history do not poison this root. */
  recoveryError: AppError | null;
  /** Run identities that predate this database owner's in-memory diagnostics. */
  maxRunIdAtBoot: number;
  close: () => void;
};

type SchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;
function migrationSql(version: SchemaVersion): string {
  const file = ['001_provider.sql', '002_agent_sessions.sql', '003_invoice_tools.sql', '004_parsed_documents.sql', '005_native_session_history.sql', '006_hidden_processing.sql', '007_hidden_chats_invoices.sql', '008_native_entry_runs.sql', '009_session_inputs.sql', '010_human_candidates.sql', '011_session_management.sql', '012_tool_runtime_observations.sql', '013_runtime_events.sql', '014_workspace_selection.sql', '015_context_snapshots.sql', '016_native_history_commits.sql', '017_subagent_runs.sql'][version - 1];
  if (!file) throw new Error('unsupported_schema_version');
  return readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
}

function runMigration(db: Database, version: SchemaVersion): void {
  const legacyAlter = version === 17 ? (db.query('PRAGMA legacy_alter_table').get() as { legacy_alter_table: number }).legacy_alter_table : 0;
  try {
    if (version === 17) {
      const foreignKeys = (db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
      if (db.inTransaction || foreignKeys !== 1) throw new Error('migration_foreign_keys_disabled');
      const columns = (db.query('PRAGMA table_info(runs)').all() as { name: string }[]).map(row => row.name);
      const before = JSON.stringify(db.query('SELECT * FROM runs ORDER BY id').all());
      const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name!='runs' AND name!='context_snapshot_insert_guard' ORDER BY name";
      const schema = JSON.stringify(db.query(schemaQuery).all());
      db.exec('PRAGMA foreign_keys=OFF'); db.exec('PRAGMA legacy_alter_table=ON');
      for (const statement of migrationSql(version).split(/^\s*-- statement\s*$/m).map(sql => sql.trim()).filter(Boolean)) db.exec(statement);
      if (db.query('PRAGMA foreign_key_check').all().length
        || JSON.stringify(db.query(`SELECT ${columns.join(',')} FROM runs ORDER BY id`).all()) !== before
        || JSON.stringify(db.query(schemaQuery).all()) !== schema
        || db.query('SELECT id FROM runs WHERE parent_run_id IS NOT NULL OR origin_tool_call_id IS NOT NULL OR plugin_agent_id IS NOT NULL').get())
        throw new Error('migration_preservation_failed');
      db.exec('COMMIT');
    } else if (version === 15 || version === 16) {
      // Trigger bodies contain semicolons: execute each explicit whole-statement boundary.
      for (const statement of migrationSql(version).split(/^\s*-- statement\s*$/m).map(sql => sql.trim()).filter(Boolean)) db.exec(statement);
      if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('migration_foreign_key_violation');
      db.exec('COMMIT');
    } else if (version === 4 || version === 10 || version === 11 || version === 14) {
      for (const statement of migrationSql(version).split(';').map((sql) => sql.trim()).filter(Boolean)) {
        db.exec(statement);
      }
      if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('migration_foreign_key_violation');
      db.exec('COMMIT');
      if (version === 10) db.exec('PRAGMA foreign_keys=ON');
    } else if (version === 8 || version === 9 || version === 12 || version === 13) {
      // Bun/SQLite can suppress a statement error in an ALTER + multi-statement exec.
      // Execute this small migration statement by statement so the outer catch rolls back.
      for (const statement of migrationSql(version).split(';').map((sql) => sql.trim()).filter(Boolean)) db.exec(statement);
    } else db.exec(migrationSql(version));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error; caller closes the database */ }
    throw error;
  } finally {
    if (version === 10) db.exec('PRAGMA foreign_keys=ON');
    if (version === 17) {
      db.exec(`PRAGMA legacy_alter_table=${legacyAlter ? 'ON' : 'OFF'}`); db.exec('PRAGMA foreign_keys=ON');
      if ((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 1) throw new Error('migration_foreign_keys_disabled');
    }
  }
}

function migrateToLatest(db: Database): void {
  const migrationTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() as { name: string } | null;
  if (!migrationTable) runMigration(db, 1);

  const rows = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  const versions = rows.map((row) => row.version);
  if (versions.some((version, index) => version !== index + 1) || versions.length < 1 || versions.length > 17) {
    throw new Error('unsupported_schema_version');
  }
  for (let version = versions.length + 1; version <= 17; version += 1) runMigration(db, version as SchemaVersion);
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
    const created = validateProductPaths(paths, validated.data);
    if (!created.ok) return created;
    db = new Database(paths.databaseFile, { create: true });
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE;');
    migrateToLatest(db);
    const runtimeEventStore = createRuntimeEventStore(db);
    const memory = createMemoryStore(db, runtimeEventStore);
    const runtimeEvents = createEventService(runtimeEventStore);
    const runs = createRunRepository(db, runtimeEventStore);
    const sessions = createSessionRepository(db, runtimeEventStore);
    const sessionInputs = createSessionInputLedger(db, runtimeEventStore);
    const documents = createDocumentRepository(db);
    const workspace = createWorkspaceRepository(db);
    const jobs = createJobRepository(db);
    const toolCalls = createToolCallRepository(db, runtimeEventStore);
    const businessEvents = createBusinessEventRepository(db);
    const candidates = createCandidateRepository(db);
    const context = createContextRepository({ db, loadHistory: sessionId => sessions.loadHistory(sessionId) });
    const interrupted = runs.failInterrupted(new Date().toISOString());
    if (!interrupted.ok) throw new Error('interrupted_run_recovery_failed');
    const recoveryError = inspectRuntimeRecovery(db);
    const maxRunIdAtBoot = (db.query('SELECT COALESCE(MAX(id),0) AS id FROM runs').get() as { id: number }).id;
    if (!Number.isSafeInteger(maxRunIdAtBoot) || maxRunIdAtBoot < 0) throw new Error('unsafe_run_id');
    return ok({ db, memory, runs, sessions, sessionInputs, documents, workspace, jobs, toolCalls, businessEvents, candidates, context, recoveryError,
      runtimeEventStore, runtimeEvents, maxRunIdAtBoot, close: () => { runtimeEvents.close(); db?.close(); } });
  } catch (error) {
    try { db?.close(); } catch { /* preserve original error */ }
    if (error instanceof Error && error.message === 'unsupported_schema_version') {
      return fail(appError('storage_schema_unsupported', 'storage', '数据库版本不受支持。'));
    }
    return fail(appError('storage_open_failed', 'storage', '数据库不可用。', true));
  }
}
