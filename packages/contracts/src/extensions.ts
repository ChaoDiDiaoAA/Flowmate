import { z } from 'zod';
import { AppErrorSchema } from './runtime.ts';
import { ResourceIdSchema, ResourceSelectionSchema } from './resources.ts';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = integer.positive(), opaque = z.string().min(1).max(256);
const timestamp = z.string().datetime({ offset: true });
const instanceId = z.string().uuid();
const report = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: 'custom', message });
export const EXTENSION_HOOKS = [
  { event: 'session_start', policy: 'critical' }, { event: 'tool_call', policy: 'critical' },
  { event: 'tool_result', policy: 'observer' }, { event: 'tool_execution_end', policy: 'observer' },
  { event: 'session_shutdown', policy: 'critical' },
] as const;
export const ExtensionHookEventSchema = z.enum(['session_start', 'tool_call', 'tool_result', 'tool_execution_end', 'session_shutdown']);
export type ExtensionHookEvent = z.infer<typeof ExtensionHookEventSchema>;
export const EXTENSION_ERROR_CODES = ['extension_config_invalid', 'extension_incompatible', 'extension_registration_conflict',
  'extension_load_failed', 'extension_hook_failed', 'extension_command_failed', 'extension_cleanup_failed',
  'extension_instance_conflict', 'extension_not_loaded'] as const;
export const ExtensionRefSchema = z.object({ id: ResourceIdSchema, version: ResourceIdSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export type ExtensionRef = z.infer<typeof ExtensionRefSchema>;
export function extensionRefKey(ref: ExtensionRef): string { return JSON.stringify([ref.id, ref.version, ref.manifestHash]); }
export const ExtensionSelectionSchema = z.object({ enabledExtensions: z.array(ExtensionRefSchema).max(2).readonly() }).strict()
  .refine(value => new Set(value.enabledExtensions.map(ref => ref.id)).size === value.enabledExtensions.length, 'Duplicate extension identity.').readonly();
export type ExtensionSelection = z.infer<typeof ExtensionSelectionSchema>;
export const EMPTY_EXTENSION_SELECTION: ExtensionSelection = ExtensionSelectionSchema.parse({ enabledExtensions: [] });
export const AssemblySelectionSnapshotSchema = z.object({ revision: integer, selection: ResourceSelectionSchema,
  extensions: ExtensionSelectionSchema.default(EMPTY_EXTENSION_SELECTION) }).strict().readonly();
export type AssemblySelectionSnapshot = z.infer<typeof AssemblySelectionSnapshotSchema>;
const manifestCommon = { schemaVersion: z.literal(1), kind: z.literal('extension'),
  hooks: z.array(z.object({ event: ExtensionHookEventSchema, policy: z.enum(['critical', 'observer']) }).strict().readonly()).length(5).readonly() };
export const ExtensionManifestSchema = z.discriminatedUnion('id', [z.object({ ...manifestCommon,
  id: z.literal('invoice-assist'), version: z.literal('v1'), sdkVersion: z.literal('0.85.1'), entryId: z.literal('invoice-assist-v1'),
  tools: z.tuple([z.object({ name: z.literal('check_invoice_sources'), version: z.literal('1') }).strict().readonly()]).readonly(),
  commands: z.tuple([z.literal('invoice-assist')]).readonly(),
}).strict(), z.object({ ...manifestCommon, id: z.literal('subagents'), version: z.literal('v1'), sdkVersion: z.literal('0.85.1'),
  entryId: z.literal('pi-subagents-managed-v1'), pluginVersion: z.literal('0.19.0'), patchVersion: z.literal('flowmate-p13.1'),
  patchHash: z.literal('a02f1ec857806c46212940c39d7066992d034ff5d8954b70c8aee402f815a98a'),
  tools: z.tuple([z.object({ name: z.literal('Agent'), version: z.literal('0.19.0-p13.1') }).strict().readonly()]).readonly(),
  commands: z.tuple([]).readonly(),
}).strict()]).superRefine((value, ctx) => {
  if (value.hooks.some((hook, index) => hook.event !== EXTENSION_HOOKS[index].event || hook.policy !== EXTENSION_HOOKS[index].policy))
    report(ctx, 'Hook declarations must match the supported extension and their required policies.');
}).readonly();
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export function canonicalExtensionManifest(value: ExtensionManifest): string {
  const { hooks, ...manifest } = ExtensionManifestSchema.parse(value);
  return JSON.stringify({ ...manifest, hooks });
}

export const FrozenExtensionsSchema = z.object({ version: z.literal(1), policyVersion: z.enum(['p12-managed-extensions-v1', 'p13-managed-extensions-v1']),
  settingsRevision: integer, selected: z.array(ExtensionRefSchema).max(2).readonly(),
  included: z.array(z.object({ ref: ExtensionRefSchema, manifest: ExtensionManifestSchema }).strict().readonly()).max(2).readonly(),
  excluded: z.array(z.object({ ref: ExtensionRefSchema, code: z.literal('tool_not_active') }).strict().readonly()).max(2).readonly(),
}).strict().superRefine((value, ctx) => {
  const selected = value.selected.map(extensionRefKey), partition = [...value.included, ...value.excluded].map(item => extensionRefKey(item.ref));
  if (selected.length !== partition.length || new Set(partition).size !== partition.length || partition.some(key => !selected.includes(key)))
    report(ctx, 'Included and excluded must partition the original selection exactly.');
  if (value.included.some(item => item.ref.id !== item.manifest.id || item.ref.version !== item.manifest.version))
    report(ctx, 'Manifest identity must match its reference.');
  if (new Set(value.selected.map(ref => ref.id)).size !== value.selected.length
    || value.policyVersion === 'p12-managed-extensions-v1' && (value.selected.length > 1 || value.selected.some(ref => ref.id !== 'invoice-assist')))
    report(ctx, 'Historical P12 selection cannot expand.');
  if (value.included.length === 2 && value.included[0].ref.id !== 'invoice-assist') report(ctx, 'Assembly order must be invoice-assist then subagents.');
}).readonly();
export type FrozenExtensions = z.infer<typeof FrozenExtensionsSchema>;
const actualTools = z.tuple([z.literal('check_invoice_sources')]).readonly();
const actualCommands = z.tuple([z.literal('invoice-assist')]).readonly();
const registeredTools = z.array(z.enum(['check_invoice_sources', 'Agent'])).max(1).readonly();
const registeredCommands = z.array(z.literal('invoice-assist')).max(1).readonly();
function matchesRegistration(value: { ref: ExtensionRef; registeredTools: readonly string[]; registeredCommands: readonly string[] }): boolean {
  return value.ref.id === 'invoice-assist' ? actualTools.safeParse(value.registeredTools).success && actualCommands.safeParse(value.registeredCommands).success
    : value.ref.id === 'subagents' && value.registeredTools.length === 1 && value.registeredTools[0] === 'Agent' && value.registeredCommands.length === 0;
}
const actualHooks = z.array(ExtensionHookEventSchema).length(5).readonly().refine(
  values => values.every((value, index) => value === EXTENSION_HOOKS[index].event), 'Actual Hooks must match the required set.');
export const ExtensionAssemblyEvidenceSchema = z.object({ version: z.literal(1), sdkVersion: z.literal('0.85.1'),
  instances: z.array(z.object({ instanceId, ref: ExtensionRefSchema, nativeSessionId: opaque, activatedAt: timestamp,
    registeredTools, registeredCommands, hookEvents: actualHooks }).strict().refine(matchesRegistration, 'Wrong extension registrations.').readonly()).max(2).readonly(),
}).strict().refine(value => new Set(value.instances.map(item => item.instanceId)).size === value.instances.length
  && new Set(value.instances.map(item => item.ref.id)).size === value.instances.length, 'Duplicate assembly identity.').readonly();
export type ExtensionAssemblyEvidence = z.infer<typeof ExtensionAssemblyEvidenceSchema>;
export function matchesExtensionAssembly(frozen: FrozenExtensions, assembly: ExtensionAssemblyEvidence, nativeSessionId?: string): boolean {
  return frozen.included.length === assembly.instances.length && assembly.instances.every((item, index) =>
    extensionRefKey(item.ref) === extensionRefKey(frozen.included[index].ref)
    && matchesRegistration(item)
    && (nativeSessionId === undefined || item.nativeSessionId === nativeSessionId));
}
export const ExtensionInstanceStateSchema = z.enum(['loading', 'active', 'load_failed', 'disposed']);
export type ExtensionInstanceState = z.infer<typeof ExtensionInstanceStateSchema>;
export const ExtensionCleanupSchema = z.object({ shutdownRequired: z.boolean(), shutdownAcknowledged: z.boolean(),
  sdkSessionCreated: z.boolean(), sdkDisposed: z.boolean(), ownedCallbacksSettled: z.boolean() }).strict().superRefine((value, ctx) => {
    if (value.shutdownAcknowledged && !value.shutdownRequired || value.sdkDisposed && !value.sdkSessionCreated)
      report(ctx, 'An inapplicable cleanup action cannot claim execution evidence.');
  }).readonly();
export type ExtensionCleanup = z.infer<typeof ExtensionCleanupSchema>;
export function isExtensionCleanupComplete(cleanup: ExtensionCleanup): boolean {
  return (!cleanup.shutdownRequired || cleanup.shutdownAcknowledged) && (!cleanup.sdkSessionCreated || cleanup.sdkDisposed)
    && cleanup.ownedCallbacksSettled;
}
export const ExtensionInstanceViewSchema = z.object({ instanceId, ref: ExtensionRefSchema, nativeSessionId: opaque,
  state: ExtensionInstanceStateSchema, admission: z.enum(['open', 'closed']), startedAt: timestamp,
  activatedAt: timestamp.nullable(), disposedAt: timestamp.nullable(), lastError: AppErrorSchema.nullable(),
  registeredTools: z.array(z.string().min(1).max(128)).max(1).readonly(), registeredCommands: z.array(z.string().min(1).max(128)).max(1).readonly(),
  hookEvents: z.array(ExtensionHookEventSchema).max(5).readonly(), cleanup: ExtensionCleanupSchema,
  diagnostics: z.array(z.object({ event: ExtensionHookEventSchema, code: z.string().regex(/^[a-z0-9_]{1,128}$/),
    at: timestamp, nativeToolCallId: opaque.optional() }).strict().readonly()).max(20).readonly(),
}).strict().superRefine((value, ctx) => {
  if (value.state !== 'active' && value.admission !== 'closed') report(ctx, 'Only an active instance can admit calls.');
  if (value.state === 'active' && (value.activatedAt === null || value.disposedAt !== null
    || !matchesRegistration(value)
    || !actualHooks.safeParse(value.hookEvents).success)) report(ctx, 'Active requires actual registrations and activation evidence.');
  if (value.state === 'loading' && value.activatedAt !== null) report(ctx, 'Loading cannot already be activated.');
  if (value.state === 'disposed' ? value.disposedAt === null || !isExtensionCleanupComplete(value.cleanup) : value.disposedAt !== null)
    report(ctx, 'Disposed requires all applicable cleanup obligations to be complete.');
}).readonly();
export type ExtensionInstanceView = z.infer<typeof ExtensionInstanceViewSchema>;
export const ExtensionCatalogItemSchema = z.object({ ref: ExtensionRefSchema, manifest: ExtensionManifestSchema,
  compatibility: z.object({ available: z.boolean(), code: z.enum(['sdk_version_mismatch', 'tool_definition_incompatible']).nullable() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.ref.id !== value.manifest.id || value.ref.version !== value.manifest.version
    || value.compatibility.available !== (value.compatibility.code === null)) report(ctx, 'Inconsistent catalog facts.');
}).readonly();
export type ExtensionCatalogItem = z.infer<typeof ExtensionCatalogItemSchema>;
export const ExtensionCatalogSchema = z.object({ revision: integer, selection: ExtensionSelectionSchema,
  items: z.array(ExtensionCatalogItemSchema).max(2).readonly() }).strict().readonly();
export type ExtensionCatalog = z.infer<typeof ExtensionCatalogSchema>;
export const ExtensionSelectionRequestSchema = z.object({ expectedRevision: integer, selection: ExtensionSelectionSchema }).strict();
export type ExtensionSelectionRequest = z.infer<typeof ExtensionSelectionRequestSchema>;
export const ExtensionSelectionResultSchema = z.object({ revision: integer, selection: ExtensionSelectionSchema }).strict().readonly();
export type ExtensionSelectionResult = z.infer<typeof ExtensionSelectionResultSchema>;
export const SessionExtensionQuerySchema = z.object({ sessionId: id }).strict();
export type SessionExtensionQuery = z.infer<typeof SessionExtensionQuerySchema>;
const instanceViews = z.array(ExtensionInstanceViewSchema).max(2).readonly();
const validInstanceOwners = (value: { nativeSessionId: string; instances: readonly ExtensionInstanceView[] }) =>
  value.instances.every(item => item.nativeSessionId === value.nativeSessionId)
  && new Set(value.instances.map(item => item.instanceId)).size === value.instances.length
  && new Set(value.instances.map(item => item.ref.id)).size === value.instances.length;
export const NativeExtensionViewSchema = z.object({ nativeSessionId: opaque, instances: instanceViews }).strict().refine(validInstanceOwners, 'Wrong instance owner.').readonly();
export type NativeExtensionView = z.infer<typeof NativeExtensionViewSchema>;
export const SessionExtensionViewSchema = z.object({ sessionId: id, nativeSessionId: opaque,
  instances: instanceViews }).strict().refine(validInstanceOwners, 'Wrong instance owner.').readonly();
export type SessionExtensionView = z.infer<typeof SessionExtensionViewSchema>;
export const RunExtensionQuerySchema = z.object({ sessionId: id, runId: id }).strict();
export type RunExtensionQuery = z.infer<typeof RunExtensionQuerySchema>;
export const RunExtensionViewSchema = z.object({ sessionId: id, runId: id, frozen: FrozenExtensionsSchema.nullable(),
  assembly: ExtensionAssemblyEvidenceSchema.nullable() }).strict().superRefine((value, ctx) => {
  if (value.assembly && (!value.frozen || !matchesExtensionAssembly(value.frozen, value.assembly))) report(ctx, 'Assembly differs from the fixed Run.');
}).readonly();
export type RunExtensionView = z.infer<typeof RunExtensionViewSchema>;
export const ExtensionCommandRequestSchema = z.object({ sessionId: id, expectedInstanceId: instanceId,
  name: z.literal('invoice-assist'), arguments: z.literal('') }).strict();
export type ExtensionCommandRequest = z.infer<typeof ExtensionCommandRequestSchema>;
export type NativeExtensionCommandRequest = Omit<ExtensionCommandRequest, 'sessionId'>;
export const ExtensionCommandReceiptSchema = z.object({ sessionId: id, instanceId, name: z.literal('invoice-assist'),
  ref: ExtensionRefSchema, registeredTools: actualTools, hookEvents: actualHooks, completedAt: timestamp }).strict().readonly();
export type ExtensionCommandReceipt = z.infer<typeof ExtensionCommandReceiptSchema>;
export const NativeExtensionCommandReceiptSchema = ExtensionCommandReceiptSchema.unwrap().omit({ sessionId: true }).extend({ nativeSessionId: opaque }).strict().readonly();
export type NativeExtensionCommandReceipt = z.infer<typeof NativeExtensionCommandReceiptSchema>;
export const ExtensionDisposeRequestSchema = z.object({ sessionId: id, expectedInstanceId: instanceId }).strict();
export type ExtensionDisposeRequest = z.infer<typeof ExtensionDisposeRequestSchema>;
export const ExtensionDisposeReceiptSchema = z.object({ sessionId: id, instanceId, state: ExtensionInstanceStateSchema,
  report: z.object({ stopped: z.boolean(), closed: z.boolean(), errors: z.array(AppErrorSchema).max(64).readonly() }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.report.closed !== (value.state === 'disposed') || value.report.closed && !value.report.stopped)
    report(ctx, 'The close report must reflect actual disposal and stopping.');
}).readonly();
export type ExtensionDisposeReceipt = z.infer<typeof ExtensionDisposeReceiptSchema>;
export type NativeExtensionDisposeReceipt = Omit<ExtensionDisposeReceipt, 'sessionId'> & { nativeSessionId: string };

const extensionResult = <T extends z.ZodTypeAny>(data: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data }).strict(), z.object({ ok: z.literal(false), error: AppErrorSchema, runId: id.optional() }).strict(),
]);
export const ExtensionCatalogResultSchema = extensionResult(ExtensionCatalogSchema);
export const ExtensionSelectionResponseSchema = extensionResult(ExtensionSelectionResultSchema);
export const SessionExtensionResultSchema = extensionResult(SessionExtensionViewSchema);
export const RunExtensionResultSchema = extensionResult(RunExtensionViewSchema);
export const ExtensionCommandResultSchema = extensionResult(ExtensionCommandReceiptSchema);
export const ExtensionDisposeResultSchema = extensionResult(ExtensionDisposeReceiptSchema);
export const ExtensionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list_extensions') }).strict(),
  z.object({ type: z.literal('update_extension_selection'), input: ExtensionSelectionRequestSchema }).strict(),
  z.object({ type: z.literal('query_session_extensions'), input: SessionExtensionQuerySchema }).strict(),
  z.object({ type: z.literal('query_run_extensions'), input: RunExtensionQuerySchema }).strict(),
  z.object({ type: z.literal('execute_extension_command'), input: ExtensionCommandRequestSchema }).strict(),
  z.object({ type: z.literal('dispose_session_extensions'), input: ExtensionDisposeRequestSchema }).strict(),
]);
export function parseExtensionCommand(value: unknown) { const parsed = ExtensionCommandSchema.safeParse(value); return parsed.success ? parsed.data : null; }
const extensionResults = { list_extensions: ExtensionCatalogResultSchema, update_extension_selection: ExtensionSelectionResponseSchema,
  query_session_extensions: SessionExtensionResultSchema, query_run_extensions: RunExtensionResultSchema,
  execute_extension_command: ExtensionCommandResultSchema, dispose_session_extensions: ExtensionDisposeResultSchema };
export function isExtensionHostCommand(type: string): type is keyof typeof extensionResults { return Object.hasOwn(extensionResults, type); }
export function parseExtensionHostResult(type: string, value: unknown) {
  if (!isExtensionHostCommand(type)) return null;
  const parsed = extensionResults[type].safeParse(value); if (!parsed.success) return null;
  return parsed.data.ok ? parsed.data : { ...parsed.data, error: { ...parsed.data.error,
    message: 'The extension operation could not be completed. Query the original facts before retrying.' } };
}
export function matchesExtensionResponse(command: { type: string; input?: unknown }, value: unknown): boolean {
  const captured = parseExtensionCommand({ type: command.type, ...(command.input === undefined ? {} : { input: command.input }) });
  if (!captured) return false;
  const result = parseExtensionHostResult(captured.type, value); if (!result) return false;
  if (!result.ok) return !('input' in captured && 'sessionId' in captured.input)
    || (result.error.sessionId === undefined || result.error.sessionId === captured.input.sessionId)
      && (!('runId' in captured.input) || result.error.runId === undefined || result.error.runId === captured.input.runId);
  const data = result.data;
  if (captured.type === 'update_extension_selection') return 'selection' in data && data.revision === captured.input.expectedRevision + 1
    && JSON.stringify(data.selection) === JSON.stringify(captured.input.selection);
  if (captured.type === 'list_extensions') return 'items' in data;
  if (!('sessionId' in data) || data.sessionId !== captured.input.sessionId) return false;
  if (captured.type === 'query_run_extensions') return 'runId' in data && data.runId === captured.input.runId;
  if (captured.type === 'query_session_extensions') return 'instances' in data;
  return 'instanceId' in data && data.instanceId === captured.input.expectedInstanceId
    && (captured.type !== 'execute_extension_command' || 'name' in data && data.name === captured.input.name);
}
export function extensionHostFailure(type: string) {
  const operation = ['update_extension_selection', 'execute_extension_command', 'dispose_session_extensions'].includes(type);
  return { ok: false as const, error: { code: operation ? 'operation_result_unknown' : 'storage_read_failed',
    category: operation ? 'runtime' as const : 'storage' as const, retryable: true,
    message: operation ? 'Operation result is unknown. Query the original selection or instance before retrying.' : 'Extensions could not be read.' } };
}
