import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, NativeHistoryRecoveryBundleSchema } from '@flowmate/contracts';
import type { AgentExecutionInput, AgentNativeOutcome, AgentPort, NativeHistoryRecoverySeed, HistoryCommitReceipt, NativeHistoryWrite, NativeContextBindingSeed, NativeHistoryAppendContext, NativeSessionHistory, Result } from '@flowmate/contracts';

// Controlled agents still cross the real SQLite history writer and input ledger.
export function createAgentHistoryFixture(cwd: string, at: () => string) {
  const histories = new Map<string, NativeSessionHistory>();
  const writers = new Map<string, (write: NativeHistoryWrite) => Result<HistoryCommitReceipt>>();
  const receipts = new Map<string, HistoryCommitReceipt>();
  const create = (nativeSessionId: string) => {
    const history: NativeSessionHistory = { storageVersion: 1, header: { type: 'session', version: 3,
      id: nativeSessionId, timestamp: at(), cwd }, entries: [], leafId: null, unusable: false };
    histories.set(nativeSessionId, history);
    return history;
  };
  const exportSession: NonNullable<AgentPort['exportSession']> = nativeId => ok(histories.get(nativeId) ?? create(nativeId));
  const watchSession: NonNullable<AgentPort['watchSession']> = (nativeId, commit, seed, save) => {
    if (!NativeHistoryRecoveryBundleSchema.safeParse({ history: histories.get(nativeId), commit, seed }).success)
      return fail(appError('session_history_invalid', 'session', 'Fixture watcher requires complete committed history.'));
    receipts.set(nativeId, structuredClone(commit)); writers.set(nativeId, save); return ok(undefined);
  };
  const restorations: { kind: 'missing' | 'leaf'; nativeId: string; history: NativeSessionHistory; bindings: readonly NativeContextBindingSeed[] | undefined }[] = [];
  function restoreSession(nativeId: string, history: NativeSessionHistory, seed: NativeHistoryRecoverySeed, commit: HistoryCommitReceipt): Result<void> {
    if (!NativeHistoryRecoveryBundleSchema.safeParse({ history, seed, commit }).success || histories.has(nativeId) || history.header.id !== nativeId || history.unusable)
      return fail(appError('session_history_invalid', 'session', 'Fixture cannot restore this history.'));
    histories.set(nativeId, structuredClone(history));
    receipts.set(nativeId, structuredClone(commit));
    restorations.push({ kind: 'missing', nativeId, history: structuredClone(history), bindings: structuredClone(seed.inputs) });
    return ok(undefined);
  }
  function restoreSessionLeaf(nativeId: string, history: NativeSessionHistory, seed: NativeHistoryRecoverySeed, commit: HistoryCommitReceipt): Result<void> {
    const current = histories.get(nativeId);
    if (!NativeHistoryRecoveryBundleSchema.safeParse({ history, seed, commit }).success || !current || history.unusable || !isDeepStrictEqual(current.header, history.header)
      || !isDeepStrictEqual(current.entries, history.entries) || history.leafId !== null && !history.entries.some(entry => entry.id === history.leafId))
      return fail(appError('session_history_invalid', 'session', 'Fixture cannot reconnect this history.'));
    histories.set(nativeId, structuredClone(history));
    receipts.set(nativeId, structuredClone(commit));
    restorations.push({ kind: 'leaf', nativeId, history: structuredClone(history), bindings: structuredClone(seed.inputs) });
    return ok(undefined);
  }
  function append(nativeId: string, message: Record<string, unknown>, context: NativeHistoryAppendContext) {
    const previous = histories.get(nativeId) ?? create(nativeId);
    const entryId = context.entryId;
    const history = { ...previous, entries: [...previous.entries, { type: 'message', id: entryId,
      parentId: previous.leafId, timestamp: at(), message }], leafId: entryId };
    const expected = receipts.get(nativeId);
    if (!expected) throw new Error('Fixture receipt is missing.');
    const result = writers.get(nativeId)?.({ expected, history, contexts: [context] });
    if (!result) throw new Error('Fixture history writer is missing.');
    if (!result.ok) throw new Error(result.error.code);
    receipts.set(nativeId, result.data);
    histories.set(nativeId, history);
  }
  function saveUser(nativeId: string, input: AgentExecutionInput) {
    if (input.inputId === undefined || input.promptText === undefined) throw new Error('Fixture requires a real admitted input.');
    append(nativeId, { role: 'user', content: [{ type: 'text', text: input.promptText }], timestamp: Date.now() },
      { entryId: `user-${input.inputId}`, runId: input.runId, inputId: input.inputId });
  }
  function saveResult(nativeId: string, input: AgentExecutionInput, outcome: AgentNativeOutcome, allowComplete = true) {
    const inputId = input.inputId;
    if (inputId === undefined) throw new Error('Fixture requires a real admitted input.');
    const entryId = `assistant-${inputId}`;
    const final = allowComplete && outcome.stopReason === 'stop' && outcome.error === null;
    append(nativeId, { role: 'assistant', content: [{ type: 'text', text: outcome.text }],
      api: 'openai-completions', provider: 'fixture', model: 'fixture',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: outcome.stopReason, timestamp: Date.now() }, { entryId, runId: input.runId,
        ...(final ? { resultInputIds: [inputId] } : {}) });
    if (final) {
      const result = input.completeInputResult?.([inputId], entryId);
      if (!result) throw new Error('Fixture result completion is missing.');
      if (!result.ok) throw new Error(result.error.code);
    }
    input.onInputAdmissionClosed?.();
  }
  return { create, exportSession, watchSession, restoreSession, restoreSessionLeaf, restorations, saveUser, saveResult };
}
