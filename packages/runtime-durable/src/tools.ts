import type { Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { AssistantEntry, defineDocFamily, defineTool, GenerationTask, ToolResultEntry, ToolTask, type ConversationId, type EntryRecord, type Harness, type Storage, type TaskId,
  type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { appError, type Result, type ToolResult } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { DurableProductToolCall, DurableProductToolDefinition, DurableProductToolFeedback } from '../../contracts/src/durable-runtime.ts';
import type { DurableProductToolExecution, DurableSubagentInvoker } from '../../contracts/src/durable-subagents.ts';

export type DurableProductToolOptions = {
  definitions: readonly DurableProductToolDefinition[];
  resolve(api: ToolExecutionApi, context: Context): Promise<DurableProductToolCall>;
  verify(call: DurableProductToolCall, signal: AbortSignal): Promise<Result<void>>;
  execute(call: DurableProductToolExecution): Result<ToolResult<unknown>> | Promise<Result<ToolResult<unknown>>>;
  read(call: DurableProductToolCall): Result<ToolResult<unknown> | null> | Promise<Result<ToolResult<unknown> | null>>;
  delegate?(api: ToolExecutionApi, context: Context, call: DurableProductToolCall): DurableSubagentInvoker;
};
const invocationMemo = 'flowmate.product-tool.invoked';
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const callSchema = z.object({ workId: id, sessionId: id, attemptId: id, requestId: z.string().min(1), nativeConversationId: id,
  nativeTaskId: id, nativeToolCallId: z.string().min(1), name: z.string().min(1), arguments: z.unknown(),
  child: z.object({ childRunId: id, childSessionId: id, originToolCallId: id }).strict().optional() }).strict();
// TaskDocs retire at terminal settlement; this immutable execution provenance remains with its conversation.
const ToolProvenance = defineDocFamily({ kind: 'flowmate.runtime.tool-provenance', version: 1, family: true, scope: 'conversation',
  history: 'latest', fork: 'initial', initial: (): { callJson: string | null; inputJson: string | null; ownerTaskId: number | null } =>
    ({ callJson: null, inputJson: null, ownerTaskId: null }),
  checkpointWhen: () => true });
export async function rememberDurableToolCall(harness: Harness, storage: Storage, call: DurableProductToolCall, context: Context) {
  const task = await storage.task(call.nativeTaskId as TaskId, context); if (!task?.owner || task.kind !== ToolTask.definition.name) throw Error('state_conflict');
  await harness.commit(async tx => {
    const saved = await tx.doc(ToolProvenance, task.conversationId, String(task.id), null);
    if (saved.callJson !== null) {
      if (!isDeepStrictEqual(JSON.parse(saved.callJson), call) || saved.inputJson === null
        || !isDeepStrictEqual(JSON.parse(saved.inputJson), task.input) || saved.ownerTaskId !== task.owner) throw Error('state_conflict');
    } else { saved.callJson = JSON.stringify(call); saved.inputJson = JSON.stringify(task.input); saved.ownerTaskId = task.owner!; }
  }, context);
}
export async function readDurableToolCall(harness: Harness, storage: Storage, taskId: TaskId, conversationId: ConversationId,
  context: Context): Promise<DurableProductToolCall | null> {
  const saved = await harness.snapshot(ToolProvenance, conversationId, String(taskId), context); if (!saved?.callJson) return null;
  const call = callSchema.parse(JSON.parse(saved.callJson)), task = await storage.task(taskId, context);
  if (!task?.owner || task.kind !== ToolTask.definition.name || task.conversationId !== conversationId || task.owner !== saved.ownerTaskId
    || saved.inputJson === null || !isDeepStrictEqual(JSON.parse(saved.inputJson), task.input)
    || call.nativeConversationId !== conversationId || call.nativeTaskId !== taskId) throw Error('state_conflict');
  const generation = await storage.task(task.owner, context);
  if (generation?.kind !== GenerationTask.definition.name || generation.conversationId !== conversationId) throw Error('state_conflict');
  const input = z.object({ kind: z.literal('model'), assistant: id, callId: z.string() }).strict().parse(task.input);
  const assistant = (await storage.entry(input.assistant as EntryRecord['id'], context))?.entry;
  const message = assistant?.model?.[0], wire = message?.role === 'assistant'
    ? message.content.find(block => block.type === 'toolCall' && block.id === input.callId) : undefined;
  if (assistant?.kind !== AssistantEntry.kind || assistant.conversationId !== conversationId || assistant.byTaskId !== task.owner || wire?.type !== 'toolCall'
    || wire.id !== call.nativeToolCallId || wire.name !== call.name) throw Error('state_conflict');
  return { ...call, arguments: call.arguments };
}
function nativeResult(result: ToolResult<unknown>): ToolExecutionResult {
  const text = JSON.stringify(result);
  return { output: [{ type: 'text', text }], details: JSON.parse(text) as JsonValue, isError: result.status !== 'succeeded' };
}
function unknownResult(): ToolExecutionResult {
  const result = { status: 'unknown', error: appError('tool_commit_unconfirmed', 'runtime',
    'The original product tool result is unknown. Query its original tool call before another write.') };
  const text = JSON.stringify(result);
  return { output: [{ type: 'text', text }], details: JSON.parse(text) as JsonValue, isError: true, control: { terminate: true } };
}

export function createDurableProductTools(options: DurableProductToolOptions) {
  const original = async (call: DurableProductToolCall): Promise<ToolExecutionResult> => {
    try {
      const saved = await options.read(call);
      return saved.ok && saved.data !== null ? nativeResult(saved.data) : unknownResult();
    } catch { return unknownResult(); }
  };
  return options.definitions.map(definition => defineTool({ name: definition.name, description: definition.description,
    parameters: Type.Unsafe(definition.inputSchema), executionMode: definition.executionMode, callers: ['model'],
    // Only safe reads without a receipt may reach product execution again; Agent resumes its owned child.
    replay: 'safe', execute: async (_args, api, context) => {
      const call = await options.resolve(api, context), signal = context.abortSignal;
      if (!signal) throw Error('The native tool cancellation signal is unavailable.');
      if (await api.memo<boolean>(invocationMemo, context) && definition.name !== 'Agent') {
        if (definition.effect !== 'PURE' && definition.effect !== 'READ') return original(call);
        try {
          const saved = await options.read(call);
          if (!saved.ok) return unknownResult();
          if (saved.data !== null) return nativeResult(saved.data);
        } catch { return unknownResult(); }
      }
      await api.memo(invocationMemo, true, context);
      const allowed = await options.verify(call, signal);
      signal.throwIfAborted();
      if (!allowed.ok) return { ...nativeResult({ status: 'failed', error: allowed.error }), control: { terminate: true } };
      try {
        const result = await options.execute({ ...call, signal,
          ...(definition.name === 'Agent' && !call.child && options.delegate ? { nativeDelegate: options.delegate(api, context, call) } : {}) });
        signal.throwIfAborted();
        return result.ok ? nativeResult(result.data) : original(call);
      } catch {
        signal.throwIfAborted();
        return original(call);
      }
    } }));
}

export function projectDurableToolFeedback(call: DurableProductToolCall, entry: EntryRecord): DurableProductToolFeedback {
  const message = entry.model?.[0];
  if (entry.kind !== ToolResultEntry.kind || entry.conversationId !== call.nativeConversationId || entry.model?.length !== 1
    || message?.role !== 'toolResult' || message.toolCallId !== call.nativeToolCallId || message.toolName !== call.name)
    throw Error('storage_corrupt');
  return { ...call, nativeEntryId: entry.id, feedbackJson: JSON.stringify(message) };
}
