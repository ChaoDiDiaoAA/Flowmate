import { z } from 'zod';
import { AppErrorSchema } from './runtime.ts';
import { CONTEXT_ERROR_FACTS } from './context.ts';
import type { AppError, DbId, Result, RunStatus, TokenColumns } from './runtime.ts';
import type { ToolCallSnapshot } from './activity.ts';
import type { SessionInputSnapshot } from './session-inputs.ts';
import type { Page } from './workspace.ts';

export type RuntimeEventBase = Readonly<{
  eventId: DbId; runId: DbId; sequence: number;
  sessionId: DbId | null; toolCallId: DbId | null;
  sourceConnection: string | null; sourceSequence: number | null;
  occurredAt: string; receivedAt: string;
}>;
export type RunEventPayload = Readonly<{
  version: 1; status: RunStatus; origin: 'live' | 'recovery';
  stopped: boolean | null; errorCode: string | null;
}>;
export type ToolEventPayload = Readonly<{
  version: 1; status: ToolCallSnapshot['status']; origin: 'live' | 'recovery';
  toolName: string; committedCandidateId: DbId | null;
  stopped: boolean | null; errorCode: string | null;
}>;
export type InputEventPayload = Readonly<{
  version: 1; inputId: DbId; origin: 'live' | 'recovery';
  status: SessionInputSnapshot['status']; processingStatus: SessionInputSnapshot['processingStatus'];
  nativeEntryId: string | null; resultEntryId: string | null; errorCode: string | null;
}>;
export type RuntimeEvent = RuntimeEventBase & (
  | { type: 'run_created' | 'run_started' | 'run_completed' | 'run_failed' | 'run_cancelled'; payload: RunEventPayload }
  | { type: 'tool_requested' | 'tool_started' | 'tool_succeeded' | 'tool_failed' | 'tool_cancelled'; payload: ToolEventPayload }
  | { type: 'input_state_changed'; payload: InputEventPayload }
  | { type: 'run_cancel_requested'; payload: { version: 1; requestedAt: string } }
  | { type: 'run_usage_updated'; payload: { version: 1; tokens: TokenColumns; attempts: number | null;
      attemptsComplete: boolean; source: 'sdk' | 'unknown' | 'not-requested' } }
);
export type RuntimeEventCursor = Readonly<{ runId: DbId; lastPersistedSequence: number }>;
export type RuntimeEventsQuery = Readonly<{
  runId: DbId; sessionId: DbId | null; cursor: RuntimeEventCursor;
  throughSequence?: number; limit?: number; availableAfterSequence?: number; subscriptionId?: string;
}>;
export type RuntimeEventsSubscriptionRequest = Omit<RuntimeEventsQuery,
  'throughSequence' | 'limit' | 'availableAfterSequence' | 'subscriptionId'>;
export type RuntimeEventRange = Readonly<{ fromSequence: number; toSequence: number }>;
export type RuntimeEventReadContext = Readonly<{
  runId: DbId; sessionId: DbId | null; highWatermark: number;
  availableRange: RuntimeEventRange | null; coverage: 'from-created' | 'partial' | 'none';
}>;
export type RuntimeEventsPage = RuntimeEventReadContext & Readonly<{
  items: readonly RuntimeEvent[]; nextCursor: RuntimeEventCursor; hasMore: boolean;
  nextAvailableAfterSequence: number | null;
}>;
export type RuntimeEventsReadResult =
  | { ok: true; data: RuntimeEventsPage }
  | { ok: false; error: AppError; context: (RuntimeEventReadContext & {
      gap?: { fromSequence: number; toSequence: number; continueAfterSequence: number };
    }) | null };
export type RuntimeEventsAvailable = Readonly<{ runId: DbId; sequence: number }>;
/** Same-process resource; only RuntimeSubscriptionInfo crosses IPC. */
export type RuntimeEventSubscription = RuntimeEventReadContext & Readonly<{ unsubscribe(): void }>;
export type RuntimeSubscriptionInfo = RuntimeEventReadContext & { subscriptionId: string };
export type RuntimeEventsWake = { type: 'runtime_events_available'; subscriptionId: string; runId: DbId; sequence: number };
export type RuntimeToolView = Pick<ToolCallSnapshot,
  'toolCallId' | 'runId' | 'sessionId' | 'toolName' | 'status' | 'requestedAt' | 'startedAt' | 'endedAt' | 'stoppedAt'> & {
  committedCandidateId: DbId | null; errorCode: string | null; stopped: boolean | null;
  deliveryState: ToolCallSnapshot['delivery']['state']; formApplicationOutcome: 'applied' | 'not_applied' | 'unknown' | null;
};
export type RunToolCallsRequest = { runId: DbId; sessionId: DbId | null; beforeId?: DbId; limit?: number };
export type RunToolCallRequest = { runId: DbId; sessionId: DbId; toolCallId: DbId };

const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const dbId = safeInteger.positive();
const nonnegative = safeInteger.nonnegative();
const nonempty = z.string().min(1);
export const RuntimeSubscriptionIdSchema = nonempty.max(256);
const subscriptionId = RuntimeSubscriptionIdSchema;
const utc = z.string().datetime().refine(value => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  // Date.parse normalizes impossible calendar dates; compare the fact fields.
  return new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}, 'Expected a valid UTC fact time.');
const origin = z.enum(['live', 'recovery']);
const errorCode = nonempty.nullable();
const encoder = new TextEncoder();
function withinBytes(value: unknown, maximum: number): boolean {
  return encoder.encode(JSON.stringify(value)).byteLength <= maximum;
}
function issue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message });
}

const runPayloadShape = { version: z.literal(1), status: z.enum(['created', 'running', 'completed', 'failed', 'cancelled']),
  origin, stopped: z.boolean().nullable(), errorCode };
const toolPayloadShape = { version: z.literal(1), status: z.enum(['requested', 'running', 'succeeded', 'failed', 'cancelled']),
  origin, toolName: nonempty, committedCandidateId: dbId.nullable(), stopped: z.boolean().nullable(), errorCode };
export const RunEventPayloadSchema: z.ZodType<RunEventPayload> = z.object(runPayloadShape).strict()
  .refine(value => withinBytes(value, 4096), 'Runtime payload exceeds 4096 UTF-8 bytes.');
export const ToolEventPayloadSchema: z.ZodType<ToolEventPayload> = z.object(toolPayloadShape).strict()
  .refine(value => withinBytes(value, 4096), 'Runtime payload exceeds 4096 UTF-8 bytes.');
export const InputEventPayloadSchema: z.ZodType<InputEventPayload> = z.object({
  version: z.literal(1), inputId: dbId, origin,
  status: z.enum(['queued', 'consumed', 'failed', 'cancelled', 'delivery_unknown']),
  processingStatus: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  nativeEntryId: nonempty.nullable(), resultEntryId: nonempty.nullable(), errorCode,
}).strict().superRefine((value, context) => {
  if ((value.status === 'consumed') !== (value.nativeEntryId !== null)
    || value.resultEntryId !== null && value.status !== 'consumed'
    || value.processingStatus === 'completed' && (value.status !== 'consumed' || value.resultEntryId === null)) {
    issue(context, 'Input event lacks its required native entry evidence.');
  }
  if (!withinBytes(value, 4096)) issue(context, 'Runtime payload exceeds 4096 UTF-8 bytes.');
});
const eventBaseShape = {
  eventId: dbId, runId: dbId, sequence: dbId, sessionId: dbId.nullable(), toolCallId: dbId.nullable(),
  sourceConnection: nonempty.nullable(), sourceSequence: dbId.nullable(), occurredAt: utc, receivedAt: utc,
};
export const RuntimeEventBaseSchema: z.ZodType<RuntimeEventBase> = z.object(eventBaseShape).strict()
  .refine(value => value.sourceSequence === null || value.sourceConnection !== null, 'Source sequence needs its connection.');
function runEvent<T extends string, S extends RunStatus>(type: T, status: S) {
  return z.object({ ...eventBaseShape, toolCallId: z.null(), type: z.literal(type),
    payload: z.object({ ...runPayloadShape, status: z.literal(status) }).strict() }).strict();
}
function toolEvent<T extends string, S extends ToolCallSnapshot['status']>(type: T, status: S) {
  return z.object({ ...eventBaseShape, sessionId: dbId, toolCallId: dbId, type: z.literal(type),
    payload: z.object({ ...toolPayloadShape, status: z.literal(status) }).strict() }).strict();
}
export const RuntimeEventSchema: z.ZodType<RuntimeEvent> = z.discriminatedUnion('type', [
  runEvent('run_created', 'created'), runEvent('run_started', 'running'), runEvent('run_completed', 'completed'),
  runEvent('run_failed', 'failed'), runEvent('run_cancelled', 'cancelled'),
  toolEvent('tool_requested', 'requested'), toolEvent('tool_started', 'running'), toolEvent('tool_succeeded', 'succeeded'),
  toolEvent('tool_failed', 'failed'), toolEvent('tool_cancelled', 'cancelled'),
  z.object({ ...eventBaseShape, sessionId: dbId, toolCallId: z.null(), type: z.literal('input_state_changed'), payload: InputEventPayloadSchema }).strict(),
  z.object({ ...eventBaseShape, toolCallId: z.null(), type: z.literal('run_cancel_requested'),
    payload: z.object({ version: z.literal(1), requestedAt: utc }).strict() }).strict(),
  z.object({ ...eventBaseShape, toolCallId: z.null(), type: z.literal('run_usage_updated'), payload: z.object({ version: z.literal(1),
    tokens: z.object({ inputTokens: nonnegative.nullable(), outputTokens: nonnegative.nullable(), totalTokens: nonnegative.nullable(),
      cost: z.string().nullable(), usageComplete: z.boolean() }).strict(), attempts: nonnegative.nullable(),
    attemptsComplete: z.boolean(), source: z.enum(['sdk', 'unknown', 'not-requested']) }).strict() }).strict(),
]).superRefine((value, context) => {
  if (value.sourceSequence !== null && value.sourceConnection === null) issue(context, 'Source sequence needs its connection.');
  if (!withinBytes(value.payload, 4096)) issue(context, 'Runtime payload exceeds 4096 UTF-8 bytes.');
  if (!withinBytes(value, 8192)) issue(context, 'Runtime event exceeds 8192 UTF-8 bytes.');
});

// Identifiable negative/foreign cursors reach the query semantic layer.
export const RuntimeEventCursorSchema: z.ZodType<RuntimeEventCursor> = z.object({ runId: dbId, lastPersistedSequence: safeInteger }).strict();
const subscriptionRequestShape = { runId: dbId, sessionId: dbId.nullable(), cursor: RuntimeEventCursorSchema };
export const RuntimeEventsQuerySchema = z.object({ ...subscriptionRequestShape,
  throughSequence: safeInteger.optional(), limit: safeInteger.min(1).max(100).default(50),
  availableAfterSequence: safeInteger.optional(), subscriptionId: subscriptionId.optional() }).strict();
export const RuntimeEventsSubscriptionRequestSchema: z.ZodType<RuntimeEventsSubscriptionRequest> = z.object(subscriptionRequestShape).strict();
export const RuntimeEventRangeSchema: z.ZodType<RuntimeEventRange> = z.object({ fromSequence: dbId, toSequence: dbId }).strict()
  .refine(value => value.fromSequence <= value.toSequence, 'Invalid Runtime event range.');
const readContextShape = { runId: dbId, sessionId: dbId.nullable(), highWatermark: nonnegative,
  availableRange: RuntimeEventRangeSchema.nullable(), coverage: z.enum(['from-created', 'partial', 'none']) };
function checkReadContext(value: RuntimeEventReadContext, context: z.RefinementCtx): void {
  if (value.availableRange === null) {
    if (value.highWatermark !== 0 || value.coverage !== 'none') issue(context, 'Empty event range must have no coverage and watermark zero.');
  } else if (value.coverage === 'none' || value.availableRange.toSequence !== value.highWatermark) {
    issue(context, 'Event range and coverage disagree with the high watermark.');
  }
}
export const RuntimeEventReadContextSchema: z.ZodType<RuntimeEventReadContext> = z.object(readContextShape).strict().superRefine(checkReadContext);
export const RuntimeEventsPageSchema: z.ZodType<RuntimeEventsPage> = z.object({ ...readContextShape,
  items: z.array(RuntimeEventSchema).max(100), nextCursor: RuntimeEventCursorSchema,
  hasMore: z.boolean(), nextAvailableAfterSequence: nonnegative.nullable() }).strict().superRefine((value, context) => {
  checkReadContext(value, context);
  if (value.nextCursor.runId !== value.runId || value.nextCursor.lastPersistedSequence < 0
    || value.nextCursor.lastPersistedSequence > value.highWatermark) issue(context, 'Page cursor does not match its Run range.');
  const eventIds = new Set<DbId>();
  for (let i = 0; i < value.items.length; i++) {
    const event = value.items[i];
    if (event.runId !== value.runId || event.sessionId !== value.sessionId || value.availableRange === null
      || event.sequence < value.availableRange.fromSequence || event.sequence > value.highWatermark
      || eventIds.has(event.eventId) || i > 0 && event.sequence !== value.items[i - 1].sequence + 1) issue(context, 'Page event identity or continuity is invalid.');
    eventIds.add(event.eventId);
    if (event.type === 'run_created' && value.coverage !== 'from-created') issue(context, 'Page coverage contradicts its created event.');
  }
  const last = value.items.at(-1)?.sequence;
  if (value.hasMore && (last === undefined || last === value.highWatermark)) issue(context, 'Page cannot have more bounded events.');
  if (value.nextAvailableAfterSequence === null) {
    if (last !== undefined && value.nextCursor.lastPersistedSequence !== last) issue(context, 'Continuous page cursor must end at its last event.');
  } else if (value.nextAvailableAfterSequence < value.nextCursor.lastPersistedSequence
    || value.nextAvailableAfterSequence > value.highWatermark
    || last !== undefined && value.nextAvailableAfterSequence !== last
    || value.items.length > 0 && value.items[0].sequence <= value.nextCursor.lastPersistedSequence) {
    issue(context, 'Segment page display position is invalid.');
  }
  // Original C/D/through preservation is checked with the original request, not added to this DTO.
  if (!withinBytes(value, 262144)) issue(context, 'Runtime page exceeds 256 KiB.');
});

const p6ErrorFacts: Readonly<Record<string, readonly [AppError['category'], boolean]>> = {
  event_cursor_invalid: ['input', false], event_gap: ['storage', false], event_subscription_limit: ['runtime', false],
  event_subscription_invalid: ['input', false], event_query_busy: ['runtime', true], storage_read_failed: ['storage', true],
  storage_corrupt: ['storage', false], state_conflict: ['runtime', false],
  ...CONTEXT_ERROR_FACTS,
};
export const RuntimeEventErrorSchema = AppErrorSchema.superRefine((error, context) => {
  const facts = Object.hasOwn(p6ErrorFacts, error.code) ? p6ErrorFacts[error.code] : undefined;
  if (facts && (error.category !== facts[0] || error.retryable !== facts[1])) issue(context, 'Runtime event error facts disagree with its code.');
});
export const RuntimeEventGapSchema = z.object({ fromSequence: dbId, toSequence: dbId, continueAfterSequence: nonnegative }).strict()
  .refine(value => value.fromSequence <= value.toSequence && value.continueAfterSequence === value.toSequence, 'Invalid event gap interval.');
export const RuntimeEventFailureContextSchema = z.object({ ...readContextShape, gap: RuntimeEventGapSchema.optional() }).strict()
  .superRefine((value, context) => {
    checkReadContext(value, context);
    if (value.gap && (value.availableRange === null || value.gap.toSequence >= value.highWatermark)) issue(context, 'Gap must precede an available event.');
  });
export const RuntimeEventsReadResultSchema: z.ZodType<RuntimeEventsReadResult> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: RuntimeEventsPageSchema }).strict(),
  z.object({ ok: z.literal(false), error: RuntimeEventErrorSchema, context: RuntimeEventFailureContextSchema.nullable() }).strict(),
]).superRefine((value, context) => {
  if (!value.ok) {
    if ((value.error.code === 'event_gap') !== (value.context?.gap !== undefined)) issue(context, 'Event gap needs its independent failure context.');
    if (value.context !== null && (value.error.runId !== undefined && value.error.runId !== value.context.runId
      || value.error.sessionId !== undefined && value.error.sessionId !== value.context.sessionId)) issue(context, 'Error identity disagrees with its read context.');
  }
  if (!withinBytes(value, 262144)) issue(context, 'Runtime response exceeds 256 KiB.');
});
export const RuntimeEventsAvailableSchema: z.ZodType<RuntimeEventsAvailable> = z.object({ runId: dbId, sequence: dbId }).strict();
export const RuntimeSubscriptionInfoSchema: z.ZodType<RuntimeSubscriptionInfo> = z.object({ ...readContextShape, subscriptionId }).strict().superRefine(checkReadContext);
export const RuntimeEventsWakeSchema: z.ZodType<RuntimeEventsWake> = z.object({ type: z.literal('runtime_events_available'),
  subscriptionId, runId: dbId, sequence: dbId }).strict();

export const RuntimeToolViewSchema: z.ZodType<RuntimeToolView> = z.object({ toolCallId: dbId, runId: dbId, sessionId: dbId,
  toolName: nonempty, status: z.enum(['requested', 'running', 'succeeded', 'failed', 'cancelled']),
  requestedAt: utc, startedAt: utc.nullable(), endedAt: utc.nullable(), stoppedAt: utc.nullable(),
  committedCandidateId: dbId.nullable(), errorCode, stopped: z.boolean().nullable(),
  deliveryState: z.enum(['not_attempted', 'message_observed', 'request_observed', 'failed', 'unknown']),
  formApplicationOutcome: z.enum(['applied', 'not_applied', 'unknown']).nullable() }).strict();
export const RunToolCallsRequestSchema = z.object({ runId: dbId, sessionId: dbId.nullable(), beforeId: dbId.optional(),
  limit: safeInteger.min(1).max(100).default(50) }).strict();
export const RunToolCallRequestSchema: z.ZodType<RunToolCallRequest> = z.object({ runId: dbId, sessionId: dbId, toolCallId: dbId }).strict();
export const RuntimeToolPageSchema: z.ZodType<Page<RuntimeToolView>> = z.object({ items: z.array(RuntimeToolViewSchema).max(100), nextBeforeId: dbId.nullable() }).strict();
function resultSchema<S extends z.ZodTypeAny>(data: S) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: RuntimeEventErrorSchema, runId: dbId.optional() }).strict()])
    .refine(value => withinBytes(value, 262144), 'Runtime response exceeds 256 KiB.');
}
export const RuntimeSubscriptionResultSchema: z.ZodType<Result<RuntimeSubscriptionInfo>> = resultSchema(RuntimeSubscriptionInfoSchema);
export const RuntimeToolResultSchema: z.ZodType<Result<RuntimeToolView>> = resultSchema(RuntimeToolViewSchema);
export const RuntimeToolPageResultSchema: z.ZodType<Result<Page<RuntimeToolView>>> = resultSchema(RuntimeToolPageSchema);
// JSON omits an undefined success value; restore the ordinary Result<void> shape after strict parsing.
export const RuntimeSubscriptionReleaseResultSchema: z.ZodType<Result<void>, z.ZodTypeDef, unknown> = resultSchema(z.undefined())
  .transform(value => value.ok ? { ok: true as const, data: undefined } : value);
