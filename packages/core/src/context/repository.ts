import { ResearchContextSchema } from '@flowmate/contracts';
import { readResearchContext } from '../research/context.ts';
import { createNativeOriginReader, NativeOriginFault } from '../memory/origins.ts';
import { SQLiteError, type Database } from 'bun:sqlite';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { join, relative, isAbsolute, sep } from 'node:path';
import { resolveNativeFilePath, nativeFileResultIncludes } from '@flowmate/shared';
import { verifyFrozenResourceMetadata } from '../skill-hub/index.ts';
import { visibleFrozenSkills } from '../skill-hub/capability-map.ts';
import { formatSkillReadinessSection } from '@flowmate/contracts';
import { ResourceEvidenceJournalSchema, ResourceExpansionEvidenceSchema, ResourceReadEvidenceSchema,
  ResourceRequestEvidenceSchema, RunResourceQuerySchema, ResourceBindingSchema, SessionInputContentV2Schema,
  resourceRefKey, resourceContentKey, NativeDerivedContextBindingSchema } from '@flowmate/contracts';
import { NativeToolOutputSchema, ListSkillResourcesInputSchema, ListSkillResourcesOutputSchema,
  ReadSkillResourceInputSchema, ReadSkillResourceOutputSchema } from '@flowmate/contracts';
import type { ResourceEvidenceJournal, ResourceExpansionEvidence, ResourceReadEvidence, ResourceRequestEvidence,
  RunResourceQuery, FrozenResources, ResourceRef } from '@flowmate/contracts';
import { appError, fail, ok, ContextSnapshotSchema, ContextSnapshotJsonSchema, ContextReferenceSchema,
  ContextObservationsSchema, NativeContextObservationsSchema, readContextObservations, RequestContextBindingSchema, ContextEvidenceUpdateSchema, ContextRequestEvidenceSchema,
  ContextSnapshotsRequestSchema, ContextSnapshotRequestSchema,
  ContextRequestsRequestSchema, ContextSnapshotDetailSchema, ContextInputErrorSchema,
  ContextSnapshotsResultSchema, ContextSnapshotResultSchema, ContextRequestsResultSchema,
  SessionInputSnapshotSchema, CompactionPolicySchema, RunCompactionEvidenceSchema, FrozenResourcesSchema, matchesResourceBinding } from '@flowmate/contracts';
import type { AppError, Result, ContextSnapshot, ContextSnapshotJson, ContextReference, ContextHooks,
  RequestContextBinding, ContextEvidenceUpdate, ContextObservations, ContextRequestEvidence,
  NativeToolResultContextBinding, NativeSessionHistory, ContextSnapshotsRequest, ContextSnapshotsPage,
  ContextSnapshotRequest, ContextSnapshotDetail, ContextRequestsRequest, ContextRequestsPage,
  ContextSnapshotSummary, SessionInputSnapshot, RunCompactionEvidence, DbId } from '@flowmate/contracts';

export interface ContextRepository {
  appendInTransaction(input: { runId: number; sessionId: number; jobId: number | null; json: ContextSnapshotJson; at: string }): Result<ContextSnapshot>;
  bindRequest(input: Parameters<ContextHooks['bind']>[0]): Result<void>;
  recordRequest(binding: RequestContextBinding, update: ContextEvidenceUpdate): Result<void>;
  recordCompactionEvidence(value: RunCompactionEvidence): Result<void>;
  readCompactionEvidence(request: { sessionId: DbId; runId: DbId; operationId?: string }): Result<readonly RunCompactionEvidence[]>;
  recordResourceRead(value: ResourceReadEvidence, owner: RunResourceQuery): Result<void>;
  recordResourceRequest(value: ResourceRequestEvidence, owner: RunResourceQuery): Result<void>;
  readResourceEvidence(owner: RunResourceQuery): Result<ResourceEvidenceJournal | null>;
  resolveToolResult(input: Parameters<ContextHooks['resolveToolResult']>[0]): Result<NativeToolResultContextBinding>;
  listContextSnapshots(request: ContextSnapshotsRequest): Result<ContextSnapshotsPage>;
  queryContextSnapshot(request: ContextSnapshotRequest): Result<ContextSnapshotDetail>;
  listContextRequests(request: ContextRequestsRequest): Result<ContextRequestsPage>;
}

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const runRowSchema = z.object({ id, kind: z.enum(['agent', 'provider', 'subagent']), session_id: id.nullable(), job_id: id.nullable(),
  config_json: z.string(), current_context_snapshot_id: id.nullable(), context_observations_json: z.string().nullable() });
type RunRow = z.infer<typeof runRowSchema>;
const json = (value: string): unknown => JSON.parse(value);
const same = isDeepStrictEqual;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
class ContextFault extends Error {
  constructor(readonly error: AppError) { super(error.code); }
}
function reject(code: string, category: AppError['category'] = 'runtime'): never {
  throw new ContextFault(appError(code, category, 'Context evidence could not be verified.'));
}
function corrupt(): never { return reject('storage_corrupt', 'storage'); }
function unknownBinding(): never { return reject('context_binding_unknown'); }
function conflict(): never { return reject('context_binding_conflict'); }
function resourceConflict(): never { return reject('resource_evidence_conflict'); }
const hashText = (value: string) => createHash('sha256').update(value).digest('hex');
function frozenResources(config: unknown): FrozenResources | null {
  const frozen = z.object({ resources: FrozenResourcesSchema.optional() }).parse(config).resources ?? null;
  if (frozen && !verifyFrozenResourceMetadata(frozen).ok) resourceConflict();
  return frozen;
}
function includesResource(frozen: FrozenResources | null, ref: ResourceRef): boolean {
  return [frozen?.prompt, ...(frozen?.discoveredSkills ?? [])].some(item => item && resourceRefKey(item) === resourceRefKey(ref));
}

function verifyResourceReadOwner(db: Database, owner: RunResourceQuery, value: ResourceReadEvidence, reader = createNativeOriginReader(db)): void {
  const row = runRowSchema.parse(db.query('SELECT * FROM runs WHERE id=?').get(owner.runId));
  const frozen = frozenResources(json(row.config_json));
  if (!['agent', 'subagent'].includes(row.kind) || row.session_id !== owner.sessionId || frozen?.bundleHash !== value.bundleHash || !includesResource(frozen, value.ref)) resourceConflict();
  const tool = z.object({ id, run_id: id, session_id: id, native_tool_call_id: z.string(), tool_name: z.string(), request_sequence: id.nullable(), args_json: z.string(),
    result_json: z.string() }).parse(db.query('SELECT * FROM tool_calls WHERE id=?').get(value.toolCallId));
  if (tool.run_id !== owner.runId || tool.session_id !== owner.sessionId || tool.native_tool_call_id !== value.nativeToolCallId
    || tool.tool_name !== value.operation || tool.request_sequence !== value.requestSequence) resourceConflict();
  const manifest = frozen.manifests.find(item => resourceRefKey(item.ref) === resourceRefKey(value.ref))?.manifest;
  const file = manifest?.files.find(item => item.path === value.path);
  if (!file || file.sha256 !== value.fileHash) resourceConflict();
  const storedArgs = z.object({ version: z.literal(1), raw: z.unknown(), final: z.unknown() }).parse(json(tool.args_json));
  if (value.operation === 'list_skill_resources' || value.operation === 'read_skill_resource') {
    const result = z.object({ status: z.literal('succeeded'), data: z.unknown() }).parse(json(tool.result_json));
    const args = value.operation === 'list_skill_resources' ? ListSkillResourcesInputSchema.parse(storedArgs.final ?? storedArgs.raw)
      : ReadSkillResourceInputSchema.parse(storedArgs.final ?? storedArgs.raw);
    const data = value.operation === 'list_skill_resources' ? ListSkillResourcesOutputSchema.parse(result.data) : ReadSkillResourceOutputSchema.parse(result.data);
    if (args.skill !== value.ref.id || resourceRefKey(data.ref) !== resourceRefKey(value.ref) || data.bundleHash !== frozen.bundleHash
      || hashText(JSON.stringify([{ type: 'text', text: JSON.stringify(result.data) }])) !== value.deliveredHash) resourceConflict();
    if ('files' in data) {
      const ordered = [...manifest!.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      if (!same(data.files, ordered) || value.fullBody !== false) resourceConflict();
    } else {
      const readArgs = ReadSkillResourceInputSchema.parse(storedArgs.final ?? storedArgs.raw);
      if (readArgs.path !== value.path || data.path !== value.path || data.sha256 !== file.sha256
        || data.totalBytes !== file.bytes || data.offset !== (readArgs.offset ?? 0) || Buffer.byteLength(data.text) > (readArgs.limit ?? 16384)
        || (data.nextOffset ?? data.totalBytes) !== data.offset + Buffer.byteLength(data.text)) resourceConflict();
      const complete = data.offset === 0 && data.nextOffset === null;
      if (value.fullBody !== complete || complete && hashText(data.text) !== file.sha256) resourceConflict();
    }
  } else {
    const result = z.object({ status: z.literal('succeeded'), data: NativeToolOutputSchema }).parse(json(tool.result_json));
    const config = z.object({ workingDirectory: z.string() }).parse(json(row.config_json));
    const args = z.object({ path: z.string().optional() }).parse(storedArgs.final ?? storedArgs.raw);
    if (value.operation === 'read' && args.path === undefined) resourceConflict();
    const target = resolveNativeFilePath(args.path ?? '.', config.workingDirectory);
    const filePath = join(frozen.bundleDirectory, value.ref.kind === 'skill' ? 'skills' : 'prompts', value.ref.id, value.ref.version, value.path);
    const rel = relative(target, filePath);
    if (value.operation === 'read' ? rel !== '' : rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) resourceConflict();
    const text = result.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (!nativeFileResultIncludes(value.operation, rel, text) || hashText(JSON.stringify(result.data.content)) !== value.deliveredHash) resourceConflict();
    if (value.fullBody === true && hashText(text) !== value.fileHash) resourceConflict();
  }
  if (value.nativeEntryId !== null) {
    const native = reader.entry(owner.sessionId, value.nativeEntryId);
    if (native?.type !== 'message' || native.message.role !== 'toolResult' || native.message.toolCallId !== value.nativeToolCallId
      || reader.tool(owner.sessionId, value.nativeToolCallId, true).toolCallId !== value.toolCallId
      || reader.resolve(owner.sessionId, value.nativeEntryId).originRunId !== owner.runId
      || hashText(JSON.stringify(native.message.content)) !== value.deliveredHash) resourceConflict();
  }
}

export function readResourceReads(db: Database, owner: RunResourceQuery, reader = createNativeOriginReader(db)): readonly ResourceReadEvidence[] {
  const row = runRowSchema.parse(db.query('SELECT * FROM runs WHERE id=?').get(owner.runId));
  if (row.session_id !== owner.sessionId) resourceConflict();
  const reads = readRunContext(row).observations?.resources?.reads ?? [];
  for (const value of reads) verifyResourceReadOwner(db, owner, value, reader);
  return reads;
}

function verifyResourceRequestOwner(db: Database, value: ResourceRequestEvidence, row: RunRow, observations: ContextObservations, reader = createNativeOriginReader(db)) {
  const owner = { row, observations, frozen: frozenResources(json(row.config_json)) };
  if (!owner.observations?.resources) resourceConflict();
  // Reuse complete proofs only within this immutable validation batch.
  const reads = new Map<string, readonly ResourceReadEvidence[]>();
  const verifiedReads = (owner: RunResourceQuery) => {
    const key = JSON.stringify([owner.sessionId, owner.runId]);
    if (!reads.has(key)) reads.set(key, readResourceReads(db, owner, reader));
    return reads.get(key)!;
  };
  const binding = value.purpose === 'answer' ? owner.observations.requests.find(item => item.binding.callSequence === value.callSequence)?.binding : null;
  const operation = value.purpose === 'compaction' ? owner.observations.compactions?.find(item => item.operationId === value.compactionOperationId) : null;
  const summary = operation?.calls.find(call => call.modelCallIndex === value.callSequence);
  if (value.purpose === 'answer' && (!binding || value.bundleHash !== (owner.frozen?.bundleHash ?? null))
    || value.purpose === 'compaction' && !summary) resourceConflict();
  const prefix = operation ? reader.path(owner.row.session_id!, operation.baseline.leafId) : [];
  const inputs = binding?.includedBindings ?? prefix.filter(entry => entry.type === 'message' && entry.message.role === 'user')
    .map(entry => reader.resolve(owner.row.session_id!, entry.id));
  const tools = binding?.includedToolResults ?? prefix.flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult'
    ? [reader.tool(owner.row.session_id!, entry.message.toolCallId, true)] : []);
  if (value.inputIds.some(inputId => !inputs.some(source => source.inputId === inputId))
    || value.toolCallIds.some(toolCallId => !tools.some(source => source.toolCallId === toolCallId))) resourceConflict();
  if (value.contentChecks.length === 0 && value.referencedBundleHashes.length === 0) return;
  const available = new Map<string, FrozenResources>();
  if (owner.frozen && value.purpose === 'answer') available.set(owner.frozen.bundleHash, owner.frozen);
  for (const source of [...inputs, ...tools]) {
    if (source.originRunId === null) continue;
    const row = z.object({ config_json: z.string() }).parse(db.query('SELECT config_json FROM runs WHERE id=?').get(source.originRunId));
    const frozen = frozenResources(json(row.config_json));
    if (frozen) available.set(frozen.bundleHash, frozen);
  }
  const derived = binding && 'includedNativeContexts' in binding ? z.array(NativeDerivedContextBindingSchema).parse(binding.includedNativeContexts) : [];
  const derivedIds = binding ? derived.map(source => source.nativeEntryId) : prefix.filter(entry => entry.type === 'compaction').map(entry => entry.id);
  for (const source of derived) {
    reader.derived(owner.row.session_id!, source);
    const entry = reader.entry(owner.row.session_id!, source.nativeEntryId);
    if (entry?.type !== 'compaction') continue;
    for (const original of reader.path(owner.row.session_id!, entry.parentId)) {
      const origin = reader.resolve(owner.row.session_id!, original.id);
      if (origin.originRunId === null) continue;
      const row = z.object({ config_json: z.string() }).parse(db.query('SELECT config_json FROM runs WHERE id=?').get(origin.originRunId));
      const frozen = frozenResources(json(row.config_json));
      if (frozen) available.set(frozen.bundleHash, frozen);
    }
  }
  if (value.referencedBundleHashes.some(hash => !available.has(hash))) resourceConflict();
  for (const check of value.contentChecks) {
    if (check.scope === 'skill-readiness') {
      const entry = owner.frozen?.skillIndex?.entries.find(entry => same(entry.ref, check.ref));
      if (!entry || value.purpose !== 'answer' || check.nativeEntryId !== null || check.path !== null) resourceConflict();
      const scope = z.object({ scope_json: z.string() }).parse(db.query('SELECT scope_json FROM runs WHERE id=?').get(owner.row.id));
      const tools = z.object({ allowedTools: z.array(z.string()).optional() }).parse(json(scope.scope_json)).allowedTools ?? [];
      const child = owner.row.kind === 'subagent';
      const visible = child ? visibleFrozenSkills(owner.frozen!, tools) : owner.frozen!.discoveredSkills;
      if (check.expectedTextHash !== hashText(formatSkillReadinessSection(entry!, tools, visible, child))) resourceConflict();
      continue;
    }
    if (![...available.values()].some(frozen => includesResource(frozen, check.ref))) resourceConflict();
    if (check.scope === 'business-prompt' || check.scope === 'skill-index') {
      if (value.purpose !== 'answer' || check.nativeEntryId !== null || !includesResource(owner.frozen, check.ref)) resourceConflict();
    }
    if (check.scope === 'expanded-body') {
      const source = inputs.find(source => source.nativeEntryId === check.nativeEntryId);
      if (!source || source.inputId === null || source.originRunId === null) resourceConflict();
      const origin = reader.resolve(owner.row.session_id!, source.nativeEntryId);
      const receipt = readResourceExpansion(db, { sessionId: origin.originSessionId, runId: source.originRunId }, source.inputId, source.nativeEntryId);
      if (!receipt || !same(receipt.skill, check.ref) || receipt.expandedTextHash !== check.expectedTextHash || !value.referencedBundleHashes.includes(receipt.bundleHash)) resourceConflict();
    }
    if (check.scope === 'tool-output') {
      if (check.nativeEntryId === null) resourceConflict();
      const native = reader.entry(owner.row.session_id!, check.nativeEntryId!);
      if (native?.type !== 'message' || native.message.role !== 'toolResult') resourceConflict();
      const origin = reader.resolve(owner.row.session_id!, check.nativeEntryId!);
      if (origin.originRunId === null) resourceConflict();
      const receipts = verifiedReads({ sessionId: origin.originSessionId, runId: origin.originRunId });
      if (!receipts.some(receipt => receipt.nativeEntryId === check.nativeEntryId && same(receipt.ref, check.ref) && receipt.path === check.path && value.referencedBundleHashes.includes(receipt.bundleHash))
        || hashText(native.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')) !== check.expectedTextHash) resourceConflict();
    }
    if (check.scope === 'derived-source') {
      if (check.nativeEntryId === null || !derivedIds.includes(check.nativeEntryId)) resourceConflict();
      const summary = reader.entry(owner.row.session_id!, check.nativeEntryId!);
      if (summary?.type !== 'compaction') resourceConflict();
      const originals = reader.path(owner.row.session_id!, summary!.parentId);
      const cut = originals.findIndex(entry => entry.id === summary!.firstKeptEntryId);
      let found = false;
      for (const entry of originals.slice(0, Math.max(0, cut))) {
        if (entry.type !== 'message' || entry.message.role !== 'user' && entry.message.role !== 'toolResult') continue;
        const origin = reader.resolve(owner.row.session_id!, entry.id); if (origin.originRunId === null) continue;
        const originalOwner = { sessionId: origin.originSessionId, runId: origin.originRunId };
        if (entry.message.role === 'user' && origin.inputId !== null) {
          const receipt = readResourceExpansion(db, originalOwner, origin.inputId, entry.id);
          if (receipt && same(receipt.skill, check.ref) && (check.path === null || check.path === 'SKILL.md')
            && value.referencedBundleHashes.includes(receipt.bundleHash)) found = true;
        } else if (entry.message.role === 'toolResult' && verifiedReads(originalOwner).some(receipt => receipt.nativeEntryId === entry.id
          && same(receipt.ref, check.ref) && (check.path === null || check.path === receipt.path) && value.referencedBundleHashes.includes(receipt.bundleHash))) found = true;
      }
      if (!found) resourceConflict();
    }
    if (check.nativeEntryId !== null) {
      const direct = inputs.some(source => source.nativeEntryId === check.nativeEntryId)
        || derivedIds.includes(check.nativeEntryId);
      const native = reader.entry(owner.row.session_id!, check.nativeEntryId!);
      const tool = native?.type === 'message' && native.message.role === 'toolResult' && tools.some(source =>
        source.nativeToolCallId === native.message.toolCallId && reader.resolve(owner.row.session_id!, check.nativeEntryId!).originRunId === source.originRunId);
      if (!direct && !tool) resourceConflict();
    }
  }
}

function verifyResourceExpansionOwner(db: Database, owner: RunResourceQuery, value: ResourceExpansionEvidence): ContextObservations & { resources: ResourceEvidenceJournal } {
  const row = runRowSchema.parse(db.query('SELECT * FROM runs WHERE id=?').get(owner.runId));
  if (!['agent', 'subagent'].includes(row.kind) || row.session_id !== owner.sessionId) resourceConflict();
  const config = json(row.config_json), frozen = frozenResources(config);
  const observations = readRunContext(row).observations;
  if (!observations?.resources || !frozen || value.bundleHash !== frozen.bundleHash || !includesResource(frozen, value.skill)) resourceConflict();
  const input = z.object({ run_id: id, session_id: id, native_entry_id: z.literal(value.nativeEntryId),
    status: z.literal('consumed'), content_json: z.string() }).parse(db.query('SELECT * FROM session_inputs WHERE id=?').get(value.inputId));
  const content = SessionInputContentV2Schema.parse(json(input.content_json));
  if (input.run_id !== owner.runId || input.session_id !== owner.sessionId
    || !matchesResourceBinding(frozen, content.resourceBinding) || !same(content.resourceBinding?.requiredSkill, value.skill)) resourceConflict();
  const entry = z.object({ run_id: id, entry_json: z.string() }).parse(db.query(
    'SELECT run_id,entry_json FROM session_native_entries WHERE session_id=? AND entry_id=?').get(owner.sessionId, value.nativeEntryId));
  const user = z.object({ type: z.literal('message'), message: z.object({ role: z.literal('user'),
    content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]) }) }).parse(json(entry.entry_json));
  const text = typeof user.message.content === 'string' ? user.message.content : user.message.content.map(item => item.text).join('');
  if (entry.run_id !== owner.runId || hashText(text) !== value.expandedTextHash) resourceConflict();
  return { ...observations, resources: observations.resources };
}

export function readResourceExpansion(db: Database, owner: RunResourceQuery, inputId: number, nativeEntryId: string): ResourceExpansionEvidence | null {
  const row = runRowSchema.parse(db.query('SELECT * FROM runs WHERE id=?').get(owner.runId));
  const journal = readRunContext(row).observations?.resources;
  const content = SessionInputContentV2Schema.parse(json(z.object({ content_json: z.string() }).parse(db.query('SELECT content_json FROM session_inputs WHERE id=?').get(inputId)).content_json));
  const receipt = journal?.expansions.find(item => item.inputId === inputId || item.nativeEntryId === nativeEntryId) ?? null;
  if (!receipt) { if (content.resourceBinding?.requiredSkill) resourceConflict(); return null; }
  if (receipt.inputId !== inputId || receipt.nativeEntryId !== nativeEntryId) resourceConflict();
  verifyResourceExpansionOwner(db, owner, receipt); return receipt;
}

/** This runs after the original native receipt CAS, inside that same transaction. */
export function appendResourceExpansionInTransaction(db: Database, owner: RunResourceQuery, raw: ResourceExpansionEvidence): void {
  if (!db.inTransaction) resourceConflict();
  const value = ResourceExpansionEvidenceSchema.parse(raw), observations = verifyResourceExpansionOwner(db, owner, value);
  const previous = observations.resources.expansions.find(item => item.inputId === value.inputId || item.nativeEntryId === value.nativeEntryId);
  if (previous) { if (!same({ ...previous, at: value.at }, value)) resourceConflict(); return; }
  const resources = ResourceEvidenceJournalSchema.parse({ ...observations.resources, expansions: [...observations.resources.expansions, value] });
  const next = { ...observations, resources };
  if (bytes(next) > 4194304) resourceConflict();
  if (db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify(next), owner.runId).changes !== 1) resourceConflict();
}

/** Pre-015 rows have no columns. Their absent fields retain the same explicit NULL semantics. */
export function contextReferenceFromColumns(row: { context_snapshot_id?: number | null; request_sequence?: number | null }): ContextReference | null {
  const snapshotId = row.context_snapshot_id ?? null, requestSequence = row.request_sequence ?? null;
  if (snapshotId === null && requestSequence === null) return null;
  return ContextReferenceSchema.parse({ snapshotId, requestSequence });
}
export function readRunContext(row: { id: number; kind: string; session_id: number | null;
  config_json: string; current_context_snapshot_id?: number | null; context_observations_json?: string | null }) {
  const config = z.record(z.unknown()).parse(json(row.config_json));
  const enabled = config.contextPolicyVersion === 'p8-context-v1';
  if (Object.hasOwn(config, 'contextPolicyVersion') && !enabled) throw new Error('invalid_context_policy');
  const pointer = row.current_context_snapshot_id ?? null;
  if (pointer !== null) id.parse(pointer);
  const raw = row.context_observations_json ?? null;
  if (enabled !== (raw !== null) || !['agent', 'subagent'].includes(row.kind) && (enabled || pointer !== null)) throw new Error('invalid_context_run_state');
  let observations: ContextObservations | null = null;
  if (raw !== null) {
    const decoded = json(raw);
    if (config.historyPolicyVersion === 'p9-native-history-v1') {
      if (!NativeContextObservationsSchema.safeParse(decoded).success) {
        // Preserve malformed-storage precedence; valid legacy shape is still
        // insufficient proof for a marked Run. Neither path projects public DTOs.
        ContextObservationsSchema.parse(decoded);
        throw new NativeOriginFault(appError('context_binding_unknown', 'runtime', 'Stored native context evidence is invalid or was not collected.'));
      }
      // Preserve the stored object's ordering and optional-field presence.
      observations = decoded as ContextObservations;
    } else observations = ContextObservationsSchema.parse(decoded);
    if (!Object.hasOwn(config, 'historyPolicyVersion')) {
      // Legacy public projection adds nullable fields and can cross the 4 MiB
      // boundary even when stored bytes fit. Preserve that original refusal.
      const checked = readContextObservations(decoded);
      if (!checked.ok) throw new NativeOriginFault(checked.error);
    }
  }
  if (Object.hasOwn(config, 'historyPolicyVersion') && config.historyPolicyVersion !== 'p9-native-history-v1') unknownBinding();
  if (observations !== null) {
    const agent = z.object({ nativeSessionId: z.string().min(1).max(256) }).parse(config.agent);
    if (observations.requests.some(request => request.binding.runId !== row.id || request.binding.sessionId !== row.session_id
      || request.binding.nativeSessionId !== agent.nativeSessionId)) throw new Error('invalid_context_journal_identity');
    if (observations.compactions?.length) {
      CompactionPolicySchema.parse(config.compactionPolicy);
      if (config.historyPolicyVersion !== 'p9-native-history-v1' || observations.compactions.some(value =>
        value.runId !== row.id || value.sessionId !== row.session_id || value.nativeSessionId !== agent.nativeSessionId))
        throw new Error('invalid_compaction_journal_identity');
    }
  }
  if (!enabled && pointer !== null) throw new Error('unexpected_legacy_context_pointer');
  return { pointer, observations };
}

export function readContextSnapshotOwner(db: Database, snapshotId: number, owner: { id: number; session_id: number | null; job_id?: number | null }): ContextSnapshot {
  const row = z.object({ id, session_id: id, run_id: id, job_id: id.nullable(), sequence: id,
    snapshot_json: z.string(), created_at: z.string() }).parse(db.query('SELECT * FROM context_snapshots WHERE id=?').get(snapshotId));
  const snapshot = ContextSnapshotSchema.parse({ id: row.id, sessionId: row.session_id, runId: row.run_id, jobId: row.job_id,
    sequence: row.sequence, json: json(row.snapshot_json), createdAt: row.created_at });
  if (snapshot.runId !== owner.id || snapshot.sessionId !== owner.session_id || snapshot.jobId !== (owner.job_id ?? null)) throw new Error('invalid_context_owner');
  const config = z.object({ config_json: z.string() }).parse(db.query('SELECT config_json FROM runs WHERE id=?').get(owner.id));
  const resources = z.object({ resources: FrozenResourcesSchema.optional() }).parse(json(config.config_json)).resources ?? null;
  if (!same(snapshot.json.research ?? null, readResearchContext(db, owner.id))) throw new Error('invalid_context_research_binding');
  if (!matchesResourceBinding(resources, snapshot.json.resourceBinding)) throw new Error('invalid_context_resource_binding');
  return snapshot;
}

type ContextOwnerRow = Parameters<typeof readRunContext>[0] & { job_id?: number | null };
/** Allocate per immutable read batch; never carry proofs across a write or another transaction. */
export type ContextOwnerCache = Map<number, { row: ContextOwnerRow; context: ReturnType<typeof readRunContext> }>;
export function readRunContextOwner(db: Database, row: ContextOwnerRow, owners?: ContextOwnerCache) {
  const cached = owners?.get(row.id);
  if (cached && cached.row.kind === row.kind && cached.row.session_id === row.session_id && cached.row.job_id === row.job_id
    && cached.row.config_json === row.config_json && cached.row.current_context_snapshot_id === row.current_context_snapshot_id
    && cached.row.context_observations_json === row.context_observations_json) return cached.context;
  const context = readRunContext(row);
  if (context.pointer !== null) readContextSnapshotOwner(db, context.pointer, row);
  for (const request of context.observations?.requests ?? []) {
    readContextSnapshotOwner(db, request.binding.snapshotId, row);
    const primary = [...request.binding.includedBindings].reverse().find(source => source.originRunId === row.id && source.snapshotId !== null);
    const saved = z.object({ id, run_id: id, session_id: id, context_snapshot_id: id, status: z.literal('consumed'), native_entry_id: z.string().min(1) })
      .parse(db.query('SELECT id,run_id,session_id,context_snapshot_id,status,native_entry_id FROM session_inputs WHERE id=?').get(request.binding.inputId));
    if (saved.run_id !== row.id || saved.session_id !== row.session_id || saved.context_snapshot_id !== request.binding.snapshotId
      || (primary ? saved.native_entry_id !== primary.nativeEntryId
        : !('includedNativeContexts' in request.binding && request.binding.includedNativeContexts.some(source => source.entryType === 'compaction'
          && createNativeOriginReader(db).compactionCoversEntry(saved.session_id, source.nativeEntryId, saved.native_entry_id)))))
      throw new Error('invalid_context_request_input');
  }
  if (context.observations !== null) verifySavedSources(db, context.observations);
  for (const value of context.observations?.resources?.expansions ?? [])
    verifyResourceExpansionOwner(db, { sessionId: row.session_id!, runId: row.id }, value);
  const resourceReader = createNativeOriginReader(db);
  for (const value of context.observations?.resources?.reads ?? [])
    verifyResourceReadOwner(db, { sessionId: row.session_id!, runId: row.id }, value, resourceReader);
  for (const value of context.observations?.resources?.requests ?? [])
    verifyResourceRequestOwner(db, value, runRowSchema.parse(row), context.observations!, resourceReader);
  owners?.set(row.id, { row, context });
  return context;
}

/** Read the association against its original Run/request, including readers used on legacy schemas. */
export function readToolContext(db: Database, row: { run_id: number; session_id: number; context_snapshot_id?: number | null; request_sequence?: number | null }, owners?: ContextOwnerCache): ContextReference | null {
  const reference = contextReferenceFromColumns(row);
  const owner = z.object({ id, kind: z.enum(['agent', 'subagent']), session_id: id, job_id: id.nullable(), config_json: z.string(),
    current_context_snapshot_id: id.nullable().optional(), context_observations_json: z.string().nullable().optional() })
    .parse(db.query('SELECT * FROM runs WHERE id=?').get(row.run_id));
  if (owner.session_id !== row.session_id) throw new Error('invalid_context_tool_owner');
  const context = readRunContextOwner(db, owner, owners);
  if ((reference === null) !== (context.observations === null)) throw new Error('invalid_context_tool_pair');
  if (reference !== null) {
    readContextSnapshotOwner(db, reference.snapshotId, owner);
    if (context.observations?.requests[reference.requestSequence - 1]?.binding.snapshotId !== reference.snapshotId) throw new Error('invalid_context_tool_request');
  }
  return reference;
}

export function readInputContext(db: Database, row: { run_id: number | null; session_id: number; context_snapshot_id?: number | null; content_json?: string }, owners?: ContextOwnerCache): number | null {
  const snapshotId = row.context_snapshot_id ?? null;
  if (row.run_id === null) {
    if (snapshotId !== null) throw new Error('invalid_context_input_owner');
    return null;
  }
  const owner = z.object({ id, kind: z.enum(['agent', 'subagent']), session_id: id, job_id: id.nullable(), config_json: z.string(),
    current_context_snapshot_id: id.nullable().optional(), context_observations_json: z.string().nullable().optional() })
    .parse(db.query('SELECT * FROM runs WHERE id=?').get(row.run_id));
  if (owner.session_id !== row.session_id) throw new Error('invalid_context_input_session');
  const context = readRunContextOwner(db, owner, owners);
  if ((snapshotId === null) !== (context.observations === null)) throw new Error('invalid_context_input_pair');
  if (snapshotId !== null) {
    const snapshot = readContextSnapshotOwner(db, snapshotId, owner);
    if (row.content_json !== undefined) {
      const content = z.object({ research: ResearchContextSchema.optional(), resourceBinding: ResourceBindingSchema.optional() }).parse(json(row.content_json));
      if (!same(content.research, snapshot.json.research)) throw new Error('invalid_input_research_binding');
      if (!same(content.resourceBinding, snapshot.json.resourceBinding)) throw new Error('invalid_input_resource_binding');
    }
  }
  return snapshotId;
}

const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const imageBlock = z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).passthrough();
const userMessage = z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]),
  timestamp: z.number().finite() }).passthrough();
/** Validate original saved sources without following today's leaf or recursively reading another journal. */
function verifySavedSources(db: Database, journal: ContextObservations) {
  const reader = createNativeOriginReader(db);
  for (const request of journal.requests) {
    const sessionId = request.binding.sessionId;
    for (const source of request.binding.includedBindings) {
      const { originSessionId: _, ...binding } = reader.resolve(sessionId, source.nativeEntryId);
      const entry = reader.entry(sessionId, source.nativeEntryId);
      if (entry?.type !== 'message' || entry.message.role !== 'user' || !same(binding,source)) unknownBinding();
    }
    for (const source of request.binding.includedToolResults)
      if (!same(reader.tool(sessionId,source.nativeToolCallId,true),source)) unknownBinding();
    if ('includedNativeContexts' in request.binding)
      for (const source of request.binding.includedNativeContexts) reader.derived(sessionId,source);
  }
  for (const value of journal.compactions ?? []) verifyCompactionSources(db, value);
}

/** Validate a historical prefix without equating its receipt with today's leaf. */
function verifyCompactionSources(db: Database, value: RunCompactionEvidence) {
  const reader = createNativeOriginReader(db), stored = reader.history(value.sessionId);
  if (!stored || stored.history.header.id !== value.nativeSessionId
    || value.baseline.commitRevision > stored.commit.commitRevision || value.baseline.entryCount > stored.commit.entryCount)
    unknownBinding();
  const prefix = stored.history.entries.slice(0, value.baseline.entryCount);
  if (value.baseline.leafId !== null && !prefix.some(entry => entry.id === value.baseline.leafId)) unknownBinding();
  if (value.firstKeptEntryId !== null && !reader.path(value.sessionId, value.baseline.leafId).some(entry =>
    entry.id === value.firstKeptEntryId && prefix.some(saved => saved.id === entry.id))) unknownBinding();
  // The complete P9 closure checks Input, Tool and ancestor provenance, not only the cut entry.
  reader.bundle(value.sessionId);
  const receipt = value.observation.saved;
  if (receipt !== null) {
    const entry = stored.history.entries[value.baseline.entryCount];
    if (receipt.commitRevision !== value.baseline.commitRevision + 1 || receipt.entryCount !== value.baseline.entryCount + 1
      || receipt.commitRevision > stored.commit.commitRevision || entry?.type !== 'compaction'
      || entry.id !== value.observation.entryId || entry.parentId !== value.baseline.leafId
      || entry.firstKeptEntryId !== value.firstKeptEntryId) unknownBinding();
    if (reader.resolve(value.sessionId, entry.id).originRunId !== null) unknownBinding();
  } else if (value.observation.entryId !== null) unknownBinding();
}

/** A newer observation may add facts; it cannot revise an already collected fact. */
function verifyCompactionUpdate(previous: RunCompactionEvidence, next: RunCompactionEvidence) {
  const { observation: old, calls: oldCalls, firstKeptEntryId: oldCut, splitTurn: oldSplit, ...oldIdentity } = previous;
  const { observation: observed, calls, firstKeptEntryId: cut, splitTurn, ...identity } = next;
  if (!same(oldIdentity, identity) || observed.observationSequence <= old.observationSequence
    || oldCut !== null && oldCut !== cut || oldSplit !== null && oldSplit !== splitTurn
    || old.generated && !observed.generated || old.stopRequested && !observed.stopRequested || old.stopped && !observed.stopped
    || old.nativeOutcome !== 'pending' && old.nativeOutcome !== observed.nativeOutcome
    || old.entryId !== null && old.entryId !== observed.entryId || old.saved !== null && !same(old.saved, observed.saved)
    || ['preparing', 'compacting', 'stopping', 'ended'].indexOf(observed.phase) < ['preparing', 'compacting', 'stopping', 'ended'].indexOf(old.phase)
    || calls.length < oldCalls.length) conflict();
  for (let index = 0; index < oldCalls.length; index++) {
    const oldCall = oldCalls[index]!, call = calls[index]!;
    if (oldCall.modelCallIndex !== call.modelCallIndex || oldCall.purpose !== call.purpose || !same(oldCall.model, call.model)
      || oldCall.transport !== call.transport || oldCall.sdkPayload !== null && !same(oldCall.sdkPayload, call.sdkPayload)
      || oldCall.attempts.length > call.attempts.length || oldCall.tokens?.usageComplete && !same(oldCall.usage, call.usage)) conflict();
    for (let attempt = 0; attempt < oldCall.attempts.length; attempt++)
      for (const [key, fact] of Object.entries(oldCall.attempts[attempt]!))
        if (fact !== null && !same(fact, Reflect.get(call.attempts[attempt]!, key))) conflict();
  }
}

export function createContextRepository(input: { db: Database; loadHistory(sessionId: number): Result<NativeSessionHistory | null> }): ContextRepository {
  const { db, loadHistory } = input;
  function read<T>(fn: () => T): Result<T> {
    try { return ok(db.inTransaction ? fn() : db.transaction(fn).deferred()); }
    catch (error) { return fail(error instanceof ContextFault || error instanceof NativeOriginFault ? error.error : error instanceof SQLiteError
      ? appError('storage_read_failed', 'storage', 'Context evidence could not be read.', true)
      : appError('storage_corrupt', 'storage', 'Saved Context evidence is invalid.')); }
  }
  function write<T>(fn: () => T): Result<T> {
    try { return ok(db.transaction(fn).immediate()); }
    catch (error) { return fail(error instanceof ContextFault || error instanceof NativeOriginFault ? error.error : appError('storage_write_failed', 'storage', 'Context evidence could not be saved.', true)); }
  }
  function session(sessionId: number) {
    id.parse(sessionId);
    const row = db.query('SELECT id,native_session_id FROM sessions WHERE id=?').get(sessionId);
    if (!row) reject('session_not_found', 'session');
    return z.object({ id, native_session_id: z.string().min(1).max(256) }).parse(row);
  }
  function run(runId: number, sessionId: number, owners?: ContextOwnerCache) {
    id.parse(runId);
    const raw = db.query('SELECT id,kind,session_id,job_id,config_json,current_context_snapshot_id,context_observations_json FROM runs WHERE id=?').get(runId);
    if (!raw) reject('run_not_found', 'runtime');
    const row = runRowSchema.parse(raw);
    if (!['agent', 'subagent'].includes(row.kind) || row.session_id !== sessionId) reject('state_conflict', 'runtime');
    let context: ReturnType<typeof readRunContext>;
    try { context = readRunContextOwner(db, row, owners); } catch (error) { if (error instanceof SQLiteError || error instanceof NativeOriginFault || error instanceof ContextFault) throw error; return corrupt(); }
    return { row, ...context };
  }
  function snapshot(snapshotId: number, owner?: RunRow): ContextSnapshot {
    const raw = db.query('SELECT * FROM context_snapshots WHERE id=?').get(snapshotId);
    if (!raw) reject('context_snapshot_not_found', 'input');
    const row = z.object({ id, session_id: id, run_id: id, job_id: id.nullable(), sequence: id,
      snapshot_json: z.string(), created_at: z.string() }).parse(raw);
    const value = ContextSnapshotSchema.parse({ id: row.id, sessionId: row.session_id, runId: row.run_id, jobId: row.job_id,
      sequence: row.sequence, json: json(row.snapshot_json), createdAt: row.created_at });
    if (owner && (value.runId !== owner.id || value.sessionId !== owner.session_id || value.jobId !== owner.job_id)) reject('state_conflict', 'runtime');
    if (owner && !matchesResourceBinding(frozenResources(json(owner.config_json)), value.json.resourceBinding)) resourceConflict();
    return value;
  }
  function savedInput(raw: unknown): SessionInputSnapshot {
    const row = z.object({ id, session_id: id, client_sequence: id, mode: z.string(), goal_mode: z.string(), run_id: id.nullable(),
      context_snapshot_id: id.nullable(), content_json: z.string(), status: z.string(), processing_status: z.string(),
      native_entry_id: z.string().nullable(), result_entry_id: z.string().nullable(), dispatched_at: z.string().nullable(),
      error_json: z.string().nullable(), created_at: z.string(), updated_at: z.string() }).parse(raw);
    return SessionInputSnapshotSchema.parse({ inputId: row.id, sessionId: row.session_id, clientSequence: row.client_sequence,
      mode: row.mode, goalMode: row.goal_mode, runId: row.run_id, contextSnapshotId: row.context_snapshot_id,
      content: json(row.content_json), status: row.status, processingStatus: row.processing_status, nativeEntryId: row.native_entry_id,
      resultEntryId: row.result_entry_id, dispatchedAt: row.dispatched_at, error: row.error_json === null ? null : json(row.error_json),
      createdAt: row.created_at, updatedAt: row.updated_at });
  }
  function snapshotInput(value: ContextSnapshot, owners?: ContextOwnerCache) {
    const rows = db.query('SELECT * FROM session_inputs WHERE context_snapshot_id=?').all(value.id);
    if (rows.length !== 1) return corrupt();
    const saved = savedInput(rows[0]);
    readInputContext(db, { run_id: saved.runId, session_id: saved.sessionId, context_snapshot_id: saved.contextSnapshotId }, owners);
    if (saved.runId !== value.runId || saved.sessionId !== value.sessionId || saved.content.text !== value.json.text
      || !same(saved.content.version === 2 ? saved.content.resourceBinding : undefined, value.json.resourceBinding)
      || !same(saved.content.version === 2 ? saved.content.research : undefined, value.json.research)
      || saved.goalMode !== value.json.goalMode || !same(saved.content.workspaceContext, value.json.workspaceContext)
      || !same(saved.content.allowedDocumentIds, value.json.allowedDocumentIds)
      || !same(saved.content.allowedArtifactIds, value.json.allowedArtifactIds)) return corrupt();
    return saved;
  }
  function path(sessionId: number) {
    const loaded = loadHistory(sessionId);
    if (!loaded.ok || loaded.data === null || loaded.data.unusable) return unknownBinding();
    const history = loaded.data;
    const entries = new Map(history.entries.map(entry => [entry.id, entry]));
    const selected: NativeSessionHistory['entries'][number][] = [];
    let cursor = history.leafId;
    const visited = new Set<string>();
    while (cursor !== null) {
      const entry = entries.get(cursor);
      if (!entry || visited.has(cursor)) return unknownBinding();
      visited.add(cursor); selected.push(entry); cursor = entry.parentId;
    }
    return selected.reverse();
  }
  function toolResult(input: Parameters<ContextHooks['resolveToolResult']>[0]): NativeToolResultContextBinding {
    const parsed = z.object({ sessionId: id, nativeToolCallId: z.string().min(1).max(256) }).strict().parse(input);
    session(parsed.sessionId);
    return createNativeOriginReader(db).tool(parsed.sessionId,parsed.nativeToolCallId);
  }
  function verifyBinding(binding: RequestContextBinding) {
    const parsed = RequestContextBindingSchema.safeParse(binding);
    if (!parsed.success) return unknownBinding();
    const saved = parsed.data;
    const owner = run(saved.runId, saved.sessionId);
    if (owner.observations === null || session(saved.sessionId).native_session_id !== saved.nativeSessionId) return unknownBinding();
    const selected = path(saved.sessionId);
    const entries = new Map(selected.map((entry, index) => [entry.id, { entry, index }]));
    const reader = createNativeOriginReader(db);
    let previous = -1;
    for (const source of saved.includedBindings) {
      const native = entries.get(source.nativeEntryId);
      if (!native || native.index <= previous || native.entry.type !== 'message' || !userMessage.safeParse(native.entry.message).success) unknownBinding();
      previous = native.index;
      const { originSessionId: _, ...binding } = reader.resolve(saved.sessionId,source.nativeEntryId);
      if (!same(binding,source)) unknownBinding();
    }
    for (const source of saved.includedToolResults)
      if (!same(reader.tool(saved.sessionId, source.nativeToolCallId), source)) unknownBinding();
    for (const source of saved.includedNativeContexts) reader.derived(saved.sessionId,source);
    const primary = snapshotInput(snapshot(saved.snapshotId, owner.row));
    if (primary.inputId !== saved.inputId || primary.sessionId !== saved.sessionId || primary.runId !== saved.runId
      || primary.status !== 'consumed') unknownBinding();
    if (!saved.includedBindings.some(source => source.originRunId === saved.runId && source.inputId === saved.inputId)
      && (primary.nativeEntryId === null || !saved.includedNativeContexts.some(source => source.entryType === 'compaction'
        && reader.compactionCoversEntry(saved.sessionId, source.nativeEntryId, primary.nativeEntryId!)))) unknownBinding();
    snapshot(saved.snapshotId, owner.row);
    return { binding: saved, owner };
  }

  function persist(owner: RunRow, observations: ContextObservations) {
    if (bytes(observations) > 4194304) reject('context_evidence_too_large');
    ContextObservationsSchema.parse(observations);
    if (db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify(observations), owner.id).changes !== 1) throw new Error('context_run_missing');
  }
  function resourceOwner(raw: RunResourceQuery) {
    const query = RunResourceQuerySchema.parse(raw), current = run(query.runId, query.sessionId);
    const config = z.object({ agent: z.object({ nativeSessionId: z.string(), systemPrompt: z.string() }), resources: FrozenResourcesSchema.optional() }).parse(json(current.row.config_json));
    if (config.agent.nativeSessionId !== session(query.sessionId).native_session_id) resourceConflict();
    return { ...current, config, frozen: config.resources ?? null };
  }
  function resourceWrite(action: () => void): Result<void> {
    const result = write(action);
    return !result.ok && result.error.code === 'storage_write_failed' ? fail(appError('resource_evidence_write_failed', 'storage', 'Resource evidence could not be saved.', true)) : result;
  }
  function persistResources(owner: ReturnType<typeof resourceOwner>, resources: ResourceEvidenceJournal) {
    if (!owner.observations?.resources) resourceConflict();
    ResourceEvidenceJournalSchema.parse(resources);
    const next = { ...owner.observations, resources };
    if (bytes(next) > 4194304) resourceConflict();
    if (!same(owner.observations.resources, resources)) persist(owner.row, next);
  }
  function publicSummary(value: ContextSnapshot, owners?: ContextOwnerCache): ContextSnapshotSummary {
    const saved = snapshotInput(value, owners), workspace = value.json.workspaceContext;
    return { id: value.id, sessionId: value.sessionId, runId: value.runId, jobId: value.jobId, sequence: value.sequence,
      createdAt: value.createdAt, inputId: saved.inputId, mode: saved.mode, documentRef: workspace?.documentRef ?? null,
      candidateRef: workspace?.candidateRef ?? null, selection: workspace?.selection ?? null,
      fragmentCount: value.json.modelProjection.fragments.length, gapCount: value.json.modelProjection.gaps.length };
  }
  return {
    readResourceEvidence(raw) { return read(() => resourceOwner(raw).observations?.resources ?? null); },
    recordResourceRead(raw, query) {
      const parsed = ResourceReadEvidenceSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('resource_evidence_conflict', 'runtime', 'Resource read evidence is invalid.'));
      return resourceWrite(() => {
        const value = parsed.data, owner = resourceOwner(query), journal = owner.observations?.resources;
        if (!journal || !includesResource(owner.frozen, value.ref)) resourceConflict();
        verifyResourceReadOwner(db, query, value);
        const key = (item: ResourceReadEvidence) => JSON.stringify([item.toolCallId, item.operation, item.path]);
        const previous = journal.reads.find(item => key(item) === key(value));
        if (previous && (!same({ ...previous, at: value.at, nativeEntryId: value.nativeEntryId }, value)
          || previous.nativeEntryId !== null && previous.nativeEntryId !== value.nativeEntryId)) resourceConflict();
        const reads = previous ? journal.reads.map(item => item === previous ? { ...value, at: previous.at } : item) : [...journal.reads, value];
        persistResources(owner, { ...journal, reads });
      });
    },
    recordResourceRequest(raw, query) {
      const parsed = ResourceRequestEvidenceSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('resource_evidence_conflict', 'runtime', 'Resource request evidence is invalid.'));
      return resourceWrite(() => {
        const value = parsed.data, owner = resourceOwner(query);
        verifyResourceRequestOwner(db, value, owner.row, owner.observations!);
        const journal = owner.observations!.resources!;
        const previous = journal.requests.find(item => item.purpose === value.purpose && item.callSequence === value.callSequence
          && item.compactionOperationId === value.compactionOperationId);
        let next = value;
        if (previous) {
          if (!same({ ...previous, contentChecks: value.contentChecks, at: value.at }, value)
            || previous.contentChecks.length !== value.contentChecks.length) resourceConflict();
          const contentChecks = value.contentChecks.map(check => {
            const original = previous.contentChecks.find(item => resourceContentKey(item) === resourceContentKey(check));
            if (!original || !same({ ...original, sdkInclusion: check.sdkInclusion, wireInclusion: check.wireInclusion, reason: check.reason }, check)
              || original.sdkInclusion !== 'unknown' && original.sdkInclusion !== check.sdkInclusion
              || original.wireInclusion !== 'unknown' && original.wireInclusion !== check.wireInclusion) resourceConflict();
            return check;
          });
          next = { ...value, contentChecks, at: previous.at };
        }
        const requests = previous ? journal.requests.map(item => item === previous ? next : item) : [...journal.requests, next];
        persistResources(owner, { ...journal, requests });
      });
    },
    appendInTransaction(value) {
      if (!db.inTransaction) return fail(appError('state_conflict', 'input', 'Context append requires its admission transaction.'));
      return write(() => {
        const owner = run(value.runId, value.sessionId);
        if (owner.row.job_id !== value.jobId || owner.observations === null) return unknownBinding();
        if (bytes(value.json) > 262144 || bytes(value.json.modelProjection) > 65536) reject('context_evidence_too_large');
        const parsed = ContextSnapshotJsonSchema.parse(value.json);
        if (!matchesResourceBinding(frozenResources(json(owner.row.config_json)), parsed.resourceBinding)) resourceConflict();
        const latest = z.object({ sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
          .parse(db.query('SELECT COALESCE(MAX(sequence),0) AS sequence FROM context_snapshots WHERE run_id=?').get(value.runId));
        if (latest.sequence === Number.MAX_SAFE_INTEGER) reject('context_evidence_too_large');
        const sequence = latest.sequence + 1;
        ContextSnapshotSchema.parse({ id: 1, runId: value.runId, sessionId: value.sessionId, jobId: value.jobId, sequence, json: parsed, createdAt: value.at });
        const inserted = db.query('INSERT INTO context_snapshots(job_id,session_id,run_id,sequence,snapshot_json,created_at) VALUES(?,?,?,?,?,?)')
          .run(value.jobId, value.sessionId, value.runId, sequence, JSON.stringify(parsed), value.at);
        const snapshotId = id.parse(Number(inserted.lastInsertRowid));
        if (db.query('UPDATE runs SET current_context_snapshot_id=? WHERE id=?').run(snapshotId, value.runId).changes !== 1) throw new Error('context_run_missing');
        return snapshot(snapshotId, owner.row);
      });
    },
    bindRequest(value) {
      return write(() => {
        const { binding, owner } = verifyBinding(value.binding);
        const request = ContextRequestEvidenceSchema.parse({ binding, api: value.api, boundAt: value.at,
          sdkPayload: null, transport: value.transport, attempts: [] });
        const observations = owner.observations!;
        const existing = observations.requests[binding.requestSequence - 1];
        if (existing) {
          if (!same(existing.binding, binding) || existing.api !== request.api || existing.boundAt !== request.boundAt || existing.transport !== request.transport) return conflict();
          return;
        }
        if (binding.requestSequence !== observations.requests.length + 1) return conflict();
        if (observations.requests.length === 64) reject('context_evidence_too_large');
        persist(owner.row, { ...observations, requests: [...observations.requests, request] });
      });
    },
    recordRequest(rawBinding, rawUpdate) {
      return write(() => {
        const binding = RequestContextBindingSchema.parse(rawBinding), update = ContextEvidenceUpdateSchema.parse(rawUpdate);
        session(binding.sessionId);
        const owner = run(binding.runId, binding.sessionId);
        const observations = owner.observations;
        const original = observations?.requests[binding.requestSequence - 1];
        if (!original || !same(original.binding, binding)) return conflict();
        // Merge only the original logical request. Terminal Run state and its current pointer are untouched.
        const request = structuredClone(original) as { -readonly [Key in keyof typeof original]: (typeof original)[Key] };
        if (update.kind === 'sdk-payload') {
          const fact = { observedAt: update.at, inclusion: update.inclusion, reason: update.reason,
            ...(update.toolDefinitions === undefined ? {} : { toolDefinitions: update.toolDefinitions }) };
          if (request.sdkPayload !== null && !same(request.sdkPayload, fact)) return conflict();
          request.sdkPayload = fact;
        } else if (update.kind === 'attempt-prepared') {
          if (request.transport !== 'observed-fetch') return conflict();
          const evidence = update.evidence, existing = request.attempts[evidence.attempt - 1];
          if (existing) {
            if (existing.preparedAt !== evidence.preparedAt || existing.wireInclusion !== evidence.wireInclusion || existing.wireReason !== evidence.wireReason
              || !same(existing.toolDefinitions, evidence.toolDefinitions)
              || evidence.enteredAt !== null || evidence.responseAt !== null || evidence.responseStatus !== null
              || evidence.transportErrorCode !== null || evidence.nativeRequestId !== null) return conflict();
          } else {
            if (evidence.attempt !== request.attempts.length + 1 || evidence.enteredAt !== null || evidence.responseAt !== null
              || evidence.responseStatus !== null || evidence.transportErrorCode !== null || evidence.nativeRequestId !== null) return conflict();
            request.attempts = [...request.attempts, evidence];
          }
        } else {
          const attempt = request.attempts[update.attempt - 1];
          if (!attempt) return conflict();
          if (update.kind === 'attempt-entered') {
            if (attempt.enteredAt !== null && attempt.enteredAt !== update.at) return conflict();
            request.attempts = request.attempts.map(item => item.attempt === update.attempt ? { ...item, enteredAt: update.at } : item);
          } else if (update.kind === 'response') {
            if (attempt.transportErrorCode !== null || attempt.responseAt !== null && attempt.responseAt !== update.at
              || attempt.responseStatus !== null && attempt.responseStatus !== update.status
              || attempt.nativeRequestId !== null && update.nativeRequestId !== null && attempt.nativeRequestId !== update.nativeRequestId) return conflict();
            request.attempts = request.attempts.map(item => item.attempt === update.attempt ? { ...item, responseAt: update.at,
              responseStatus: update.status, nativeRequestId: update.nativeRequestId ?? item.nativeRequestId } : item);
          } else {
            if (attempt.responseAt !== null || attempt.transportErrorCode !== null && attempt.transportErrorCode !== update.code) return conflict();
            request.attempts = request.attempts.map(item => item.attempt === update.attempt ? { ...item, transportErrorCode: update.code } : item);
          }
        }
        const requests = observations!.requests.map(item => item.binding.requestSequence === binding.requestSequence ? request : item);
        if (!same(request, original)) persist(owner.row, { ...observations!, requests });
      });
    },
    recordCompactionEvidence(raw) {
      return write(() => {
        const value = RunCompactionEvidenceSchema.parse(raw), owner = run(value.runId, value.sessionId);
        const config = json(owner.row.config_json) as Record<string, unknown>;
        if (owner.observations === null || config.historyPolicyVersion !== 'p9-native-history-v1'
          || !CompactionPolicySchema.safeParse(config.compactionPolicy).success
          || session(value.sessionId).native_session_id !== value.nativeSessionId) unknownBinding();
        const existing = owner.observations.compactions ?? [], index = existing.findIndex(item => item.operationId === value.operationId);
        if (index >= 0 && same(existing[index], value)) return;
        if (index >= 0) verifyCompactionUpdate(existing[index]!, value);
        else {
          const stored = createNativeOriginReader(db).history(value.sessionId);
          if (!stored || !same(stored.commit, value.baseline)) unknownBinding();
          if (existing.length === 64) reject('context_evidence_too_large');
          if (value.observation.generated || value.observation.entryId !== null || value.observation.saved !== null || value.calls.length) unknownBinding();
        }
        verifyCompactionSources(db, value);
        const compactions = index < 0 ? [...existing, value] : existing.map((item, offset) => offset === index ? value : item);
        persist(owner.row, { ...owner.observations, compactions });
      });
    },
    readCompactionEvidence(value) {
      return read(() => {
        const request = z.object({ sessionId: id, runId: id, operationId: z.string().uuid().optional() }).strict().parse(value);
        session(request.sessionId);
        const owner = run(request.runId, request.sessionId);
        return (owner.observations?.compactions ?? []).filter(item => request.operationId === undefined || item.operationId === request.operationId);
      });
    },
    resolveToolResult(value) { return read(() => toolResult(value)); },
    listContextSnapshots(value) {
      const normalized = ContextSnapshotsRequestSchema.safeParse(value);
      if (!normalized.success) return fail(appError('input_invalid', 'input', 'Context query is invalid.'));
      return read(() => {
        const owners: ContextOwnerCache = new Map();
        const request = normalized.data;
        session(request.sessionId);
        if (request.runId !== undefined) run(request.runId, request.sessionId, owners);
        const rows = db.query(`SELECT id FROM context_snapshots WHERE session_id=? AND (? IS NULL OR run_id=?)
          AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`).all(request.sessionId, request.runId ?? null, request.runId ?? null,
          request.beforeId ?? null, request.beforeId ?? null, request.limit + 1);
        const page: ContextSnapshotsPage = { sessionId: request.sessionId, runId: request.runId ?? null, items: [], nextBeforeId: null };
        for (const raw of rows) {
          if (page.items.length === request.limit) break;
          const value = snapshot(z.object({ id }).parse(raw).id);
          const owner = run(value.runId, request.sessionId, owners);
          if (value.jobId !== owner.row.job_id) return corrupt();
          const item = publicSummary(value, owners);
          const candidate = { ...page, items: [...page.items, item], nextBeforeId: item.id };
          if (bytes(ok(candidate)) > 131072) { if (!page.items.length) reject('context_evidence_too_large'); break; }
          page.items = candidate.items;
        }
        page.nextBeforeId = rows.length > page.items.length ? page.items.at(-1)?.id ?? null : null;
        return ContextSnapshotsResultSchema.parse(ok(page)).ok ? page : corrupt();
      });
    },
    queryContextSnapshot(value) {
      const normalized = ContextSnapshotRequestSchema.safeParse(value);
      if (!normalized.success) return fail(appError('input_invalid', 'input', 'Context query is invalid.'));
      return read(() => {
        const request = normalized.data;
        session(request.sessionId);
        const owner = run(request.runId, request.sessionId), savedSnapshot = snapshot(request.snapshotId, owner.row), saved = snapshotInput(savedSnapshot);
        const { workingDirectory, allowedDocumentIds: _documents, allowedArtifactIds: _artifacts, ...publicJson } = savedSnapshot.json;
        const { content: _content, contextSnapshotId: _context, ...input } = saved;
        let error = null;
        if (input.error !== null) {
          const projected = ContextInputErrorSchema.safeParse({ code: input.error.code, category: input.error.category, retryable: input.error.retryable });
          error = projected.success ? projected.data : { code: 'internal_error' as const, category: 'internal' as const, retryable: false };
        }
        const detail = ContextSnapshotDetailSchema.parse({ snapshot: { ...savedSnapshot, json: { ...publicJson, hasWorkingDirectory: workingDirectory !== null } },
          input: { ...input, error } });
        if (bytes(ok(detail)) > 524288) reject('context_evidence_too_large');
        ContextSnapshotResultSchema.parse(ok(detail));
        return detail;
      });
    },
    listContextRequests(value) {
      const normalized = ContextRequestsRequestSchema.safeParse(value);
      if (!normalized.success) return fail(appError('input_invalid', 'input', 'Context query is invalid.'));
      return read(() => {
        const request = normalized.data;
        session(request.sessionId);
        const owner = run(request.runId, request.sessionId);
        const projected = owner.observations === null ? null : readContextObservations(owner.observations,
          JSON.parse(owner.row.config_json).historyPolicyVersion);
        if (projected && !projected.ok) throw new NativeOriginFault(projected.error);
        const matching = [...(projected?.ok ? projected.data.requests : [])].reverse()
          .filter(item => request.beforeRequestSequence === undefined || item.binding.requestSequence < request.beforeRequestSequence);
        const page: ContextRequestsPage = { sessionId: request.sessionId, runId: request.runId,
          collection: owner.observations === null ? 'not-collected' : 'collected', items: [], nextBeforeRequestSequence: null };
        for (const item of matching.slice(0, request.limit + 1)) {
          if (page.items.length === request.limit) break;
          const candidate = { ...page, items: [...page.items, item], nextBeforeRequestSequence: item.binding.requestSequence };
          if (bytes(ok(candidate)) > 1048576) { if (!page.items.length) reject('context_evidence_too_large'); break; }
          page.items = candidate.items;
        }
        page.nextBeforeRequestSequence = matching.length > page.items.length ? page.items.at(-1)?.binding.requestSequence ?? null : null;
        ContextRequestsResultSchema.parse(ok(page));
        return page;
      });
    },
  };
}
