import type { AppError, DbId, InvoiceFormApplicationReceipt, ProductToolContext, StoredToolResult, ToolCallCleanup, ToolCallContext, ToolCallDelivery, ToolCallSnapshot, ToolDefinition, ToolRuntimeObservation, Result } from '@flowmate/contracts';
import type { ToolCallRepository } from '../storage/repositories.ts';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail } from '@flowmate/contracts';

export function createToolRecorder(repository: ToolCallRepository, now: () => string) {
  function settle(save: () => Result<ToolCallSnapshot>, facts: Parameters<ToolCallRepository['finish']>[0]): Result<ToolCallSnapshot> {
    let saved: Result<ToolCallSnapshot>;
    try { saved = save(); }
    catch { saved = fail(appError('storage_write_failed', 'storage', 'ToolCall settlement response could not be confirmed.')); }
    if (saved.ok) return saved;
    let recovered: Result<ToolCallSnapshot>;
    try { recovered = repository.getById(facts.toolCallId); }
    catch { return fail(appError('storage_corrupt', 'storage', 'Original ToolCall facts could not be read.')); }
    if (!recovered.ok) return recovered;
    const call = recovered.data;
    if (call.result === null) return saved;
    const { formApplication: _receipt, ...result } = call.result;
    const { nativeProcesses: _processes, nativeOutputs: _outputs, ...cleanup } = call.cleanup;
    const { nativeProcesses, nativeOutputs, ...expectedCleanup } = facts.cleanup;
    return isDeepStrictEqual(result, facts.result) && isDeepStrictEqual(cleanup, expectedCleanup)
      && (nativeProcesses === undefined || isDeepStrictEqual(nativeProcesses, call.cleanup.nativeProcesses))
      && (nativeOutputs === undefined || isDeepStrictEqual(nativeOutputs, call.cleanup.nativeOutputs))
      && call.endedAt === facts.endedAt && call.stoppedAt === facts.stoppedAt
      && isDeepStrictEqual(call.runtimeObservation ?? null, facts.runtimeObservation ?? null) ? recovered : saved;
  }
  return {
    request(input: { context: ProductToolContext; call: ToolCallContext; name: string; definition?: ToolDefinition<any, any>; raw: unknown }) {
      return repository.request({ runId: input.context.runId, sessionId: input.context.sessionId,
        nativeToolCallId: input.call.nativeToolCallId, toolName: input.name,
        toolVersion: input.definition?.version ?? null, effect: input.definition?.effect ?? null,
        rawArguments: input.raw, requestedAt: now() });
    },
    fixArguments(toolCallId: DbId, finalArguments: unknown) {
      return repository.fixArguments({ toolCallId, finalArguments });
    },
    start(toolCallId: DbId) {
      return repository.start({ toolCallId, startedAt: now() });
    },
    finish(input: { toolCallId: DbId; status: 'succeeded' | 'failed' | 'cancelled'; data?: unknown; error?: AppError;
      committedCandidateId: DbId | null; cleanup: ToolCallCleanup; stoppedAt: string | null; endedAt?: string; runtimeObservation?: ToolRuntimeObservation }) {
      const result: StoredToolResult = input.status === 'succeeded'
        ? { version: 1, committedCandidateId: input.committedCandidateId, status: 'succeeded', data: input.data }
        : { version: 1, committedCandidateId: input.committedCandidateId, status: input.status,
          error: input.error ?? { version: 1, code: 'tool_execution_failed', category: 'tool', message: '工具执行失败。', retryable: false },
          ...(input.data === undefined ? {} : { data: input.data }) };
      const facts = { toolCallId: input.toolCallId, result, cleanup: input.cleanup, endedAt: input.endedAt ?? now(),
        stoppedAt: input.stoppedAt, ...(input.runtimeObservation ? { runtimeObservation: input.runtimeObservation } : {}) };
      return settle(() => repository.finish(facts), facts);
    },
    reject(input: { toolCallId: DbId; error: AppError; status?: 'failed' | 'cancelled'; endedAt?: string; runtimeObservation?: ToolRuntimeObservation }) {
      const facts: Parameters<ToolCallRepository['reject']>[0] = { toolCallId: input.toolCallId, result: { version: 1, committedCandidateId: null,
        status: input.status ?? 'failed', error: input.error }, cleanup: {
        version: 1, stopReason: 'not-executed', stopped: true, errors: [],
      }, endedAt: input.endedAt ?? now(), ...(input.runtimeObservation ? { runtimeObservation: input.runtimeObservation } : {}) };
      return settle(() => repository.reject(facts), { ...facts, stoppedAt: null });
    },
    query(input: { runId: DbId; sessionId: DbId; nativeToolCallId: string }) {
      return repository.get(input);
    },
    recordDelivery(toolCallId: DbId, delivery: ToolCallDelivery) {
      return repository.recordDelivery({ toolCallId, delivery });
    },
    recordFormApplication(input: { toolCallId: DbId; receipt: InvoiceFormApplicationReceipt }) {
      return repository.recordFormApplication(input);
    },
    readFormApplicationRequest(toolCallId: DbId) {
      return repository.readFormApplicationRequest(toolCallId);
    },
    queryById(toolCallId: DbId) {
      return repository.getById(toolCallId);
    },
    queryCandidateCommit(input: { toolCallId: DbId; runId: DbId; sessionId: DbId }) { return repository.queryCandidateCommit(input); },
    observationCutoff() { return repository.observationCutoff(); },
    recentStarted(input: { groupKey: string; cutoff: DbId }) { return repository.recentStarted(input); },
    recentObservations(input: { groupKey: string; cutoff: DbId }) { return repository.recentObservations(input); },
    verifyUse(context: ProductToolContext) { return repository.verifyUse(context); },
    validateOutput(input: { toolCallId: DbId; data: unknown }) { return repository.validateOutput(input); },
    list(runId: DbId, limit: number, beforeId?: DbId) {
      return repository.list({ runId, limit, beforeId });
    },
  };
}
