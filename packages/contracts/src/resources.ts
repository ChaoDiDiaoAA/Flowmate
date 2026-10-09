import { z } from 'zod';
import { AppErrorSchema } from './runtime.ts';
import type { Result } from './runtime.ts';

export const RESOURCE_LIMITS = {
  packages: 64, files: 64, packageBytes: 4 * 1024 * 1024, manifestBytes: 65536,
  bodyBytes: 65536, fileBytes: 512 * 1024, indexBytes: 16384, pageBytes: 16384,
  keywords: 16, keywordChars: 64, dependencies: 64, contentChecks: 576, journalBytes: 4 * 1024 * 1024,
} as const;
export const RESOURCE_ERROR_CODES = ['resource_manifest_invalid', 'resource_name_conflict', 'resource_version_changed',
  'resource_dependency_missing', 'resource_required_unavailable', 'resource_bundle_unavailable', 'resource_expansion_mismatch',
  'resource_evidence_conflict', 'resource_evidence_write_failed', 'resource_content_too_large', 'resource_file_unavailable'] as const;
export type ResourceErrorCode = typeof RESOURCE_ERROR_CODES[number];

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = integer.positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().min(1).max(256);
const time = z.string().datetime({ offset: true });
const code = z.string().min(1).max(128);
const report = (context: z.RefinementCtx, message: string) => context.addIssue({ code: 'custom', message });
const unique = (values: readonly string[]) => new Set(values).size === values.length;
function safeSegment(value: string): boolean {
  return value !== '.' && value !== '..' && !/[\x00-\x1f\x7f\\:*?"<>|/]/.test(value)
    && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);
}
export const ResourceIdSchema = z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).refine(safeSegment, 'Resource IDs must be safe directory segments.');
export const ResourceFilePathSchema = z.string().min(1).max(4096).refine(value =>
  value.split('/').every(part => part.length > 0 && safeSegment(part)), 'Resource paths must be relative, unaliased file paths.');
export const ResourceRefSchema = z.object({ kind: z.enum(['prompt', 'skill']), id: ResourceIdSchema,
  version: ResourceIdSchema, contentHash: hash }).strict().readonly();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;
const skillRef = ResourceRefSchema.refine(value => value.kind === 'skill', 'Expected a Skill reference.');
const promptRef = ResourceRefSchema.refine(value => value.kind === 'prompt', 'Expected a Prompt reference.');
export function resourceRefKey(ref: ResourceRef): string {
  return JSON.stringify([ref.kind, ref.id, ref.version, ref.contentHash]);
}
export const ResourceDependencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tool'), name: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('skill'), id: ResourceIdSchema, version: ResourceIdSchema, contentHash: hash }).strict(),
  z.object({ kind: z.literal('extension'), id: ResourceIdSchema, version: ResourceIdSchema }).strict(),
]);
export type ResourceDependency = z.infer<typeof ResourceDependencySchema>;
const manifestFileShape = { path: ResourceFilePathSchema, bytes: integer.max(RESOURCE_LIMITS.fileBytes), sha256: hash };
const manifestFile = z.object(manifestFileShape).strict().readonly();
export const ResourceManifestSchema = z.object({ schemaVersion: z.literal(1), kind: z.enum(['prompt', 'skill']),
  id: ResourceIdSchema, version: ResourceIdSchema, bodyFile: z.enum(['prompt.md', 'SKILL.md']),
  keywords: z.array(z.string().min(1).max(RESOURCE_LIMITS.keywordChars)).max(RESOURCE_LIMITS.keywords).readonly(),
  requires: z.array(ResourceDependencySchema).max(RESOURCE_LIMITS.dependencies).readonly(),
  files: z.array(manifestFile).min(1).max(RESOURCE_LIMITS.files).readonly(),
}).strict().superRefine((value, context) => {
  if (value.bodyFile !== (value.kind === 'prompt' ? 'prompt.md' : 'SKILL.md')
    || !value.files.some(file => file.path === value.bodyFile && file.bytes <= RESOURCE_LIMITS.bodyBytes))
    report(context, 'The declared body must match the resource kind and body byte limit.');
  if (!unique(value.files.map(file => file.path.toLowerCase())) || value.files.some(file => file.path.toLowerCase() === 'resource.json'))
    report(context, 'Files must be unaliased and cannot include their own manifest.');
  if (value.files.reduce((sum, file) => sum + file.bytes, 0) > RESOURCE_LIMITS.packageBytes)
    report(context, 'Resource package exceeds its byte limit.');
  if (!unique(value.keywords) || !unique(value.requires.map(dependencyKey))) report(context, 'Metadata entries must be unique.');
}).readonly();
export type ResourceManifest = z.infer<typeof ResourceManifestSchema>;
function dependencyKey(value: ResourceDependency): string {
  return JSON.stringify(value.kind === 'tool' ? ['tool', value.name] : value.kind === 'skill'
    ? ['skill', value.id, value.version, value.contentHash] : ['extension', value.id, value.version]);
}
export function canonicalResourceManifest(value: ResourceManifest): string {
  const manifest = ResourceManifestSchema.parse(value);
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return JSON.stringify({ schemaVersion: manifest.schemaVersion, kind: manifest.kind, id: manifest.id,
    version: manifest.version, bodyFile: manifest.bodyFile, keywords: [...manifest.keywords].sort(compare),
    requires: [...manifest.requires].sort((a, b) => compare(dependencyKey(a), dependencyKey(b))),
    files: [...manifest.files].sort((a, b) => compare(a.path, b.path)) });
}
export const ResourceSelectionSchema = z.object({ prompt: promptRef.nullable(),
  enabledSkills: z.array(skillRef).max(RESOURCE_LIMITS.packages).readonly() }).strict().superRefine((value, context) => {
  if (!unique(value.enabledSkills.map(ref => ref.id))) report(context, 'Only one version of each Skill may be enabled.');
  if (value.enabledSkills.length + Number(value.prompt !== null) > RESOURCE_LIMITS.packages) report(context, 'Too many selected resource packages.');
}).readonly();
export type ResourceSelection = z.infer<typeof ResourceSelectionSchema>;
export const EMPTY_RESOURCE_SELECTION: ResourceSelection = Object.freeze({ prompt: null, enabledSkills: Object.freeze([]) });
export const ResourceBindingSchema = z.object({ bundleHash: hash, requiredSkill: skillRef.nullable() }).strict().readonly();
export type ResourceBinding = z.infer<typeof ResourceBindingSchema>;
export const SkillIndexEntrySchema = z.object({ ref: skillRef, description: z.string().max(160),
  checks: z.array(z.object({ dependency: ResourceDependencySchema, available: z.boolean(), reason: z.string().max(2048).nullable() }).strict())
    .max(RESOURCE_LIMITS.dependencies).readonly(), diagnostic: z.string().max(2048).nullable() }).strict().readonly();
export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;
export const SkillIndexSnapshotSchema = z.object({ entries: z.array(SkillIndexEntrySchema).max(RESOURCE_LIMITS.packages).readonly(), hash }).strict().readonly();
export const FrozenResourcesSchema = z.object({ version: z.literal(1), policyVersion: z.literal('p11-resources-v1'),
  settingsRevision: integer, bundleHash: hash, bundleDirectory: z.string().min(1).max(8192)
    .refine(value => !/[\x00-\x1f\x7f]/.test(value) && /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value)), prompt: promptRef.nullable(),
  manifests: z.array(z.object({ ref: ResourceRefSchema, manifest: ResourceManifestSchema }).strict().readonly()).max(RESOURCE_LIMITS.packages).readonly(),
  selectedSkills: z.array(skillRef).max(RESOURCE_LIMITS.packages).readonly(),
  discoveredSkills: z.array(skillRef).max(RESOURCE_LIMITS.packages).readonly(),
  excludedSkills: z.array(z.object({ ref: skillRef, code }).strict().readonly()).max(RESOURCE_LIMITS.packages).readonly(),
  skillIndex: SkillIndexSnapshotSchema.optional(),
}).strict().superRefine((value, context) => {
  const selected = value.selectedSkills.map(resourceRefKey);
  const partition = [...value.discoveredSkills.map(resourceRefKey), ...value.excludedSkills.map(item => resourceRefKey(item.ref))];
  if (!unique(value.selectedSkills.map(ref => ref.id)) || !unique(partition) || selected.length !== partition.length
    || partition.some(key => !selected.includes(key))) report(context, 'Discovered and excluded Skills must exactly partition selected versions.');
  if (selected.length + Number(value.prompt !== null) > RESOURCE_LIMITS.packages) report(context, 'Too many selected resource packages.');
  if (!value.bundleDirectory.replaceAll('\\', '/').endsWith('/' + value.bundleHash)) report(context, 'Frozen content location must identify its bundle.');
  const included = [...(value.prompt ? [value.prompt] : []), ...value.discoveredSkills].map(resourceRefKey);
  if (value.skillIndex && (value.skillIndex.entries.length !== selected.length
    || !unique(value.skillIndex.entries.map(entry => resourceRefKey(entry.ref)))
    || value.skillIndex.entries.some(entry => !selected.includes(resourceRefKey(entry.ref)))))
    report(context, 'Skill index must exactly identify the original enabled versions.');
  if (!unique(value.manifests.map(item => resourceRefKey(item.ref))) || value.manifests.length !== included.length
    || value.manifests.some(item => !included.includes(resourceRefKey(item.ref)) || item.ref.kind !== item.manifest.kind
      || item.ref.id !== item.manifest.id || item.ref.version !== item.manifest.version)) report(context, 'Frozen manifests must exactly identify included resources.');
}).readonly();
export type FrozenResources = z.infer<typeof FrozenResourcesSchema>;
export function matchesResourceBinding(frozen: FrozenResources | null, binding: ResourceBinding | undefined): boolean {
  return frozen === null ? binding === undefined : binding !== undefined && binding.bundleHash === frozen.bundleHash
    && (binding.requiredSkill === null || frozen.discoveredSkills.some(ref => resourceRefKey(ref) === resourceRefKey(binding.requiredSkill!)));
}
export const ResourceBundleManifestSchema = z.object({ version: z.literal(1), bundleHash: hash,
  resources: z.array(z.object({ ref: ResourceRefSchema, manifest: ResourceManifestSchema }).strict().readonly()).max(RESOURCE_LIMITS.packages).readonly(),
  files: z.array(z.object({ ref: ResourceRefSchema, ...manifestFileShape }).strict().readonly())
    .max(RESOURCE_LIMITS.packages * RESOURCE_LIMITS.files).readonly(),
}).strict().superRefine((value, context) => {
  if (!unique(value.resources.map(item => resourceRefKey(item.ref)))
    || !unique(value.resources.map(item => JSON.stringify([item.ref.kind, item.ref.id])))) report(context, 'Bundle versions must be unique.');
  const files = value.resources.flatMap(item => item.manifest.files.map(file => JSON.stringify([resourceRefKey(item.ref), file.path.toLowerCase(), file.bytes, file.sha256])));
  const index = value.files.map(file => JSON.stringify([resourceRefKey(file.ref), file.path.toLowerCase(), file.bytes, file.sha256]));
  if (!unique(index) || files.length !== index.length || index.some(file => !files.includes(file))) report(context, 'Bundle file index must match its manifests.');
  if (value.resources.some(item => item.ref.kind !== item.manifest.kind || item.ref.id !== item.manifest.id
    || item.ref.version !== item.manifest.version)) report(context, 'Bundle metadata must match each resource reference.');
}).readonly();
export type ResourceBundleManifest = z.infer<typeof ResourceBundleManifestSchema>;
const diagnosticShape = { code, message: z.string().min(1).max(2048) };
const diagnostic = z.object(diagnosticShape).strict().readonly();
export const ResourceNativeMetadataSchema = z.object({ name: z.string().min(1).max(64), description: z.string().min(1).max(1024),
  disableModelInvocation: z.boolean(), diagnostics: z.array(diagnostic).max(128).readonly() }).strict().readonly();
export type ResourceNativeMetadata = z.infer<typeof ResourceNativeMetadataSchema>;
export type InspectNativeResources = (input: { versionDirectory: string; manifest: ResourceManifest }) => Result<ResourceNativeMetadata>;
export const ResourceCatalogSchema = z.object({ settingsRevision: integer, selection: ResourceSelectionSchema,
  diagnostics: z.array(z.object({ resourceId: ResourceIdSchema.nullable(), version: ResourceIdSchema.nullable(),
    ...diagnosticShape }).strict().readonly()).max(128).readonly(),
  items: z.array(z.object({ ref: ResourceRefSchema, name: z.string().min(1).max(64), description: z.string().max(1024),
    keywords: z.array(z.string().max(64)).max(16).readonly(), enabled: z.boolean(), available: z.boolean(),
    disableModelInvocation: z.boolean(), bodyFile: ResourceFilePathSchema, files: z.array(z.object(manifestFileShape).strict().readonly()).max(RESOURCE_LIMITS.files).readonly(), dependencies: z.array(ResourceDependencySchema).max(64).readonly(),
    dependencyChecks: z.array(z.object({ dependency: ResourceDependencySchema, available: z.boolean(),
      reason: z.string().min(1).max(2048).nullable() }).strict().readonly()).max(RESOURCE_LIMITS.dependencies).readonly(),
    diagnostics: z.array(diagnostic).max(128).readonly() }).strict().readonly()).max(RESOURCE_LIMITS.packages).readonly(),
}).strict().superRefine((value, context) => {
  for (const item of value.items) {
    if (item.dependencyChecks.length !== item.dependencies.length || item.dependencyChecks.some((check, index) =>
      dependencyKey(check.dependency) !== dependencyKey(item.dependencies[index]!) || check.available !== (check.reason === null)))
      report(context, 'Dependency checks must match declared requirements and explain unavailable requirements.');
  }
}).readonly();
export type ResourceCatalog = z.infer<typeof ResourceCatalogSchema>;
export const ResourceFileRequestSchema = z.object({ ref: ResourceRefSchema, path: ResourceFilePathSchema,
  offset: integer.optional(), limit: integer.min(4).max(RESOURCE_LIMITS.pageBytes).optional() }).strict();
export type ResourceFileRequest = z.infer<typeof ResourceFileRequestSchema>;
export const ResourceFilePageSchema = z.object({ ref: ResourceRefSchema, path: ResourceFilePathSchema, sha256: hash,
  offset: integer, text: z.string().refine(value => new TextEncoder().encode(value).length <= RESOURCE_LIMITS.pageBytes),
  nextOffset: integer.nullable(), totalBytes: integer.max(RESOURCE_LIMITS.fileBytes),
}).strict().superRefine((value, context) => {
  if (value.offset > value.totalBytes || value.nextOffset !== null
    && (value.nextOffset <= value.offset || value.nextOffset >= value.totalBytes)) report(context, 'Page offsets must make bounded progress.');
}).readonly();
export type ResourceFilePage = z.infer<typeof ResourceFilePageSchema>;
export const SKILL_RESOURCE_TOOL_NAMES = ['list_skill_resources', 'read_skill_resource'] as const;
export const ListSkillResourcesInputSchema = z.object({ skill: ResourceIdSchema }).strict();
export type ListSkillResourcesInput = z.infer<typeof ListSkillResourcesInputSchema>;
export const ReadSkillResourceInputSchema = z.object({ skill: ResourceIdSchema, path: ResourceFilePathSchema,
  offset: integer.optional(), limit: integer.min(4).max(RESOURCE_LIMITS.pageBytes).optional() }).strict();
export type ReadSkillResourceInput = z.infer<typeof ReadSkillResourceInputSchema>;
export const ListSkillResourcesOutputSchema = z.object({ ref: skillRef, bundleHash: hash,
  files: z.array(manifestFile).min(1).max(RESOURCE_LIMITS.files).readonly() }).strict().refine(value =>
    unique(value.files.map(file => file.path.toLowerCase())), 'Listed files must be unique.').readonly();
export type ListSkillResourcesOutput = z.infer<typeof ListSkillResourcesOutputSchema>;
export const ReadSkillResourceOutputSchema = ResourceFilePageSchema.unwrap().innerType().extend({ ref: skillRef, bundleHash: hash })
  .strict().superRefine((value, context) => {
    if (value.offset > value.totalBytes || value.nextOffset !== null
      && (value.nextOffset <= value.offset || value.nextOffset >= value.totalBytes)) report(context, 'Page offsets must make bounded progress.');
  }).readonly();
export type ReadSkillResourceOutput = z.infer<typeof ReadSkillResourceOutputSchema>;
export const ResourceSelectionRequestSchema = z.object({ expectedRevision: integer, selection: ResourceSelectionSchema }).strict();
export type ResourceSelectionRequest = z.infer<typeof ResourceSelectionRequestSchema>;
export const ResourceSelectionResultSchema = z.object({ revision: integer, selection: ResourceSelectionSchema }).strict().readonly();
export type ResourceSelectionResult = z.infer<typeof ResourceSelectionResultSchema>;
export const RunResourceQuerySchema = z.object({ sessionId: id, runId: id }).strict();
export type RunResourceQuery = z.infer<typeof RunResourceQuerySchema>;
export const RunResourceFileRequestSchema = RunResourceQuerySchema.extend(ResourceFileRequestSchema.shape).strict();
export type RunResourceFileRequest = z.infer<typeof RunResourceFileRequestSchema>;
export const ResourceExpansionEvidenceSchema = z.object({ inputId: id, nativeEntryId: opaque, skill: skillRef,
  bundleHash: hash, expandedTextHash: hash, at: time }).strict().readonly();
export type ResourceExpansionEvidence = z.infer<typeof ResourceExpansionEvidenceSchema>;
export const ResourceReadEvidenceSchema = z.object({ toolCallId: id, nativeToolCallId: opaque, requestSequence: id,
  ref: ResourceRefSchema, bundleHash: hash, path: ResourceFilePathSchema, fileHash: hash, deliveredHash: hash,
  operation: z.enum(['read', 'grep', 'find', 'ls', 'list_skill_resources', 'read_skill_resource']), fullBody: z.boolean().nullable(), nativeEntryId: opaque.nullable(), at: time,
}).strict().refine(value => value.fullBody !== true || value.operation === 'read' || value.operation === 'read_skill_resource', 'Only actual read can prove a full body.').readonly();
export type ResourceReadEvidence = z.infer<typeof ResourceReadEvidenceSchema>;
export const ResourceContentEvidenceSchema = z.object({ ref: ResourceRefSchema, nativeEntryId: opaque.nullable(),
  path: ResourceFilePathSchema.nullable(), scope: z.enum(['business-prompt', 'skill-index', 'skill-readiness', 'expanded-body', 'tool-output', 'derived-source']),
  expectedTextHash: hash.nullable(), sdkInclusion: z.enum(['confirmed', 'not-included', 'unknown']),
  wireInclusion: z.enum(['confirmed', 'not-included', 'unknown']), reason: z.string().min(1).max(256).nullable(),
}).strict().superRefine((value, context) => {
  if (value.expectedTextHash === null && (value.sdkInclusion === 'confirmed' || value.wireInclusion === 'confirmed'))
    report(context, 'Confirmed inclusion requires observable content, not only source provenance.');
  if ((value.sdkInclusion === 'unknown' || value.wireInclusion === 'unknown') && value.reason === null)
    report(context, 'Unknown inclusion must state its evidence boundary.');
  if (value.scope === 'derived-source' && (value.expectedTextHash !== null || value.sdkInclusion !== 'unknown'
    || value.wireInclusion !== 'unknown' || value.nativeEntryId === null || value.reason !== 'derived-source-only'))
    report(context, 'Derived provenance requires its original summary identity and makes no content inclusion claim.');
  if (value.scope === 'business-prompt' && value.ref.kind !== 'prompt'
    || (value.scope === 'skill-index' || value.scope === 'expanded-body') && value.ref.kind !== 'skill')
    report(context, 'Content scope must match its resource kind.');
}).readonly();
export type ResourceContentEvidence = z.infer<typeof ResourceContentEvidenceSchema>;
export function formatSkillReadinessSection(entry: SkillIndexEntry, tools: readonly string[], visible: readonly ResourceRef[], child: boolean): string {
  const checks = entry.checks.map(check => {
    const dependency = check.dependency;
    const available = check.available && (dependency.kind === 'tool' ? tools.includes(dependency.name)
      : dependency.kind === 'skill' ? visible.some(ref => resourceRefKey(ref) === resourceRefKey(dependency)) : !child);
    return { ...check, available, reason: available ? null : check.reason ?? 'Unavailable in this Run scope.' };
  });
  const ready = visible.some(ref => resourceRefKey(ref) === resourceRefKey(entry.ref)) && !entry.diagnostic && checks.every(check => check.available);
  const missing = checks.filter(check => !check.available).map(check => `${check.dependency.kind === 'tool' ? check.dependency.name : check.dependency.id}: ${check.reason}`);
  return `- ${entry.ref.id}: ${entry.description}\n  readiness: ${ready ? 'Ready' : 'Partial'} (${checks.filter(check => check.available).length}/${checks.length} capabilities)${checks.length ? '' : '; No requirements'}${missing.length ? '; missing: '+missing.join(', ') : ''}${entry.diagnostic ? '; '+entry.diagnostic : ''}`;
}
export function resourceContentKey(value: Pick<ResourceContentEvidence, 'ref' | 'scope' | 'nativeEntryId' | 'path'>): string {
  return JSON.stringify([resourceRefKey(value.ref), value.scope, value.nativeEntryId, value.path]);
}
export const ResourceRequestEvidenceSchema = z.object({ purpose: z.enum(['answer', 'compaction']), callSequence: id,
  compactionOperationId: opaque.nullable(), bundleHash: hash.nullable(), referencedBundleHashes: z.array(hash).max(512).readonly(),
  systemPromptHash: hash, inputIds: z.array(id).max(512).readonly(), toolCallIds: z.array(id).max(512).readonly(),
  contentChecks: z.array(ResourceContentEvidenceSchema).max(RESOURCE_LIMITS.contentChecks).readonly(), at: time,
}).strict().superRefine((value, context) => {
  if ((value.purpose === 'compaction') !== (value.compactionOperationId !== null)
    || value.purpose === 'compaction' && value.bundleHash !== null) report(context, 'Summary evidence needs its original operation and an independent system prompt.');
  if (!unique(value.contentChecks.map(resourceContentKey)) || !unique(value.referencedBundleHashes)
    || !unique(value.inputIds.map(String)) || !unique(value.toolCallIds.map(String))) report(context, 'Request evidence identities must be unique.');
}).readonly();
export type ResourceRequestEvidence = z.infer<typeof ResourceRequestEvidenceSchema>;
export const ResourceEvidenceJournalSchema = z.object({ version: z.literal(1),
  expansions: z.array(ResourceExpansionEvidenceSchema).readonly(), reads: z.array(ResourceReadEvidenceSchema).readonly(),
  requests: z.array(ResourceRequestEvidenceSchema).max(128).readonly(),
}).strict().superRefine((value, context) => {
  if (!unique(value.expansions.map(item => String(item.inputId)))
    || !unique(value.expansions.map(item => item.nativeEntryId))
    || !unique(value.reads.map(item => JSON.stringify([item.toolCallId, item.operation, item.path])))
    || !unique(value.requests.map(item => JSON.stringify([item.purpose, item.callSequence, item.compactionOperationId]))))
    report(context, 'Resource journal contains conflicting observation identities.');
  if (new TextEncoder().encode(JSON.stringify(value)).length > RESOURCE_LIMITS.journalBytes) report(context, 'Resource journal exceeds 4 MiB.');
}).readonly();
export type ResourceEvidenceJournal = z.infer<typeof ResourceEvidenceJournalSchema>;
export function emptyResourceJournal(): ResourceEvidenceJournal {
  return { version: 1, expansions: [], reads: [], requests: [] };
}
export const RunResourceViewSchema = z.object({ sessionId: id, runId: id, frozen: FrozenResourcesSchema.nullable(),
  evidence: ResourceEvidenceJournalSchema.nullable(), gap: z.enum(['legacy-not-collected', 'bundle-unavailable']).nullable(),
}).strict().readonly();
export type RunResourceView = z.infer<typeof RunResourceViewSchema>;
function resourceResult<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema, runId: id.optional() }).strict()]);
}
export const ResourceCatalogResultSchema = resourceResult(ResourceCatalogSchema);
export const ResourceFileResultSchema = resourceResult(ResourceFilePageSchema);
export const ResourceSelectionResponseSchema = resourceResult(ResourceSelectionResultSchema);
export const RunResourceResultSchema = resourceResult(RunResourceViewSchema);

export const ResourceCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list_resources') }).strict(),
  z.object({ type: z.literal('read_resource_file'), input: ResourceFileRequestSchema }).strict(),
  z.object({ type: z.literal('update_resource_selection'), input: ResourceSelectionRequestSchema }).strict(),
  z.object({ type: z.literal('query_run_resources'), input: RunResourceQuerySchema }).strict(),
  z.object({ type: z.literal('read_run_resource_file'), input: RunResourceFileRequestSchema }).strict(),
]);
export function parseResourceCommand(value: unknown) {
  const parsed = ResourceCommandSchema.safeParse(value); return parsed.success ? parsed.data : null;
}
const resourceResultSchemas = { list_resources: ResourceCatalogResultSchema, read_resource_file: ResourceFileResultSchema,
  update_resource_selection: ResourceSelectionResponseSchema, query_run_resources: RunResourceResultSchema,
  read_run_resource_file: ResourceFileResultSchema };
export function isResourceHostCommand(type: string): type is keyof typeof resourceResultSchemas { return Object.hasOwn(resourceResultSchemas, type); }
export function parseResourceHostResult(type: string, value: unknown) {
  if (!isResourceHostCommand(type)) return null;
  const parsed = resourceResultSchemas[type].safeParse(value);
  if (!parsed.success) return null;
  const result = parsed.data;
  return result.ok ? result : { ...result, error: { ...result.error, message: result.error.code === 'config_revision_conflict'
    ? 'Settings changed. Refresh before saving.' : result.error.code === 'resource_dependency_missing'
      ? 'This resource has an unavailable dependency.' : result.error.code === 'resource_evidence_conflict'
        ? 'The original resource evidence could not be verified.' : 'The resource operation could not be completed.' } };
}
export function matchesResourceResponse(command: { type: string; input?: unknown }, value: unknown): boolean {
  const captured = parseResourceCommand({ type: command.type, ...(command.input === undefined ? {} : { input: command.input }) });
  if (!captured) return false;
  const result = parseResourceHostResult(captured.type, value); if (!result || !isResourceHostCommand(command.type)) return false;
  if (!result.ok) {
    if (captured.type === 'query_run_resources' || captured.type === 'read_run_resource_file')
      return (result.error.runId === undefined || result.error.runId === captured.input.runId)
        && (result.error.sessionId === undefined || result.error.sessionId === captured.input.sessionId);
    return true;
  }
  if (captured.type === 'query_run_resources') return 'runId' in result.data && result.data.runId === captured.input.runId && result.data.sessionId === captured.input.sessionId;
  if (captured.type === 'read_resource_file' || captured.type === 'read_run_resource_file') return 'ref' in result.data
    && resourceRefKey(result.data.ref) === resourceRefKey(captured.input.ref) && result.data.path === captured.input.path && result.data.offset === (captured.input.offset ?? 0);
  if (captured.type === 'update_resource_selection') return 'revision' in result.data && result.data.revision === captured.input.expectedRevision + 1
    && JSON.stringify(result.data.selection) === JSON.stringify(captured.input.selection);
  return true;
}
export function resourceHostFailure(type: string) {
  return { ok: false as const, error: { code: type === 'update_resource_selection' ? 'operation_result_unknown' : 'storage_read_failed',
    category: type === 'update_resource_selection' ? 'runtime' as const : 'storage' as const, retryable: true,
    message: type === 'update_resource_selection' ? 'Save result is unknown. Refresh the selection before trying again.' : 'Resources could not be read. Refresh to try again.' } };
}
