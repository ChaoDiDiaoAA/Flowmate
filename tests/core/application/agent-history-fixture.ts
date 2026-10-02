import { ok } from '@flowmate/contracts';
import type { AgentExecutionInput, AgentNativeOutcome, AgentPort, NativeHistoryAppendContext, NativeSessionHistory, Result } from '@flowmate/contracts';

// Controlled agents still cross the real SQLite history writer and input ledger.
export function createAgentHistoryFixture(cwd: string, at: () => string) {
  const histories = new Map<string, NativeSessionHistory>();
  const writers = new Map<string, (history: NativeSessionHistory, context?: NativeHistoryAppendContext) => Result<void>>();
  const create = (nativeSessionId: string) => {
    const history: NativeSessionHistory = { storageVersion: 1, header: { type: 'session', version: 3,
      id: nativeSessionId, timestamp: at(), cwd }, entries: [], leafId: null, unusable: false };
    histories.set(nativeSessionId, history);
    return history;
  };
  const exportSession: NonNullable<AgentPort['exportSession']> = nativeId => ok(histories.get(nativeId) ?? create(nativeId));
  const watchSession: NonNullable<AgentPort['watchSession']> = (nativeId, save) => { writers.set(nativeId, save); return ok(undefined); };
  function append(nativeId: string, message: Record<string, unknown>, context: NativeHistoryAppendContext) {
    const previous = histories.get(nativeId) ?? create(nativeId);
    const entryId = context.entryId;
    const history = { ...previous, entries: [...previous.entries, { type: 'message', id: entryId,
      parentId: previous.leafId, timestamp: at(), message }], leafId: entryId };
    const result = writers.get(nativeId)?.(history, context);
    if (!result) throw new Error('Fixture history writer is missing.');
    if (!result.ok) throw new Error(result.error.code);
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
      stopReason: outcome.stopReason, timestamp: Date.now() }, { entryId, runId: input.runId,
        ...(final ? { resultInputIds: [inputId] } : {}) });
    if (final) {
      const result = input.completeInputResult?.([inputId], entryId);
      if (!result) throw new Error('Fixture result completion is missing.');
      if (!result.ok) throw new Error(result.error.code);
    }
    input.onInputAdmissionClosed?.();
  }
  return { create, exportSession, watchSession, saveUser, saveResult };
}
