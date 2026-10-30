import { z } from 'zod';
import { AppErrorSchema, type AppError } from './runtime.ts';
import * as P from './personal-agent.ts';
import * as H from './personal-history.ts';
import * as T from './invoice-work-timeline.ts';

const withinWireBudget = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262_144;
const result = <T extends z.ZodTypeAny>(data: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema, runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
]).refine(withinWireBudget, 'Personal Agent response exceeds its UTF-8 limit.');

const commandSchemas = [
  z.object({ type: z.literal('personal_agent_get'), input: z.object({}).strict() }).strict(),
  z.object({ type: z.literal('personal_agent_update'), input: P.PersonalAgentUpdateRequestSchema }).strict(),
  z.object({ type: z.literal('personal_agent_open_conversation'), input: P.PersonalAgentOpenConversationRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_create'), input: P.InvoiceWorkCreateRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_list'), input: P.InvoiceWorkListRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_get'), input: P.InvoiceWorkGetRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_supplement'), input: P.InvoiceWorkSupplementRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_dispose_item'), input: P.InvoiceWorkDisposeItemRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_continue'), input: P.InvoiceWorkContinueRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_cancel'), input: P.InvoiceWorkCancelRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_query_operation'), input: P.InvoiceWorkQueryOperationRequestSchema }).strict(),
  z.object({ type: z.literal('personal_task_list'), input: P.PersonalTaskListRequestSchema }).strict(),
  z.object({ type: z.literal('personal_task_get'), input: P.PersonalTaskGetRequestSchema }).strict(),
  z.object({ type: z.literal('personal_task_stop'), input: P.PersonalTaskStopRequestSchema }).strict(),
  z.object({ type: z.literal('personal_task_history'), input: H.PersonalHistoryRequestSchema }).strict(),
  z.object({ type: z.literal('personal_task_history_entry'), input: H.PersonalHistoryEntryRequestSchema }).strict(),
  z.object({ type: z.literal('invoice_work_timeline'), input: T.InvoiceWorkTimelineRequestSchema }).strict(),
] as const;

export const PersonalAgentCommandSchema = z.discriminatedUnion('type', commandSchemas)
  .refine(withinWireBudget, 'Personal Agent command exceeds its UTF-8 limit.');
export type PersonalAgentCommand = z.infer<typeof PersonalAgentCommandSchema>;
export type PersonalAgentCommandType = PersonalAgentCommand['type'];
export function personalAgentHostCommandTypes(): readonly PersonalAgentCommandType[] {
  return commandSchemas.map(schema => schema.shape.type.value);
}
export function personalAgentHostCommandSchemas(envelope: { version: z.ZodLiteral<1>; requestId: z.ZodString }) {
  return commandSchemas.map(schema => schema.extend(envelope));
}

const resultSchemas = {
  personal_agent_get: result(P.PersonalAgentSnapshotSchema),
  personal_agent_update: result(P.PersonalAgentSnapshotSchema),
  personal_agent_open_conversation: result(P.PersonalAgentConversationSchema),
  invoice_work_create: result(P.InvoiceWorkCreateReceiptSchema),
  invoice_work_list: result(P.InvoiceWorkListResultSchema),
  invoice_work_get: result(P.InvoiceWorkGetResultSchema),
  invoice_work_supplement: result(P.InvoiceWorkSupplementReceiptSchema),
  invoice_work_dispose_item: result(P.InvoiceWorkDisposeItemReceiptSchema),
  invoice_work_continue: result(P.InvoiceWorkContinueReceiptSchema),
  invoice_work_cancel: result(P.InvoiceWorkCancelReceiptSchema),
  invoice_work_query_operation: result(P.InvoiceWorkOperationReceiptSchema.nullable()),
  personal_task_list: result(P.PersonalTaskListResultSchema),
  personal_task_get: result(P.PersonalTaskGetResultSchema),
  personal_task_stop: result(P.PersonalTaskStopReceiptSchema),
  personal_task_history: result(H.PersonalHistoryPageSchema),
  personal_task_history_entry: result(H.PersonalHistoryEntrySchema),
  invoice_work_timeline: result(T.InvoiceWorkTimelinePageSchema),
};

export function isPersonalAgentHostCommand(type: string): type is PersonalAgentCommandType {
  return Object.hasOwn(resultSchemas, type);
}
export function parsePersonalAgentCommand(value: unknown): PersonalAgentCommand | null {
  const parsed = PersonalAgentCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function publicError(error: AppError): AppError {
  return { ...error, message: error.code === 'personal_agent_unavailable' ? 'Personal Agent is unavailable.'
    : error.code === 'input_invalid' ? 'The Personal Agent request is invalid.'
    : error.code === 'state_conflict' ? 'Saved Personal Agent facts changed. Refresh before continuing.'
    : error.code === 'operation_result_unknown' ? 'The operation receipt is unknown. Query the original request before retrying.'
    : error.code === 'stop_unconfirmed' ? 'Stopping is not confirmed. Refresh the original task.'
    : 'The Personal Agent operation could not be completed. Refresh the saved facts before trying again.' };
}
export function parsePersonalAgentHostResult(type: string, value: unknown) {
  if (!isPersonalAgentHostCommand(type)) return null;
  const parsed = resultSchemas[type].safeParse(value);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (!result.ok) return { ...result, error: publicError(result.error) };
  if (result.data && 'execution' in result.data && 'kind' in result.data.execution && result.data.execution.kind === 'blocked')
    return { ...result, data: { ...result.data, execution: { ...result.data.execution, reason: publicError(result.data.execution.reason) } } };
  return result;
}

/** The original command supplies ownership, filters and cursors absent from a standalone result schema. */
export function matchesPersonalAgentResponse(command: { type: string; input?: unknown }, value: unknown): boolean {
  const captured = parsePersonalAgentCommand({ type: command.type, input: command.input });
  const result = parsePersonalAgentHostResult(command.type, value);
  if (!captured || !result) return false;
  if (!result.ok) return result.runId === undefined && result.error.runId === undefined
    && result.error.sessionId === undefined && result.error.toolCallId === undefined;
  const data = result.data;
  if (data === null) return captured.type === 'invoice_work_query_operation';
  if ('execution' in data && 'kind' in data.execution && data.execution.kind === 'blocked') {
    const { reason, attempt } = data.execution;
    if (reason.runId !== undefined && reason.runId !== attempt?.runId || reason.toolCallId !== undefined
      || reason.sessionId !== undefined && (!('sessionId' in data) || reason.sessionId !== data.sessionId)) return false;
  }
  switch (captured.type) {
    case 'personal_task_history': return 'owner' in data && 'entries' in data
      && data.owner.workId === captured.input.target.workId && data.owner.childRunId === (captured.input.target.childRunId ?? null)
      && (captured.input.throughEntryId === undefined || data.throughEntryId === captured.input.throughEntryId)
      && data.entries.length <= captured.input.limit && data.entries.every(entry => captured.input.beforeEntryId === undefined
        || entry.entryId < captured.input.beforeEntryId);
    case 'personal_task_history_entry': return 'owner' in data && 'entryId' in data
      && data.owner.workId === captured.input.target.workId && data.owner.childRunId === (captured.input.target.childRunId ?? null)
      && data.throughEntryId === captured.input.throughEntryId && data.entryId === captured.input.entryId
      && data.offset === captured.input.offset && new TextEncoder().encode(data.text).byteLength <= captured.input.limit;
    case 'invoice_work_timeline': return 'semantics' in data && data.workId === captured.input.workId
      && data.entries.length <= captured.input.limit && data.entries.every(entry => captured.input.before === undefined
        || T.compareInvoiceWorkTimelineCursor(entry, captured.input.before) < 0);
    case 'personal_agent_get': return true;
    case 'personal_agent_update': return 'personalAgentId' in data && 'configuration' in data
      && data.personalAgentId === captured.input.personalAgentId && data.revision >= captured.input.expectedRevision;
    case 'personal_agent_open_conversation': return 'workId' in data && data.workId === captured.input.workId;
    case 'invoice_work_list': return 'items' in data && data.items.length <= captured.input.limit
      && data.items.every(item => 'personalAgentId' in item && item.personalAgentId === captured.input.personalAgentId
        && (captured.input.status === undefined || item.status === captured.input.status)
        && (captured.input.beforeId === undefined || item.workId < captured.input.beforeId));
    case 'invoice_work_get': {
      const input = captured.input;
      if (!('view' in data) || data.view !== input.view || data.work.workId !== input.workId) return false;
      return input.view === 'work' ? data.view === 'work' && data.items.length <= input.limit
        && data.items.every(item => input.afterItemId === undefined || item.itemId > input.afterItemId)
        : data.view === 'item' && data.item.itemId === input.itemId && data.todos.length <= input.limit
          && data.todos.every(todo => input.afterTodoId === undefined || todo.todoId > input.afterTodoId);
    }
    case 'personal_task_list': return 'items' in data && 'workId' in data && data.workId === captured.input.workId
      && data.items.length <= captured.input.limit && data.items.every(item => 'attempt' in item
        && (captured.input.beforeAttemptId === undefined || item.attempt.attemptId < captured.input.beforeAttemptId));
    case 'personal_task_get': return 'task' in data && data.task.workId === captured.input.workId
      && data.task.attempt.attemptId === captured.input.attemptId && data.children.length <= captured.input.limit
      && data.children.every(child => captured.input.afterChildRunId === undefined || child.childRunId > captured.input.afterChildRunId)
      && (data.stopReceipt === null || data.stopReceipt.requestId === captured.input.stopRequestId);
    case 'personal_task_stop': return 'stopConfirmed' in data && data.workId === captured.input.workId
      && data.attemptId === captured.input.attemptId && data.requestId === captured.input.requestId;
    case 'invoice_work_query_operation': return 'operation' in data && data.operation === captured.input.operation
      && data.requestId === captured.input.requestId && (captured.input.operation === 'create'
        ? data.operation === 'create' && data.personalAgentId === captured.input.personalAgentId : data.workId === captured.input.workId);
    case 'invoice_work_create': return 'operation' in data && data.operation === 'create'
      && data.personalAgentId === captured.input.personalAgentId && data.requestId === captured.input.requestId;
    case 'invoice_work_continue': return 'operation' in data && data.operation === 'continueWork'
      && data.workId === captured.input.workId && data.requestId === captured.input.requestId && data.revision >= captured.input.expectedRevision;
    case 'invoice_work_cancel': return 'operation' in data && data.operation === 'cancelWork'
      && data.workId === captured.input.workId && data.requestId === captured.input.requestId && data.revision >= captured.input.expectedRevision;
    case 'invoice_work_supplement': return 'operation' in data && data.operation === 'supplement'
      && data.workId === captured.input.workId && data.itemId === captured.input.itemId && data.todoId === captured.input.todoId
      && data.requestId === captured.input.requestId && data.revision >= captured.input.expectedRevision;
    case 'invoice_work_dispose_item': return 'operation' in data && data.operation === 'disposeItem'
      && data.workId === captured.input.workId && data.itemId === captured.input.itemId && data.disposition === captured.input.decision.kind
      && data.requestId === captured.input.requestId && data.revision >= captured.input.expectedRevision;
  }
}

export function personalAgentHostFailure(type: string) {
  const write = ['personal_agent_update', 'invoice_work_create', 'invoice_work_supplement', 'invoice_work_dispose_item',
    'invoice_work_continue', 'invoice_work_cancel', 'personal_task_stop'].includes(type);
  return { ok: false as const, error: { code: write ? 'operation_result_unknown' : 'storage_read_failed',
    category: write ? 'runtime' as const : 'storage' as const, retryable: true,
    message: write ? 'The operation result is unknown. Refresh the original saved request before retrying.'
      : 'Personal Agent facts could not be read. Refresh to retry.' } };
}
