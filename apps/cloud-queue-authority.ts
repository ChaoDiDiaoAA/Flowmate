import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CloudQueueControlQuerySchema, CloudQueueControlSchema, CloudQueueInstructionSchema, CloudQueueOwnerSchema, CloudQueueReceiptSchema,
  CloudQueueVerifyInputsSchema, CloudQueueViewSchema, CloudWorkspaceIdSchema, fail, matchesCloudQueueReceipt, ok, type AppError, type CloudQueueControl, type CloudQueueControlQuery,
  type CloudQueueInstruction, type CloudQueueOwner, type CloudQueuePort, type CloudQueueReceipt, type CloudQueueView, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';

type Options = { database: Pick<DbHandle, 'read' | 'transaction'>; workspaceId: string; runtime: CloudQueuePort; now(): string;
  authorize(input: CloudQueueControl, queue: CloudQueueView, scope: SqlDatabaseStore): Result<void>; onChanged?(): void };
type Row = { request_json: string; receipt_json: string | null };
class QueueFault extends Error { constructor(readonly detail: AppError) { super(detail.code); } }
function need<T>(result: Result<T>): T { if (!result.ok) throw new QueueFault(result.error); return result.data; }
function conflict(): never { throw new QueueFault(appError('state_conflict', 'input', 'The original queue control has different facts.')); }
const unknown = () => fail(appError('operation_result_unknown', 'runtime', 'The original queue control receipt is unknown. Query the same request.', true));

/** Authority persists one exact control intent before asking the native Runtime to apply it. */
export class CloudQueueAuthority {
  private readonly workspaceId: string;
  private readonly pending = new Map<string, { input: CloudQueueControl; result: Promise<Result<CloudQueueReceipt>> }>();
  constructor(private readonly options: Options) { this.workspaceId = CloudWorkspaceIdSchema.parse(options.workspaceId); }
  private async run<T>(action: () => Promise<T>): Promise<Result<T>> {
    try { return ok(await action()); }
    catch (error) { return fail(error instanceof QueueFault ? error.detail
      : appError('cloud_queue_unavailable', 'storage', 'The original queue control could not be confirmed.', true)); }
  }
  private owner(scope: SqlDatabaseStore, input: CloudQueueOwner, active: boolean): void {
    const row = scope.db.query<{ status: string; session_id: number; current_attempt_id: number | null; run_id: number | null;
      stop_requested_at: string | null; stopped_at: string | null }, [number, number]>(`SELECT w.status,w.session_id,w.current_attempt_id,
        a.run_id,a.stop_requested_at,a.stopped_at FROM invoice_works w JOIN invoice_work_attempts a ON a.work_id=w.id
        WHERE w.id=? AND a.id=?`).get(input.workId, input.attemptId);
    const session = need(scope.sessions.get(input.sessionId));
    if (!row || row.session_id !== input.sessionId || session.runtimeKind !== 'durable' || session.durableRuntimeId === 'local'
      || session.cloudWorkspaceId !== this.workspaceId) conflict();
    if (input.itemId !== undefined && !scope.db.query('SELECT id FROM invoice_work_items WHERE work_id=? AND id=?').get(input.workId, input.itemId)) conflict();
    if (active) {
      if (row.status !== 'open' || row.current_attempt_id !== input.attemptId || row.stop_requested_at !== null || row.stopped_at !== null
        || row.run_id === null || session.status !== 'active' || session.deletePending || session.modelUseBlocked) conflict();
      const run = need(scope.runs.get(row.run_id));
      if (run.status !== 'running' || run.cancelRequestedAt !== null) conflict();
    }
  }
  private row(scope: SqlDatabaseStore, input: CloudQueueControlQuery): Row | null {
    return scope.db.query<Row, [number, string]>('SELECT request_json,receipt_json FROM cloud_queue_controls WHERE work_id=? AND control_request_id=?')
      .get(input.workId, input.controlRequestId);
  }
  private original(row: Row, input: CloudQueueControlQuery): CloudQueueControl {
    const value = CloudQueueControlSchema.parse(JSON.parse(row.request_json));
    if (value.workId !== input.workId || value.sessionId !== input.sessionId || value.itemId !== input.itemId || value.attemptId !== input.attemptId
      || value.controlRequestId !== input.controlRequestId) conflict();
    return value;
  }
  private receipt(row: Row, input: CloudQueueControl): CloudQueueReceipt | null {
    if (row.receipt_json === null) return null;
    const value = CloudQueueReceiptSchema.parse(JSON.parse(row.receipt_json));
    if (!matchesCloudQueueReceipt(input, value)) conflict();
    return value;
  }
  private async save(input: CloudQueueControl, raw: CloudQueueReceipt): Promise<Result<CloudQueueReceipt>> {
    const result = await this.run(() => this.options.database.transaction(scope => {
      this.owner(scope, input, false);
      const row = this.row(scope, input); if (!row || !isDeepStrictEqual(this.original(row, input), input)) conflict();
      const checked = this.receipt({ ...row, receipt_json: JSON.stringify(raw) }, input); if (!checked) conflict();
      const prior = this.receipt(row, input);
      if (prior && !isDeepStrictEqual(prior, checked)) conflict();
      if (!prior) scope.db.query('UPDATE cloud_queue_controls SET receipt_json=? WHERE work_id=? AND control_request_id=? AND receipt_json IS NULL')
        .run(JSON.stringify(checked), input.workId, input.controlRequestId);
      return prior ?? checked;
    }));
    if (result.ok) try { this.options.onChanged?.(); } catch { /* The committed receipt remains queryable. */ }
    return result;
  }
  async read(raw: unknown): Promise<Result<CloudQueueView>> {
    const parsed = CloudQueueOwnerSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The queue owner is invalid.'));
    const owner = parsed.data;
    const allowed = await this.run(() => this.options.database.read(scope => { this.owner(scope, owner, false); }));
    if (!allowed.ok) return allowed;
    let result: Result<CloudQueueView>;
    try { result = await this.options.runtime.read(owner); }
    catch { return fail(appError('cloud_queue_unavailable', 'runtime', 'The original native queue could not be read.', true)); }
    if (!result.ok) return result;
    const view = CloudQueueViewSchema.safeParse(result.data);
    if (!view.success || view.data.workId !== owner.workId || view.data.sessionId !== owner.sessionId || view.data.itemId !== owner.itemId || view.data.attemptId !== owner.attemptId
      || new Set(view.data.items.map(item => item.submissionId)).size !== view.data.items.length)
      return fail(appError('cloud_queue_unavailable', 'runtime', 'The original native queue response is invalid.', true));
    const verified = await this.run(() => this.options.database.read(scope => {
      this.owner(scope, owner, false);
      const session = need(scope.sessions.get(owner.sessionId));
      if (session.runtimeKind !== 'durable' || session.durableConversationId === null) conflict();
      for (const item of view.data.items) {
        const phase = scope.db.query<{ native_submission_id: number; native_conversation_id: number; item_id: number | null; scheduler_state: string }, [number, number, string]>(
          `SELECT native_submission_id,native_conversation_id,item_id,scheduler_state FROM invoice_work_phases
          WHERE work_id=? AND attempt_id=? AND request_id=? AND native_conversation_id IS NOT NULL AND native_submission_id IS NOT NULL AND closed_at IS NULL`)
          .get(owner.workId, owner.attemptId, item.requestId);
        if (!phase) throw new QueueFault(appError('source_invalid', 'runtime', 'A queued input is not linked to its original invoice phase.'));
        if (phase.scheduler_state === 'legacy' ? owner.itemId !== undefined || phase.native_conversation_id !== session.durableConversationId
          : owner.itemId === undefined || phase.item_id !== owner.itemId) conflict();
        if (phase.native_submission_id === item.submissionId) continue;
        const controls = scope.db.query<Row, [number, number]>('SELECT request_json,receipt_json FROM cloud_queue_controls WHERE work_id=? AND attempt_id=? ORDER BY id')
          .all(owner.workId, owner.attemptId);
        const matched = controls.some(row => {
          const input = CloudQueueControlSchema.parse(JSON.parse(row.request_json));
          const receipt = this.receipt(row, input);
          return input.workId === owner.workId && input.sessionId === owner.sessionId && input.itemId === owner.itemId && input.attemptId === owner.attemptId
            && input.action.kind === 'enqueue' && input.action.phaseRequestId === item.requestId && receipt?.status === 'applied'
            && receipt.submissionId === item.submissionId;
        });
        if (!matched) throw new QueueFault(appError('source_invalid', 'runtime', 'A queued input has no original authorized control receipt.'));
      }
      const phases = scope.db.query<{ request_id: string }, [number, number, number | null, number | null]>(`SELECT request_id FROM invoice_work_phases
        WHERE work_id=? AND attempt_id=? AND native_submission_id IS NOT NULL AND closed_at IS NULL
          AND ((? IS NULL AND scheduler_state='legacy') OR (item_id=? AND scheduler_state!='legacy')) ORDER BY id LIMIT 2`)
        .all(owner.workId, owner.attemptId, owner.itemId ?? null, owner.itemId ?? null);
      if (phases.length > 1) conflict();
      return phases[0]?.request_id ?? null;
    }));
    if (!verified.ok) return verified;
    return ok({ ...view.data, activePhaseRequestId: verified.data });
  }
  async queryControl(raw: unknown): Promise<Result<CloudQueueReceipt | null>> {
    const parsed = CloudQueueControlQuerySchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The queue control identity is invalid.'));
    const input = parsed.data;
    const found = await this.run(() => this.options.database.read(scope => {
      this.owner(scope, input, false); const row = this.row(scope, input); if (!row) return null;
      const original = this.original(row, input); return { original, receipt: this.receipt(row, original) };
    }));
    if (!found.ok) return found;
    if (found.data === null) return ok(null);
    if (found.data.receipt) return ok(found.data.receipt);
    let remote: Result<CloudQueueReceipt | null>;
    try { remote = await this.options.runtime.queryControl(input); } catch { return unknown(); }
    if (!remote.ok) return unknown();
    if (remote.data === null) return ok(null);
    return this.save(found.data.original, remote.data);
  }
  private async resolveReceipt(entry: { input: CloudQueueControl; receipt: CloudQueueReceipt | null }): Promise<Result<CloudQueueReceipt | null>> {
    if (entry.receipt) return ok(entry.receipt);
    const { workId, sessionId, itemId, attemptId, controlRequestId } = entry.input;
    const key = { workId, sessionId, ...(itemId === undefined ? {} : { itemId }), attemptId, controlRequestId };
    const active = this.pending.get(JSON.stringify([workId, controlRequestId]));
    if (active && isDeepStrictEqual(active.input, entry.input)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([active.result, new Promise<Result<CloudQueueReceipt>>(resolve => {
          timer = setTimeout(() => resolve(unknown()), 30_000);
        })]);
        if (result.ok) return result;
      } finally { if (timer) clearTimeout(timer); }
    }
    return this.queryControl(key);
  }
  async wasCancelled(raw: unknown): Promise<Result<boolean>> {
    const parsed = CloudQueueOwnerSchema.extend({ requestId: z.string().min(1).max(128), nativeSubmissionId: z.number().int().positive().safe() }).strict().safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The queue phase identity is invalid.'));
    const query = parsed.data;
    const found = await this.run(() => this.options.database.read(scope => {
      this.owner(scope, query, false);
      const phase = need(scope.invoiceWorks.getPhase({ workId: query.workId, attemptId: query.attemptId, requestId: query.requestId }));
      if (!phase || phase.nativeSubmissionId !== query.nativeSubmissionId
        || (phase.basis.executionMode === 'item-lane-approval-v1' ? phase.itemId !== query.itemId : query.itemId !== undefined)) conflict();
      return scope.db.query<Row, [number, number]>('SELECT request_json,receipt_json FROM cloud_queue_controls WHERE work_id=? AND attempt_id=? ORDER BY id')
        .all(query.workId, query.attemptId).map(row => {
          const input = CloudQueueControlSchema.parse(JSON.parse(row.request_json));
          if (input.workId !== query.workId || input.sessionId !== query.sessionId || input.attemptId !== query.attemptId) conflict();
          return { input, receipt: this.receipt(row, input) };
        }).filter(value => value.input.itemId === query.itemId && value.input.action.kind === 'cancel' && value.input.action.submissionId === query.nativeSubmissionId);
    }));
    if (!found.ok) return found;
    for (const entry of found.data) {
      const receipt = await this.resolveReceipt(entry);
      if (!receipt.ok) return receipt;
      if (!receipt.data) return unknown();
      if (receipt.data.status === 'applied') return ok(true);
    }
    return ok(false);
  }
  async verifyInputs(raw: unknown): Promise<Result<CloudQueueInstruction[]>> {
    const parsed = CloudQueueVerifyInputsSchema.safeParse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The queued phase inputs are invalid.'));
    const query = parsed.data;
    const found = await this.run(() => this.options.database.read(scope => {
      this.owner(scope, query, false);
      const phase = need(scope.invoiceWorks.getPhase({ workId: query.workId, attemptId: query.attemptId, requestId: query.requestId }));
      if (!phase || phase.nativeSubmissionId === null
        || (phase.basis.executionMode === 'item-lane-approval-v1' ? phase.itemId !== query.itemId : query.itemId !== undefined)) conflict();
      return scope.db.query<Row, [number, number]>('SELECT request_json,receipt_json FROM cloud_queue_controls WHERE work_id=? AND attempt_id=? ORDER BY id')
        .all(query.workId, query.attemptId).map(row => {
          const input = CloudQueueControlSchema.parse(JSON.parse(row.request_json));
          if (input.workId !== query.workId || input.sessionId !== query.sessionId || input.attemptId !== query.attemptId) conflict();
          return { input, receipt: this.receipt(row, input) };
        }).filter(value => value.input.itemId === query.itemId);
    }));
    if (!found.ok) return found;
    const verified: CloudQueueInstruction[] = [];
    for (const item of query.items) {
      const start = found.data.findIndex(entry => entry.input.controlRequestId === item.controlRequestId
        && entry.input.action.kind === 'enqueue' && entry.input.action.phaseRequestId === query.requestId);
      if (start < 0) return fail(appError('source_invalid', 'runtime', 'The original queued input is not authorized.'));
      const original = found.data[start]!, receipt = await this.resolveReceipt(original);
      if (!receipt.ok) return receipt; if (!receipt.data) return unknown();
      if (receipt.data.status !== 'applied' || receipt.data.submissionId !== item.submissionId || original.input.action.kind !== 'enqueue')
        return fail(appError('source_invalid', 'runtime', 'The original queued input receipt does not match.'));
      let content = original.input.action.content;
      for (const entry of found.data.slice(start + 1)) {
        if (entry.input.action.kind !== 'edit' && entry.input.action.kind !== 'cancel' || entry.input.action.submissionId !== item.submissionId) continue;
        const settled = await this.resolveReceipt(entry); if (!settled.ok) return settled; if (!settled.data) return unknown();
        if (settled.data.status !== 'applied') continue;
        if (entry.input.action.kind === 'cancel') return fail(appError('source_invalid', 'runtime', 'The queued input was cancelled.'));
        content = entry.input.action.content;
      }
      if (content !== item.content) return fail(appError('source_invalid', 'runtime', 'The queued input content differs from its confirmed controls.'));
      verified.push(CloudQueueInstructionSchema.parse({ provenance: 'user-provided', controlRequestId: item.controlRequestId,
        submissionId: item.submissionId, content }));
    }
    return ok(verified);
  }
  async currentEdit(raw: unknown): Promise<Result<{ controlRequestId: string; content: string } | null>> {
    const parsed = CloudQueueOwnerSchema.extend({ requestId: z.string().min(1).max(128) }).strict().safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The queue phase identity is invalid.'));
    const query = parsed.data;
    const found = await this.run(() => this.options.database.read(scope => {
      this.owner(scope, query, false);
      const phase = need(scope.invoiceWorks.getPhase({ workId: query.workId, attemptId: query.attemptId, requestId: query.requestId }));
      if (!phase || (phase.basis.executionMode === 'item-lane-approval-v1' ? phase.itemId !== query.itemId : query.itemId !== undefined)) conflict();
      if (phase.nativeSubmissionId === null) return [];
      return scope.db.query<Row, [number, number]>('SELECT request_json,receipt_json FROM cloud_queue_controls WHERE work_id=? AND attempt_id=? ORDER BY id')
        .all(query.workId, query.attemptId).map(row => {
          const input = CloudQueueControlSchema.parse(JSON.parse(row.request_json));
          if (input.workId !== query.workId || input.sessionId !== query.sessionId || input.attemptId !== query.attemptId) conflict();
          return { input, receipt: this.receipt(row, input) };
        }).filter(value => value.input.itemId === query.itemId && value.input.action.kind === 'edit' && value.input.action.submissionId === phase.nativeSubmissionId);
    }));
    if (!found.ok) return found;
    let current: { controlRequestId: string; content: string } | null = null;
    for (const entry of found.data) {
      const receipt = await this.resolveReceipt(entry);
      if (!receipt.ok) return receipt;
      if (!receipt.data) return unknown();
      if (receipt.data.status === 'applied' && entry.input.action.kind === 'edit')
        current = { controlRequestId: entry.input.controlRequestId, content: entry.input.action.content };
    }
    return ok(current);
  }
  apply(raw: unknown): Promise<Result<CloudQueueReceipt>> {
    const parsed = CloudQueueControlSchema.safeParse(raw); if (!parsed.success) return Promise.resolve(fail(appError('input_invalid', 'input', 'The queue control is invalid.')));
    const input = parsed.data, id = JSON.stringify([input.workId, input.controlRequestId]), current = this.pending.get(id);
    if (current) return isDeepStrictEqual(current.input, input) ? current.result
      : Promise.resolve(fail(appError('state_conflict', 'input', 'The original queue control has different facts.')));
    const result = this.applyOriginal(input).catch(unknown).finally(() => { if (this.pending.get(id)?.result === result) this.pending.delete(id); });
    this.pending.set(id, { input: structuredClone(input), result }); return result;
  }
  private async applyOriginal(input: CloudQueueControl): Promise<Result<CloudQueueReceipt>> {
    const owner = { workId: input.workId, sessionId: input.sessionId, ...(input.itemId === undefined ? {} : { itemId: input.itemId }), attemptId: input.attemptId },
      key = { ...owner, controlRequestId: input.controlRequestId };
    let original = await this.run(() => this.options.database.read(scope => {
      this.owner(scope, input, false); const row = this.row(scope, key);
      if (!row) return null;
      if (!isDeepStrictEqual(this.original(row, key), input)) conflict();
      return this.receipt(row, input);
    }));
    if (!original.ok) return original;
    if (original.data) return ok(original.data);
    const existing = await this.options.database.read(scope => this.row(scope, key)).catch(() => undefined);
    if (existing === undefined) return unknown();
    if (!existing) {
      const queue = await this.read(owner); if (!queue.ok) return queue;
      const recorded = await this.run(() => this.options.database.transaction(scope => {
        this.owner(scope, input, true); need(this.options.authorize(structuredClone(input), structuredClone(queue.data), scope));
        const prior = this.row(scope, key);
        if (prior) { if (!isDeepStrictEqual(this.original(prior, key), input)) conflict(); return; }
        const at = z.string().datetime({ offset: true }).parse(this.options.now());
        scope.db.query(`INSERT INTO cloud_queue_controls(workspace_id,work_id,session_id,attempt_id,control_request_id,request_json,created_at)
          VALUES(?,?,?,?,?,?,?)`).run(this.workspaceId, input.workId, input.sessionId, input.attemptId, input.controlRequestId, JSON.stringify(input), at);
      }));
      if (!recorded.ok) return recorded;
    }
    const found = await this.queryControl(key); if (!found.ok) return found;
    if (found.data) return ok(found.data);
    const queue = await this.read(owner); if (!queue.ok) return queue;
    const allowed = await this.run(() => this.options.database.read(scope => {
      this.owner(scope, input, true); need(this.options.authorize(structuredClone(input), structuredClone(queue.data), scope));
    }));
    if (!allowed.ok) return allowed;
    let result: Result<CloudQueueReceipt>;
    try { result = await this.options.runtime.apply(input); } catch { return unknown(); }
    if (!result.ok) return unknown();
    return this.save(input, result.data);
  }
}
