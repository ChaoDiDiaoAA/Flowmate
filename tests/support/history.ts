import type { Database } from 'bun:sqlite';
import { appError, fail, ok } from '@flowmate/contracts';
import type { NativeHistoryAppendContext, NativeSessionHistory, Result } from '@flowmate/contracts';
import { commitInTransaction, loadNativeHistoryInTransaction, MemoryCommitFault } from '../../packages/core/src/memory/persistence.ts';
import type { RuntimeEventStore } from '../../packages/core/src/events/store.ts';

export const nativeAssistantFacts = { api: 'openai-completions', provider: 'fixture', model: 'fixture',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

/** Fixtures deliberately fetch an explicit expected receipt for each test operation.
 * This is not a runtime watcher: production consumers must hold their confirmed receipt.
 * Undefined events seeds historical pre-P6 facts, preserving their original regression purpose.
 */
export function saveTestHistory(db: Database, events: RuntimeEventStore | undefined, sessionId: number,
  history: NativeSessionHistory, context?: NativeHistoryAppendContext): Result<void> {
  try {
    const previous = loadNativeHistoryInTransaction(db, sessionId);
    const input = { sessionId, expected: previous?.commit ?? null, header: history.header, appendEntries: history.entries,
      leafId: history.leafId, unusable: history.unusable, contexts: context ? [context] : [] };
    const write = () => commitInTransaction(db, input, events);
    if (events) events.withTransaction(write); else db.transaction(write).immediate();
    return ok(undefined);
  } catch (error) {
    return fail(error instanceof MemoryCommitFault ? error.error : appError('storage_write_failed', 'storage', 'Fixture history could not be saved.', true));
  }
}
