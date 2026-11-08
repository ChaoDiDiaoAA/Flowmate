import type { Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { AssistantEntry, defineDocFamily, defineTool, GenerationTask, ToolResultEntry, ToolTask, type ConversationId, type EntryRecord, type Harness, type Storage, type TaskId,
  type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { appError, AppErrorSchema, type Result, type ToolResult } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { DurableProductToolCall, DurableProductToolDefinition, DurableProductToolFeedback } from '../../contracts/src/durable-runtime.ts';
import type { DurableProductToolExecution, DurableSubagentInvoker } from '../../contracts/src/durable-subagents.ts';
import type { DurableApprovalWaitCallbacks } from '../../contracts/src/durable-approval.ts';
import type { InvoiceWorkWorkingContext } from '../../contracts/src/personal-context.ts';

export type DurableProductToolOptions = {
  definitions: readonly DurableProductToolDefinition[];
  resolve(api: ToolExecutionApi, context: Context): Promise<DurableProductToolCall>;
  verify(call: DurableProductToolCall, signal: AbortSignal): Promise<Result<void>>;
  execute(call: DurableProductToolExecution): Result<ToolResult<unknown>> | Promise<Result<ToolResult<unknown>>>;
  read(call: DurableProductToolCall): Result<ToolResult<unknown> | null> | Promise<Result<ToolResult<unknown> | null>>;
  delegate?(api: ToolExecutionApi, context: Context, call: DurableProductToolCall): DurableSubagentInvoker;
  approval?: { context(call: DurableProductToolCall): Promise<Result<InvoiceWorkWorkingContext>>; wait?: DurableApprovalWaitCallbacks };
};
const invocationMemo = 'flowmate.product-tool.invoked';
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const callSchema = z.object({ workId: id, sessionId: id, itemId: id.optional(), attemptId: id, requestId: z.string().min(1), nativeConversationId: id,
  nativeTaskId: id, nativeToolCallId: z.string().min(1), name: z.string().min(1), arguments: z.unknown(), parentNativeTaskId: id.optional(),
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
  const productResult = async (call: DurableProductToolCall, result: ToolResult<unknown>, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
    const native = nativeResult(result);
    if ((call.name !== 'desktop_propose_action' && call.name !== 'browser_request_read') || result.status !== 'succeeded') return native;
    const saved = await options.approval?.context(call);
    if (!saved?.ok) return unknownResult();
    if (saved.data.phase.basis.executionMode !== 'item-lane-approval-v1') return { ...native, control: { terminate: true } };
    const proposal = z.object({ proposalId: id }).passthrough().safeParse(result.data), signal = context.abortSignal;
    if (!proposal.success || !signal || !options.approval?.wait || call.itemId === undefined || saved.data.item.itemId !== call.itemId) return unknownResult();
    const identity = { workId: call.workId, sessionId: call.sessionId, attemptId: call.attemptId, requestId: call.requestId,
      itemId: call.itemId, phaseId: saved.data.phase.phaseId, nativeConversationId: call.nativeConversationId, nativeTaskId: call.nativeTaskId,
      proposalId: proposal.data.proposalId, kind: call.name === 'browser_request_read' ? 'browser' as const : 'desktop' as const };
    let state = await options.approval.wait.begin(identity);
    let begun = state.ok;
    for (;;) {
      signal.throwIfAborted();
      if (!state.ok && !state.error.retryable) return unknownResult();
      if (state.ok && state.data.scheduling === 'active' && state.data.status === 'rejected')
        return nativeResult({ status: 'failed', error: appError('approval_rejected', 'runtime', 'The original action was rejected by the user.') });
      if (state.ok && (state.data.status === 'invalidated' || state.data.status === 'unknown')) return unknownResult();
      if (state.ok && state.data.scheduling === 'active' && state.data.status === 'approved') {
        const checkedState = await options.approval.wait.read(identity);
        if (!checkedState.ok && !checkedState.error.retryable) return unknownResult();
        if (checkedState.ok && checkedState.data.status === 'approved' && checkedState.data.scheduling === 'active'
          && checkedState.data.deviceReady !== false) {
          const nested = await api.executeTool(call.name === 'browser_request_read' ? 'browser_read_approved' : 'desktop_execute_approved',
            call.name === 'browser_request_read' ? {} : { proposalId: proposal.data.proposalId }, context, { key: 'approved-execution' });
          const checked = z.discriminatedUnion('status', [z.object({ status: z.literal('succeeded'), data: z.unknown() }).strict(),
            z.object({ status: z.literal('failed'), error: AppErrorSchema, data: z.unknown().optional() }).strict(),
            z.object({ status: z.literal('cancelled'), error: AppErrorSchema, data: z.unknown().optional() }).strict()]).safeParse(nested.details);
          if (!checked.success || nested.isError !== (checked.data.status !== 'succeeded')) return unknownResult();
          return nativeResult(checked.data.status === 'succeeded' ? { status: 'succeeded', data: checked.data.data } : checked.data);
        }
        state = checkedState;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 5000);
        const abort = () => { clearTimeout(timer); reject(Error('cancelled')); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      state = begun ? await options.approval.wait.read(identity) : await options.approval.wait.begin(identity);
      begun ||= state.ok;
    }
  };
  const original = async (call: DurableProductToolCall, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
    try {
      const saved = await options.read(call);
      return saved.ok && saved.data !== null ? productResult(call, saved.data, api, context) : unknownResult();
    } catch { return unknownResult(); }
  };
  return options.definitions.map(definition => defineTool({ name: definition.name, description: definition.description,
    parameters: Type.Unsafe(definition.inputSchema), executionMode: definition.executionMode,
    callers: definition.name === 'browser_read_approved' || definition.name === 'desktop_execute_approved' ? ['model', 'tools'] : ['model'],
    // Only safe reads without a receipt may reach product execution again; Agent resumes its owned child.
    replay: 'safe', execute: async (_args, api, context) => {
      const call = await options.resolve(api, context), signal = context.abortSignal;
      if (!signal) throw Error('The native tool cancellation signal is unavailable.');
      if (await api.memo<boolean>(invocationMemo, context) && definition.name !== 'Agent') {
        if (definition.effect !== 'PURE' && definition.effect !== 'READ') return original(call, api, context);
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
        return result.ok ? productResult(call, result.data, api, context) : original(call, api, context);
      } catch {
        signal.throwIfAborted();
        return original(call, api, context);
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
