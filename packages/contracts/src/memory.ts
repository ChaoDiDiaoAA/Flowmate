import { z } from 'zod';
import { ResourceExpansionEvidenceSchema, ResourceReadEvidenceSchema } from './resources.ts';
import { SessionSnapshotSchema } from './runtime.ts';
import type { DbId, NativeHistoryAppendContext, NativeSessionHistory, Result } from './runtime.ts';
import { ContextErrorSchema, NativeInputContextBindingSchema } from './context.ts';
import { normalizeSessionTitle } from './session-title.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const HistorySafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const NativeEntryIdSchema = z.string().min(1).max(256);
const time = z.string().datetime({ offset: true });
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: 'custom', message });

export const NativeEntryTypeSchema = z.enum(['message', 'model_change', 'thinking_level_change', 'compaction',
  'branch_summary', 'custom', 'custom_message', 'label', 'session_info']);
export type NativeEntryType = z.infer<typeof NativeEntryTypeSchema>;
export const HistorySelectionReasonSchema = z.enum(['empty-context', 'incomplete-tool-pair', 'history-invalid',
  'source-unavailable', 'context-unsupported', 'session-unavailable', 'busy']);
export type HistorySelectionReason = z.infer<typeof HistorySelectionReasonSchema>;

function hasUnsafeSerializationHook(value: object): boolean {
  for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'toJSON');
    if (descriptor) return !('value' in descriptor) || typeof descriptor.value === 'function';
  }
  return false;
}

/** Inspect descriptors before parsing so a malformed snapshot cannot execute a getter. */
function isNativeJson(value: unknown, ancestors = new Set<object>(), allowUndefined = true): boolean {
  if (value === undefined) return allowUndefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) return false;
    if (hasUnsafeSerializationHook(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) return false;
    ancestors.add(value);
    if (array) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor || !('value' in descriptor) || !isNativeJson(descriptor.value, ancestors, false)) return false;
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor)) return false;
      if (array && key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
      if (!array && (!descriptor.enumerable && descriptor.value !== undefined || !isNativeJson(descriptor.value, ancestors))) return false;
    }
    ancestors.delete(value);
    return true;
  } catch { return false; }
}
const nativeJson = z.custom<unknown>(value => isNativeJson(value), 'Native history must contain safe JSON values.');
function preserveNative<T extends z.ZodTypeAny>(shape: T) {
  return nativeJson.pipe(z.unknown().superRefine((value, context) => {
    const parsed = shape.safeParse(value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    if (!parsed.success) for (const error of parsed.error.issues) context.addIssue(error);
  }).transform(value => value as z.output<T>));
}
const nativeText = z.object({ type: z.literal('text'), text: z.string(), textSignature: z.string().optional() }).passthrough();
const nativeImage = z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).passthrough();
const nativeThinking = z.object({ type: z.literal('thinking'), thinking: z.string(), thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional() }).passthrough();
const nativeToolCall = z.object({ type: z.literal('toolCall'), id: NativeEntryIdSchema, name: z.string().min(1),
  arguments: z.record(z.unknown()), thoughtSignature: z.string().optional(), namespace: z.string().optional() }).passthrough();
const nativeUsage = z.object({ input: z.number().finite(), output: z.number().finite(), cacheRead: z.number().finite(),
  cacheWrite: z.number().finite(), cacheWrite1h: z.number().finite().optional(), reasoning: z.number().finite().optional(),
  totalTokens: z.number().finite(), cost: z.object({ input: z.number().finite(), output: z.number().finite(),
    cacheRead: z.number().finite(), cacheWrite: z.number().finite(), total: z.number().finite() }).passthrough() }).passthrough();
const nativeContent = z.union([z.string(), z.array(z.discriminatedUnion('type', [nativeText, nativeImage]))]);
const stopReason = z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);
const nativeMessages = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: nativeContent, timestamp: z.number().finite() }).passthrough(),
  z.object({ role: z.literal('assistant'), content: z.array(z.discriminatedUnion('type', [nativeText, nativeThinking, nativeToolCall])),
    api: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), usage: nativeUsage,
    stopReason, timestamp: z.number().finite(), responseModel: z.string().optional(), responseId: z.string().optional(),
    providerThinkingLevel: z.string().optional(), diagnostics: z.array(z.unknown()).optional(),
    deferred: z.object({ provider: z.string(), modelId: z.string(), api: z.string(), id: z.string(),
      expiresAt: z.number().finite().optional(), pollAfterMs: z.number().finite().optional(), data: z.unknown().optional() }).passthrough().optional(),
    errorMessage: z.string().optional(), rawStopReason: z.string().optional(), endTurn: z.boolean().optional() }).passthrough(),
  z.object({ role: z.literal('toolResult'), toolCallId: NativeEntryIdSchema, toolName: z.string().min(1),
    content: z.array(z.discriminatedUnion('type', [nativeText, nativeImage])), details: z.unknown().optional(),
    usage: nativeUsage.optional(), addedToolNames: z.array(z.string()).optional(), isError: z.boolean(), timestamp: z.number().finite() }).passthrough(),
  z.object({ role: z.literal('bashExecution'), command: z.string(), output: z.string(), exitCode: z.number().finite().optional(),
    cancelled: z.boolean(), truncated: z.boolean(), fullOutputPath: z.string().optional(), excludeFromContext: z.boolean().optional(),
    timestamp: z.number().finite() }).passthrough(),
  z.object({ role: z.literal('custom'), customType: z.string(), content: nativeContent, display: z.boolean(),
    details: z.unknown().optional(), timestamp: z.number().finite() }).passthrough(),
  z.object({ role: z.literal('branchSummary'), summary: z.string(), fromId: NativeEntryIdSchema.nullable(), timestamp: z.number().finite() }).passthrough(),
  z.object({ role: z.literal('compactionSummary'), summary: z.string(), tokensBefore: z.number().finite(), timestamp: z.number().finite() }).passthrough(),
]);
export const NativeAgentMessageSchema = preserveNative(nativeMessages);
export type NativeAgentMessage = z.infer<typeof NativeAgentMessageSchema>;
const entryBase = { id: NativeEntryIdSchema, parentId: NativeEntryIdSchema.nullable(), timestamp: time };
const nativeEntries = z.discriminatedUnion('type', [
  z.object({ ...entryBase, type: z.literal('message'), message: nativeMessages }).passthrough(),
  z.object({ ...entryBase, type: z.literal('model_change'), provider: z.string(), modelId: z.string() }).passthrough(),
  z.object({ ...entryBase, type: z.literal('thinking_level_change'), thinkingLevel: z.string() }).passthrough(),
  z.object({ ...entryBase, type: z.literal('compaction'), summary: z.string(), firstKeptEntryId: NativeEntryIdSchema,
    tokensBefore: z.number().finite(), details: z.unknown().optional(), usage: nativeUsage.optional(), fromHook: z.boolean().optional() }).passthrough(),
  z.object({ ...entryBase, type: z.literal('branch_summary'), fromId: NativeEntryIdSchema, summary: z.string(),
    details: z.unknown().optional(), usage: nativeUsage.optional(), fromHook: z.boolean().optional() }).passthrough(),
  z.object({ ...entryBase, type: z.literal('custom'), customType: z.string(), data: z.unknown().optional() }).passthrough(),
  z.object({ ...entryBase, type: z.literal('custom_message'), customType: z.string(), content: nativeContent,
    display: z.boolean(), details: z.unknown().optional() }).passthrough(),
  z.object({ ...entryBase, type: z.literal('label'), targetId: NativeEntryIdSchema, label: z.string().optional() }).passthrough(),
  z.object({ ...entryBase, type: z.literal('session_info'), name: z.string().optional() }).passthrough(),
]);
export const NativeSessionEntrySchema = preserveNative(nativeEntries);
export type NativeSessionEntry = z.infer<typeof NativeSessionEntrySchema>;
export const NativeSessionHeaderSchema = preserveNative(z.object({ type: z.literal('session'), id: NativeEntryIdSchema,
  timestamp: time, cwd: z.string(), version: HistorySafeIntegerSchema.optional(), parentSession: z.string().optional() }).passthrough());
export const NativeSessionHistorySchema = nativeJson.pipe(z.object({ storageVersion: z.literal(1),
  header: NativeSessionHeaderSchema, entries: z.array(NativeSessionEntrySchema).readonly(), leafId: NativeEntryIdSchema.nullable(),
  unusable: z.boolean() }).strict()).superRefine((history, context) => {
  const all = new Set(history.entries.map(entry => entry.id));
  const seen = new Set<string>();
  for (const entry of history.entries) {
    if (seen.has(entry.id) || entry.parentId !== null && !seen.has(entry.parentId)) issue(context, 'Entry IDs and parent order must be valid.');
    seen.add(entry.id);
    let reference: string | null = null;
    if (entry.type === 'label') reference = entry.targetId;
    if (entry.type === 'compaction') reference = entry.firstKeptEntryId;
    if (entry.type === 'branch_summary') reference = entry.fromId === 'root' ? null : entry.fromId;
    if (entry.type === 'message' && entry.message.role === 'branchSummary')
      reference = entry.message.fromId === 'root' ? null : entry.message.fromId;
    if (reference !== null && !all.has(reference)) issue(context, 'Native entry reference is missing.');
  }
  if (history.leafId !== null && !all.has(history.leafId)) issue(context, 'Native leaf must identify a saved entry.');
});

export const HistoryCommitStateSchema = z.object({ commitRevision: HistorySafeIntegerSchema,
  entryCount: HistorySafeIntegerSchema, leafId: NativeEntryIdSchema.nullable() }).strict().readonly();
export type HistoryCommitState = z.infer<typeof HistoryCommitStateSchema>;
export const HistoryCommitReceiptSchema = HistoryCommitStateSchema;
export type HistoryCommitReceipt = HistoryCommitState;
const appendContext = z.object({ entryId: NativeEntryIdSchema, runId: id, inputId: id.optional(), resultInputIds: z.array(id).optional(),
  resourceExpansion: ResourceExpansionEvidenceSchema.optional() }).strict().refine(value => value.resourceExpansion === undefined
    || value.resourceExpansion.inputId === value.inputId && value.resourceExpansion.nativeEntryId === value.entryId,
  'Expansion receipt must identify the same committed user Input.');
export const StoredNativeHistorySchema = z.object({ history: NativeSessionHistorySchema, commit: HistoryCommitStateSchema }).strict()
  .refine(value => value.history.entries.length === value.commit.entryCount && value.history.leafId === value.commit.leafId,
    'Committed count and leaf must agree with native history.');
export type StoredNativeHistory = { history: NativeSessionHistory; commit: HistoryCommitState };
export const HistoryCommitInputSchema = z.object({ sessionId: id, expected: HistoryCommitStateSchema.nullable(),
  header: NativeSessionHeaderSchema, appendEntries: z.array(NativeSessionEntrySchema).readonly(), leafId: NativeEntryIdSchema.nullable(),
  unusable: z.boolean(), contexts: z.array(appendContext).readonly() }).strict();
export type HistoryCommitInput = { sessionId: DbId; expected: HistoryCommitState | null; header: NativeSessionHistory['header'];
  appendEntries: NativeSessionHistory['entries']; leafId: string | null; unusable: boolean; contexts: readonly NativeHistoryAppendContext[] };
export const NativeHistoryWriteSchema = z.object({ expected: HistoryCommitStateSchema, history: NativeSessionHistorySchema,
  contexts: z.array(appendContext).readonly() }).strict();
export type NativeHistoryWrite = { expected: HistoryCommitState; history: NativeSessionHistory; contexts: readonly NativeHistoryAppendContext[] };
export const NativeHistoryOriginSeedSchema = z.object({ nativeEntryId: NativeEntryIdSchema, originSessionId: id,
  originRunId: id.nullable() }).strict().readonly();
export type NativeHistoryOriginSeed = z.infer<typeof NativeHistoryOriginSeedSchema>;
export const NativeHistoryRecoverySeedSchema = z.object({ sessionId: id, inputs: z.array(z.lazy(() => NativeInputContextBindingSchema)).readonly(),
  origins: z.array(NativeHistoryOriginSeedSchema).readonly(),
  resourceExpansions: z.array(ResourceExpansionEvidenceSchema).readonly().optional(),
  resourceReads: z.array(ResourceReadEvidenceSchema).readonly().optional() }).strict().superRefine((seed, context) => {
  if (new Set(seed.origins.map(origin => origin.nativeEntryId)).size !== seed.origins.length
    || new Set(seed.inputs.map(input => input.nativeEntryId)).size !== seed.inputs.length) issue(context, 'Recovery identities must be unique.');
  const receipts = seed.resourceExpansions ?? [];
  if (new Set(receipts.map(item => item.inputId)).size !== receipts.length
    || new Set(receipts.map(item => item.nativeEntryId)).size !== receipts.length
    || receipts.some(receipt => !seed.inputs.some(input => input.inputId === receipt.inputId && input.nativeEntryId === receipt.nativeEntryId)))
    issue(context, 'Expansion recovery requires the original unique Input binding.');
  const reads = seed.resourceReads ?? [];
  if (new Set(reads.map(read => JSON.stringify([read.toolCallId, read.operation, read.path]))).size !== reads.length
    || reads.some(read => read.nativeEntryId === null || !seed.origins.some(origin => origin.nativeEntryId === read.nativeEntryId)))
    issue(context, 'Read recovery requires the original unique tool-result Entry.');
}).readonly();
export type NativeHistoryRecoverySeed = z.infer<typeof NativeHistoryRecoverySeedSchema>;
export const NativeHistoryRecoveryBundleSchema = z.object({ history: NativeSessionHistorySchema.nullable(),
  commit: HistoryCommitStateSchema.nullable(), seed: NativeHistoryRecoverySeedSchema }).strict().superRefine((bundle, context) => {
  const { history, commit, seed } = bundle;
  if (history === null || commit === null) {
    if (history !== null || commit !== null || seed.origins.length !== 0 || seed.inputs.length !== 0 || (seed.resourceExpansions?.length ?? 0) !== 0 || (seed.resourceReads?.length ?? 0) !== 0)
      issue(context, 'Legacy history requires an empty recovery seed and absent commit.');
    return;
  }
  if (history.entries.length !== commit.entryCount || history.leafId !== commit.leafId) issue(context, 'Recovery commit disagrees with native history.');
  const entries = new Map(history.entries.map(entry => [entry.id, entry]));
  const origins = new Map(seed.origins.map(origin => [origin.nativeEntryId, origin]));
  if (origins.size !== entries.size || seed.origins.some(origin => !entries.has(origin.nativeEntryId))) issue(context, 'Origins must cover every committed entry.');
  for (const input of seed.inputs) {
    const entry = entries.get(input.nativeEntryId);
    if (entry?.type !== 'message' || entry.message.role !== 'user' || origins.get(input.nativeEntryId)?.originRunId !== input.originRunId)
      issue(context, 'Input seed requires its actual user entry and origin Run.');
  }
  for (const read of seed.resourceReads ?? []) {
    const entry = entries.get(read.nativeEntryId!);
    if (entry?.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.toolCallId !== read.nativeToolCallId)
      issue(context, 'Read recovery requires its actual native ToolResult.');
  }
}).readonly();
export type NativeHistoryRecoveryBundle = { history: NativeSessionHistory | null; commit: HistoryCommitState | null; seed: NativeHistoryRecoverySeed };

export const NativeHistoryPageRequestSchema = z.object({ sessionId: id, expectedCommitRevision: HistorySafeIntegerSchema.optional(),
  afterSequence: HistorySafeIntegerSchema.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict()
  .refine(value => value.afterSequence === undefined || value.expectedCommitRevision !== undefined, 'Subsequent pages require the saved revision.');
export type NativeHistoryPageRequest = z.input<typeof NativeHistoryPageRequestSchema>;
export const SessionHistoryEntryRequestSchema = z.object({ sessionId: id, entryId: NativeEntryIdSchema,
  expectedCommitRevision: HistorySafeIntegerSchema, partIndex: HistorySafeIntegerSchema.default(0), offset: HistorySafeIntegerSchema.default(0) }).strict();
export type SessionHistoryEntryRequest = z.input<typeof SessionHistoryEntryRequestSchema>;
const preview = z.string().refine(value => bytes(value) <= 1024, 'Preview exceeds 1024 UTF-8 bytes.');
export const HistoryTextPreviewSchema = z.object({ text: preview, truncated: z.boolean() }).strict().readonly();
export type HistoryTextPreview = z.infer<typeof HistoryTextPreviewSchema>;
export const HistoryEntrySummarySchema = z.object({ sequence: HistorySafeIntegerSchema, entryId: NativeEntryIdSchema,
  parentId: NativeEntryIdSchema.nullable(), type: NativeEntryTypeSchema, timestamp: time, isCurrentPath: z.boolean(),
  isLeaf: z.boolean(), preview, truncated: z.boolean(), originSessionId: id, originRunId: id.nullable(),
  canSelect: z.boolean(), cannotSelectReason: HistorySelectionReasonSchema.nullable() }).strict().superRefine((value, context) => {
  if (value.canSelect !== (value.cannotSelectReason === null)) issue(context, 'Selection requires a consistent reason.');
  if (value.isLeaf && !value.isCurrentPath) issue(context, 'Current leaf must be on its current path.');
}).readonly();
export type HistoryEntrySummary = z.infer<typeof HistoryEntrySummarySchema>;
const images = { hasImages: z.boolean(), imageMimeTypes: z.array(z.string().min(1).max(256)).readonly() };
export const HistoryEntryDisplayFieldsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), role: z.enum(['user', 'assistant', 'toolResult', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary']),
    toolName: HistoryTextPreviewSchema.nullable(), callId: NativeEntryIdSchema.nullable(), stopReason: stopReason.nullable(),
    isError: z.boolean().nullable(), ...images }).strict(),
  z.object({ type: z.literal('model_change'), provider: HistoryTextPreviewSchema, modelId: HistoryTextPreviewSchema }).strict(),
  z.object({ type: z.literal('thinking_level_change'), thinkingLevel: HistoryTextPreviewSchema }).strict(),
  z.object({ type: z.literal('compaction'), firstKeptEntryId: NativeEntryIdSchema, tokensBefore: z.number().finite() }).strict(),
  z.object({ type: z.literal('branch_summary'), fromId: NativeEntryIdSchema }).strict(),
  z.object({ type: z.literal('custom'), customType: HistoryTextPreviewSchema, hasOpaqueData: z.boolean() }).strict(),
  z.object({ type: z.literal('custom_message'), customType: HistoryTextPreviewSchema, display: z.boolean(), hasOpaqueData: z.boolean(), ...images }).strict(),
  z.object({ type: z.literal('label'), targetId: NativeEntryIdSchema, label: HistoryTextPreviewSchema.nullable() }).strict(),
  z.object({ type: z.literal('session_info'), name: HistoryTextPreviewSchema.nullable() }).strict(),
]).superRefine((fields, context) => {
  if ('hasImages' in fields && fields.hasImages !== (fields.imageMimeTypes.length > 0)) issue(context, 'Image MIME facts disagree.');
  if (fields.type === 'message') {
    const toolResult = fields.role === 'toolResult';
    if (toolResult ? fields.toolName === null || fields.callId === null || fields.isError === null
      : fields.toolName !== null || fields.callId !== null || fields.isError !== null) issue(context, 'Message tool facts disagree with its role.');
    if ((fields.role === 'assistant') !== (fields.stopReason !== null)) issue(context, 'Message stop reason disagrees with its role.');
    if (fields.hasImages && !['user', 'toolResult', 'custom'].includes(fields.role)) issue(context, 'Message role cannot contain native images.');
  }
}).readonly();
export type HistoryEntryDisplayFields = z.infer<typeof HistoryEntryDisplayFieldsSchema>;
export const NativeHistoryPageSchema = z.object({ session: SessionSnapshotSchema, commit: HistoryCommitStateSchema,
  items: z.array(HistoryEntrySummarySchema).max(100).readonly(), nextAfterSequence: HistorySafeIntegerSchema.nullable() }).strict()
  .superRefine((page, context) => {
    if (new Set(page.items.map(item => item.entryId)).size !== page.items.length) issue(context, 'History page entry identities must be unique.');
    if (page.items.some((item, index) => item.sequence >= page.commit.entryCount
      || index > 0 && item.sequence <= page.items[index - 1]!.sequence
      || item.isLeaf !== (item.entryId === page.commit.leafId))) issue(context, 'History page order or committed identity disagrees.');
    if (page.nextAfterSequence !== null && page.nextAfterSequence !== page.items.at(-1)?.sequence) issue(context, 'History cursor must be its last row.');
  }).readonly();
export type NativeHistoryPage = z.infer<typeof NativeHistoryPageSchema>;
const partCursor = z.object({ partIndex: HistorySafeIntegerSchema, offset: HistorySafeIntegerSchema }).strict();
export const SessionHistoryEntryDetailSchema = z.object({ summary: HistoryEntrySummarySchema, commit: HistoryCommitStateSchema,
  fields: HistoryEntryDisplayFieldsSchema, part: z.object({ kind: z.enum(['text', 'thinking', 'summary', 'command', 'output']),
    text: z.string().min(1).refine(value => bytes(value) <= 65536, 'Part exceeds 64 KiB.') }).strict().nullable(),
  partIndex: HistorySafeIntegerSchema, offset: HistorySafeIntegerSchema, next: partCursor.nullable() }).strict()
  .superRefine((detail, context) => {
    if (detail.fields.type !== detail.summary.type || detail.summary.sequence >= detail.commit.entryCount
      || detail.summary.isLeaf !== (detail.summary.entryId === detail.commit.leafId)) issue(context, 'Detail must identify its committed entry.');
    if (detail.part === null && (detail.partIndex !== 0 || detail.offset !== 0 || detail.next !== null)) issue(context, 'Absent text has no part cursor.');
    if (detail.next !== null && (detail.next.partIndex < detail.partIndex || detail.next.partIndex === detail.partIndex && detail.next.offset <= detail.offset))
      issue(context, 'Detail continuation must advance.');
  }).readonly();
export type SessionHistoryEntryDetail = z.infer<typeof SessionHistoryEntryDetailSchema>;
const normalizedTitle = z.string().transform((title, context) => {
  const result = normalizeSessionTitle(title);
  if (result === null) { issue(context, 'Session title is invalid.'); return z.NEVER; }
  return result;
});
export const ForkSessionRequestSchema = z.object({ sourceSessionId: id, expected: HistoryCommitStateSchema,
  targetEntryId: NativeEntryIdSchema, title: normalizedTitle, clientOperationId: z.string().uuid().transform(value => value.toLowerCase()) }).strict();
export type ForkSessionRequest = z.infer<typeof ForkSessionRequestSchema>;
// selectedEntryId records creation intent; idempotent lookup reports the target's current commit.
export const ForkSessionResultSchema = z.object({ session: SessionSnapshotSchema, commit: HistoryCommitStateSchema,
  sourceSessionId: id, selectedEntryId: NativeEntryIdSchema }).strict().refine(value => value.session.sessionId !== value.sourceSessionId
    && value.commit.entryCount > 0, 'Fork must identify an independent committed Session.').readonly();
export type ForkSessionResult = z.infer<typeof ForkSessionResultSchema>;
export const NativeHistoryInspectionSchema = z.object({ positions: z.array(z.object({ entryId: NativeEntryIdSchema,
  isCurrentPath: z.boolean(), contextState: z.enum(['empty', 'complete', 'incomplete-tool-pair', 'unsupported']) }).strict()).readonly() }).strict()
  .refine(value => new Set(value.positions.map(position => position.entryId)).size === value.positions.length, 'Inspected positions must be unique.').readonly();
export type NativeHistoryInspection = z.infer<typeof NativeHistoryInspectionSchema>;
function normalize<T extends z.ZodTypeAny>(schema: T, raw: unknown): Result<z.output<T>> {
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false,
    error: { code: 'input_invalid', category: 'input', message: 'Session history request is invalid.', retryable: false } };
}
export const normalizeNativeHistoryPageRequest = (raw: unknown) => normalize(NativeHistoryPageRequestSchema, raw);
export const normalizeSessionHistoryEntryRequest = (raw: unknown) => normalize(SessionHistoryEntryRequestSchema, raw);
export const normalizeForkSessionRequest = (raw: unknown) => normalize(ForkSessionRequestSchema, raw);
function resultSchema<T extends z.ZodTypeAny>(data: T, maximumBytes: number) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: z.lazy(() => ContextErrorSchema), runId: id.optional() }).strict()])
    .refine(value => jsonBytes(value) <= maximumBytes, 'Complete History Result exceeds its UTF-8 budget.');
}
export const NativeHistoryPageResultSchema = resultSchema(NativeHistoryPageSchema, 1048576);
export const SessionHistoryEntryResultSchema = resultSchema(SessionHistoryEntryDetailSchema, 131072);
export const ForkSessionResponseSchema = resultSchema(ForkSessionResultSchema, 131072);
export const BranchSessionResponseSchema = resultSchema(z.object({ session: SessionSnapshotSchema,
  leafId: NativeEntryIdSchema, entryCount: HistorySafeIntegerSchema }).strict(), 131072);
export interface MemoryStore {
  load(sessionId: DbId): Result<StoredNativeHistory | null>;
  commit(input: HistoryCommitInput): Result<HistoryCommitReceipt>;
  list(input: NativeHistoryPageRequest): Result<NativeHistoryPage>;
}
