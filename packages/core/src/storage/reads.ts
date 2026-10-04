import { SQLiteError, type Database } from 'bun:sqlite';
import { appError, fail } from '@flowmate/contracts';
import { NativeOriginFault } from '../memory/origins.ts';

/** Enclose the initial product row and every evidence lookup in the same SQL snapshot. */
export function readTransaction<T>(db: Database, read: () => T): T {
  return db.inTransaction ? read() : db.transaction(read).deferred();
}

export function evidenceReadFailure(error: unknown, message: string, runId?: number) {
  return fail(error instanceof NativeOriginFault ? error.error
    : error instanceof SQLiteError ? appError('storage_read_failed', 'storage', message, true, runId)
    : appError('storage_corrupt', 'storage', message, false, runId));
}
