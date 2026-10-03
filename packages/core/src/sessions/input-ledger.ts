import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { RuntimeEventStore } from '../events/store.ts';
import { readInputContext, readContextSnapshotOwner } from '../context/repository.ts';
import { appError, fail, normalizeSessionInputRequest, ok, SessionInputContentV2Schema,
  SessionInputQuerySchema, SessionInputSnapshotSchema, SessionInputsRequestSchema, LegacySessionInputRequestSchema } from '@flowmate/contracts';
import type { AppError, DbId, NormalizedSessionInputRequest, Result, SessionInputQuery, SessionInputQueryResult,
  SessionInputRequest, SessionInputSnapshot, SessionInputsRequest, SessionInputsPage, SessionInputContentV2 } from '@flowmate/contracts';

type InputRow = { id: number; session_id: number; client_sequence: number; mode: string; goal_mode: string;
  request_hash: string; run_id: number | null; context_snapshot_id?: number | null; content_json: string; status: string; processing_status: string;
  native_entry_id: string | null; result_entry_id: string | null; dispatched_at: string | null;
  error_json: string | null; created_at: string; updated_at: string };
type NativeEntry = { id: string; parentId: string | null; type: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }>; stopReason?: string; toolCallId?: string } };
export type FrozenSessionInputAdmission = { runId: DbId; content: SessionInputContentV2 };
export type SessionInputAdmission = FrozenSessionInputAdmission & (
  | { contextPolicyVersion: 'p8-context-v1'; contextSnapshotId: DbId }
  | { contextPolicyVersion?: never; contextSnapshotId?: never }
);
export type InputResultBatch = { inputIds: readonly DbId[]; resultEntryId: string };
function snapshot(db: Database, row: InputRow): SessionInputSnapshot {
  return SessionInputSnapshotSchema.parse({ inputId: row.id, sessionId: row.session_id, clientSequence: row.client_sequence,
    mode: row.mode, goalMode: row.goal_mode, runId: row.run_id, contextSnapshotId: readInputContext(db, row), content: JSON.parse(row.content_json), status: row.status,
    processingStatus: row.processing_status, nativeEntryId: row.native_entry_id, resultEntryId: row.result_entry_id ?? null,
    dispatchedAt: row.dispatched_at, error: row.error_json === null ? null : JSON.parse(row.error_json),
    createdAt: row.created_at, updatedAt: row.updated_at });
}
const writeFailure = () => fail(appError('storage_write_failed', 'storage', 'Session input could not be saved.', true));
const readFailure = () => fail(appError('storage_read_failed', 'storage', 'Session input could not be read.', true));
function appendInputState(db: Database, inputId: DbId, events: RuntimeEventStore | undefined,
  origin: 'live' | 'recovery' = 'live'): void {
  if (!events) return;
  const row = db.query('SELECT * FROM session_inputs WHERE id=?').get(inputId) as InputRow | null;
  if (!row || row.run_id === null) throw new Error('event_input_missing');
  const input = snapshot(db, row);
  events.appendInTransaction({ runId: row.run_id, sessionId: row.session_id, toolCallId: null,
    type: 'input_state_changed', occurredAt: input.updatedAt,
    dedupeKey: `input:${inputId}:${input.status}:${input.processingStatus}:${input.nativeEntryId ?? 'none'}:${input.resultEntryId ?? 'none'}`,
    payload: { version: 1, inputId, origin, status: input.status, processingStatus: input.processingStatus,
      nativeEntryId: input.nativeEntryId, resultEntryId: input.resultEntryId, errorCode: input.error?.code ?? null } });
}
/** Schema 009 hash bytes remain an existing idempotency fact. */
function requestHash(request: NormalizedSessionInputRequest, legacy: boolean, identityVersion?: 1): string {
  const identity = identityVersion === 1 ? { requestIdentityVersion: 1, request }
    : legacy ? LegacySessionInputRequestSchema.parse(request)
      : request.mode === 'prompt' ? { ...request, timeoutMs: request.timeoutMs ?? 60_000, stopGraceMs: request.stopGraceMs ?? 5000 } : request;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export type SessionInputLedger = ReturnType<typeof createSessionInputLedger>;
export function createSessionInputLedger(db: Database, events?: RuntimeEventStore) {
  const byId = (inputId: DbId) => db.query('SELECT * FROM session_inputs WHERE id=?').get(inputId) as InputRow | null;
  const writeTransaction = <T>(fn: () => T): T => events ? events.withTransaction(fn) : db.transaction(fn).immediate();
  function lookup(raw: SessionInputRequest, desktopRequestHash?: string): Result<SessionInputSnapshot | null> {
    const normalized = normalizeSessionInputRequest(raw);
    if (!normalized.ok) return normalized;
    if (desktopRequestHash !== undefined && (normalized.data.mode !== 'prompt' || !/^[a-f0-9]{64}$/.test(desktopRequestHash)))
      return fail(appError('input_invalid', 'input', 'Desktop request identity is invalid.'));
    try {
      const request = normalized.data;
      const row = db.query('SELECT * FROM session_inputs WHERE session_id=? AND client_sequence=?')
        .get(request.sessionId, request.clientSequence) as InputRow | null;
      if (!row) return ok(null);
      if (desktopRequestHash !== undefined) {
        const input = snapshot(db, row);
        return input.content.version === 2 && input.content.desktopRequestHash === desktopRequestHash ? ok(input)
          : fail(appError('state_conflict', 'input', 'This client sequence belongs to another input.'));
      }
      const content = JSON.parse(row.content_json) as { version: number; requestIdentityVersion?: 1 };
      if (content.version === 1 && !LegacySessionInputRequestSchema.safeParse(request).success)
        return fail(appError('state_conflict', 'input', 'This client sequence belongs to another input.'));
      if (row.request_hash !== requestHash(request, content.version === 1, content.requestIdentityVersion))
        return fail(appError('state_conflict', 'input', 'This client sequence belongs to another input.'));
      return ok(snapshot(db, row));
    } catch { return readFailure(); }
  }
  return {
    lookup,
    allocateSequence<T>(sessionId: DbId, accept: (sequence: number) => Result<T>): Result<T> {
      let rejected: Result<never> | null = null;
      try {
        return writeTransaction(() => {
          const max = (db.query('SELECT COALESCE(MAX(client_sequence),0) AS sequence FROM session_inputs WHERE session_id=?')
            .get(sessionId) as { sequence: number }).sequence;
          if (max >= Number.MAX_SAFE_INTEGER) throw new Error('input_sequence_exhausted');
          const result = accept(max + 1);
          if (!result.ok) { rejected = result; throw new Error('input_admission_rejected'); }
          return result;
        });
      } catch { return rejected ?? writeFailure(); }
    },
    query(raw: SessionInputQuery): Result<SessionInputQueryResult> {
      const parsed = SessionInputQuerySchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session input query is invalid.'));
      try {
        const { sessionId, clientSequence, inputId } = parsed.data;
        if (!db.query('SELECT id FROM sessions WHERE id=?').get(sessionId)) return fail(appError('session_not_found', 'session', 'Session does not exist.'));
        const max = (db.query('SELECT COALESCE(MAX(client_sequence),0) AS sequence FROM session_inputs WHERE session_id=?')
          .get(sessionId) as { sequence: number }).sequence;
        const row = inputId !== undefined ? db.query('SELECT * FROM session_inputs WHERE session_id=? AND id=?').get(sessionId, inputId)
          : clientSequence !== undefined ? db.query('SELECT * FROM session_inputs WHERE session_id=? AND client_sequence=?').get(sessionId, clientSequence) : null;
        return ok({ input: row ? snapshot(db, row as InputRow) : null, nextClientSequence: max < Number.MAX_SAFE_INTEGER ? max + 1 : null });
      } catch { return readFailure(); }
    },
    list(raw: SessionInputsRequest): Result<SessionInputsPage> {
      const parsed = SessionInputsRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session input page is invalid.'));
      try {
        const request = parsed.data;
        if (!db.query('SELECT id FROM sessions WHERE id=?').get(request.sessionId)) return fail(appError('session_not_found', 'session', 'Session does not exist.'));
        if (request.runId !== undefined) {
          const run = db.query('SELECT kind,session_id FROM runs WHERE id=?').get(request.runId) as { kind: string; session_id: number | null } | null;
          if (!run) return fail(appError('run_not_found', 'runtime', 'Run does not exist.'));
          if (run.kind !== 'agent' || run.session_id !== request.sessionId)
            return fail(appError('state_conflict', 'session', 'Run does not belong to this Session.'));
        }
        const rows = db.query(`SELECT * FROM session_inputs WHERE session_id=? AND (? IS NULL OR run_id=?)
          AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`).all(request.sessionId, request.runId ?? null,
          request.runId ?? null, request.beforeInputId ?? null, request.beforeInputId ?? null, request.limit + 1) as InputRow[];
        const items = rows.slice(0, request.limit).map(row => snapshot(db, row));
        return ok({ items, nextBeforeInputId: rows.length > request.limit ? items.at(-1)!.inputId : null });
      } catch { return readFailure(); }
    },
    get(inputId: DbId): Result<SessionInputSnapshot | null> {
      try { const row = byId(inputId); return ok(row ? snapshot(db, row) : null); } catch { return readFailure(); }
    },
    forRun(runId: DbId): Result<SessionInputSnapshot[]> {
      try { return ok((db.query('SELECT * FROM session_inputs WHERE run_id=? ORDER BY id').all(runId) as InputRow[]).map(row => snapshot(db, row))); }
      catch { return readFailure(); }
    },
    admit(raw: SessionInputRequest, admitInput: () => Result<SessionInputAdmission>, at: string, desktopRequestHash?: string): Result<{ input: SessionInputSnapshot; created: boolean }> {
      const normalized = normalizeSessionInputRequest(raw);
      if (!normalized.ok) return normalized;
      let rejected: Result<never> | null = null;
      try {
        return writeTransaction(() => {
          const existing = lookup(normalized.data, desktopRequestHash);
          if (!existing.ok) { rejected = existing; throw new Error('input_admission_rejected'); }
          if (existing.data) return ok({ input: existing.data, created: false });
          const accepted = admitInput();
          if (!accepted.ok) { rejected = accepted; throw new Error('input_admission_rejected'); }
          const admission = accepted.data;
          const run = db.query('SELECT id,session_id,job_id,kind,status,config_json,cancel_requested_at FROM runs WHERE id=?')
            .get(admission.runId) as { id: number; session_id: number; job_id: number | null; kind: string; status: string; config_json: string; cancel_requested_at: string | null } | null;
          const request = normalized.data;
          if (run?.kind !== 'agent' || run.session_id !== request.sessionId || run.cancel_requested_at !== null
            || (request.mode === 'prompt' ? run.status !== 'created' : !['created', 'running'].includes(run.status) || request.runId !== admission.runId))
            throw new Error('input_run_identity_invalid');
          const content = SessionInputContentV2Schema.parse(admission.content);
          const enabled = JSON.parse(run.config_json).contextPolicyVersion === 'p8-context-v1';
          if (enabled !== (admission.contextPolicyVersion === 'p8-context-v1')) throw new Error('input_context_policy_invalid');
          const contextSnapshotId = admission.contextSnapshotId ?? null;
          if (enabled) {
            if (!Number.isSafeInteger(contextSnapshotId) || contextSnapshotId === null || contextSnapshotId <= 0) throw new Error('input_context_snapshot_missing');
            const saved = readContextSnapshotOwner(db, contextSnapshotId, run);
            if (saved.json.text !== content.text || JSON.stringify(saved.json.workspaceContext) !== JSON.stringify(content.workspaceContext)
              || JSON.stringify(saved.json.allowedDocumentIds) !== JSON.stringify(content.allowedDocumentIds)
              || JSON.stringify(saved.json.allowedArtifactIds) !== JSON.stringify(content.allowedArtifactIds)) throw new Error('input_context_snapshot_invalid');
          }
          if (content.requestIdentityVersion === 1) {
            if (request.mode !== 'prompt') throw new Error('input_active_budget_invalid');
            const overrides = { ...(request.budget === undefined ? {} : { budget: request.budget }),
              ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
              ...(request.stopGraceMs === undefined ? {} : { stopGraceMs: request.stopGraceMs }) };
            if (JSON.stringify(content.originalBudgetOverrides) !== JSON.stringify(overrides)) throw new Error('input_budget_identity_invalid');
          }
          if (content.desktopRequestHash !== desktopRequestHash) throw new Error('input_desktop_identity_invalid');
          if (content.text !== request.text || content.workspaceContext !== null && content.workspaceContext.sessionId !== request.sessionId)
            throw new Error('input_session_identity_invalid');
          const goalMode = request.mode === 'prompt' ? request.goalMode : JSON.parse(run.config_json).goalMode ?? 'answer';
          if (request.mode !== 'prompt' && goalMode === 'fill-form') throw new Error('input_fill_append_invalid');
          const inserted = db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,
            context_snapshot_id,content_json,status,processing_status,native_entry_id,result_entry_id,dispatched_at,error_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,'queued','pending',NULL,NULL,NULL,NULL,?,?)`)
            .run(request.sessionId, request.clientSequence, request.mode, goalMode, requestHash(request, false, content.requestIdentityVersion),
              admission.runId, contextSnapshotId, JSON.stringify(content), at, at);
          appendInputState(db, Number(inserted.lastInsertRowid), events);
          return ok({ input: snapshot(db, byId(Number(inserted.lastInsertRowid))!), created: true });
        });
      } catch { return rejected ?? writeFailure(); }
    },
    dispatch(inputId: DbId, at: string): Result<void> {
      try {
        const row = byId(inputId);
        if (!row || row.status !== 'queued' || row.processing_status !== 'pending' || row.dispatched_at !== null)
          return fail(appError('state_conflict', 'session', 'Session input is not eligible for a new dispatch.'));
        const changed = db.query("UPDATE session_inputs SET dispatched_at=?,updated_at=? WHERE id=? AND status='queued' AND dispatched_at IS NULL")
          .run(at, at, inputId).changes;
        return changed === 1 ? ok(undefined) : fail(appError('state_conflict', 'session', 'Session input dispatch has changed.'));
      } catch { return writeFailure(); }
    },
    resultEvidence(runId: DbId, inputIds: readonly DbId[], resultEntryId: string): Result<{ inputs: SessionInputSnapshot[]; toolCallIds: string[] }> {
      try {
        const rows = verifiedResultMembers(db, runId, inputIds, resultEntryId);
        const path = resultPath(db, rows[0]!.session_id, runId, resultEntryId);
        const firstUser = Math.max(...rows.map(row => path.findIndex(entry => entry.id === row.native_entry_id)));
        return ok({ inputs: rows.map(row => snapshot(db, row)), toolCallIds: path.slice(0, firstUser).flatMap(entry => entry.message?.role === 'toolResult'
          && typeof entry.message.toolCallId === 'string' ? [entry.message.toolCallId] : []) });
      } catch { return fail(appError('input_processing_unconfirmed', 'runtime', 'Saved input result cannot be confirmed.', true, runId)); }
    },
    completeResult(runId: DbId, inputIds: readonly DbId[], resultEntryId: string, at: string): Result<void> {
      try { writeTransaction(() => completeSessionInputs(db, runId, inputIds, resultEntryId, at, events)); return ok(undefined); }
      catch { return writeFailure(); }
    },
    failResult(runId: DbId, inputIds: readonly DbId[], resultEntryId: string, error: AppError, at: string): Result<void> {
      try {
        writeTransaction(() => {
          verifiedResultMembers(db, runId, inputIds, resultEntryId);
          for (const id of inputIds) {
            const changed = db.query("UPDATE session_inputs SET processing_status='failed',error_json=?,updated_at=? WHERE id=? AND processing_status='pending'")
              .run(JSON.stringify(error), at, id).changes;
            if (changed === 1) appendInputState(db, id, events);
          }
        });
        return ok(undefined);
      } catch { return writeFailure(); }
    },
  };
}
/** Called within the transaction saving this exact SDK user entry. */
export function markInputConsumed(db: Database, inputId: DbId, runId: DbId, entryId: string, at: string,
  events?: RuntimeEventStore): void {
  const row = db.query('SELECT * FROM session_inputs WHERE id=?').get(inputId) as InputRow | null;
  if (!row || row.run_id !== runId) throw new Error('input_consumption_identity_invalid');
  const entry = db.query('SELECT entry_json,run_id FROM session_native_entries WHERE session_id=? AND entry_id=?')
    .get(row.session_id, entryId) as { entry_json: string; run_id: number | null } | null;
  const run = db.query('SELECT session_id,kind FROM runs WHERE id=?').get(runId) as { session_id: number; kind: string } | null;
  const native = entry ? JSON.parse(entry.entry_json) as NativeEntry : null;
  if (!entry || entry.run_id !== runId || run?.kind !== 'agent' || run.session_id !== row.session_id
    || native?.type !== 'message' || native.message?.role !== 'user') throw new Error('input_consumption_identity_invalid');
  if (row.status === 'consumed') { if (row.native_entry_id !== entryId) throw new Error('input_consumption_identity_conflict'); return; }
  if (!['queued', 'delivery_unknown'].includes(row.status) || row.native_entry_id !== null) throw new Error('input_consumption_state_conflict');
  const changed = db.query("UPDATE session_inputs SET status='consumed',native_entry_id=?,updated_at=? WHERE id=? AND status IN ('queued','delivery_unknown')")
    .run(entryId, at, inputId).changes;
  if (changed === 1) appendInputState(db, inputId, events);
}
function resultPath(db: Database, sessionId: DbId, runId: DbId, resultEntryId: string): NativeEntry[] {
  const stored = db.query('SELECT entry_id,entry_json,run_id FROM session_native_entries WHERE session_id=?').all(sessionId) as {
    entry_id: string; entry_json: string; run_id: number | null }[];
  const entries = new Map(stored.map(row => [row.entry_id, { entry: JSON.parse(row.entry_json) as NativeEntry, runId: row.run_id }]));
  const result = entries.get(resultEntryId);
  const message = result?.entry.message;
  if (result?.runId !== runId || result.entry.type !== 'message' || message?.role !== 'assistant' || message.stopReason !== 'stop'
    || !Array.isArray(message.content) || message.content.some(part => part?.type === 'toolCall')
    || !message.content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())) throw new Error('input_result_identity_invalid');
  const path: NativeEntry[] = [];
  let id: string | null = resultEntryId;
  const visited = new Set<string>();
  while (id !== null) {
    const item = entries.get(id);
    if (!item || visited.has(id)) throw new Error('input_result_path_invalid');
    visited.add(id); path.push(item.entry); id = item.entry.parentId;
  }
  return path;
}
function verifiedResultMembers(db: Database, runId: DbId, inputIds: readonly DbId[], resultEntryId: string): InputRow[] {
  if (!inputIds.length || new Set(inputIds).size !== inputIds.length) throw new Error('input_result_batch_invalid');
  const rows = inputIds.map(id => db.query('SELECT * FROM session_inputs WHERE id=?').get(id) as InputRow | null);
  if (rows.some(row => !row || row.run_id !== runId || row.status !== 'consumed' || row.native_entry_id === null
    || row.result_entry_id !== resultEntryId || !['pending', 'completed'].includes(row.processing_status)
    || JSON.parse(row.content_json).version !== 2)) throw new Error('input_result_batch_invalid');
  const members = rows as InputRow[];
  const sameResult = db.query('SELECT id FROM session_inputs WHERE run_id=? AND result_entry_id=?').all(runId, resultEntryId) as { id: number }[];
  if (sameResult.length !== members.length || sameResult.some(row => !inputIds.includes(row.id))) throw new Error('input_result_batch_frozen');
  const path = resultPath(db, members[0]!.session_id, runId, resultEntryId);
  if (members.some(row => row.session_id !== members[0]!.session_id || !path.some(entry => entry.id === row.native_entry_id
    && entry.type === 'message' && entry.message?.role === 'user'))) throw new Error('input_result_context_missing');
  for (const row of members) {
    const native = db.query('SELECT run_id FROM session_native_entries WHERE session_id=? AND entry_id=?')
      .get(row.session_id, row.native_entry_id!) as { run_id: number | null } | null;
    if (native?.run_id !== runId) throw new Error('input_consumption_identity_invalid');
    const userIndex = path.findIndex(entry => entry.id === row.native_entry_id);
    if (path.slice(1, userIndex).some(entry => entry.type === 'message' && entry.message?.role === 'assistant'
      && entry.message.stopReason === 'stop' && Array.isArray(entry.message.content)
      && !entry.message.content.some(part => part.type === 'toolCall')
      && entry.message.content.some(part => part.type === 'text' && part.text?.trim()))) throw new Error('input_result_first_binding_invalid');
  }
  return members;
}
/** Assistant persistence fixes the first result and members, without claiming completion. */
export function associateInputResult(db: Database, runId: DbId, inputIds: readonly DbId[], resultEntryId: string, at: string,
  events?: RuntimeEventStore): void {
  if (!inputIds.length || new Set(inputIds).size !== inputIds.length) throw new Error('input_result_batch_invalid');
  for (const id of inputIds) {
    const row = db.query('SELECT * FROM session_inputs WHERE id=?').get(id) as InputRow | null;
    if (!row || row.run_id !== runId || row.status !== 'consumed' || row.native_entry_id === null
      || row.processing_status !== 'pending' && !(row.processing_status === 'completed' && row.result_entry_id === resultEntryId)
      || row.result_entry_id !== null && row.result_entry_id !== resultEntryId || JSON.parse(row.content_json).version !== 2)
      throw new Error('input_result_batch_invalid');
  }
  const existing = db.query('SELECT id FROM session_inputs WHERE run_id=? AND result_entry_id=?').all(runId, resultEntryId) as { id: number }[];
  if (existing.length && (existing.length !== inputIds.length || existing.some(row => !inputIds.includes(row.id)))) throw new Error('input_result_batch_frozen');
  for (const id of inputIds) {
    const changed = db.query('UPDATE session_inputs SET result_entry_id=?,updated_at=? WHERE id=? AND result_entry_id IS NULL').run(resultEntryId, at, id).changes;
    if (changed === 1) appendInputState(db, id, events);
  }
  verifiedResultMembers(db, runId, inputIds, resultEntryId);
}
/** Caller verifies authorization, tools and goal for this response batch before this transaction. */
export function completeSessionInputs(db: Database, runId: DbId, inputIds: readonly DbId[], resultEntryId: string, at: string,
  events?: RuntimeEventStore, origin: 'live' | 'recovery' = 'live'): void {
  verifiedResultMembers(db, runId, inputIds, resultEntryId);
  for (const id of inputIds) {
    const changed = db.query("UPDATE session_inputs SET processing_status='completed',error_json=NULL,updated_at=? WHERE id=? AND processing_status='pending'").run(at, id).changes;
    if (changed === 1) appendInputState(db, id, events, origin);
  }
}
/** Run terminal state only closes pending inputs. Completed members require a per-result write. */
export function finishSessionInputs(db: Database, runId: DbId, status: 'completed' | 'failed' | 'cancelled', error: AppError | null,
  at: string, confirmedUnconsumedInputIds: readonly DbId[] = [], events?: RuntimeEventStore, origin: 'live' | 'recovery' = 'live'): void {
  const rows = db.query("SELECT * FROM session_inputs WHERE run_id=? AND processing_status='pending'").all(runId) as InputRow[];
  if (status === 'completed' && rows.some(row => row.status === 'consumed'
    || row.dispatched_at !== null && !confirmedUnconsumedInputIds.includes(row.id))) throw new Error('input_processing_unconfirmed');
  for (const row of rows) {
    if (status === 'completed') {
      const changed = db.query("UPDATE session_inputs SET status='cancelled',processing_status='cancelled',error_json=?,updated_at=? WHERE id=? AND processing_status='pending'")
        .run(JSON.stringify(appError('input_not_consumed', 'session', 'Native execution ended without consuming this input.', false, runId)), at, row.id).changes;
      if (changed === 1) appendInputState(db, row.id, events, origin);
      continue;
    }
    const delivery = row.status === 'consumed' ? 'consumed' : row.dispatched_at === null || confirmedUnconsumedInputIds.includes(row.id)
      ? status === 'cancelled' ? 'cancelled' : 'failed' : 'delivery_unknown';
    const changed = db.query("UPDATE session_inputs SET status=?,processing_status=?,error_json=?,updated_at=? WHERE id=? AND processing_status='pending'")
      .run(delivery, status, error === null ? null : JSON.stringify(error), at, row.id).changes;
    if (changed === 1) appendInputState(db, row.id, events, origin);
  }
}
/** Boot repair neither invents a result nor dispatches another input. */
export function recoverSessionInputs(db: Database, at: string,
  qualify: (runId: DbId, inputIds: readonly DbId[], resultEntryId: string, completed?: boolean) => boolean = () => false,
  events?: RuntimeEventStore): void {
  const completed = db.query("SELECT * FROM session_inputs WHERE processing_status='completed' AND json_extract(content_json,'$.version')=2").all() as InputRow[];
  const verified = new Set<string>();
  for (const input of completed) {
    const key = `${input.run_id}:${input.result_entry_id}`;
    if (verified.has(key)) continue;
    verified.add(key);
    try {
      if (input.run_id === null || input.result_entry_id === null) throw new Error('input_processing_unconfirmed');
      const members = db.query('SELECT id FROM session_inputs WHERE run_id=? AND result_entry_id=?').all(input.run_id, input.result_entry_id) as { id: number }[];
      const ids = members.map(row => row.id);
      verifiedResultMembers(db, input.run_id, ids, input.result_entry_id);
      if (!qualify(input.run_id, ids, input.result_entry_id, true)) throw new Error('input_processing_unconfirmed');
    } catch { db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(input.session_id); }
  }
  const rows = db.query(`SELECT DISTINCT run.id,run.session_id,run.status,run.error_json FROM session_inputs input JOIN runs run ON run.id=input.run_id
    WHERE input.processing_status='pending' AND run.status IN ('completed','failed','cancelled')`).all() as {
      id: number; session_id: number; status: 'completed' | 'failed' | 'cancelled'; error_json: string | null }[];
  for (const row of rows) {
    if (row.status === 'completed') {
      const inputs = db.query('SELECT * FROM session_inputs WHERE run_id=? ORDER BY id').all(row.id) as InputRow[];
      for (const resultEntryId of new Set(inputs.filter(input => input.processing_status === 'pending' && input.result_entry_id !== null)
        .map(input => input.result_entry_id!))) {
        const members = inputs.filter(input => input.result_entry_id === resultEntryId).map(input => input.id);
        if (qualify(row.id, members, resultEntryId)) completeSessionInputs(db, row.id, members, resultEntryId, at, events, 'recovery');
      }
      if (!db.query("SELECT id FROM session_inputs WHERE run_id=? AND processing_status='pending' LIMIT 1").get(row.id)) continue;
    }
    const error = row.status === 'completed' ? appError('input_processing_unconfirmed', 'runtime', 'A terminal Run has unconfirmed input results.', true, row.id)
      : row.error_json === null ? null : JSON.parse(row.error_json);
    finishSessionInputs(db, row.id, row.status === 'completed' ? 'failed' : row.status, error, at, [], events, 'recovery');
    if (row.status === 'completed') db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(row.session_id);
  }
}
