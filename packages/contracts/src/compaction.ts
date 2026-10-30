import { z } from 'zod';
import { HistoryCommitStateSchema } from './memory.ts';
import { UsageRecordSchema, TokenColumnsSchema } from './runtime.ts';
import type { AppError, DbId, Result } from './runtime.ts';
import { ProviderConfigSchema } from './schemas.ts';
import { ContextErrorSchema, ContextSdkPayloadEvidenceSchema, ContextTransportEvidenceSchema } from './context.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaqueId = z.string().min(1).max(256);
const uuid = z.string().uuid();
const report = (context: z.RefinementCtx, message: string) => context.addIssue({ code: 'custom', message });

export const CompactionReasonSchema = z.enum(['manual', 'threshold', 'overflow']);
export type CompactionReason = z.infer<typeof CompactionReasonSchema>;
export const CompactionPhaseSchema = z.enum(['preparing', 'compacting', 'stopping', 'ended']);
export type CompactionPhase = z.infer<typeof CompactionPhaseSchema>;
export const CompactionPolicySchema = z.object({
  version: z.literal('p10-native-compaction-v1'), autoEnabled: z.boolean(),
  reserveTokens: id, keepRecentTokens: id,
}).strict().readonly();
export type CompactionPolicy = z.infer<typeof CompactionPolicySchema>;

export const CompactionCapacitySchema = z.object({
  tokens: nonnegative.nullable(),
  source: z.enum(['sdk-usage-estimate', 'sdk-post-compaction-estimate', 'message-estimate', 'unknown']),
  contextWindow: id.nullable(), thresholdTokens: nonnegative.nullable(), fitsEstimate: z.boolean().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.source === 'unknown') !== (value.tokens === null))
    report(context, 'Unknown capacity must not invent a token count.');
  if (value.thresholdTokens !== null && (value.contextWindow === null || value.thresholdTokens >= value.contextWindow))
    report(context, 'Capacity threshold requires a valid model window and reserved headroom.');
  const known = value.tokens !== null && value.contextWindow !== null && value.thresholdTokens !== null;
  const fits = known ? value.tokens! <= value.thresholdTokens! : null;
  if (value.fitsEstimate !== fits) report(context, 'Capacity estimate and fit must agree, preserving unknown.');
}).readonly();
export type CompactionCapacity = z.infer<typeof CompactionCapacitySchema>;

export const CompactionObservationSchema = z.object({
  sessionId: id, nativeSessionId: opaqueId, operationId: uuid, runId: id.nullable(),
  reason: CompactionReasonSchema, observationSequence: id, phase: CompactionPhaseSchema,
  generated: z.boolean(), nativeOutcome: z.enum(['pending', 'succeeded', 'failed', 'cancelled']),
  entryId: opaqueId.nullable(), saved: z.lazy(() => HistoryCommitStateSchema).nullable(),
  error: z.lazy(() => ContextErrorSchema).nullable(), stopRequested: z.boolean(), stopped: z.boolean(),
  continuation: z.enum(['current-run', 'next-run']), mayContinue: z.boolean(),
  capacity: CompactionCapacitySchema,
  usage: z.lazy(() => UsageRecordSchema), tokens: z.lazy(() => TokenColumnsSchema),
}).strict().superRefine((value, context) => {
  const manual = value.reason === 'manual';
  if (manual !== (value.runId === null) || value.continuation !== (manual ? 'next-run' : 'current-run'))
    report(context, 'Compaction must retain its actual operation and Run identity.');
  if (value.nativeOutcome === 'succeeded' && !value.generated)
    report(context, 'Native summary success requires actual generation.');
  if (value.saved !== null && (!value.generated || value.entryId === null || value.saved.leafId !== value.entryId))
    report(context, 'Committed compaction requires its actual generated entry and receipt.');
  if (value.mayContinue && (value.stopRequested || !value.stopped || value.phase !== 'ended'
    || value.capacity.fitsEstimate !== true || value.generated && value.saved === null || value.nativeOutcome === 'cancelled'))
    report(context, 'Continuation requires capacity, an ended operation, necessary saving and no stop.');
}).readonly();
export type CompactionObservation = Readonly<Omit<z.infer<typeof CompactionObservationSchema>, 'error'> & { error: AppError | null }>;

export const DesktopSessionCompactionRequestSchema = z.object({
  sessionId: id, operationId: uuid, expected: z.lazy(() => HistoryCommitStateSchema), modelId: z.string().min(1).max(128),
}).strict().readonly();
export type DesktopSessionCompactionRequest = z.infer<typeof DesktopSessionCompactionRequestSchema>;
export const SessionCompactionRequestSchema = z.object({
  sessionId: id, operationId: uuid, expected: z.lazy(() => HistoryCommitStateSchema),
  config: z.lazy(() => ProviderConfigSchema),
}).strict().readonly();
export type SessionCompactionRequest = z.infer<typeof SessionCompactionRequestSchema>;
export const SessionCompactionQuerySchema = z.object({ sessionId: id, operationId: uuid.optional(), runId: id.optional() }).strict().readonly();
export type SessionCompactionQuery = z.infer<typeof SessionCompactionQuerySchema>;
export const SessionCompactionCancelSchema = z.object({ sessionId: id, operationId: uuid }).strict().readonly();
export type SessionCompactionCancel = z.infer<typeof SessionCompactionCancelSchema>;
export const CompactionAcceptedSchema = z.object({ sessionId: id, operationId: uuid }).strict().readonly();
export type CompactionAccepted = z.infer<typeof CompactionAcceptedSchema>;
export const CompactionCancelAcceptedSchema = z.object({ sessionId: id, operationId: uuid, accepted: z.boolean() }).strict().readonly();

export const SavedCompactionViewSchema = z.object({
  entryId: opaqueId, firstKeptEntryId: opaqueId, tokensBefore: nonnegative,
  usage: z.lazy(() => UsageRecordSchema).nullable(), originSessionId: id,
}).strict().readonly();
export type SavedCompactionView = z.infer<typeof SavedCompactionViewSchema>;
export const SessionCompactionSnapshotSchema = z.object({
  sessionId: id, nativeSessionId: opaqueId, commit: z.lazy(() => HistoryCommitStateSchema),
  policy: CompactionPolicySchema, capacity: CompactionCapacitySchema,
  lastSaved: SavedCompactionViewSchema.nullable(), operation: CompactionObservationSchema.nullable(),
  operationAvailability: z.enum(['live', 'recorded', 'unknown', 'none']),
  manualAllowed: z.boolean(), blockCode: z.string().min(1).max(128).nullable(),
}).strict().superRefine((value, context) => {
  if (value.operation && (value.operation.sessionId !== value.sessionId || value.operation.nativeSessionId !== value.nativeSessionId))
    report(context, 'Compaction query must belong to the requested Session.');
  if ((value.operationAvailability === 'live' || value.operationAvailability === 'recorded') !== (value.operation !== null))
    report(context, 'Available operation requires actual observable facts.');
  if (value.manualAllowed && value.blockCode !== null) report(context, 'Blocked Session cannot offer manual admission.');
}).readonly();
export type SessionCompactionSnapshot = Readonly<Omit<z.infer<typeof SessionCompactionSnapshotSchema>, 'operation'> & { operation: CompactionObservation | null }>;

export const SummaryCallEvidenceSchema = z.object({
  modelCallIndex: id.max(64), purpose: z.enum(['history', 'turn-prefix']),
  model: z.object({ provider: opaqueId, model: opaqueId, api: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    contextWindow: id }).strict().readonly(),
  transport: z.enum(['observed-fetch', 'not-observable']),
  sdkPayload: z.lazy(() => ContextSdkPayloadEvidenceSchema).nullable(),
  attempts: z.array(z.lazy(() => ContextTransportEvidenceSchema)).max(2).readonly(),
  usage: z.lazy(() => UsageRecordSchema).nullable(), tokens: z.lazy(() => TokenColumnsSchema).nullable(),
}).strict().superRefine((value, context) => {
  if (value.transport === 'not-observable' && value.attempts.length !== 0)
    report(context, 'Unobservable summary transport cannot invent HTTP attempts.');
  if (value.attempts.some((attempt, index) => attempt.attempt !== index + 1))
    report(context, 'Summary HTTP attempt indices must be continuous.');
  if ((value.usage === null) !== (value.tokens === null))
    report(context, 'Summary usage and normalized columns are recorded together.');
}).readonly();
export type SummaryCallEvidence = z.infer<typeof SummaryCallEvidenceSchema>;

export const RunCompactionEvidenceSchema = z.object({
  operationId: uuid, runId: id, sessionId: id, nativeSessionId: opaqueId, reason: z.enum(['threshold', 'overflow']),
  baseline: z.lazy(() => HistoryCommitStateSchema), firstKeptEntryId: opaqueId.nullable(), splitTurn: z.boolean().nullable(),
  observation: CompactionObservationSchema, calls: z.array(SummaryCallEvidenceSchema).max(2).readonly(),
}).strict().superRefine((value, context) => {
  const observed = value.observation;
  if (observed.operationId !== value.operationId || observed.runId !== value.runId || observed.sessionId !== value.sessionId
    || observed.nativeSessionId !== value.nativeSessionId || observed.reason !== value.reason)
    report(context, 'Automatic evidence must belong to the actual observed Run and operation.');
  if (value.calls.length && (value.firstKeptEntryId === null || value.splitTurn === null))
    report(context, 'Summary requests require actual SDK preparation.');
  if (value.calls.some((call, index) => index > 0 && call.modelCallIndex !== value.calls[index - 1]!.modelCallIndex + 1))
    report(context, 'Split summary calls must use consecutive logical model indices.');
  const purposes = value.calls.map(call => call.purpose);
  if (value.splitTurn === false && purposes.some(purpose => purpose !== 'history')
    || purposes.length === 2 && (value.splitTurn !== true || purposes[0] !== 'history' || purposes[1] !== 'turn-prefix'))
    report(context, 'Summary purpose order must match native split preparation.');
}).readonly();
export type RunCompactionEvidence = Readonly<Omit<z.infer<typeof RunCompactionEvidenceSchema>, 'observation'> & { observation: CompactionObservation }>;

export type NativeCompactionControl = {
  sessionId: DbId; operationId: string; signal: AbortSignal; remainingMs: () => number; maxModelCalls: number;
  verifyUse: () => Result<void> | Promise<Result<void>>; observe: (value: CompactionObservation) => void;
};
export type NativeCompactionOutcome = {
  observation: CompactionObservation; stopped: boolean; cleanupErrors: readonly AppError[];
};

function resultSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: z.lazy(() => ContextErrorSchema), runId: id.optional() }).strict(),
  ]).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 131072,
    'Complete compaction result exceeds its UTF-8 budget.');
}
export const CompactionAcceptedResultSchema = resultSchema(CompactionAcceptedSchema);
export const SessionCompactionSnapshotResultSchema = resultSchema(SessionCompactionSnapshotSchema);
export const CompactionCancelAcceptedResultSchema = resultSchema(CompactionCancelAcceptedSchema);
export const CompactionNotificationSchema = z.object({
  type: z.literal('compaction_observation'), observation: CompactionObservationSchema,
}).strict().readonly();

function normalize<T extends z.ZodTypeAny>(schema: T, raw: unknown): Result<z.output<T>> {
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false,
    error: { code: 'input_invalid', category: 'input', message: 'Compaction request is invalid.', retryable: false } };
}
export const normalizeSessionCompactionRequest = (raw: unknown) => normalize(SessionCompactionRequestSchema, raw);
export const normalizeDesktopSessionCompactionRequest = (raw: unknown) => normalize(DesktopSessionCompactionRequestSchema, raw);
export const normalizeSessionCompactionQuery = (raw: unknown) => normalize(SessionCompactionQuerySchema, raw);
export const normalizeSessionCompactionCancel = (raw: unknown) => normalize(SessionCompactionCancelSchema, raw);
