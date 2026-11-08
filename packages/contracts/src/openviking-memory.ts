import { z } from 'zod';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.string().datetime({ offset: true });
export const MemoryProviderSchema = z.enum(['native', 'openviking']);
export const MemoryCaptureModeSchema = z.enum(['off', 'explicit', 'auto']);
export const MemoryEndpointSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port
      && !url.username && !url.password && url.pathname === '/' && !url.search && !value.includes('#');
  } catch { return false; }
}, 'The memory service must use an explicit local loopback endpoint.');
const settings = { provider: MemoryProviderSchema, recallEnabled: z.boolean(), captureMode: MemoryCaptureModeSchema,
  endpoint: MemoryEndpointSchema.nullable() };
const validSettings = (value: { provider: 'native' | 'openviking'; recallEnabled: boolean; captureMode: 'off' | 'explicit' | 'auto'; endpoint: string | null }) =>
  value.endpoint !== null || value.provider === 'native' && !value.recallEnabled && value.captureMode === 'off';
export const MemorySettingsSchema = z.object({ revision, ...settings, updatedAt: time }).strict().refine(validSettings);
export const MemorySettingsUpdateSchema = z.object({ expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1), ...settings, at: time }).strict().refine(validSettings);
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;
export type MemorySettingsUpdate = z.infer<typeof MemorySettingsUpdateSchema>;

export const MemorySessionBindingRequestSchema = z.object({ sessionId: id, branch: revision,
  provider: MemoryProviderSchema, identityId: id.nullable(), remoteSessionId: z.string().min(1).max(128).nullable(), at: time }).strict()
  .refine(value => value.provider === 'native' ? value.identityId === null && value.remoteSessionId === null
    : value.identityId !== null && value.remoteSessionId !== null);
export const MemorySessionBindingSchema = z.object({ id, runtimeKind: z.literal('agent_session'), sessionId: id, branch: revision,
  provider: MemoryProviderSchema, identityId: id.nullable(), remoteSessionId: z.string().min(1).max(128).nullable(), createdAt: time }).strict()
  .refine(value => value.provider === 'native' ? value.identityId === null && value.remoteSessionId === null
    : value.identityId !== null && value.remoteSessionId !== null);
export type MemorySessionBindingRequest = z.infer<typeof MemorySessionBindingRequestSchema>;
export type MemorySessionBinding = z.infer<typeof MemorySessionBindingSchema>;

export const MemoryRecallItemSchema = z.object({ uri: z.string().min(1).max(4096), revision: id, content: z.string().min(1), truncated: z.boolean() }).strict();
const boundedRecall = (value: { status: string; items: readonly { content: string }[] }) =>
  (value.status === 'ready' ? value.items.length > 0 : value.items.length === 0)
  && value.items.reduce((total, item) => total + new TextEncoder().encode(item.content).byteLength, 0) <= 6000;
export const MemoryRecallResultSchema = z.object({ status: z.enum(['disabled', 'empty', 'ready', 'unavailable']),
  items: z.array(MemoryRecallItemSchema).max(5) }).strict().refine(boundedRecall);
export type MemoryRecallItem = z.infer<typeof MemoryRecallItemSchema>;
export type MemoryRecallResult = z.infer<typeof MemoryRecallResultSchema>;

export const MemoryWorkBindingRequestSchema = z.object({ sessionId: id, workId: id, itemId: id, branch: revision,
  provider: MemoryProviderSchema, identityId: id.nullable(), remoteSessionId: z.string().min(1).max(128).nullable(), at: time }).strict()
  .refine(value => value.provider === 'native' ? value.identityId === null && value.remoteSessionId === null
    : value.identityId !== null && value.remoteSessionId !== null);
export const MemoryWorkBindingSchema = z.object({ id, runtimeKind: z.literal('durable'), sessionId: id, workId: id, itemId: id, branch: revision,
  provider: MemoryProviderSchema, identityId: id.nullable(), remoteSessionId: z.string().min(1).max(128).nullable(), createdAt: time }).strict()
  .refine(value => value.provider === 'native' ? value.identityId === null && value.remoteSessionId === null
    : value.identityId !== null && value.remoteSessionId !== null);
export type MemoryWorkBindingRequest = z.infer<typeof MemoryWorkBindingRequestSchema>;
export type MemoryWorkBinding = z.infer<typeof MemoryWorkBindingSchema>;

const recallKeyFields = { bindingId: id, inputId: id.nullable(), phaseId: id.nullable() };
const oneRecallSource = (value: { inputId: number | null; phaseId: number | null }) => (value.inputId === null) !== (value.phaseId === null);
export const MemoryRecallKeySchema = z.object(recallKeyFields).strict().refine(oneRecallSource);
export const MemoryRecallReserveSchema = z.object({ ...recallKeyFields, at: time }).strict().refine(oneRecallSource);
export const MemoryRecallCompleteSchema = z.object({ ...recallKeyFields, result: MemoryRecallResultSchema }).strict().refine(oneRecallSource);
export const MemoryRecallSnapshotSchema = z.object({ id, ...recallKeyFields,
  status: z.enum(['pending', 'disabled', 'empty', 'ready', 'unavailable']), items: z.array(MemoryRecallItemSchema).max(5), createdAt: time }).strict()
  .refine(oneRecallSource).refine(boundedRecall);
export type MemoryRecallKey = z.infer<typeof MemoryRecallKeySchema>;
export type MemoryRecallSnapshot = z.infer<typeof MemoryRecallSnapshotSchema>;

export const MemoryPolicyUpdateSchema = z.object({ expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1),
  provider: MemoryProviderSchema, recallEnabled: z.boolean(), captureMode: MemoryCaptureModeSchema }).strict();
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
export const MemoryConnectionConfigurationSchema = z.object({ expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1),
  endpoint: MemoryEndpointSchema, accountId: identity, userId: identity, peerId: identity,
  credentialRef: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/), recallEnabled: z.boolean(), captureMode: MemoryCaptureModeSchema }).strict();
export const MemorySettingsViewSchema = z.object({ settings: MemorySettingsSchema,
  identity: z.object({ accountId: z.string().min(1).max(128), userId: z.string().min(1).max(128), peerId: z.string().min(1).max(128) }).strict().nullable() }).strict();
export const MemorySetupResultSchema = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(true) }).strict(), z.object({ cancelled: z.literal(false), settings: MemorySettingsViewSchema }).strict(),
]);
export const MemoryRememberRequestSchema = z.object({ requestId: z.string().trim().min(1).max(128),
  source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('session'), sessionId: id, inputId: id }).strict(),
    z.object({ kind: z.literal('work'), workId: id, itemId: id, phaseId: id }).strict()]),
  content: z.string().min(1).refine(value => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 65000),
  scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('personal') }).strict(),
    z.object({ kind: z.literal('session'), sessionId: id }).strict(), z.object({ kind: z.literal('work'), workId: id }).strict()]),
  confirmed: z.literal(true) }).strict();
export const MemorySearchRequestSchema = z.object({ query: z.string().trim().min(1).max(500), source: MemoryRememberRequestSchema.shape.source }).strict();
export const MemoryRememberResultSchema = z.object({ requestId: z.string().min(1).max(128),
  state: z.enum(['pending', 'unknown', 'completed', 'failed']), uri: z.string().min(1).max(4096), entryId: id.nullable(), contentConfirmed: z.boolean() }).strict();
export const MemoryRememberRecoveryRequestSchema = z.object({ operationId: id, requestId: z.string().trim().min(1).max(128) }).strict();
export const MemoryRememberRecoveryResultSchema = z.object({ operationId: id, result: MemoryRememberResultSchema }).strict();
export const MemoryForgetWriteSchema = z.object({ entryId: id, expectedRevision: id.max(Number.MAX_SAFE_INTEGER - 1),
  requestId: z.string().trim().min(1).max(128), confirmed: z.literal(true) }).strict();
export const MemoryForgetCheckSchema = MemoryRememberRecoveryRequestSchema.extend({ entryId: id }).strict();
export const MemoryForgetRequestSchema = MemoryForgetWriteSchema.or(MemoryForgetCheckSchema);
export const MemoryForgetResultSchema = z.object({ requestId: z.string().min(1).max(128), entryId: id,
  state: z.enum(['pending', 'unknown', 'completed', 'conflict']) }).strict();
export const MemoryEntriesRequestSchema = z.object({ afterId: id.optional(), limit: z.number().int().min(1).max(100).default(30) }).strict();
export const MemoryEntrySummarySchema = z.object({ entryId: id, endpoint: MemoryEndpointSchema, uri: z.string().min(1).max(4096), revision: id,
  state: z.enum(['active', 'forgotten']), identityActive: z.boolean(),
  grants: z.array(z.object({ kind: z.enum(['personal', 'session', 'work', 'workspace']), scopeId: z.string().min(1).max(128) }).strict()).max(100) }).strict();
export const MemoryEntriesPageSchema = z.object({ items: z.array(MemoryEntrySummarySchema).max(100), nextAfterId: id.nullable() }).strict();
export const MemoryEntryRequestSchema = z.object({ entryId: id }).strict();
export const MemoryEntryDetailSchema = MemoryEntrySummarySchema.extend({ content: z.string().nullable(),
  origin: z.object({ bindingId: id, inputId: id.nullable(), phaseId: id.nullable() }).strict().refine(oneRecallSource).nullable() }).strict()
  .refine(value => value.state === 'active' ? value.content !== null && value.content.length > 0
    && new TextEncoder().encode(value.content).byteLength <= 65000 : value.content === null && value.origin === null);
export const MemoryOperationsRequestSchema = z.object({ kind: z.enum(['sync', 'remember', 'forget']), afterId: id.optional(),
  limit: z.number().int().min(1).max(100).default(30) }).strict();
export const MemoryOperationSummarySchema = z.object({ operationId: id, kind: z.enum(['sync', 'remember', 'forget']),
  requestId: z.string().min(1).max(128).nullable(), state: z.enum(['pending', 'sending', 'unknown', 'appended', 'commit_pending',
    'accepted', 'running', 'completed', 'failed', 'cancelled', 'abandoned', 'conflict', 'forgotten']),
  entryId: id.nullable(), sessionId: id.nullable(), workId: id.nullable(), itemId: id.nullable(), inputId: id.nullable(), phaseId: id.nullable(), updatedAt: time }).strict();
export const MemoryOperationsPageSchema = z.object({ items: z.array(MemoryOperationSummarySchema).max(100), nextAfterId: id.nullable() }).strict();
export const MemorySyncRequestSchema = z.object({ syncId: id, abandonConfirmed: z.literal(true).optional() }).strict();
export const MemorySyncResultSchema = z.object({ syncId: id, state: z.enum(['pending', 'unknown', 'completed', 'abandoned']) }).strict();
export type MemoryRememberRequest = z.infer<typeof MemoryRememberRequestSchema>;
export type MemoryApi = {
  getSettings(): Promise<import('./runtime.ts').Result<z.infer<typeof MemorySettingsViewSchema>>>;
  listEntries(input: z.input<typeof MemoryEntriesRequestSchema>): Promise<import('./runtime.ts').Result<z.infer<typeof MemoryEntriesPageSchema>>>;
  readEntry(input: z.infer<typeof MemoryEntryRequestSchema>): Promise<import('./runtime.ts').Result<z.infer<typeof MemoryEntryDetailSchema>>>;
  listOperations(input: z.input<typeof MemoryOperationsRequestSchema>): Promise<import('./runtime.ts').Result<z.infer<typeof MemoryOperationsPageSchema>>>;
  search(input: z.infer<typeof MemorySearchRequestSchema>): Promise<import('./runtime.ts').Result<MemoryRecallResult>>;
  updatePolicy(input: z.infer<typeof MemoryPolicyUpdateSchema>): Promise<import('./runtime.ts').Result<z.infer<typeof MemorySettingsViewSchema>>>;
  remember(input: MemoryRememberRequest): Promise<import('./runtime.ts').Result<z.infer<typeof MemoryRememberResultSchema>>>;
  reconcileRemember(input: MemoryRememberRequest): Promise<import('./runtime.ts').Result<z.infer<typeof MemoryRememberResultSchema>>>;
  reconcileRememberById(input: z.infer<typeof MemoryRememberRecoveryRequestSchema>): Promise<import('./runtime.ts').Result<z.infer<typeof MemoryRememberRecoveryResultSchema>>>;
  forget(input: z.infer<typeof MemoryForgetRequestSchema>): Promise<import('./runtime.ts').Result<z.infer<typeof MemoryForgetResultSchema>>>;
  reconcileSync(syncId: number, abandonConfirmed?: true): Promise<import('./runtime.ts').Result<z.infer<typeof MemorySyncResultSchema>>>;
};
