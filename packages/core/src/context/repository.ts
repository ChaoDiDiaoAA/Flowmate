import { SQLiteError, type Database } from 'bun:sqlite';
import { z } from 'zod';
import { appError, fail, ok, ContextSnapshotSchema, ContextSnapshotJsonSchema, ContextReferenceSchema,
  ContextObservationsSchema, RequestContextBindingSchema, ContextEvidenceUpdateSchema, ContextRequestEvidenceSchema,
  NativeToolResultContextBindingSchema, ContextSnapshotsRequestSchema, ContextSnapshotRequestSchema,
  ContextRequestsRequestSchema, ContextSnapshotDetailSchema, ContextInputErrorSchema,
  ContextSnapshotsResultSchema, ContextSnapshotResultSchema, ContextRequestsResultSchema,
  SessionInputSnapshotSchema } from '@flowmate/contracts';
import type { AppError, Result, ContextSnapshot, ContextSnapshotJson, ContextReference, ContextHooks,
  RequestContextBinding, ContextEvidenceUpdate, ContextObservations, ContextRequestEvidence,
  NativeToolResultContextBinding, NativeSessionHistory, ContextSnapshotsRequest, ContextSnapshotsPage,
  ContextSnapshotRequest, ContextSnapshotDetail, ContextRequestsRequest, ContextRequestsPage,
  ContextSnapshotSummary, SessionInputSnapshot } from '@flowmate/contracts';

export interface ContextRepository {
  appendInTransaction(input: { runId: number; sessionId: number; jobId: number | null; json: ContextSnapshotJson; at: string }): Result<ContextSnapshot>;
  bindRequest(input: Parameters<ContextHooks['bind']>[0]): Result<void>;
  recordRequest(binding: RequestContextBinding, update: ContextEvidenceUpdate): Result<void>;
  resolveToolResult(input: Parameters<ContextHooks['resolveToolResult']>[0]): Result<NativeToolResultContextBinding>;
  listContextSnapshots(request: ContextSnapshotsRequest): Result<ContextSnapshotsPage>;
  queryContextSnapshot(request: ContextSnapshotRequest): Result<ContextSnapshotDetail>;
  listContextRequests(request: ContextRequestsRequest): Result<ContextRequestsPage>;
}

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const runRowSchema = z.object({ id, kind: z.enum(['agent', 'provider']), session_id: id.nullable(), job_id: id.nullable(),
  config_json: z.string(), current_context_snapshot_id: id.nullable(), context_observations_json: z.string().nullable() });
type RunRow = z.infer<typeof runRowSchema>;
const json = (value: string): unknown => JSON.parse(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
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
  if (enabled !== (raw !== null) || row.kind !== 'agent' && (enabled || pointer !== null)) throw new Error('invalid_context_run_state');
  const observations = raw === null ? null : ContextObservationsSchema.parse(json(raw));
  if (observations !== null) {
    const agent = z.object({ nativeSessionId: z.string().min(1).max(256) }).parse(config.agent);
    if (observations.requests.some(request => request.binding.runId !== row.id || request.binding.sessionId !== row.session_id
      || request.binding.nativeSessionId !== agent.nativeSessionId)) throw new Error('invalid_context_journal_identity');
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
  return snapshot;
}

export function readRunContextOwner(db: Database, row: Parameters<typeof readRunContext>[0] & { job_id?: number | null }) {
  const context = readRunContext(row);
  if (context.pointer !== null) readContextSnapshotOwner(db, context.pointer, row);
  for (const request of context.observations?.requests ?? []) {
    readContextSnapshotOwner(db, request.binding.snapshotId, row);
    const primary = [...request.binding.includedBindings].reverse().find(source => source.originRunId === row.id && source.snapshotId !== null);
    const saved = z.object({ id, run_id: id, session_id: id, context_snapshot_id: id, status: z.literal('consumed'), native_entry_id: z.string().min(1) })
      .parse(db.query('SELECT id,run_id,session_id,context_snapshot_id,status,native_entry_id FROM session_inputs WHERE id=?').get(request.binding.inputId));
    if (saved.run_id !== row.id || saved.session_id !== row.session_id || saved.context_snapshot_id !== request.binding.snapshotId
      || saved.native_entry_id !== primary?.nativeEntryId) throw new Error('invalid_context_request_input');
  }
  if (context.observations !== null) verifySavedSources(db, context.observations);
  return context;
}

/** Read the association against its original Run/request, including readers used on legacy schemas. */
export function readToolContext(db: Database, row: { run_id: number; session_id: number; context_snapshot_id?: number | null; request_sequence?: number | null }): ContextReference | null {
  const reference = contextReferenceFromColumns(row);
  const owner = z.object({ id, kind: z.literal('agent'), session_id: id, job_id: id.nullable(), config_json: z.string(),
    current_context_snapshot_id: id.nullable().optional(), context_observations_json: z.string().nullable().optional() })
    .parse(db.query('SELECT * FROM runs WHERE id=?').get(row.run_id));
  if (owner.session_id !== row.session_id) throw new Error('invalid_context_tool_owner');
  const context = readRunContextOwner(db, owner);
  if ((reference === null) !== (context.observations === null)) throw new Error('invalid_context_tool_pair');
  if (reference !== null) {
    readContextSnapshotOwner(db, reference.snapshotId, owner);
    if (context.observations?.requests[reference.requestSequence - 1]?.binding.snapshotId !== reference.snapshotId) throw new Error('invalid_context_tool_request');
  }
  return reference;
}

export function readInputContext(db: Database, row: { run_id: number | null; session_id: number; context_snapshot_id?: number | null }): number | null {
  const snapshotId = row.context_snapshot_id ?? null;
  if (row.run_id === null) {
    if (snapshotId !== null) throw new Error('invalid_context_input_owner');
    return null;
  }
  const owner = z.object({ id, kind: z.literal('agent'), session_id: id, job_id: id.nullable(), config_json: z.string(),
    current_context_snapshot_id: id.nullable().optional(), context_observations_json: z.string().nullable().optional() })
    .parse(db.query('SELECT * FROM runs WHERE id=?').get(row.run_id));
  if (owner.session_id !== row.session_id) throw new Error('invalid_context_input_session');
  const context = readRunContextOwner(db, owner);
  if ((snapshotId === null) !== (context.observations === null)) throw new Error('invalid_context_input_pair');
  if (snapshotId !== null) readContextSnapshotOwner(db, snapshotId, owner);
  return snapshotId;
}

const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const imageBlock = z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string().min(1) }).passthrough();
const userMessage = z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]),
  timestamp: z.number().finite() }).passthrough();
const resultMessage = z.object({ role: z.literal('toolResult'), toolCallId: z.string().min(1).max(256), toolName: z.string().min(1),
  content: z.array(z.union([textBlock, imageBlock])), isError: z.boolean(), timestamp: z.number().finite() }).passthrough();
const callBlock = z.object({ type: z.literal('toolCall'), id: z.string().min(1).max(256), name: z.string().min(1),
  arguments: z.record(z.unknown()) }).passthrough();
const usageSchema = z.object({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
  cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative(), totalTokens: z.number().finite().nonnegative(),
  cost: z.object({ input: z.number().finite().nonnegative(), output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(), cacheWrite: z.number().finite().nonnegative(), total: z.number().finite().nonnegative() }) });
const assistantMessage = z.object({ role: z.literal('assistant'), content: z.array(z.union([textBlock,
  z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough(), callBlock])),
  api: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), usage: usageSchema,
  stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']), timestamp: z.number().finite() }).passthrough();

/** Validate original saved sources without following today's leaf or recursively reading another journal. */
function verifySavedSources(db: Database, journal: ContextObservations) {
  const sourceRunSchema = z.object({ id, kind: z.literal('agent'), session_id: id, job_id: id.nullable(), config_json: z.string(),
    current_context_snapshot_id: id.nullable().optional(), context_observations_json: z.string().nullable().optional() });
  const runs = new Map<number, { row: z.infer<typeof sourceRunSchema>; context: ReturnType<typeof readRunContext> }>();
  const tools = new Map<number, z.infer<typeof toolSourceSchema>>();
  const snapshots = new Map<number, ContextSnapshot>();
  const legacyTools = new Set<string>();
  const toolSourceSchema = z.object({ id, run_id: id, session_id: id, native_tool_call_id: z.string(), context_snapshot_id: id.nullable(), request_sequence: id.nullable() });
  function origin(runId: number, sessionId: number) {
    let saved = runs.get(runId);
    if (!saved) {
      const row = sourceRunSchema.parse(db.query('SELECT * FROM runs WHERE id=?').get(runId));
      saved = { row, context: readRunContext(row) }; runs.set(runId, saved);
    }
    if (saved.row.session_id !== sessionId) throw new Error('invalid_context_source_session');
    return saved;
  }
  function originalSnapshot(snapshotId: number, owner: z.infer<typeof sourceRunSchema>) {
    let snapshot = snapshots.get(snapshotId);
    if (!snapshot) { snapshot = readContextSnapshotOwner(db, snapshotId, owner); snapshots.set(snapshotId, snapshot); }
    if (snapshot.runId !== owner.id || snapshot.sessionId !== owner.session_id || snapshot.jobId !== owner.job_id) throw new Error('invalid_context_source_snapshot');
  }
  for (const request of journal.requests) {
    const sessionId = request.binding.sessionId;
    for (const source of request.binding.includedBindings) {
      const native = z.object({ entry_id: z.string(), entry_json: z.string(), run_id: id.nullable() })
        .parse(db.query('SELECT entry_id,entry_json,run_id FROM session_native_entries WHERE session_id=? AND entry_id=?').get(sessionId, source.nativeEntryId));
      const entry = z.object({ type: z.literal('message'), id: z.string(), message: userMessage }).passthrough().parse(json(native.entry_json));
      if (entry.id !== source.nativeEntryId || native.run_id !== source.originRunId) throw new Error('invalid_context_source_entry');
      if (source.inputId === null) {
        if (db.query('SELECT id FROM session_inputs WHERE session_id=? AND native_entry_id=?').get(sessionId, source.nativeEntryId)
          || source.originRunId !== null && origin(source.originRunId, sessionId).context.observations !== null) throw new Error('invalid_context_preledger_source');
      } else {
        const input = z.object({ id, run_id: id, session_id: id, native_entry_id: z.string(), context_snapshot_id: id.nullable(), status: z.literal('consumed') })
          .parse(db.query('SELECT id,run_id,session_id,native_entry_id,context_snapshot_id,status FROM session_inputs WHERE id=?').get(source.inputId));
        if (input.session_id !== sessionId || input.run_id !== source.originRunId || input.native_entry_id !== source.nativeEntryId
          || input.context_snapshot_id !== source.snapshotId) throw new Error('invalid_context_saved_input');
        const owner = origin(input.run_id, sessionId);
        if ((source.snapshotId === null) !== (owner.context.observations === null)) throw new Error('invalid_context_saved_input_policy');
        if (source.snapshotId !== null) originalSnapshot(source.snapshotId, owner.row);
      }
    }
    for (const source of request.binding.includedToolResults) {
      if (source.toolCallId === null) {
        const key = JSON.stringify([sessionId, source.nativeToolCallId]);
        if (!legacyTools.has(key)) {
          if (db.query('SELECT id FROM tool_calls WHERE session_id=? AND native_tool_call_id=?').get(sessionId, source.nativeToolCallId)) throw new Error('invalid_context_legacy_tool');
          const rows = z.array(z.object({ entry_id: z.string(), entry_json: z.string(), run_id: id.nullable() }))
            .parse(db.query('SELECT entry_id,entry_json,run_id FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(sessionId));
          const entries = rows.map(row => ({ row, entry: z.object({ id: z.string(), parentId: z.string().nullable(), type: z.string(), message: z.unknown().optional() }).passthrough().parse(json(row.entry_json)) }));
          if (entries.some(item => item.row.entry_id !== item.entry.id)) throw new Error('invalid_context_legacy_entry');
          const results = entries.filter(item => {
            const message = z.object({ role: z.unknown().optional(), toolCallId: z.unknown().optional() }).passthrough().safeParse(item.entry.message);
            return item.entry.type === 'message' && message.success && message.data.role === 'toolResult' && message.data.toolCallId === source.nativeToolCallId;
          });
          if (results.length !== 1) throw new Error('invalid_context_legacy_result');
          const result = results[0]!, message = resultMessage.parse(result.entry.message), byId = new Map(entries.map(item => [item.entry.id,item]));
          const calls: Array<{ runId: number | null; name: string }> = [], visited = new Set<string>();
          let parent = result.entry.parentId;
          while (parent !== null) {
            const item = byId.get(parent);
            if (!item || visited.has(parent)) throw new Error('invalid_context_legacy_path');
            visited.add(parent);
            const raw = z.object({ role: z.unknown().optional(), content: z.unknown().optional() }).passthrough().safeParse(item.entry.message);
            if (item.entry.type === 'message' && raw.success && raw.data.role === 'assistant' && Array.isArray(raw.data.content)
              && raw.data.content.some(block => typeof block === 'object' && block !== null && 'id' in block && block.id === source.nativeToolCallId)) {
              const assistant = assistantMessage.parse(item.entry.message);
              for (const block of assistant.content) if (block.type === 'toolCall' && block.id === source.nativeToolCallId) calls.push({runId:item.row.run_id,name:block.name});
            }
            parent = item.entry.parentId;
          }
          if (calls.length !== 1 || calls[0]!.name !== message.toolName || calls[0]!.runId === null || calls[0]!.runId !== result.row.run_id
            || origin(calls[0]!.runId, sessionId).context.observations !== null) throw new Error('invalid_context_legacy_origin');
          legacyTools.add(key);
        }
      } else {
        let tool = tools.get(source.toolCallId);
        if (!tool) { tool = toolSourceSchema.parse(db.query('SELECT * FROM tool_calls WHERE id=?').get(source.toolCallId)); tools.set(source.toolCallId, tool); }
        if (tool.session_id !== sessionId || tool.run_id !== source.originRunId || tool.native_tool_call_id !== source.nativeToolCallId
          || !same(contextReferenceFromColumns(tool), source.context)) throw new Error('invalid_context_original_tool');
        const owner = origin(tool.run_id, sessionId);
        if ((source.context === null) !== (owner.context.observations === null)) throw new Error('invalid_context_original_tool_policy');
        if (source.context !== null) {
          originalSnapshot(source.context.snapshotId, owner.row);
          if (owner.context.observations?.requests[source.context.requestSequence - 1]?.binding.snapshotId !== source.context.snapshotId) throw new Error('invalid_context_original_tool_request');
        }
      }
    }
  }
}

export function createContextRepository(input: { db: Database; loadHistory(sessionId: number): Result<NativeSessionHistory | null> }): ContextRepository {
  const { db, loadHistory } = input;
  function read<T>(fn: () => T): Result<T> {
    try { return ok(fn()); }
    catch (error) { return fail(error instanceof ContextFault ? error.error : error instanceof SQLiteError
      ? appError('storage_read_failed', 'storage', 'Context evidence could not be read.', true)
      : appError('storage_corrupt', 'storage', 'Saved Context evidence is invalid.')); }
  }
  function write<T>(fn: () => T): Result<T> {
    try { return ok(db.transaction(fn).immediate()); }
    catch (error) { return fail(error instanceof ContextFault ? error.error : appError('storage_write_failed', 'storage', 'Context evidence could not be saved.', true)); }
  }
  function session(sessionId: number) {
    id.parse(sessionId);
    const row = db.query('SELECT id,native_session_id FROM sessions WHERE id=?').get(sessionId);
    if (!row) reject('session_not_found', 'session');
    return z.object({ id, native_session_id: z.string().min(1).max(256) }).parse(row);
  }
  function run(runId: number, sessionId: number) {
    id.parse(runId);
    const raw = db.query('SELECT id,kind,session_id,job_id,config_json,current_context_snapshot_id,context_observations_json FROM runs WHERE id=?').get(runId);
    if (!raw) reject('run_not_found', 'runtime');
    const row = runRowSchema.parse(raw);
    if (row.kind !== 'agent' || row.session_id !== sessionId) reject('state_conflict', 'runtime');
    let context: ReturnType<typeof readRunContext>;
    try { context = readRunContextOwner(db, row); } catch (error) { if (error instanceof SQLiteError) throw error; return corrupt(); }
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
  function snapshotInput(value: ContextSnapshot) {
    const rows = db.query('SELECT * FROM session_inputs WHERE context_snapshot_id=?').all(value.id);
    if (rows.length !== 1) return corrupt();
    const saved = savedInput(rows[0]);
    readInputContext(db, { run_id: saved.runId, session_id: saved.sessionId, context_snapshot_id: saved.contextSnapshotId });
    if (saved.runId !== value.runId || saved.sessionId !== value.sessionId || saved.content.text !== value.json.text
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
  function entryRun(sessionId: number, entryId: string): number | null {
    const row = db.query('SELECT run_id FROM session_native_entries WHERE session_id=? AND entry_id=?').get(sessionId, entryId);
    if (!row) return unknownBinding();
    return z.object({ run_id: id.nullable() }).parse(row).run_id;
  }
  function toolResult(input: Parameters<ContextHooks['resolveToolResult']>[0]): NativeToolResultContextBinding {
    const parsed = z.object({ sessionId: id, nativeToolCallId: z.string().min(1).max(256) }).strict().parse(input);
    session(parsed.sessionId);
    const rows = db.query('SELECT id,run_id,context_snapshot_id,request_sequence FROM tool_calls WHERE session_id=? AND native_tool_call_id=?')
      .all(parsed.sessionId, parsed.nativeToolCallId);
    if (rows.length > 1) return unknownBinding();
    if (rows.length === 1) {
      try {
        const row = z.object({ id, run_id: id, context_snapshot_id: id.nullable(), request_sequence: id.nullable() }).parse(rows[0]);
        const owner = run(row.run_id, parsed.sessionId);
        const context = contextReferenceFromColumns(row);
        if (owner.observations === null ? context !== null : context === null) return unknownBinding();
        if (context) {
          snapshot(context.snapshotId, owner.row);
          const request = owner.observations?.requests[context.requestSequence - 1];
          if (!request || request.binding.snapshotId !== context.snapshotId) return unknownBinding();
        }
        return NativeToolResultContextBindingSchema.parse({ nativeToolCallId: parsed.nativeToolCallId,
          toolCallId: row.id, originRunId: row.run_id, context });
      } catch { return unknownBinding(); }
    }
    const selected = path(parsed.sessionId);
    // A malformed match is uncertainty, even if a second well-formed message has the same ID.
    for (const entry of selected) {
      if (entry.type !== 'message') continue;
      const message = z.object({ role: z.unknown().optional(), toolCallId: z.unknown().optional(), content: z.unknown().optional() }).passthrough().safeParse(entry.message);
      if (!message.success) continue;
      if (message.data.role === 'toolResult' && message.data.toolCallId === parsed.nativeToolCallId && !resultMessage.safeParse(entry.message).success) return unknownBinding();
      if (message.data.role === 'assistant' && Array.isArray(message.data.content)
        && message.data.content.some(block => typeof block === 'object' && block !== null && 'type' in block && block.type === 'toolCall'
          && 'id' in block && block.id === parsed.nativeToolCallId) && !assistantMessage.safeParse(entry.message).success) return unknownBinding();
    }
    const results = selected.map((entry, index) => ({ entry, index, message: resultMessage.safeParse(entry.message) }))
      .filter(item => item.entry.type === 'message' && item.message.success && item.message.data.toolCallId === parsed.nativeToolCallId);
    if (results.length !== 1) return unknownBinding();
    const result = results[0]!;
    if (!result.message.success) return unknownBinding();
    const resultToolName = result.message.data.toolName;
    const calls = selected.flatMap((entry, index) => {
      if (entry.type !== 'message') return [];
      const parsedMessage = assistantMessage.safeParse(entry.message);
      if (!parsedMessage.success) return [];
      return parsedMessage.data.content.flatMap(block => block.type === 'toolCall' && block.id === parsed.nativeToolCallId
        ? [{ entry, index, name: block.name }] : []);
    });
    if (calls.length !== 1 || calls[0]!.index >= result.index || calls[0]!.name !== resultToolName) return unknownBinding();
    const origin = entryRun(parsed.sessionId, calls[0]!.entry.id);
    if (origin === null || entryRun(parsed.sessionId, result.entry.id) !== origin) return unknownBinding();
    try { if (run(origin, parsed.sessionId).observations !== null) return unknownBinding(); }
    catch { return unknownBinding(); }
    return { nativeToolCallId: parsed.nativeToolCallId, toolCallId: null, originRunId: null, context: null };
  }
  function verifyBinding(binding: RequestContextBinding) {
    const saved = RequestContextBindingSchema.parse(binding);
    const owner = run(saved.runId, saved.sessionId);
    if (owner.observations === null || session(saved.sessionId).native_session_id !== saved.nativeSessionId) return unknownBinding();
    const selected = path(saved.sessionId);
    const entries = new Map(selected.map((entry, index) => [entry.id, { entry, index }]));
    let previous = -1;
    for (const source of saved.includedBindings) {
      const native = entries.get(source.nativeEntryId);
      if (!native || native.index <= previous || native.entry.type !== 'message' || !userMessage.safeParse(native.entry.message).success
        || entryRun(saved.sessionId, native.entry.id) !== source.originRunId) return unknownBinding();
      previous = native.index;
      if (source.inputId === null) {
        if (source.snapshotId !== null || db.query('SELECT id FROM session_inputs WHERE session_id=? AND native_entry_id=?').get(saved.sessionId, source.nativeEntryId)) return unknownBinding();
        if (source.originRunId !== null && run(source.originRunId, saved.sessionId).observations !== null) return unknownBinding();
      } else {
        const owners = db.query('SELECT id FROM session_inputs WHERE session_id=? AND native_entry_id=?').all(saved.sessionId, source.nativeEntryId);
        if (owners.length !== 1 || z.object({ id }).parse(owners[0]).id !== source.inputId) return unknownBinding();
        const row = db.query('SELECT * FROM session_inputs WHERE id=?').get(source.inputId);
        if (!row) return unknownBinding();
        const savedInput = thisInput(row);
        if (savedInput.sessionId !== saved.sessionId || savedInput.runId !== source.originRunId
          || savedInput.status !== 'consumed' || savedInput.nativeEntryId !== source.nativeEntryId
          || savedInput.contextSnapshotId !== source.snapshotId) return unknownBinding();
        const origin = run(source.originRunId!, saved.sessionId);
        if ((origin.observations === null) !== (source.snapshotId === null)) return unknownBinding();
        if (source.snapshotId !== null) snapshotInput(snapshot(source.snapshotId, origin.row));
      }
    }
    for (const source of saved.includedToolResults) if (!same(toolResult({ sessionId: saved.sessionId, nativeToolCallId: source.nativeToolCallId }), source)) return unknownBinding();
    snapshot(saved.snapshotId, owner.row);
    return { binding: saved, owner };
  }
  function thisInput(raw: unknown) { try { return savedInput(raw); } catch { return unknownBinding(); } }
  function persist(owner: RunRow, observations: ContextObservations) {
    if (bytes(observations) > 4194304) reject('context_evidence_too_large');
    ContextObservationsSchema.parse(observations);
    if (db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify(observations), owner.id).changes !== 1) throw new Error('context_run_missing');
  }
  function publicSummary(value: ContextSnapshot): ContextSnapshotSummary {
    const saved = snapshotInput(value), workspace = value.json.workspaceContext;
    return { id: value.id, sessionId: value.sessionId, runId: value.runId, jobId: value.jobId, sequence: value.sequence,
      createdAt: value.createdAt, inputId: saved.inputId, mode: saved.mode, documentRef: workspace?.documentRef ?? null,
      candidateRef: workspace?.candidateRef ?? null, selection: workspace?.selection ?? null,
      fragmentCount: value.json.modelProjection.fragments.length, gapCount: value.json.modelProjection.gaps.length };
  }
  return {
    appendInTransaction(value) {
      if (!db.inTransaction) return fail(appError('state_conflict', 'input', 'Context append requires its admission transaction.'));
      return write(() => {
        const owner = run(value.runId, value.sessionId);
        if (owner.row.job_id !== value.jobId || owner.observations === null) return unknownBinding();
        if (bytes(value.json) > 262144 || bytes(value.json.modelProjection) > 65536) reject('context_evidence_too_large');
        const parsed = ContextSnapshotJsonSchema.parse(value.json);
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
        persist(owner.row, { version: 1, requests: [...observations.requests, request] });
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
        const request: { -readonly [Key in keyof ContextRequestEvidence]: ContextRequestEvidence[Key] } = structuredClone(original);
        if (update.kind === 'sdk-payload') {
          const fact = { observedAt: update.at, inclusion: update.inclusion, reason: update.reason };
          if (request.sdkPayload !== null && !same(request.sdkPayload, fact)) return conflict();
          request.sdkPayload = fact;
        } else if (update.kind === 'attempt-prepared') {
          if (request.transport !== 'observed-fetch') return conflict();
          const evidence = update.evidence, existing = request.attempts[evidence.attempt - 1];
          if (existing) {
            if (existing.preparedAt !== evidence.preparedAt || existing.wireInclusion !== evidence.wireInclusion || existing.wireReason !== evidence.wireReason
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
        if (!same(request, original)) persist(owner.row, { version: 1, requests });
      });
    },
    resolveToolResult(value) { return read(() => toolResult(value)); },
    listContextSnapshots(value) {
      const normalized = ContextSnapshotsRequestSchema.safeParse(value);
      if (!normalized.success) return fail(appError('input_invalid', 'input', 'Context query is invalid.'));
      return read(() => {
        const request = normalized.data;
        session(request.sessionId);
        if (request.runId !== undefined) run(request.runId, request.sessionId);
        const rows = db.query(`SELECT id FROM context_snapshots WHERE session_id=? AND (? IS NULL OR run_id=?)
          AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`).all(request.sessionId, request.runId ?? null, request.runId ?? null,
          request.beforeId ?? null, request.beforeId ?? null, request.limit + 1);
        const page: ContextSnapshotsPage = { sessionId: request.sessionId, runId: request.runId ?? null, items: [], nextBeforeId: null };
        for (const raw of rows) {
          if (page.items.length === request.limit) break;
          const value = snapshot(z.object({ id }).parse(raw).id);
          const owner = run(value.runId, request.sessionId);
          if (value.jobId !== owner.row.job_id) return corrupt();
          const item = publicSummary(value);
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
        const matching = [...(owner.observations?.requests ?? [])].reverse()
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
