import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import type { Storage } from '@earendil-works/pi-durable';

type SharedExecutor = Omit<SqliteExecutor, 'run'> & {
  run(sql: string, ...parameters: SqliteValue[]): Promise<unknown>;
};
export interface DurableSqliteCoordinator {
  read<T>(operation: (executor: SharedExecutor) => Promise<T>): Promise<T>;
  transaction<T>(operation: (executor: SharedExecutor) => Promise<T>): Promise<T>;
}
const nativeExecutor = (executor: SharedExecutor): SqliteExecutor => ({
  exec: sql => executor.exec(sql),
  run: async (sql, ...parameters) => { await executor.run(sql, ...parameters); },
  get: <T extends object>(sql: string, ...parameters: SqliteValue[]) => executor.get<T>(sql, ...parameters),
  all: <T extends object>(sql: string, ...parameters: SqliteValue[]) => executor.all<T>(sql, ...parameters),
});

export function createDurableSqliteStorage(coordinator: DurableSqliteCoordinator): Promise<Storage> {
  let closed = false, closing: Promise<void> | undefined;
  const read = <T>(operation: (executor: SharedExecutor) => Promise<T>): Promise<T> =>
    closed ? Promise.reject(new Error('Durable SQLite facade is closed.')) : coordinator.read(operation);
  const database: SqliteDatabase = {
    exec: sql => read(executor => executor.exec(sql)),
    run: (sql, ...parameters) => read(async executor => { await executor.run(sql, ...parameters); }),
    get: <T extends object>(sql: string, ...parameters: SqliteValue[]) => read(executor => executor.get<T>(sql, ...parameters)),
    all: <T extends object>(sql: string, ...parameters: SqliteValue[]) => read(executor => executor.all<T>(sql, ...parameters)),
    transaction: operation => closed ? Promise.reject(new Error('Durable SQLite facade is closed.'))
      : coordinator.transaction(executor => operation(nativeExecutor(executor))),
    close: () => {
      closed = true;
      // Storage owns this facade; the product database owner closes the shared connection after both runtimes.
      closing ??= coordinator.read(async () => undefined);
      return closing;
    },
  };
  return SqliteStorage.open(database, { prefix: 'fm_durable_' });
}
