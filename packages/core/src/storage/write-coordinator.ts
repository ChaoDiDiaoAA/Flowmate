import { AsyncLocalStorage } from 'node:async_hooks';
import type { Changes, Database, SQLQueryBindings } from 'bun:sqlite';

type ScopedStatement<Row, Bindings extends SQLQueryBindings | SQLQueryBindings[]> =
  ReturnType<typeof scopedStatement<Row, Bindings>>;

function scopedStatement<Row, Bindings extends SQLQueryBindings | SQLQueryBindings[]>(database: Database, sql: string, check: () => void) {
  check(); const statement = database.query<Row, Bindings>(sql);
  return {
    get(...parameters: Parameters<typeof statement.get>) { check(); return statement.get(...parameters); },
    all(...parameters: Parameters<typeof statement.all>) { check(); return statement.all(...parameters); },
    run(...parameters: Parameters<typeof statement.run>) { check(); return statement.run(...parameters); },
  };
}

export interface SynchronousDatabaseExecutor {
  exec(sql: string): void;
  query<Row extends object = Record<string, unknown>, Bindings extends SQLQueryBindings | SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): ScopedStatement<Row, Bindings>;
  transaction<T>(write: () => T): { (): T; deferred(): T; immediate(): T; exclusive(): T };
  readonly inTransaction: boolean;
  afterCommit?(notify: () => void): void;
}
export interface DatabaseExecutor {
  readonly synchronous: SynchronousDatabaseExecutor;
  exec(sql: string): Promise<void>;
  run(sql: string, ...parameters: SQLQueryBindings[]): Promise<Changes>;
  get<T extends object>(sql: string, ...parameters: SQLQueryBindings[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...parameters: SQLQueryBindings[]): Promise<T[]>;
}
type Operation<T> = (executor: DatabaseExecutor) => T | Promise<T>;
export interface DatabaseCoordinator {
  read<T>(operation: Operation<T>): Promise<T>;
  transaction<T>(operation: Operation<T>): Promise<T>;
  close(): Promise<void>;
}
export class DatabaseCoordinationError extends Error {
  constructor(readonly code: 'storage_queue_reentry' | 'storage_executor_expired' | 'storage_executor_scope_mismatch'
    | 'storage_coordinator_closed' | 'storage_coordinator_failed' | 'storage_transaction_required') {
    super(code); this.name = 'DatabaseCoordinationError';
  }
}

export function createDatabaseCoordinator(database: Database): DatabaseCoordinator {
  const context = new AsyncLocalStorage<{ active: boolean }>();
  let tail: Promise<void> = Promise.resolve(), closing: Promise<void> | undefined, failed = false;
  const error = (code: ConstructorParameters<typeof DatabaseCoordinationError>[0]) => new DatabaseCoordinationError(code);
  const enqueue = <T>(transaction: boolean, operation: Operation<T>): Promise<T> => {
    if (context.getStore()?.active) return Promise.reject(error('storage_queue_reentry'));
    if (closing) return Promise.reject(error('storage_coordinator_closed'));
    if (failed) return Promise.reject(error('storage_coordinator_failed'));
    const queued = tail.then(async () => {
      if (failed) throw error('storage_coordinator_failed');
      const scope = { active: true };
      return context.run(scope, async () => {
        const check = () => {
          if (!scope.active) throw error('storage_executor_expired');
          if (context.getStore() !== scope) throw error('storage_executor_scope_mismatch');
        };
        const committed: (() => void)[] = [];
        let began = false, succeeded = false;
        const synchronous: SynchronousDatabaseExecutor = {
          exec(sql) { check(); database.exec(sql); },
          query<Row extends object, Bindings extends SQLQueryBindings | SQLQueryBindings[]>(sql: string): ScopedStatement<Row, Bindings> {
            return scopedStatement<Row, Bindings>(database, sql, check);
          },
          transaction<T>(write: () => T) {
            check(); const nested = database.transaction(write);
            const invoke = (run: () => T): T => {
              check(); const mark = committed.length;
              try { return run(); } catch (error) { committed.length = mark; throw error; }
            };
            return Object.assign(() => invoke(() => nested()), {
              deferred: () => invoke(() => nested.deferred()), immediate: () => invoke(() => nested.immediate()),
              exclusive: () => invoke(() => nested.exclusive()),
            });
          },
          get inTransaction() { check(); return database.inTransaction; },
          afterCommit(notify) {
            check(); if (!began || !database.inTransaction) throw error('storage_transaction_required');
            committed.push(notify);
          },
        };
        const executor: DatabaseExecutor = {
          synchronous,
          async exec(sql) { check(); database.exec(sql); },
          async run(sql, ...parameters) { check(); return database.query(sql).run(...parameters); },
          async get<T extends object>(sql: string, ...parameters: SQLQueryBindings[]): Promise<T | undefined> {
            check(); const row = database.query(sql).get(...parameters); return row === null ? undefined : row as T;
          },
          async all<T extends object>(sql: string, ...parameters: SQLQueryBindings[]): Promise<T[]> {
            check(); return database.query(sql).all(...parameters) as T[];
          },
        };
        try {
          if (transaction) { database.exec('BEGIN IMMEDIATE'); began = true; }
          const value = await operation(executor);
          if (transaction) database.exec('COMMIT');
          succeeded = true;
          return value;
        } catch (failure) {
          if (began) {
            try { database.exec('ROLLBACK'); }
            catch (rollback) {
              failed = true;
              throw new AggregateError([failure, rollback], 'Database rollback could not be confirmed.');
            }
          }
          throw failure;
        } finally {
          scope.active = false;
          if (succeeded) for (const notify of committed) {
            try { notify(); } catch { try { console.warn('storage_commit_observer_failed'); } catch { /* COMMIT already succeeded */ } }
          }
        }
      });
    });
    tail = queued.then(() => undefined, () => undefined);
    return queued;
  };
  return {
    read: operation => enqueue(false, operation),
    transaction: operation => enqueue(true, operation),
    close: () => {
      if (context.getStore()?.active) return Promise.reject(error('storage_queue_reentry'));
      closing ??= tail.then(() => { database.close(); });
      return closing;
    },
  };
}
