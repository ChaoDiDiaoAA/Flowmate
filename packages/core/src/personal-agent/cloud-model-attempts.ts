import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CloudModelAttemptRequestSchema, DurableRunConfigSnapshotSchema, fail, isRetryableCloudModelStatus, ok,
  type AppError, type CloudModelAttempt, type DurableAttemptIdentity, type DurableSubagentIdentity, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { DurableInvoiceGovernor } from './admission.ts';

const requestSchema = CloudModelAttemptRequestSchema;
type Request = CloudModelAttempt;
type State = 'reserved' | 'sending' | 'confirmed' | 'uncertain';
type Row = { request_json: string; state: State; http_status: number | null };
class AttemptFault extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
function reject(code: string, message: string): never { throw new AttemptFault(appError(code, 'runtime', message, true)); }
function need<T>(value: Result<T>): T { if (!value.ok) throw new AttemptFault(value.error); return value.data; }
const identity = (input: Request): DurableAttemptIdentity => ({ workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId });
const childIdentity = (input: Request): DurableSubagentIdentity | null => input.child
  ? { ...identity(input), ...(input.itemId === undefined ? {} : { itemId: input.itemId }), requestId: input.requestId, childRunId: input.child.childRunId, childSessionId: input.child.childSessionId,
    originToolCallId: input.child.originToolCallId, nativeToolTaskId: input.child.nativeToolTaskId } : null;

/** Product transactions bind one native request identity to one quota reservation and one transport. */
export class CloudModelAttempts {
  private used = false;
  constructor(private readonly database: Pick<DbHandle, 'transaction'>, private readonly governor: DurableInvoiceGovernor,
    private readonly now: () => string) {}

  private async transaction<T>(action: (store: SqlDatabaseStore) => T): Promise<Result<T>> {
    try { return ok(await this.database.transaction(action)); }
    catch (error) { return fail(error instanceof AttemptFault ? error.detail
      : appError('cloud_model_storage_unavailable', 'storage', 'The original cloud model attempt could not be confirmed.', true)); }
  }

  private parse(raw: unknown): Result<Request> {
    const parsed = requestSchema.safeParse(raw);
    return parsed.success ? ok(parsed.data) : fail(appError('input_invalid', 'input', 'The cloud model attempt is invalid.'));
  }

  private original(store: SqlDatabaseStore, input: Request): void {
    const row = store.db.query<{ durable_runtime_id: string; cloud_workspace_id: string | null; native_conversation_id: number | null;
      native_submission_id: number | null; run_id: number | null; item_id: number | null; scheduler_state: string }, [number, number, number, number, string]>(`SELECT s.durable_runtime_id,
      s.cloud_workspace_id,p.native_conversation_id,p.native_submission_id,p.item_id,p.scheduler_state,a.run_id FROM invoice_work_phases p
      JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=p.work_id
      JOIN invoice_works w ON w.id=p.work_id JOIN sessions s ON s.id=w.session_id
      WHERE p.id=? AND p.work_id=? AND p.attempt_id=? AND w.session_id=? AND p.request_id=?`)
      .get(input.phaseId, input.workId, input.attemptId, input.sessionId, input.requestId);
    if (!row || row.durable_runtime_id !== input.cloudRuntimeId || row.cloud_workspace_id !== input.workspaceId
      || row.native_submission_id !== input.nativeSubmissionId || row.run_id === null
      || (row.scheduler_state === 'legacy' ? input.itemId !== undefined : row.item_id !== input.itemId))
      reject('source_invalid', 'The model attempt does not belong to its original cloud phase.');
    const session = need(store.sessions.get(input.child?.childSessionId ?? input.sessionId));
    if (session.runtimeKind !== 'durable' || session.durableRuntimeId !== input.cloudRuntimeId
      || session.cloudWorkspaceId !== input.workspaceId
      || (input.child || row.scheduler_state === 'legacy') && session.durableConversationId !== input.nativeConversationId
      || !input.child && row.native_conversation_id !== input.nativeConversationId)
      reject('source_invalid', 'The model attempt does not belong to its original native Session.');
    const run = need(store.runs.get(row.run_id)), config = DurableRunConfigSnapshotSchema.parse(run.config);
    if (config.requestedModel.model !== input.model) reject('source_invalid', 'The model differs from the original Work configuration.');
  }

  private row(store: SqlDatabaseStore, input: Request): Row | null {
    return store.db.query<Row, [string]>('SELECT request_json,state,http_status FROM cloud_model_attempts WHERE model_attempt_id=?').get(input.modelAttemptId);
  }

  private same(row: Row, input: Request): void {
    if (!isDeepStrictEqual(JSON.parse(row.request_json), input)) reject('state_conflict', 'The original model attempt identity has different request facts.');
  }

  async reserve(raw: unknown): Promise<Result<{ state: State }>> {
    this.used = true;
    const parsed = this.parse(raw); if (!parsed.ok) return parsed;
    const input = parsed.data;
    return this.transaction(store => {
      this.original(store, input);
      const existing = this.row(store, input);
      if (existing) { this.same(existing, input); return { state: existing.state }; }
      const sameCheckpoint = store.db.query<Row, [string, number, number, number]>(`SELECT request_json,state,http_status FROM cloud_model_attempts
        WHERE durable_runtime_id=? AND native_task_id=? AND checkpoint_entry_id=? AND transport_ordinal=?`)
        .get(input.cloudRuntimeId, input.nativeTaskId, input.checkpointEntryId, input.transportOrdinal);
      if (sameCheckpoint) reject('state_conflict', 'The native model checkpoint already owns another request identity.');
      if (input.transportOrdinal > 0) {
        const previous = store.db.query<Row, [string, number, number, number]>(`SELECT request_json,state,http_status FROM cloud_model_attempts
          WHERE durable_runtime_id=? AND native_task_id=? AND checkpoint_entry_id=? AND transport_ordinal=?`)
          .get(input.cloudRuntimeId, input.nativeTaskId, input.checkpointEntryId, input.transportOrdinal - 1);
        const prior = previous && requestSchema.parse(JSON.parse(previous.request_json));
        if (!previous || previous.state !== 'confirmed' || !isRetryableCloudModelStatus(previous.http_status ?? 0)
          || !prior || !isDeepStrictEqual({ ...prior, modelAttemptId: input.modelAttemptId, transportOrdinal: input.transportOrdinal }, input))
          reject('state_conflict', 'A new model transport needs its original confirmed retryable failure.');
      }
      const child = childIdentity(input);
      need(child ? this.governor.reserveSubagentModelRequestInStore(store, child) : this.governor.reserveModelRequestInStore(store, identity(input)));
      const at = z.string().datetime({ offset: true }).parse(this.now());
      store.db.query(`INSERT INTO cloud_model_attempts(model_attempt_id,durable_runtime_id,work_id,attempt_id,phase_id,native_task_id,
        checkpoint_entry_id,transport_ordinal,request_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,?)`)
        .run(input.modelAttemptId, input.cloudRuntimeId, input.workId, input.attemptId, input.phaseId, input.nativeTaskId,
          input.checkpointEntryId, input.transportOrdinal, JSON.stringify(input), at, at);
      return { state: 'reserved' as const };
    });
  }

  async begin(raw: unknown): Promise<Result<void>> {
    this.used = true;
    const parsed = this.parse(raw); if (!parsed.ok) return parsed;
    const input = parsed.data;
    return this.transaction(store => {
      this.original(store, input);
      const existing = this.row(store, input);
      if (!existing) reject('source_invalid', 'The original model request has no reservation.');
      this.same(existing, input);
      if (existing.state !== 'reserved') reject('cloud_model_result_unknown', 'The original model transport cannot be sent again.');
      const child = childIdentity(input);
      need(child ? this.governor.verifySubagentModelUseInStore(store, child) : this.governor.verifyModelUseInStore(store, identity(input)));
      const at = z.string().datetime({ offset: true }).parse(this.now());
      if (store.db.query("UPDATE cloud_model_attempts SET state='sending',updated_at=? WHERE model_attempt_id=? AND state='reserved'")
        .run(at, input.modelAttemptId).changes !== 1) reject('cloud_model_result_unknown', 'The original model transport state changed.');
    });
  }

  async confirmedStatus(raw: unknown): Promise<Result<number | null>> {
    this.used = true;
    const parsed = this.parse(raw); if (!parsed.ok) return parsed;
    const input = parsed.data;
    return this.transaction(store => {
      this.original(store, input);
      const existing = this.row(store, input); if (!existing) reject('source_invalid', 'The original model request has no reservation.');
      this.same(existing, input);
      return existing.state === 'confirmed' ? existing.http_status : null;
    });
  }

  async settle(raw: unknown, outcome: { kind: 'uncertain' } | { kind: 'confirmed'; httpStatus: number }): Promise<Result<void>> {
    this.used = true;
    const parsed = this.parse(raw); if (!parsed.ok) return parsed;
    if (outcome.kind !== 'uncertain' && (outcome.kind !== 'confirmed' || !Number.isInteger(outcome.httpStatus)
      || outcome.httpStatus < 100 || outcome.httpStatus > 599)) return fail(appError('input_invalid', 'input', 'The model outcome is invalid.'));
    const input = parsed.data;
    return this.transaction(store => {
      const existing = this.row(store, input); if (!existing) reject('source_invalid', 'The original model request has no reservation.');
      this.same(existing, input);
      const status = outcome.kind === 'confirmed' ? outcome.httpStatus : null;
      if (existing.state === outcome.kind && existing.http_status === status) return;
      if (existing.state !== 'sending') reject('state_conflict', 'The original model transport cannot change its outcome.');
      const at = z.string().datetime({ offset: true }).parse(this.now());
      if (store.db.query("UPDATE cloud_model_attempts SET state=?,http_status=?,updated_at=? WHERE model_attempt_id=? AND state='sending'")
        .run(outcome.kind, status, at, input.modelAttemptId).changes !== 1) reject('state_conflict', 'The original model transport outcome changed.');
    });
  }

  /** Only call during exclusive Authority startup, before accepting model transports. */
  async recoverSending(): Promise<Result<void>> {
    if (this.used) return fail(appError('state_conflict', 'runtime', 'Model transport recovery must precede new requests.'));
    this.used = true;
    return this.transaction(store => {
      const at = z.string().datetime({ offset: true }).parse(this.now());
      store.db.query("UPDATE cloud_model_attempts SET state='uncertain',updated_at=? WHERE state='sending'").run(at);
    });
  }
}
