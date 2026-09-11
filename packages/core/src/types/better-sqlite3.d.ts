declare module "better-sqlite3" {
  type SqlValue = string | number | bigint | Buffer | Uint8Array | null;
  type RunResult = { changes: number; lastInsertRowid: number | bigint };
  type Statement = {
    run(...params: SqlValue[]): RunResult;
    get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined;
    all<T = Record<string, unknown>>(...params: SqlValue[]): T[];
  };
  type Database = {
    pragma(source: string): unknown;
    exec(source: string): void;
    prepare(source: string): Statement;
    close(): void;
  };
  const Database: { new (filename: string): Database };
  export default Database;
}
