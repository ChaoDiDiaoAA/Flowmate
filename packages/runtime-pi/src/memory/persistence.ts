import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, HistoryCommitReceiptSchema } from '@flowmate/contracts';
import type { HistoryCommitState, HistoryCommitReceipt, NativeHistoryRecoverySeed, NativeHistoryWriter, NativeSessionHistory, NativeHistoryAppendContext, Result } from '@flowmate/contracts';
import { validateNativeHistory, validateRecovery } from './history.ts';

const json = (value: unknown) => JSON.parse(JSON.stringify(value));
/** Confirmed history only. The Session owns append ordering; the writer owns SQL and lost-receipt lookup. */
export class PiMemoryAdapter {
  public lastSavedHistory: NativeSessionHistory;
  public commit: HistoryCommitState;
  public seed: NativeHistoryRecoverySeed;
  public failure?: ReturnType<typeof appError>;
  constructor(history: NativeSessionHistory, commit: HistoryCommitState, seed: NativeHistoryRecoverySeed,
    public writer: NativeHistoryWriter) {
    if (!validateRecovery(history, seed, commit).ok) throw new Error('invalid_recovery');
    this.lastSavedHistory = structuredClone(history); this.commit = structuredClone(commit); this.seed = structuredClone(seed);
  }
  public save(history: NativeSessionHistory, contexts: readonly NativeHistoryAppendContext[], inputs: NativeHistoryRecoverySeed['inputs'] = []): ReturnType<NativeHistoryWriter> {
    if (this.failure) return fail(this.failure);
    const reject = (error = appError('storage_write_failed', 'storage', 'Native conversation save was not confirmed.', true)) => {
      this.failure = error; return fail(error);
    };
    try {
      const previous = this.lastSavedHistory;
      if (!validateNativeHistory(history).ok || !isDeepStrictEqual(json(previous.header), json(history.header))
        || history.entries.length < previous.entries.length || !isDeepStrictEqual(json(previous.entries), json(history.entries.slice(0, previous.entries.length)))
        || previous.unusable && !history.unusable) return reject(appError('session_history_invalid', 'session', 'The confirmed conversation prefix changed.'));
      const added = history.entries.slice(previous.entries.length), addedIds = new Set(added.map(e => e.id));
      if (contexts.some(c => !addedIds.has(c.entryId)) || new Set(contexts.map(c => c.entryId)).size !== contexts.length)
        return reject(appError('session_history_invalid', 'session', 'Append associations do not identify new entries.'));
      const nextSeed: NativeHistoryRecoverySeed = { sessionId: this.seed.sessionId, inputs: [...this.seed.inputs, ...inputs],
        ...(this.seed.resourceReads === undefined ? {} : { resourceReads: this.seed.resourceReads }),
        ...(this.seed.resourceExpansions !== undefined || contexts.some(context => context.resourceExpansion !== undefined)
          ? { resourceExpansions: [...(this.seed.resourceExpansions ?? []), ...contexts.flatMap(context => context.resourceExpansion ? [context.resourceExpansion] : [])] } : {}),
        origins: [...this.seed.origins, ...added.map(e => ({ nativeEntryId: e.id, originSessionId: this.seed.sessionId,
          originRunId: contexts.find(c => c.entryId === e.id)?.runId ?? null }))] };
      const changed = !isDeepStrictEqual(json(previous), json(history));
      const expected = { commitRevision: this.commit.commitRevision + (changed ? 1 : 0), entryCount: history.entries.length, leafId: history.leafId };
      if (!validateRecovery(history, nextSeed, expected).ok) return reject(appError('session_history_invalid', 'session', 'New conversation provenance is incomplete.'));
      if (!changed) return ok(structuredClone(this.commit));
      // Detached target/associations are captured before calling a writer, which may synchronously publish events.
      const target = structuredClone(history), frozenContexts = structuredClone(contexts), frozenSeed = structuredClone(nextSeed);
      const result = this.writer({ expected: structuredClone(this.commit), history: structuredClone(target), contexts: frozenContexts });
      const confirm = (saved: Result<HistoryCommitReceipt>): Result<HistoryCommitReceipt> => {
        if (!saved.ok) return reject(saved.error);
        if (!HistoryCommitReceiptSchema.safeParse(saved.data).success || !isDeepStrictEqual(saved.data, expected)) return reject();
        this.lastSavedHistory = target; this.commit = structuredClone(saved.data); this.seed = frozenSeed;
        return ok(structuredClone(saved.data));
      };
      return 'ok' in result ? confirm(result) : Promise.resolve(result).then(confirm).catch(() => reject());
    } catch { return reject(); }
  }
}
