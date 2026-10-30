import { createManagedFileContents } from './managed-file-contents.ts';
import { backupLegacyStore, migrateLegacyMetadata, type LegacyStoreBackup } from './migration-020.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { createDatabaseCoordinator, type SynchronousDatabaseExecutor } from './write-coordinator.ts';
import type { DbHandle, SqlDatabaseStore } from './database.ts';
import { createMemoryStore } from '../memory/persistence.ts';
import { appError, fail, ok, type ProductPaths, type Result } from '@flowmate/contracts';
import { validateProductPaths } from '@flowmate/shared';
import { createSessionInputLedger } from '../sessions/input-ledger.ts';
import { createRuntimeEventStore, type RuntimeEventStore } from '../events/store.ts';
import { createEventService } from '../events/service.ts';
import { createContextRepository } from '../context/repository.ts';
import { createResearchRepository } from '../research/repository.ts';
import { createInvoiceWorkRepository, createPersonalAgentRepository } from '../personal-agent/repository.ts';
import { createInvoiceWorkContextRepository } from '../personal-agent/context-repository.ts';
import { createInvoiceWorkAttemptRepository } from '../personal-agent/attempts.ts';
import { createInvoiceWorkModelBindingRepository } from '../personal-agent/model-bindings.ts';
import { createDocumentRepository, createToolCallRepository, createBusinessEventRepository, createCandidateRepository,
  createJobRepository, createRunRepository, createSessionRepository, createWorkspaceRepository, inspectRuntimeRecovery } from './repositories.ts';

export type DatabaseBootstrap = { owner: DbHandle; db: Database; stores: SqlDatabaseStore };

type EventListener = Parameters<RuntimeEventStore['onCommitted']>[0];
function createSqlStore(db: SynchronousDatabaseExecutor, listeners: Set<EventListener>): SqlDatabaseStore {
  const runtimeEventStore = createRuntimeEventStore(db, listeners);
  const sessions = createSessionRepository(db, runtimeEventStore);
  return {
    db, runtimeEventStore, sessions, memory: createMemoryStore(db, runtimeEventStore),
    runs: createRunRepository(db, runtimeEventStore), sessionInputs: createSessionInputLedger(db, runtimeEventStore),
    documents: createDocumentRepository(db), contents: createManagedFileContents(db), workspace: createWorkspaceRepository(db),
    jobs: createJobRepository(db), toolCalls: createToolCallRepository(db, runtimeEventStore),
    businessEvents: createBusinessEventRepository(db), candidates: createCandidateRepository(db), research: createResearchRepository(db),
    personalAgents: createPersonalAgentRepository(db), invoiceWorks: createInvoiceWorkRepository(db),
    invoiceWorkContexts: createInvoiceWorkContextRepository(db),
    invoiceWorkAttempts: createInvoiceWorkAttemptRepository(db),
    invoiceWorkModelBindings: createInvoiceWorkModelBindingRepository(db),
    context: createContextRepository({ db, loadHistory: sessionId => sessions.loadHistory(sessionId) }),
  };
}

type SchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;
function migrationSql(version: SchemaVersion): string {
  const file = ['001_provider.sql', '002_agent_sessions.sql', '003_invoice_tools.sql', '004_parsed_documents.sql', '005_native_session_history.sql', '006_hidden_processing.sql', '007_hidden_chats_invoices.sql', '008_native_entry_runs.sql', '009_session_inputs.sql', '010_human_candidates.sql', '011_session_management.sql', '012_tool_runtime_observations.sql', '013_runtime_events.sql', '014_workspace_selection.sql', '015_context_snapshots.sql', '016_native_history_commits.sql', '017_subagent_runs.sql', '018_subagent_parallel.sql', '019_research.sql', '020_direct_content.sql', '021_personal_agent.sql'][version - 1];
  if (!file) throw new Error('unsupported_schema_version');
  return readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
}

function runMigration(db: Database, version: SchemaVersion, paths?: ProductPaths, backup: LegacyStoreBackup | null = null): void {
  const legacyAlter = version === 17 || version === 21 ? (db.query('PRAGMA legacy_alter_table').get() as { legacy_alter_table: number }).legacy_alter_table : 0;
  try {
    if (version === 21) {
      const foreignKeys = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys;
      if (db.inTransaction || foreignKeys !== 1) throw new Error('migration_foreign_keys_disabled');
      const columns = db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all().map(row => row.name);
      const before = JSON.stringify(db.query('SELECT * FROM sessions ORDER BY id').all());
      const candidateColumns = db.query<{ name: string }, []>('PRAGMA table_info(invoice_candidates)').all();
      const candidateForeignKeys = (table: 'invoice_candidates' | 'invoice_candidates_p18_previous') => db
        .query<{ table: string; from: string; to: string; on_update: string; on_delete: string; match: string }, []>(`PRAGMA foreign_key_list(${table})`)
        .all().map(row => ({ table: row.table, from: row.from, to: row.to, on_update: row.on_update,
          on_delete: row.on_delete, match: row.match })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const expectedCandidateKeys = candidateForeignKeys('invoice_candidates')
        .filter(row => !(row.table === 'runs' && row.from === 'job_id'));
      const candidateDefinitions = db.query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_master WHERE tbl_name='invoice_candidates' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all();
      const schema = db.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name!='sessions' AND name!='runs_one_active_root' AND NOT(type='table' AND name='invoice_candidates') ORDER BY name").all();
      db.exec('PRAGMA foreign_keys=OFF'); db.exec('PRAGMA legacy_alter_table=ON');
      for (const statement of migrationSql(version).split(/^\s*-- statement\s*$/m).map(sql => sql.trim()).filter(Boolean)) {
        if (/^DROP TABLE invoice_candidates_p18_previous\s*;?$/.test(statement)) {
          const actualColumns = db.query<{ name: string }, []>('PRAGMA table_info(invoice_candidates)').all();
          const names = candidateColumns.map(column => `"${column.name.replaceAll('"', '""')}"`).join(',');
          if (JSON.stringify(actualColumns) !== JSON.stringify(candidateColumns)
            || JSON.stringify(candidateForeignKeys('invoice_candidates')) !== JSON.stringify(expectedCandidateKeys)
            || db.query(`SELECT ${names} FROM invoice_candidates_p18_previous EXCEPT SELECT ${names} FROM invoice_candidates LIMIT 1`).get()
            || db.query(`SELECT ${names} FROM invoice_candidates EXCEPT SELECT ${names} FROM invoice_candidates_p18_previous LIMIT 1`).get())
            throw new Error('migration_candidate_preservation_failed');
        }
        const definitionName = /^CREATE\s+(?:UNIQUE\s+)?(?:INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z_0-9]*)\b/i.exec(statement)?.[1];
        // Preserve the installed definitions, including their original line endings and literals.
        db.exec(candidateDefinitions.find(definition => definition.name === definitionName)?.sql ?? statement);
      }
      for (const definition of candidateDefinitions) {
        if (!db.query('SELECT name FROM sqlite_master WHERE name=?').get(definition.name)) db.exec(definition.sql);
      }
      const preserved = db.query<{ name: string; sql: string }, [string]>(
        'SELECT name,sql FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?)) ORDER BY name').all(JSON.stringify(schema.map(row => row.name)));
      if (db.query('PRAGMA foreign_key_check').all().length
        || JSON.stringify(db.query(`SELECT ${columns.join(',')} FROM sessions ORDER BY id`).all()) !== before
        || JSON.stringify(preserved) !== JSON.stringify(schema)) throw new Error('migration_preservation_failed');
      db.exec('COMMIT');
    } else if (version === 17) {
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
    } else if (version === 15 || version === 16 || version === 18 || version === 19 || version === 20) {
      // Trigger bodies contain semicolons: execute each explicit whole-statement boundary.
      for (const statement of migrationSql(version).split(/^\s*-- statement\s*$/m).map(sql => sql.trim()).filter(Boolean)) db.exec(statement);
      if (version === 20 && paths) migrateLegacyMetadata(db, paths, backup);
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
    } else {
      // Bun can swallow a later error in multi-statement exec; these early migrations contain no trigger bodies.
      for (const statement of migrationSql(version).split(';').map(sql => sql.trim()).filter(Boolean)) db.exec(statement);
    }
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error; caller closes the database */ }
    if (version === 20) backup?.restore();
    throw error;
  } finally {
    if (version === 10) db.exec('PRAGMA foreign_keys=ON');
    if (version === 17 || version === 21) {
      db.exec(`PRAGMA legacy_alter_table=${legacyAlter ? 'ON' : 'OFF'}`); db.exec('PRAGMA foreign_keys=ON');
      if ((db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 1) throw new Error('migration_foreign_keys_disabled');
    }
  }
}

function migrateToLatest(db: Database, paths: ProductPaths): void {
  const migrationTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() as { name: string } | null;
  if (!migrationTable) runMigration(db, 1);

  const rows = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  const versions = rows.map((row) => row.version);
  if (versions.some((version, index) => version !== index + 1) || versions.length < 1 || versions.length > 21) {
    throw new Error('unsupported_schema_version');
  }
  const backup = migrationTable && versions.length < 20 ? backupLegacyStore(db, paths) : null;
  for (let version = versions.length + 1; version <= 21; version += 1) runMigration(db, version as SchemaVersion, paths, backup);
  const completed = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
  if (completed.length !== 21 || completed.some((row, index) => row.version !== index + 1)) throw new Error('unsupported_schema_version');
}

export function bootstrapDatabase(paths: ProductPaths): Result<DatabaseBootstrap> {
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
    migrateToLatest(db, paths);
    const listeners = new Set<EventListener>();
    const stores = createSqlStore(db, listeners);
    const interrupted = stores.runs.failInterrupted(new Date().toISOString());
    if (!interrupted.ok) throw new Error('interrupted_run_recovery_failed');
    const recoveryError = inspectRuntimeRecovery(db);
    const maxRunIdAtBoot = (db.query('SELECT COALESCE(MAX(id),0) AS id FROM runs').get() as { id: number }).id;
    if (!Number.isSafeInteger(maxRunIdAtBoot) || maxRunIdAtBoot < 0) throw new Error('unsafe_run_id');
    const coordinator = createDatabaseCoordinator(db);
    const read = <T>(operation: (store: SqlDatabaseStore) => T | Promise<T>): Promise<T> =>
      coordinator.read(executor => operation(createSqlStore(executor.synchronous, listeners)));
    const transaction = <T>(operation: (store: SqlDatabaseStore) => T | Promise<T>): Promise<T> =>
      coordinator.transaction(executor => operation(createSqlStore(executor.synchronous, listeners)));
    const runtimeEvents = createEventService({ onCommitted: stores.runtimeEventStore.onCommitted,
      query: input => read(scope => scope.runtimeEventStore.query(input)) });
    const owner: DbHandle = { read, transaction, coordinator: { read: coordinator.read, transaction: coordinator.transaction },
      recoveryError, runtimeEvents, maxRunIdAtBoot,
      close: async () => { await coordinator.close(); runtimeEvents.close(); } };
    return ok({ owner, db, stores });
  } catch (error) {
    try { db?.close(); } catch { /* preserve original error */ }
    if (error instanceof Error && error.message === 'unsupported_schema_version') {
      return fail(appError('storage_schema_unsupported', 'storage', '数据库版本不受支持。'));
    }
    return fail(appError('storage_open_failed', 'storage', '数据库不可用。', true));
  }
}
