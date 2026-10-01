import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { appError, fail, normalizeSessionInputRequest, ok, SessionInputContentSchema,
  SessionInputQuerySchema, SessionInputSnapshotSchema } from '@flowmate/contracts';
import type { AppError, DbId, Result, SessionInputQuery, SessionInputQueryResult,
  SessionInputRequest, SessionInputSnapshot } from '@flowmate/contracts';
import type { WorkspaceRunAdmission } from '../storage/repositories.ts';

type InputRow = { id: number; session_id: number; client_sequence: number; mode: string; goal_mode: string;
  request_hash: string; run_id: number | null; content_json: string; status: string; processing_status: string;
  native_entry_id: string | null; dispatched_at: string | null; error_json: string | null; created_at: string; updated_at: string };
function snapshot(row: InputRow): SessionInputSnapshot {
  return SessionInputSnapshotSchema.parse({ inputId: row.id, sessionId: row.session_id, clientSequence: row.client_sequence,
    mode: row.mode, goalMode: row.goal_mode, runId: row.run_id, content: JSON.parse(row.content_json), status: row.status,
    processingStatus: row.processing_status, nativeEntryId: row.native_entry_id, dispatchedAt: row.dispatched_at,
    error: row.error_json === null ? null : JSON.parse(row.error_json), createdAt: row.created_at, updatedAt: row.updated_at });
}
const writeFailure = () => fail(appError('storage_write_failed', 'storage', 'Session input could not be saved.', true));
export type SessionInputLedger = ReturnType<typeof createSessionInputLedger>;
export function createSessionInputLedger(db: Database) {
  const rowByRun = (runId: DbId) => db.query('SELECT * FROM session_inputs WHERE run_id=? ORDER BY id').get(runId) as InputRow | null;
  function lookup(raw: SessionInputRequest): Result<SessionInputSnapshot | null> {
    const normalized = normalizeSessionInputRequest(raw);
    if (!normalized.ok) return normalized;
    try {
      const request = normalized.data;
      const row = db.query('SELECT * FROM session_inputs WHERE session_id=? AND client_sequence=?')
        .get(request.sessionId, request.clientSequence) as InputRow | null;
      if (!row) return ok(null);
      const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      if (row.request_hash !== hash) return fail(appError('state_conflict', 'input', 'This client sequence belongs to another input.'));
      return ok(snapshot(row));
    } catch { return fail(appError('storage_read_failed', 'storage', 'Session input could not be read.', true)); }
  }
  return {
    lookup,
    query(raw: SessionInputQuery): Result<SessionInputQueryResult> {
      const parsed = SessionInputQuerySchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session input query is invalid.'));
      try {
        const { sessionId, clientSequence } = parsed.data;
        if (!db.query('SELECT id FROM sessions WHERE id=?').get(sessionId)) return fail(appError('session_not_found', 'session', 'Session does not exist.'));
        const max = (db.query('SELECT COALESCE(MAX(client_sequence),0) AS sequence FROM session_inputs WHERE session_id=?')
          .get(sessionId) as { sequence: number }).sequence;
        const row = clientSequence === undefined ? null : db.query('SELECT * FROM session_inputs WHERE session_id=? AND client_sequence=?')
          .get(sessionId, clientSequence) as InputRow | null;
        return ok({ input: row ? snapshot(row) : null, nextClientSequence: max < Number.MAX_SAFE_INTEGER ? max + 1 : null });
      } catch { return fail(appError('storage_read_failed', 'storage', 'Session input could not be read.', true)); }
    },
    getForRun(runId: DbId): Result<SessionInputSnapshot | null> {
      try { const row = rowByRun(runId); return ok(row ? snapshot(row) : null); }
      catch { return fail(appError('storage_read_failed', 'storage', 'Session input could not be read.', true)); }
    },
    admit(raw: SessionInputRequest, createRun: () => Result<WorkspaceRunAdmission>, at: string): Result<{
      input: SessionInputSnapshot; admission: WorkspaceRunAdmission | null; created: boolean;
    }> {
      const normalized = normalizeSessionInputRequest(raw);
      if (!normalized.ok) return normalized;
      let rejected: Result<never> | null = null;
      try {
        return db.transaction(() => {
          const existing = lookup(normalized.data);
          if (!existing.ok) { rejected = existing; throw new Error('input_admission_rejected'); }
          if (existing.data) return ok({ input: existing.data, admission: null, created: false });
          const created = createRun();
          if (!created.ok) { rejected = created; throw new Error('input_admission_rejected'); }
          const admission = created.data;
          const run = db.query("SELECT session_id,kind,status FROM runs WHERE id=?").get(admission.runId) as {
            session_id: number; kind: string; status: string } | null;
          if (run?.kind !== 'agent' || run.session_id !== normalized.data.sessionId || run.status !== 'created') throw new Error('input_run_identity_invalid');
          const content = SessionInputContentSchema.parse({ version: 1, text: normalized.data.text,
            workspaceContext: admission.workspaceContext, allowedDocumentIds: admission.scope.allowedDocumentIds,
            allowedArtifactIds: admission.scope.allowedArtifactIds });
          if (content.workspaceContext.sessionId !== normalized.data.sessionId) throw new Error('input_session_identity_invalid');
          const hash = createHash('sha256').update(JSON.stringify(normalized.data)).digest('hex');
          const inserted = db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,
            content_json,status,processing_status,native_entry_id,dispatched_at,error_json,created_at,updated_at)
            VALUES (?,?,'prompt','fill-form',?,?,?,'queued','pending',NULL,NULL,NULL,?,?)`)
            .run(normalized.data.sessionId, normalized.data.clientSequence, hash, admission.runId, JSON.stringify(content), at, at);
          const row = db.query('SELECT * FROM session_inputs WHERE id=?').get(Number(inserted.lastInsertRowid)) as InputRow;
          return ok({ input: snapshot(row), admission, created: true });
        }).immediate();
      } catch { return rejected ?? writeFailure(); }
    },
    dispatch(runId: DbId, at: string): Result<void> {
      try {
        const row = rowByRun(runId);
        if (!row || row.status !== 'queued' || row.processing_status !== 'pending' || row.dispatched_at !== null)
          return fail(appError('state_conflict', 'session', 'Session input is not eligible for a new dispatch.'));
        const changed = db.query("UPDATE session_inputs SET dispatched_at=?,updated_at=? WHERE id=? AND status='queued' AND dispatched_at IS NULL")
          .run(at, at, row.id).changes;
        return changed === 1 ? ok(undefined) : fail(appError('state_conflict', 'session', 'Session input dispatch has changed.'));
      } catch { return writeFailure(); }
    },
  };
}

/** Called only within the transaction saving this actual SDK user entry. */
export function markInputConsumed(db: Database, runId: DbId, entryId: string, at: string): void {
  const rows = db.query('SELECT * FROM session_inputs WHERE run_id=? ORDER BY id').all(runId) as InputRow[];
  if (rows.length === 0) return;
  if (rows.length !== 1) throw new Error('ambiguous_initial_input');
  const row = rows[0]!;
  const entry = db.query('SELECT entry_json,run_id FROM session_native_entries WHERE session_id=? AND entry_id=?')
    .get(row.session_id, entryId) as { entry_json: string; run_id: number | null } | null;
  const run = db.query("SELECT session_id,kind FROM runs WHERE id=?").get(runId) as { session_id: number; kind: string } | null;
  if (!entry || entry.run_id !== runId || run?.kind !== 'agent' || run.session_id !== row.session_id
    || JSON.parse(entry.entry_json)?.type !== 'message' || JSON.parse(entry.entry_json)?.message?.role !== 'user')
    throw new Error('input_consumption_identity_invalid');
  if (row.status === 'consumed') {
    if (row.native_entry_id !== entryId) throw new Error('input_consumption_identity_conflict');
    return;
  }
  if (!['queued', 'delivery_unknown'].includes(row.status) || row.native_entry_id !== null) throw new Error('input_consumption_state_conflict');
  db.query("UPDATE session_inputs SET status='consumed',native_entry_id=?,updated_at=? WHERE id=? AND status IN ('queued','delivery_unknown')")
    .run(entryId, at, row.id);
}

/** Run/Job terminal facts and the original input processing fact share the caller's transaction. */
export function finishSessionInputs(db: Database, runId: DbId, status: 'completed' | 'failed' | 'cancelled', error: AppError | null, at: string): void {
  const rows = db.query("SELECT * FROM session_inputs WHERE run_id=? AND processing_status='pending'").all(runId) as InputRow[];
  for (const row of rows) {
    if (status === 'completed' && row.status !== 'consumed') throw new Error('input_consumption_unconfirmed');
    const delivery = row.status === 'consumed' ? 'consumed' : row.dispatched_at === null
      ? status === 'cancelled' ? 'cancelled' : 'failed' : 'delivery_unknown';
    db.query("UPDATE session_inputs SET status=?,processing_status=?,error_json=?,updated_at=? WHERE id=? AND processing_status='pending'")
      .run(delivery, status, error === null ? null : JSON.stringify(error), at, row.id);
  }
}

/** Boot repair reads existing Run/entry facts; it never starts another prompt or tool. */
export function recoverSessionInputs(db: Database, at: string): void {
  const rows = db.query(`SELECT DISTINCT run.id,run.status,run.error_json FROM session_inputs input JOIN runs run ON run.id=input.run_id
    WHERE input.processing_status='pending' AND run.status IN ('completed','failed','cancelled')`).all() as {
      id: number; status: 'completed' | 'failed' | 'cancelled'; error_json: string | null }[];
  for (const row of rows) finishSessionInputs(db, row.id, row.status, row.error_json === null ? null : JSON.parse(row.error_json), at);
}
