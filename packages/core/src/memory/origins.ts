import { SQLiteError, type Database } from 'bun:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, NativeSessionHistorySchema, NativeHistoryRecoveryBundleSchema, SessionInputContentSchema } from '@flowmate/contracts';
import type { AppError, DbId, NativeSessionEntry, NativeHistoryRecoveryBundle, NativeToolResultContextBinding, NativeDerivedContextBinding, Result } from '@flowmate/contracts';
import { loadNativeHistoryInTransaction } from './persistence.ts';
import { readRunContext, readContextSnapshotOwner, contextReferenceFromColumns } from '../context/repository.ts';

export class NativeOriginFault extends Error {
  constructor(readonly error: AppError = appError('context_binding_unknown', 'runtime', 'Native history origins could not be verified.')) { super(error.code); }
}
function unknown(): never { throw new NativeOriginFault(); }
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ownerSchema = z.object({ id, kind: z.literal('agent'), session_id: id, job_id: id.nullable(), config_json: z.string(),
  current_context_snapshot_id: id.nullable(), context_observations_json: z.string().nullable() });
export type NativeEntryOrigin = { originSessionId: DbId; nativeEntryId: string; originRunId: DbId | null; inputId: DbId | null; snapshotId: DbId | null };

/** SDK references only. Opaque custom data is deliberately not interpreted as entry IDs. */
export function nativeEntryReferences(entry: NativeSessionEntry, includeParent = true): string[] {
  const refs: string[] = includeParent && entry.parentId !== null ? [entry.parentId] : [];
  if (entry.type === 'compaction') refs.push(entry.firstKeptEntryId);
  if (entry.type === 'label') refs.push(entry.targetId);
  const from = entry.type === 'branch_summary' ? entry.fromId
    : entry.type === 'message' && entry.message.role === 'branchSummary' ? entry.message.fromId : null;
  if (from !== null && from !== 'root') refs.push(from);
  return [...new Set(refs)];
}

/** Cache lifetime is one caller-owned SQL snapshot. Never invokes the outer journal reader. */
export function createNativeOriginReader(db: Database) {
  type Stored = { history: z.infer<typeof NativeSessionHistorySchema>; commit: NonNullable<ReturnType<typeof loadNativeHistoryInTransaction>>['commit'] };
  const histories = new Map<number, Stored | null>();
  const entryIndexes = new Map<number, Map<string, NativeSessionEntry>>();
  const origins = new Map<string, NativeEntryOrigin>();
  const toolResults = new Map<string, NativeToolResultContextBinding>();
  const snapshots = new Map<string, ReturnType<typeof readContextSnapshotOwner>>();
  const owners = new Map<number, { row: z.infer<typeof ownerSchema>; context: ReturnType<typeof readRunContext> }>();
  const verifiedForks = new Set<number>();
  const forkSchema = z.object({ source_session_id: id, source_commit_revision: count, source_entry_count: count,
    source_leaf_id: z.string().nullable(), selected_entry_id: z.string(), inherited_entry_count: count.positive() });
  function contextSnapshot(snapshotId: number, owner: Parameters<typeof readContextSnapshotOwner>[2]) {
    const key = JSON.stringify([snapshotId, owner.id, owner.session_id, owner.job_id ?? null]);
    const cached = snapshots.get(key); if (cached) return cached;
    const value = readContextSnapshotOwner(db, snapshotId, owner);
    // Reuse only a complete ownership proof within this immutable SQL read.
    snapshots.set(key, value); return value;
  }
  function history(sessionId: number) {
    id.parse(sessionId);
    if (!histories.has(sessionId)) {
      if (!db.query('SELECT id FROM sessions WHERE id=?').get(sessionId)) unknown();
      try { const stored=loadNativeHistoryInTransaction(db, sessionId);
        // The strict loader already validates this exact body. Preserve the schema's
        // copied, readonly entry array without repeating its full JSON/schema walk.
        histories.set(sessionId, stored ? { ...stored, history: { ...stored.history,
          entries: Object.freeze([...stored.history.entries]) } as Stored['history'] } : null); }
      catch (error) { if (error instanceof SQLiteError) throw error; unknown(); }
    }
    return histories.get(sessionId)!;
  }
  function nativeEntryAt(sessionId: number, entryId: string) {
    if (!entryIndexes.has(sessionId)) entryIndexes.set(sessionId, new Map(history(sessionId)?.history.entries.map(value => [value.id,value])));
    return entryIndexes.get(sessionId)!.get(entryId);
  }
  function fork(sessionId: number) {
    const rows = db.query('SELECT * FROM session_forks WHERE target_session_id=?').all(sessionId);
    if (rows.length > 1) unknown();
    return rows.length ? forkSchema.parse(rows[0]) : null;
  }
  function association(sessionId: number, entryId: string) {
    return z.object({ run_id: id.nullable(), sequence: count }).parse(db.query(
      'SELECT run_id,sequence FROM session_native_entries WHERE session_id=? AND entry_id=?').get(sessionId, entryId));
  }
  function verifyFork(sessionId: number, chain = new Set<number>()): void {
    if (chain.has(sessionId)) unknown();
    if (verifiedForks.has(sessionId)) return;
    const provenance = fork(sessionId);
    if (!provenance) { verifiedForks.add(sessionId); return; }
    chain.add(sessionId);
    const target = history(sessionId), source = history(provenance.source_session_id);
    if (!target || !source || provenance.inherited_entry_count > target.history.entries.length
      || provenance.source_entry_count > source.history.entries.length) unknown();
    const inherited = target.history.entries.slice(0, provenance.inherited_entry_count);
    const allowed = new Map(inherited.map(entry => [entry.id, entry]));
    const frozen = new Map(source.history.entries.slice(0, provenance.source_entry_count).map(entry => [entry.id, entry]));
    if (!allowed.has(provenance.selected_entry_id) || provenance.source_leaf_id !== null && !frozen.has(provenance.source_leaf_id)) unknown();
    for (const entry of inherited) {
      if (association(sessionId, entry.id).run_id !== null || !isDeepStrictEqual(entry, frozen.get(entry.id))
        || nativeEntryReferences(entry).some(ref => !allowed.has(ref))) unknown();
    }
    const done=new Set<string>(), visiting=new Set<string>();
    function visit(entryId:string):void {
      if(visiting.has(entryId)) unknown();
      if(done.has(entryId)) return;
      visiting.add(entryId);
      for(const ref of nativeEntryReferences(allowed.get(entryId)!)) visit(ref);
      visiting.delete(entryId); done.add(entryId);
    }
    for(const entry of inherited) visit(entry.id);
    // A label belonging to the copied closure is itself part of that closure.
    for (const entry of frozen.values()) if (entry.type === 'label' && allowed.has(entry.targetId) && !allowed.has(entry.id)) unknown();
    verifyFork(provenance.source_session_id, chain);
    chain.delete(sessionId); verifiedForks.add(sessionId);
  }
  function run(runId: number, sessionId: number) {
    const cached=owners.get(runId);
    if(cached) { if(cached.row.session_id!==sessionId) unknown(); return cached; }
    const row = ownerSchema.parse(db.query('SELECT * FROM runs WHERE id=?').get(runId));
    if (row.session_id !== sessionId) unknown();
    const context = readRunContext(row);
    const native = z.object({ agent: z.object({ nativeSessionId: z.string() }).optional() }).passthrough().parse(JSON.parse(row.config_json));
    const session = db.query('SELECT native_session_id FROM sessions WHERE id=?').get(sessionId) as { native_session_id: string };
    if (native.agent && native.agent.nativeSessionId !== session.native_session_id) unknown();
    if (context.pointer !== null) contextSnapshot(context.pointer, row);
    // Memoize identity before following original request sources. A request contains its own
    // consumed user entry; revisiting that Run must not recurse through the outer journal reader.
    const owner={row,context}; owners.set(runId,owner);
    for (const request of context.observations?.requests ?? []) {
      const snapshot = contextSnapshot(request.binding.snapshotId, row);
      const primary = db.query('SELECT session_id,run_id,context_snapshot_id,status,native_entry_id,content_json,goal_mode FROM session_inputs WHERE id=?')
        .get(request.binding.inputId) as { session_id: number; run_id: number; context_snapshot_id: number; status: string; native_entry_id: string; content_json: string; goal_mode: string } | null;
      if (!primary || primary.session_id !== sessionId || primary.run_id !== runId || primary.context_snapshot_id !== snapshot.id
        || primary.status !== 'consumed' || !request.binding.includedBindings.some(binding => binding.nativeEntryId === primary.native_entry_id
          && binding.inputId === request.binding.inputId && binding.originRunId === runId && binding.snapshotId === snapshot.id)) unknown();
      const content=SessionInputContentSchema.parse(JSON.parse(primary.content_json));
      if(content.version!==2 || snapshot.json.text!==content.text || snapshot.json.goalMode!==primary.goal_mode
        || !isDeepStrictEqual(snapshot.json.workspaceContext,content.workspaceContext)
        || !isDeepStrictEqual(snapshot.json.allowedDocumentIds,content.allowedDocumentIds)
        || !isDeepStrictEqual(snapshot.json.allowedArtifactIds,content.allowedArtifactIds)) unknown();
      for(const source of request.binding.includedBindings) {
        const {originSessionId:_,...binding}=resolve(sessionId,source.nativeEntryId);
        const native=nativeEntryAt(sessionId,source.nativeEntryId);
        if(native?.type!=='message' || native.message.role!=='user' || !isDeepStrictEqual(binding,source)) unknown();
      }
      for(const source of request.binding.includedToolResults) {
        if(!isDeepStrictEqual(tool(sessionId,source.nativeToolCallId,true),source)
          || source.originRunId===runId && source.context!==null && source.context.requestSequence>=request.binding.requestSequence) unknown();
      }
      if('includedNativeContexts' in request.binding) for(const source of request.binding.includedNativeContexts) derived(sessionId,source);
    }
    return owner;
  }
  function resolve(targetSessionId: number, nativeEntryId: string): NativeEntryOrigin {
    const key = JSON.stringify([targetSessionId,nativeEntryId]);
    const cached = origins.get(key); if (cached) return cached;
    verifyFork(targetSessionId);
    const entry = nativeEntryAt(targetSessionId,nativeEntryId);
    if (!entry) unknown();
    const link = fork(targetSessionId), native = association(targetSessionId,nativeEntryId);
    if (link && native.sequence < link.inherited_entry_count) {
      const original = resolve(link.source_session_id,nativeEntryId);
      // A copy cannot acquire target-side product Input associations.
      if (db.query('SELECT id FROM session_inputs WHERE session_id=? AND native_entry_id=?').get(targetSessionId,nativeEntryId)) unknown();
      origins.set(key,original); return original;
    }
    const owner = native.run_id === null ? null : run(native.run_id,targetSessionId);
    const inputs = db.query('SELECT * FROM session_inputs WHERE session_id=? AND native_entry_id=?').all(targetSessionId,nativeEntryId);
    let inputId: number | null = null, snapshotId: number | null = null;
    if (entry.type !== 'message' || entry.message.role !== 'user') { if (inputs.length) unknown(); }
    else if (inputs.length === 0) { if (owner?.context.observations !== null && owner !== null) unknown(); }
    else {
      if (inputs.length !== 1 || !owner) unknown();
      const input = z.object({ id, session_id: id, run_id: id, context_snapshot_id: id.nullable(), status: z.literal('consumed'),
        goal_mode: z.string(), content_json: z.string() }).parse(inputs[0]);
      if (input.run_id !== native.run_id || (input.context_snapshot_id === null) !== (owner.context.observations === null)) unknown();
      const content = SessionInputContentSchema.parse(JSON.parse(input.content_json));
      if (input.context_snapshot_id !== null) {
        const snapshot = contextSnapshot(input.context_snapshot_id,owner.row);
        if (content.version !== 2 || snapshot.json.text !== content.text || snapshot.json.goalMode !== input.goal_mode
          || !isDeepStrictEqual(snapshot.json.workspaceContext,content.workspaceContext)
          || !isDeepStrictEqual(snapshot.json.allowedDocumentIds,content.allowedDocumentIds)
          || !isDeepStrictEqual(snapshot.json.allowedArtifactIds,content.allowedArtifactIds)
          || db.query('SELECT id FROM session_inputs WHERE context_snapshot_id=?').all(input.context_snapshot_id).length !== 1) unknown();
      }
      inputId=input.id; snapshotId=input.context_snapshot_id;
    }
    const origin = { originSessionId: targetSessionId,nativeEntryId,originRunId:native.run_id,inputId,snapshotId };
    origins.set(key,origin); return origin;
  }
  function path(sessionId: number, leafId?: string | null): NativeSessionEntry[] {
    const stored = history(sessionId); if (!stored) unknown();
    const entries = new Map(stored.history.entries.map(entry => [entry.id,entry]));
    const selected: NativeSessionEntry[] = [], visited = new Set<string>();
    let cursor = leafId === undefined ? stored.history.leafId : leafId;
    while (cursor !== null) { const entry=entries.get(cursor); if (!entry || visited.has(cursor)) unknown();
      visited.add(cursor); selected.push(entry); cursor=entry.parentId; }
    return selected.reverse();
  }
  function tool(sessionId: number, nativeToolCallId: string, saved = false): NativeToolResultContextBinding {
    const key = JSON.stringify([sessionId, nativeToolCallId, saved]);
    const cached = toolResults.get(key); if (cached) return cached;
    const stored=history(sessionId); if (!stored) unknown();
    const candidates=(saved ? stored.history.entries : path(sessionId)).filter(entry => entry.type==='message'
      && entry.message.role==='toolResult' && entry.message.toolCallId===nativeToolCallId);
    if (candidates.length!==1) unknown();
    const result=candidates[0]!;
    if (result.type!=='message' || result.message.role!=='toolResult') unknown();
    const calls=path(sessionId,result.id).flatMap(entry => entry.type==='message' && entry.message.role==='assistant'
      ? entry.message.content.flatMap(block => block.type==='toolCall' && block.id===nativeToolCallId ? [{entry,name:block.name}] : []) : []);
    // Duplicate IDs elsewhere in the full tree are ambiguous, even when today's leaf hides one.
    const allCalls=stored.history.entries.flatMap(entry => entry.type==='message' && entry.message.role==='assistant'
      ? entry.message.content.filter(block => block.type==='toolCall' && block.id===nativeToolCallId) : []);
    if(calls.length!==1 || allCalls.length!==1 || calls[0]!.name!==result.message.toolName) unknown();
    const origin=resolve(sessionId,result.id), callOrigin=resolve(sessionId,calls[0]!.entry.id);
    if(origin.originRunId===null || origin.originRunId!==callOrigin.originRunId || origin.originSessionId!==callOrigin.originSessionId) unknown();
    const owner=run(origin.originRunId,origin.originSessionId);
    const rows=db.query('SELECT * FROM tool_calls WHERE session_id=? AND native_tool_call_id=?').all(origin.originSessionId,nativeToolCallId);
    let copiedSession=sessionId;
    while(copiedSession!==origin.originSessionId) {
      if(db.query('SELECT id FROM tool_calls WHERE session_id=? AND native_tool_call_id=?').get(copiedSession,nativeToolCallId)) unknown();
      const provenance=fork(copiedSession); if(!provenance) unknown();
      copiedSession=provenance.source_session_id;
    }
    if(rows.length===0) { if(owner.context.observations!==null) unknown();
      const binding = {nativeToolCallId,toolCallId:null,originRunId:null,context:null};
      toolResults.set(key, binding); return binding; }
    if(rows.length!==1) unknown();
    const row=z.object({id,run_id:id,session_id:id,tool_name:z.string(),context_snapshot_id:id.nullable(),request_sequence:id.nullable()}).parse(rows[0]);
    if(row.run_id!==origin.originRunId || row.tool_name!==result.message.toolName) unknown();
    const context=contextReferenceFromColumns(row);
    if((context===null)!==(owner.context.observations===null)) unknown();
    if(context) { contextSnapshot(context.snapshotId,owner.row);
      if(owner.context.observations?.requests[context.requestSequence-1]?.binding.snapshotId!==context.snapshotId) unknown(); }
    const binding = {nativeToolCallId,toolCallId:row.id,originRunId:row.run_id,context};
    // Only a complete proof is reusable, and only in this caller's SQL snapshot.
    toolResults.set(key, binding); return binding;
  }
  function derived(sessionId: number, source: NativeDerivedContextBinding): void {
    const entry=nativeEntryAt(sessionId,source.nativeEntryId);
    const origin=resolve(sessionId,source.nativeEntryId);
    if(!entry || entry.type!==source.entryType || origin.originSessionId!==source.originSessionId) unknown();
    const role=entry.type==='custom_message'?'custom':entry.type==='compaction'?'compactionSummary':entry.type==='branch_summary'?'branchSummary'
      :entry.type==='message'?entry.message.role:null;
    if(role!==source.messageRole || entry.type==='message' && entry.message.role==='bashExecution' && entry.message.excludeFromContext===true
      || !isDeepStrictEqual(nativeEntryReferences(entry,false),source.referenceEntryIds)) unknown();
  }
  function bundle(sessionId: number): NativeHistoryRecoveryBundle {
    const stored=history(sessionId); verifyFork(sessionId);
    const all=(stored?.history.entries ?? []).map(entry=>resolve(sessionId,entry.id));
    for(const entry of stored?.history.entries ?? []) if(entry.type==='message' && entry.message.role==='toolResult')
      tool(sessionId,entry.message.toolCallId,true);
    const inputs=all.filter((_,index)=> { const entry=stored!.history.entries[index]!; return entry.type==='message' && entry.message.role==='user'; })
      .map(({originSessionId:_,...binding})=>binding);
    const localIds=new Set(stored?.history.entries.map(entry=>entry.id));
    for(const raw of db.query('SELECT native_entry_id FROM session_inputs WHERE session_id=? AND native_entry_id IS NOT NULL').all(sessionId))
      if(!localIds.has(z.object({native_entry_id:z.string()}).parse(raw).native_entry_id)) unknown();
    return NativeHistoryRecoveryBundleSchema.parse({history:stored?.history??null,commit:stored?.commit??null,seed:{sessionId,inputs,
      origins:all.map(({inputId:_,snapshotId:__,...origin})=>origin)}});
  }
  function ancestors(sessionId: number): number[] {
    verifyFork(sessionId); const values:number[]=[]; let cursor:number|null=sessionId;
    while(cursor!==null) { if(values.includes(cursor)) unknown(); values.push(cursor); history(cursor); cursor=fork(cursor)?.source_session_id??null; }
    // Validate every frozen entry's real material evidence, irrespective of current leaf.
    bundle(sessionId); return values;
  }
  function resolveEntry(sessionId: number, entryId: string): NativeEntryOrigin {
    const origin=resolve(sessionId,entryId);
    const entry=nativeEntryAt(sessionId,entryId);
    if(entry?.type==='message' && entry.message.role==='toolResult') {
      const evidence=tool(sessionId,entry.message.toolCallId,true);
      return {...origin,inputId:null,snapshotId:evidence.context?.snapshotId??null};
    }
    return origin;
  }
  function checked<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args) => { try { return fn(...args); } catch(error) {
      if(error instanceof SQLiteError || error instanceof NativeOriginFault) throw error;
      return unknown();
    } };
  }
  return {history:checked(history),entry:checked(nativeEntryAt),resolve:checked(resolveEntry),path:checked(path),tool:checked(tool),derived:checked(derived),bundle:checked(bundle),ancestors:checked(ancestors)};
}

export function resolveNativeEntryOrigin(db: Database, input: { targetSessionId: DbId; nativeEntryId: string }): Result<NativeEntryOrigin> {
  try { const read=()=>createNativeOriginReader(db).resolve(input.targetSessionId,input.nativeEntryId);
    return ok(db.inTransaction?read():db.transaction(read).deferred()); }
  catch(error) { return fail(error instanceof SQLiteError ? appError('storage_read_failed','storage','Native origins could not be read.',true)
    : error instanceof NativeOriginFault ? error.error : new NativeOriginFault().error); }
}
