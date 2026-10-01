import type { AppError, DbId, InvoiceFormApplicationReceipt, ProductToolContext, StoredToolResult, ToolCallCleanup, ToolCallContext, ToolCallDelivery, ToolCallSnapshot, ToolDefinition } from '@flowmate/contracts';
import type { ToolCallRepository } from '../storage/repositories.ts';

export function createToolRecorder(repository: ToolCallRepository, now: () => string) {
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
      committedCandidateId: DbId | null; cleanup: ToolCallCleanup; stoppedAt: string | null }) {
      const result: StoredToolResult = input.status === 'succeeded'
        ? { version: 1, committedCandidateId: input.committedCandidateId, status: 'succeeded', data: input.data }
        : { version: 1, committedCandidateId: input.committedCandidateId, status: input.status,
          error: input.error ?? { version: 1, code: 'tool_execution_failed', category: 'tool', message: '工具执行失败。', retryable: false },
          ...(input.data === undefined ? {} : { data: input.data }) };
      return repository.finish({ toolCallId: input.toolCallId, result, cleanup: input.cleanup, endedAt: now(), stoppedAt: input.stoppedAt });
    },
    reject(input: { toolCallId: DbId; error: AppError; status?: 'failed' | 'cancelled' }) {
      return repository.reject({ toolCallId: input.toolCallId, result: { version: 1, committedCandidateId: null,
        status: input.status ?? 'failed', error: input.error }, cleanup: {
        version: 1, stopReason: 'not-executed', stopped: true, errors: [],
      }, endedAt: now() });
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
    list(runId: DbId, limit: number, beforeId?: DbId) {
      return repository.list({ runId, limit, beforeId });
    },
  };
}
