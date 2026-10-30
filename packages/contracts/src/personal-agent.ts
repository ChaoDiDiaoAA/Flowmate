import { z } from 'zod';
import { AppErrorSchema, RunStatusSchema, type Result } from './runtime.ts';
import { AcceptInvoiceCandidateRequestSchema, DocumentRefSchema, SourceRefSchema } from './invoice.ts';
import { InvoiceCandidateFieldPathSchema, WorkspaceExpectationSchema } from './workspace.ts';
import { ResourceSelectionSchema } from './resources.ts';
import { ExtensionSelectionSchema } from './extensions.ts';
import { RegisteredToolNameSchema } from './tools.ts';
import { WorkingDirectorySchema } from './schemas.ts';
import { SUBAGENT_ROLE } from './subagents.ts';
import { ToolCallDeliverySchema } from './activity.ts';
import type { PersonalHistoryApi } from './personal-history.ts';
import type { InvoiceWorkTimelineApi } from './invoice-work-timeline.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().min(1).max(128).refine(value => value.trim().length > 0, 'Request identity is empty.');

export { SessionRuntimeKindSchema, type SessionRuntimeKind } from './runtime.ts';
export const InvoiceWorkStatusSchema = z.enum(['open', 'completed', 'cancelled']);
export type InvoiceWorkStatus = z.infer<typeof InvoiceWorkStatusSchema>;
export const InvoiceWorkItemDispositionSchema = z.enum(['unresolved', 'accepted', 'rejected', 'excluded']);
export type InvoiceWorkItemDisposition = z.infer<typeof InvoiceWorkItemDispositionSchema>;

export const InvoiceWorkContinueRequestSchema = z.object({
  workId: id, requestId, expectedRevision: revision, expectedAttemptId: id.nullable(),
}).strict();
export type InvoiceWorkContinueRequest = z.infer<typeof InvoiceWorkContinueRequestSchema>;

export const InvoiceWorkQueryOperationRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), personalAgentId: id, requestId }).strict(),
  z.object({ operation: z.enum(['continueWork', 'supplement', 'disposeItem', 'cancelWork']), workId: id, requestId }).strict(),
]);
export type InvoiceWorkQueryOperationRequest = z.infer<typeof InvoiceWorkQueryOperationRequestSchema>;

const wireBytes = 262_144;
const text = z.string().max(22_000).refine(value => new TextEncoder().encode(value).byteLength <= 22_000);
const requiredText = text.refine(value => value.trim().length > 0, 'Text is empty.');
const time = z.string().datetime({ offset: true });
const candidateRef = WorkspaceExpectationSchema.shape.candidateRef;
const sourceItem = z.object({ itemId: id, documentRef: DocumentRefSchema, candidateRef }).strict();
const uniqueIds = (values: readonly number[]) => new Set(values).size === values.length;
const bounded = <T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T, z.output<T>, z.input<T>> => schema.refine(value =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= wireBytes, 'Personal Agent payload exceeds its UTF-8 limit.');

export const InvoiceWorkCreateRequestSchema = bounded(z.object({
  personalAgentId: id, expectedAgentRevision: revision, requestId, goal: requiredText,
  documents: z.array(DocumentRefSchema).min(1).refine(values => uniqueIds(values.map(value => value.id)), 'Invoice membership must be unique.'),
  source: z.object({ workId: id, items: z.array(sourceItem).min(1) }).strict().optional(),
}).strict());
export type InvoiceWorkCreateRequest = z.infer<typeof InvoiceWorkCreateRequestSchema>;

export const InvoiceWorkSupplementRequestSchema = bounded(z.object({
  workId: id, itemId: id, todoId: id, requestId, expectedRevision: revision,
  text, materials: z.array(DocumentRefSchema),
}).strict().refine(input => input.text.trim().length > 0 || input.materials.length > 0, 'A clarification or material reference is required.'));
export type InvoiceWorkSupplementRequest = z.infer<typeof InvoiceWorkSupplementRequestSchema>;

const finalReason = z.string().min(1).max(2048).refine(value => value.trim().length > 0, 'A final decision needs a reason.');
export const InvoiceWorkDispositionDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted'), candidateRef: candidateRef.unwrap(), acceptRequest: AcceptInvoiceCandidateRequestSchema }).strict(),
  z.object({ kind: z.literal('rejected'), reason: finalReason }).strict(),
  z.object({ kind: z.literal('excluded'), reason: finalReason }).strict(),
]).refine(decision => decision.kind !== 'accepted' || decision.candidateRef.id === decision.acceptRequest.candidateId
  && decision.acceptRequest.candidateId === decision.acceptRequest.expectedCandidateId, 'The original acceptance and selected candidate must agree.');
export type InvoiceWorkDispositionDecision = z.infer<typeof InvoiceWorkDispositionDecisionSchema>;
export const InvoiceWorkDisposeItemRequestSchema = bounded(z.object({
  workId: id, itemId: id, requestId, expectedRevision: revision, decision: InvoiceWorkDispositionDecisionSchema,
}).strict());
export type InvoiceWorkDisposeItemRequest = z.infer<typeof InvoiceWorkDisposeItemRequestSchema>;
export const InvoiceWorkCancelRequestSchema = z.object({ workId: id, requestId, expectedRevision: revision }).strict();
export type InvoiceWorkCancelRequest = z.infer<typeof InvoiceWorkCancelRequestSchema>;

export const InvoiceWorkAttemptReferenceSchema = z.object({
  attemptId: id, runId: id.nullable(), runtimeLinked: z.boolean(),
}).strict();
export type InvoiceWorkAttemptReference = z.infer<typeof InvoiceWorkAttemptReferenceSchema>;

// Immutable command decisions describe admission; current execution remains a separate read projection.
export const InvoiceWorkExecutionDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['accepted', 'queued', 'pending-boundary']), authorizationAccepted: z.literal(true),
    attempt: InvoiceWorkAttemptReferenceSchema, relation: z.enum(['original', 'new']) }).strict(),
  z.object({ kind: z.literal('existing'), authorizationAccepted: z.literal(false),
    attempt: InvoiceWorkAttemptReferenceSchema, relation: z.literal('original') }).strict(),
  z.object({ kind: z.literal('waiting'), authorizationAccepted: z.literal(false), attempt: InvoiceWorkAttemptReferenceSchema.nullable(),
    reason: z.string().min(1).max(2048), todoIds: z.array(id) }).strict(),
  z.object({ kind: z.literal('blocked'), authorizationAccepted: z.literal(false), attempt: InvoiceWorkAttemptReferenceSchema.nullable(),
    reason: AppErrorSchema }).strict(),
]);
export type InvoiceWorkExecutionDecision = z.infer<typeof InvoiceWorkExecutionDecisionSchema>;
const operationReceipt = { workId: id, requestId, revision, receivedAt: time };
const createReceipt = z.object({ ...operationReceipt, operation: z.literal('create'), personalAgentId: id, sessionId: id,
  execution: InvoiceWorkExecutionDecisionSchema }).strict();
const continueReceipt = z.object({ ...operationReceipt, operation: z.literal('continueWork'),
  execution: InvoiceWorkExecutionDecisionSchema }).strict();
const supplementReceipt = z.object({ ...operationReceipt, operation: z.literal('supplement'), itemId: id, todoId: id, inputId: id,
  saved: z.literal(true), execution: InvoiceWorkExecutionDecisionSchema }).strict();
const disposeReceipt = z.object({ ...operationReceipt, operation: z.literal('disposeItem'), itemId: id,
  disposition: z.enum(['accepted', 'rejected', 'excluded']) }).strict();
const cancelReceipt = z.object({ ...operationReceipt, operation: z.literal('cancelWork'), cancelled: z.literal(true) }).strict();
export const InvoiceWorkCreateReceiptSchema = bounded(createReceipt);
export const InvoiceWorkContinueReceiptSchema = bounded(continueReceipt);
export const InvoiceWorkSupplementReceiptSchema = bounded(supplementReceipt);
export const InvoiceWorkDisposeItemReceiptSchema = bounded(disposeReceipt);
export const InvoiceWorkCancelReceiptSchema = bounded(cancelReceipt);
export const InvoiceWorkOperationReceiptSchema = bounded(z.discriminatedUnion('operation', [
  createReceipt, continueReceipt, supplementReceipt, disposeReceipt, cancelReceipt,
]));
export type InvoiceWorkCreateReceipt = z.infer<typeof InvoiceWorkCreateReceiptSchema>;
export type InvoiceWorkContinueReceipt = z.infer<typeof InvoiceWorkContinueReceiptSchema>;
export type InvoiceWorkSupplementReceipt = z.infer<typeof InvoiceWorkSupplementReceiptSchema>;
export type InvoiceWorkDisposeItemReceipt = z.infer<typeof InvoiceWorkDisposeItemReceiptSchema>;
export type InvoiceWorkCancelReceipt = z.infer<typeof InvoiceWorkCancelReceiptSchema>;
export type InvoiceWorkOperationReceipt = z.infer<typeof InvoiceWorkOperationReceiptSchema>;

export const PersonalAgentConfigurationSchema = bounded(z.object({
  modelId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).nullable(),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  resources: ResourceSelectionSchema, extensions: ExtensionSelectionSchema,
  tools: z.array(RegisteredToolNameSchema).refine(values => new Set(values).size === values.length, 'Tools must be unique.').readonly(),
  workingDirectory: WorkingDirectorySchema.nullable(), preferences: text,
}).strict()).readonly();
export type PersonalAgentConfiguration = z.infer<typeof PersonalAgentConfigurationSchema>;
export const PersonalAgentSnapshotSchema = bounded(z.object({
  personalAgentId: id, revision, runtimeKind: z.literal('durable'), configuration: PersonalAgentConfigurationSchema,
  createdAt: time, updatedAt: time,
}).strict()).readonly();
export type PersonalAgentSnapshot = z.infer<typeof PersonalAgentSnapshotSchema>;
export const PersonalAgentUpdateRequestSchema = bounded(z.object({
  personalAgentId: id, expectedRevision: revision, configuration: PersonalAgentConfigurationSchema,
}).strict());
export type PersonalAgentUpdateRequest = z.infer<typeof PersonalAgentUpdateRequestSchema>;
export const PersonalAgentOpenConversationRequestSchema = z.object({ workId: id }).strict();
export type PersonalAgentOpenConversationRequest = z.infer<typeof PersonalAgentOpenConversationRequestSchema>;
export const PersonalAgentConversationSchema = z.object({ workId: id, sessionId: id, runtimeKind: z.literal('durable') }).strict().readonly();
export type PersonalAgentConversation = z.infer<typeof PersonalAgentConversationSchema>;

export const InvoiceWorkActionSchema = z.object({
  kind: z.enum(['continue', 'supplement', 'review', 'stop', 'cancel', 'repair', 'create-related']),
  enabled: z.boolean(), reason: z.string().max(2048).nullable(), itemId: id.nullable(), todoId: id.nullable(),
}).strict().refine(value => {
  if (value.todoId !== null && value.itemId === null) return false;
  if (['continue', 'stop', 'cancel'].includes(value.kind) && (value.itemId !== null || value.todoId !== null)) return false;
  if (!value.enabled) return value.reason !== null && value.reason.trim().length > 0;
  if (value.kind === 'supplement') return value.itemId !== null && value.todoId !== null;
  if (value.kind === 'review') return value.itemId !== null;
  return value.kind !== 'create-related' || value.todoId === null;
}, 'Action target or unavailable reason is incomplete.').readonly();
export type InvoiceWorkAction = z.infer<typeof InvoiceWorkActionSchema>;
export const InvoiceWorkExecutionViewSchema = z.object({
  attempt: InvoiceWorkAttemptReferenceSchema.nullable(), runStatus: RunStatusSchema.nullable(),
  queued: z.boolean(), requiresContinue: z.boolean(), stopUnconfirmed: z.boolean(),
  waitingReason: z.string().max(2048).nullable(),
  // Only currently occupied child capacity is listed here; historical results have their own read page.
  ownedChildRunIds: z.array(id).max(4).refine(uniqueIds, 'Owned children must be unique.').readonly(),
}).strict().refine(value => value.attempt !== null || value.runStatus === null && !value.queued
  && !value.stopUnconfirmed && value.ownedChildRunIds.length === 0, 'Execution references require the original product attempt.').readonly();
export type InvoiceWorkExecutionView = z.infer<typeof InvoiceWorkExecutionViewSchema>;
export const InvoiceWorkViewSchema = bounded(z.object({
  workId: id, personalAgentId: id, sessionId: id, runtimeKind: z.literal('durable'), revision, goal: requiredText,
  status: InvoiceWorkStatusSchema, createdAt: time, updatedAt: time,
  counts: z.object({ total: id, unresolved: revision, accepted: revision, rejected: revision, excluded: revision }).strict().readonly(),
  execution: InvoiceWorkExecutionViewSchema, actions: z.array(InvoiceWorkActionSchema).readonly(),
}).strict().superRefine((value, context) => {
  const counts = value.counts;
  if (counts.total !== counts.unresolved + counts.accepted + counts.rejected + counts.excluded)
    context.addIssue({ code: 'custom', message: 'Item counts disagree.' });
  if (value.status === 'completed' && (counts.unresolved !== 0 || value.execution.stopUnconfirmed
    || value.execution.queued || value.execution.ownedChildRunIds.length !== 0))
    context.addIssue({ code: 'custom', message: 'Completed work cannot retain unresolved or unconfirmed owned work.' });
  if (value.status !== 'open' && value.execution.requiresContinue)
    context.addIssue({ code: 'custom', message: 'Ended work cannot require continuing the original work.' });
})).readonly();
export type InvoiceWorkView = z.infer<typeof InvoiceWorkViewSchema>;
export const InvoiceWorkItemViewSchema = bounded(z.object({
  workId: id, itemId: id, revision, documentRef: DocumentRefSchema, jobId: id.nullable(), candidateRef,
  disposition: InvoiceWorkItemDispositionSchema, decision: InvoiceWorkDispositionDecisionSchema.nullable(),
  disposedAt: time.nullable(), todoCount: revision, latestInputId: id.nullable(), updatedAt: time,
}).strict().superRefine((value, context) => {
  if (value.disposition === 'unresolved' ? value.decision !== null || value.disposedAt !== null
    : value.decision?.kind !== value.disposition || value.disposedAt === null)
    context.addIssue({ code: 'custom', message: 'Final disposition requires its explicit decision and timestamp.' });
  if (value.decision?.kind === 'accepted' && (value.jobId !== value.decision.acceptRequest.jobId
    || value.candidateRef?.id !== value.decision.candidateRef.id || value.candidateRef?.sequence !== value.decision.candidateRef.sequence))
    context.addIssue({ code: 'custom', message: 'Accepted item, Job and original candidate version disagree.' });
})).readonly();
export type InvoiceWorkItemView = z.infer<typeof InvoiceWorkItemViewSchema>;
export const InvoiceWorkSourceLocatorSchema = SourceRefSchema.omit({ quote: true }).strict().readonly();
export type InvoiceWorkSourceLocator = z.infer<typeof InvoiceWorkSourceLocatorSchema>;
export const InvoiceWorkTodoViewSchema = bounded(z.object({
  todoId: id, workId: id, itemId: id, revision, actor: z.enum(['user', 'agent', 'system']),
  fieldPath: InvoiceCandidateFieldPathSchema.nullable(), problem: finalReason, needed: finalReason, satisfiedBy: finalReason,
  applicable: z.boolean(), action: z.enum(['supplement', 'review', 'continue', 'repair']),
  basis: z.object({ origin: z.enum(['rule', 'model', 'user']), documentRefs: z.array(DocumentRefSchema).readonly(),
    sourceRefs: z.array(InvoiceWorkSourceLocatorSchema).readonly(), inputIds: z.array(id).readonly(), candidateRef }).strict().readonly(),
}).strict().refine(value => value.basis.origin !== 'model' || value.basis.documentRefs.length > 0
  || value.basis.sourceRefs.length > 0 || value.basis.inputIds.length > 0 || value.basis.candidateRef !== null,
  'A model-proposed Todo needs an original basis.')).readonly();
export type InvoiceWorkTodoView = z.infer<typeof InvoiceWorkTodoViewSchema>;

const pageLimit = z.number().int().min(1).max(100).default(50);
export const InvoiceWorkListRequestSchema = z.object({ personalAgentId: id, beforeId: id.optional(),
  status: InvoiceWorkStatusSchema.optional(), limit: pageLimit }).strict();
export type InvoiceWorkListRequest = z.input<typeof InvoiceWorkListRequestSchema>;
export const InvoiceWorkListResultSchema = bounded(z.object({
  items: z.array(InvoiceWorkViewSchema).max(100).readonly(), nextBeforeId: id.nullable(),
}).strict().refine(page => page.items.every((item, index) => index === 0 || item.workId < page.items[index - 1]!.workId)
  && (page.nextBeforeId === null || page.items.length > 0 && page.nextBeforeId === page.items.at(-1)!.workId),
  'Work page order or continuation disagrees.')).readonly();
export type InvoiceWorkListResult = z.infer<typeof InvoiceWorkListResultSchema>;
export const InvoiceWorkGetRequestSchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('work'), workId: id, afterItemId: id.optional(), limit: pageLimit }).strict(),
  z.object({ view: z.literal('item'), workId: id, itemId: id, afterTodoId: id.optional(), limit: pageLimit }).strict(),
]);
export type InvoiceWorkGetRequest = z.input<typeof InvoiceWorkGetRequestSchema>;
export const InvoiceWorkGetResultSchema = bounded(z.discriminatedUnion('view', [
  z.object({ view: z.literal('work'), work: InvoiceWorkViewSchema, items: z.array(InvoiceWorkItemViewSchema).max(100).readonly(),
    nextAfterItemId: id.nullable() }).strict(),
  z.object({ view: z.literal('item'), work: InvoiceWorkViewSchema, item: InvoiceWorkItemViewSchema,
    todos: z.array(InvoiceWorkTodoViewSchema).max(100).readonly(), nextAfterTodoId: id.nullable() }).strict(),
]).superRefine((value, context) => {
  if (value.view === 'work') {
    if (value.items.some((item, index) => item.workId !== value.work.workId || index > 0 && item.itemId <= value.items[index - 1]!.itemId)
      || value.nextAfterItemId !== null && (value.items.length === 0 || value.nextAfterItemId !== value.items.at(-1)!.itemId))
      context.addIssue({ code: 'custom', message: 'Work item page has a foreign owner or invalid continuation.' });
  } else if (value.item.workId !== value.work.workId || value.todos.some((todo, index) => todo.workId !== value.work.workId
    || todo.itemId !== value.item.itemId || index > 0 && todo.todoId <= value.todos[index - 1]!.todoId)
    || value.nextAfterTodoId !== null && (value.todos.length === 0 || value.nextAfterTodoId !== value.todos.at(-1)!.todoId))
    context.addIssue({ code: 'custom', message: 'Todo page has a foreign owner or invalid continuation.' });
})).readonly();
export type InvoiceWorkGetResult = z.infer<typeof InvoiceWorkGetResultSchema>;

export const InvoiceWorkChildReferenceSchema = bounded(z.object({
  runtimeKind: z.literal('durable'), kind: z.literal('subagent'), workId: id, itemId: id, parentAttemptId: id,
  childRunId: id, originToolCallId: id, role: z.literal(SUBAGENT_ROLE), runStatus: RunStatusSchema,
  resultRecorded: z.boolean(), delivery: ToolCallDeliverySchema, stopConfirmed: z.boolean(), stoppedAt: time.nullable(),
  parentModelReceivedAt: time.nullable().default(null),
}).strict().refine(value => value.stopConfirmed === (value.stoppedAt !== null), 'Stop confirmation needs its saved timestamp.')).readonly();
export type InvoiceWorkChildReference = z.infer<typeof InvoiceWorkChildReferenceSchema>;
export const PersonalTaskIdentitySchema = z.object({ workId: id, attemptId: id }).strict();
export type PersonalTaskIdentity = z.infer<typeof PersonalTaskIdentitySchema>;
export const PersonalTaskStopRequestSchema = PersonalTaskIdentitySchema.extend({ requestId, expectedRevision: revision });
export type PersonalTaskStopRequest = z.infer<typeof PersonalTaskStopRequestSchema>;
export const PersonalTaskStopReceiptSchema = z.object({ workId: id, attemptId: id, requestId, receivedAt: time,
  accepted: z.boolean(), stopConfirmed: z.boolean(), stoppedAt: time.nullable() }).strict()
  .refine(value => value.stopConfirmed === (value.stoppedAt !== null), 'Stop intent is not a stop confirmation.').readonly();
export type PersonalTaskStopReceipt = z.infer<typeof PersonalTaskStopReceiptSchema>;
export const PersonalTaskViewSchema = bounded(z.object({ workId: id, sessionId: id, attempt: InvoiceWorkAttemptReferenceSchema,
  runStatus: RunStatusSchema.nullable(), createdAt: time, queued: z.boolean(), stopRequestedAt: time.nullable(),
  stoppedAt: time.nullable() }).strict()).readonly();
export type PersonalTaskView = z.infer<typeof PersonalTaskViewSchema>;
export const PersonalTaskListRequestSchema = z.object({ workId: id, beforeAttemptId: id.optional(), limit: pageLimit }).strict();
export type PersonalTaskListRequest = z.input<typeof PersonalTaskListRequestSchema>;
export const PersonalTaskListResultSchema = bounded(z.object({ workId: id, items: z.array(PersonalTaskViewSchema).max(100).readonly(),
  nextBeforeAttemptId: id.nullable() }).strict().refine(page => page.items.every((item, index) => item.workId === page.workId
    && (index === 0 || item.attempt.attemptId < page.items[index - 1]!.attempt.attemptId))
    && (page.nextBeforeAttemptId === null || page.items.length > 0 && page.nextBeforeAttemptId === page.items.at(-1)!.attempt.attemptId),
    'Attempt page ownership or continuation disagrees.')).readonly();
export type PersonalTaskListResult = z.infer<typeof PersonalTaskListResultSchema>;
export const PersonalTaskGetRequestSchema = PersonalTaskIdentitySchema.extend({ stopRequestId: requestId.optional(),
  afterChildRunId: id.optional(), limit: pageLimit });
export type PersonalTaskGetRequest = z.input<typeof PersonalTaskGetRequestSchema>;
export const PersonalTaskGetResultSchema = bounded(z.object({ task: PersonalTaskViewSchema,
  children: z.array(InvoiceWorkChildReferenceSchema).max(100).readonly(), nextAfterChildRunId: id.nullable(),
  stopReceipt: PersonalTaskStopReceiptSchema.nullable() }).strict().refine(page => page.children.every((child, index) =>
    child.workId === page.task.workId && child.parentAttemptId === page.task.attempt.attemptId
    && (index === 0 || child.childRunId > page.children[index - 1]!.childRunId))
    && (page.nextAfterChildRunId === null || page.children.length > 0 && page.nextAfterChildRunId === page.children.at(-1)!.childRunId)
    && (page.stopReceipt === null || page.stopReceipt.workId === page.task.workId && page.stopReceipt.attemptId === page.task.attempt.attemptId),
    'Child or stop evidence belongs to another attempt, or has an invalid continuation.')).readonly();
export type PersonalTaskGetResult = z.infer<typeof PersonalTaskGetResultSchema>;

export interface PersonalAgentApi {
  get(): Promise<Result<PersonalAgentSnapshot>>;
  update(input: PersonalAgentUpdateRequest): Promise<Result<PersonalAgentSnapshot>>;
  openConversation(input: PersonalAgentOpenConversationRequest): Promise<Result<PersonalAgentConversation>>;
}
export interface InvoiceWorksApi extends InvoiceWorkTimelineApi {
  create(input: InvoiceWorkCreateRequest): Promise<Result<InvoiceWorkCreateReceipt>>;
  list(input: InvoiceWorkListRequest): Promise<Result<InvoiceWorkListResult>>;
  get(input: InvoiceWorkGetRequest): Promise<Result<InvoiceWorkGetResult>>;
  supplement(input: InvoiceWorkSupplementRequest): Promise<Result<InvoiceWorkSupplementReceipt>>;
  disposeItem(input: InvoiceWorkDisposeItemRequest): Promise<Result<InvoiceWorkDisposeItemReceipt>>;
  continueWork(input: InvoiceWorkContinueRequest): Promise<Result<InvoiceWorkContinueReceipt>>;
  cancelWork(input: InvoiceWorkCancelRequest): Promise<Result<InvoiceWorkCancelReceipt>>;
  queryOperation(input: InvoiceWorkQueryOperationRequest): Promise<Result<InvoiceWorkOperationReceipt | null>>;
}
export interface PersonalTasksApi extends PersonalHistoryApi {
  list(input: PersonalTaskListRequest): Promise<Result<PersonalTaskListResult>>;
  get(input: PersonalTaskGetRequest): Promise<Result<PersonalTaskGetResult>>;
  stop(input: PersonalTaskStopRequest): Promise<Result<PersonalTaskStopReceipt>>;
  /** Internal continuation of existing authorization, never a second UI "continue work" command. */
  resume(input: PersonalTaskIdentity): Promise<Result<void>>;
}
