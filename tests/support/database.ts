import type { ProductPaths, Result } from '@flowmate/contracts';
import { ok } from '@flowmate/contracts';
import type { Database } from 'bun:sqlite';
import { bootstrapDatabase, type DatabaseBootstrap } from '../../packages/core/src/storage/bootstrap.ts';
import { deferCleanup } from './resources.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DbHandle, SqlDatabaseStore } from '../../packages/core/src/storage/database.ts';

export type TestDbHandle = DbHandle & Omit<SqlDatabaseStore, 'db'> & { db: Database };

/** Recreate a pre-memory schema in an isolated migration fixture. */
export function removeMemorySchemaFromFixture(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS personal_tool_model_sources; DROP TABLE IF EXISTS personal_model_observations; DELETE FROM schema_migrations WHERE version=30; DROP TABLE IF EXISTS invoice_work_feedback; DELETE FROM schema_migrations WHERE version=29; DROP TABLE invoice_work_peer_reviews; DELETE FROM schema_migrations WHERE version=28;
    DROP TRIGGER memory_grants_remove_session;
    DROP TABLE memory_forget_requests; DROP TABLE memory_remember_requests; DROP TABLE memory_grants; DROP TABLE memory_entries; DROP TABLE memory_sync;
    DROP TABLE memory_recalls; DROP TABLE memory_input_bindings; DROP TABLE memory_bindings; DROP TABLE memory_identities;
    DROP TABLE memory_config; DELETE FROM schema_migrations WHERE version=27;`);
}
export function testDatabase(bundle: DatabaseBootstrap): TestDbHandle {
  return { ...bundle.stores, ...bundle.owner, db: bundle.db,
    get read() { return bundle.owner.read; },
    set read(value: DbHandle['read']) { bundle.owner.read = value; },
    get transaction() { return bundle.owner.transaction; },
    set transaction(value: DbHandle['transaction']) { bundle.owner.transaction = value; },
  };
}

export function openTestDatabase(paths: ProductPaths): Result<TestDbHandle> {
  const opened = bootstrapDatabase(paths);
  if (!opened.ok) return opened;
  const database = testDatabase(opened.data);
  deferCleanup(() => database.close());
  return ok(database);
}

/** Keep native-history fault probes on the real current executor after consumers move into the owner queue. */
export function withNativeHistoryFaults(database: TestDbHandle): TestDbHandle {
  const current = new AsyncLocalStorage<SqlDatabaseStore>();
  const commit = database.memory.commit, read = database.sessions.readHistorySnapshot;
  database.memory.commit = input => (current.getStore()?.memory.commit ?? commit)(input);
  database.sessions.readHistorySnapshot = (id, inspect, inputIds) =>
    (current.getStore()?.sessions.readHistorySnapshot ?? read)(id, inspect, inputIds);
  // Root aliases must not make a captured callback usable after its real executor expires.
  const project = (scope: SqlDatabaseStore): SqlDatabaseStore => ({ ...scope,
    memory: { ...scope.memory, commit: input => { void scope.db.inTransaction; return database.memory.commit(input); } },
    sessions: { ...scope.sessions, readHistorySnapshot: (id, inspect, inputIds) => {
      void scope.db.inTransaction; return database.sessions.readHistorySnapshot(id, inspect, inputIds);
    } },
  });
  return { ...database,
    read: operation => database.read(scope => current.run(scope, () => operation(project(scope)))),
    transaction: operation => database.transaction(scope => current.run(scope, () => operation(project(scope)))),
  };
}
