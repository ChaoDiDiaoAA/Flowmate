import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, PersonalTaskStopRequestSchema, PersonalTaskStopReceiptSchema, PersonalTaskViewSchema,
  PersonalTaskListRequestSchema, PersonalTaskListResultSchema, PersonalTaskGetRequestSchema, PersonalTaskGetResultSchema,
  InvoiceWorkChildReferenceSchema, ToolCallCleanupSchema, ToolCallDeliverySchema, ToolRuntimeObservationSchema,
  type AppError, type DurableAttemptStopResult, type PersonalTaskStopRequest, type PersonalTaskStopReceipt,
  type PersonalTaskView, type PersonalTaskListRequest, type PersonalTaskListResult, type PersonalTaskGetRequest,
  type PersonalTaskGetResult, type Result } from '@flowmate/contracts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';
import { readTransaction } from '../storage/reads.ts';
import { createRunRepository, createToolCallRepository } from '../storage/repositories.ts';

export type InvoiceWorkAttemptFinishRequest = { workId: number; attemptId: number; runId: number | null; at: string;
  effectsReconciled: boolean; stopResult?: DurableAttemptStopResult };
export type InvoiceWorkAttemptFinishResult = { closed: boolean; task: PersonalTaskView;
  reason: 'run-active' | 'root-stop-unconfirmed' | 'phase-unclosed' | 'owned-execution-unclosed'
    | 'tool-execution-unclosed' | 'effects-unconfirmed' | null };
export interface InvoiceWorkAttemptRepository {
  list(input: PersonalTaskListRequest): Result<PersonalTaskListResult>;
  get(input: PersonalTaskGetRequest): Result<PersonalTaskGetResult>;
  requestStop(input: PersonalTaskStopRequest, options: { at: string }): Result<PersonalTaskStopReceipt>;
  finish(input: InvoiceWorkAttemptFinishRequest): Result<InvoiceWorkAttemptFinishResult>;
}

type WorkRow = { id: number; session_id: number; revision: number; current_attempt_id: number | null; status: string };
type AttemptRow = { id: number; work_id: number; run_id: number | null; created_at: string;
  stop_requested_at: string | null; stopped_at: string | null };
type StopRow = { request_json: string; receipt_json: string };
type ExecutionRow = { id: number; status: string; stopped_at: string | null; cleanup_json: string;
  scope_json: string; origin_tool_call_id: number | null; output_json: string | null };
type ToolRow = { id: number; run_id: number; session_id: number; tool_name: string; effect: string | null;
  status: string; stopped_at: string | null; cleanup_json: string; runtime_observation_json: string | null };
class AttemptFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function requireFact(condition: unknown, code = 'state_conflict', message = 'The original attempt facts have changed.'): asserts condition {
  if (!condition) throw new AttemptFault(appError(code, code === 'storage_corrupt' ? 'storage' : 'input', message));
}
function need<T>(result: Result<T>): T { if (!result.ok) throw new AttemptFault(result.error); return result.data; }
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value); requireFact(parsed.success, 'input_invalid', 'The attempt request is invalid.'); return parsed.data;
}
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), time = z.string().datetime({ offset: true });
const stopResultSchema = z.object({ workId: id, sessionId: id, attemptId: id, stopped: z.boolean(),
  reason: z.enum(['stopped', 'not-started', 'stop-unconfirmed']) }).strict().refine(value => value.stopped === (value.reason !== 'stop-unconfirmed'));
const finishSchema = z.object({ workId: id, attemptId: id, runId: id.nullable(), at: time, effectsReconciled: z.boolean(),
  stopResult: stopResultSchema.optional() }).strict();
const executionCleanupSchema = z.object({ stopped: z.boolean(), lateObservationRequired: z.boolean() }).passthrough();
const ownedSql = `WITH RECURSIVE owned(id) AS (SELECT ? UNION ALL SELECT r.id FROM runs r JOIN owned p ON r.parent_run_id=p.id)`;

/** Run outcomes remain owned by RunRepository; this repository records product stop and closure facts. */
export function createInvoiceWorkAttemptRepository(db: SynchronousDatabaseExecutor): InvoiceWorkAttemptRepository {
  const runs = createRunRepository(db), toolCalls = createToolCallRepository(db);
  function operation<T>(write: boolean, action: () => T): Result<T> {
    try {
      if (write) requireFact(db.inTransaction, 'state_conflict', 'Attempt writes require the product transaction.');
      return ok(write ? db.transaction(action).immediate() : readTransaction(db, action));
    } catch (error) {
      return fail(error instanceof AttemptFault ? error.fact : error instanceof z.ZodError || error instanceof SyntaxError
        ? appError('storage_corrupt', 'storage', 'Stored attempt facts are invalid.')
        : appError(write ? 'storage_write_failed' : 'storage_read_failed', 'storage', 'Attempt storage is unavailable.', true));
    }
  }
  function work(workId: number): WorkRow {
    const row = db.query<WorkRow, [number]>(`SELECT w.* FROM invoice_works w JOIN sessions s ON s.id=w.session_id
      WHERE w.id=? AND s.runtime_kind='durable'`).get(workId);
    requireFact(row, 'invoice_work_not_found', 'The original invoice Work does not exist.'); return row;
  }
  function attempt(owner: WorkRow, attemptId: number): AttemptRow {
    const row = db.query<AttemptRow, [number, number]>('SELECT * FROM invoice_work_attempts WHERE work_id=? AND id=?').get(owner.id, attemptId);
    requireFact(row, 'invoice_work_attempt_not_found', 'The original attempt does not belong to this Work.'); return row;
  }
  function task(owner: WorkRow, row: AttemptRow): PersonalTaskView {
    const run = row.run_id === null ? null : need(runs.get(row.run_id));
    requireFact(run === null || 'runtimeKind' in run && run.runtimeKind === 'durable' && run.sessionId === owner.session_id
      && run.scope?.version === 4 && run.scope.workId === owner.id && run.scope.attemptId === row.id, 'storage_corrupt');
    return PersonalTaskViewSchema.parse({ workId: owner.id, sessionId: owner.session_id,
      attempt: { attemptId: row.id, runId: row.run_id, runtimeLinked: db.query(`SELECT id FROM invoice_work_phases
        WHERE attempt_id=? AND native_submission_id IS NOT NULL LIMIT 1`).get(row.id) !== null },
      runStatus: run?.status ?? null, createdAt: row.created_at,
      queued: owner.status === 'open' && owner.current_attempt_id === row.id && row.run_id === null
        && row.stop_requested_at === null && row.stopped_at === null,
      stopRequestedAt: row.stop_requested_at, stoppedAt: row.stopped_at });
  }
  function stopReceipt(owner: WorkRow, row: AttemptRow, requestId: string): PersonalTaskStopReceipt | null {
    const saved = db.query<StopRow, [number, number, string]>(`SELECT request_json,receipt_json FROM invoice_work_attempt_stop_requests
      WHERE work_id=? AND attempt_id=? AND request_id=?`).get(owner.id, row.id, requestId);
    if (!saved) return null;
    const request = PersonalTaskStopRequestSchema.parse(JSON.parse(saved.request_json));
    const receipt = PersonalTaskStopReceiptSchema.parse(JSON.parse(saved.receipt_json));
    requireFact(request.workId === owner.id && request.attemptId === row.id && request.requestId === requestId
      && receipt.workId === owner.id && receipt.attemptId === row.id && receipt.requestId === requestId, 'storage_corrupt');
    return receipt;
  }
  function executions(row: AttemptRow): ExecutionRow[] {
    return row.run_id === null ? [] : db.query<ExecutionRow, [number]>(`${ownedSql} SELECT r.* FROM runs r JOIN owned o ON o.id=r.id ORDER BY r.id`)
      .all(row.run_id);
  }
  return {
    list(raw) {
      return operation(false, () => {
        const input = parse(PersonalTaskListRequestSchema, raw), owner = work(input.workId);
        const rows = db.query<AttemptRow, [number, number | null, number | null, number]>(`SELECT * FROM invoice_work_attempts
          WHERE work_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`)
          .all(owner.id, input.beforeAttemptId ?? null, input.beforeAttemptId ?? null, input.limit + 1);
        return PersonalTaskListResultSchema.parse({ workId: owner.id, items: rows.slice(0, input.limit).map(row => task(owner, row)),
          nextBeforeAttemptId: rows.length > input.limit ? rows[input.limit - 1]!.id : null });
      });
    },
    get(raw) {
      return operation(false, () => {
        const input = parse(PersonalTaskGetRequestSchema, raw), owner = work(input.workId), row = attempt(owner, input.attemptId);
        const owned = executions(row).filter(child => child.id !== row.run_id && child.id > (input.afterChildRunId ?? 0));
        const children = owned.slice(0, input.limit).map(child => {
          const scope = z.object({ workId: id, itemId: id }).passthrough().parse(JSON.parse(child.scope_json));
          const origin = db.query<{ delivery_json: string; parent_received_at: string | null }, [number | null]>(`SELECT t.delivery_json,b.parent_received_at
            FROM tool_calls t JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id WHERE t.id=?`).get(child.origin_tool_call_id);
          requireFact(scope.workId === owner.id && origin, 'storage_corrupt', 'The owned child has no original invoice/tool binding.');
          const cleanup = executionCleanupSchema.parse(JSON.parse(child.cleanup_json));
          const stoppedAt = cleanup.stopped && !cleanup.lateObservationRequired ? child.stopped_at : null;
          return InvoiceWorkChildReferenceSchema.parse({ runtimeKind: 'durable', kind: 'subagent', workId: owner.id,
            itemId: scope.itemId, parentAttemptId: row.id, childRunId: child.id, originToolCallId: child.origin_tool_call_id,
            role: 'invoice-evidence-checker', runStatus: child.status, resultRecorded: child.output_json !== null,
            delivery: ToolCallDeliverySchema.parse(JSON.parse(origin.delivery_json)), parentModelReceivedAt: origin.parent_received_at,
            stopConfirmed: stoppedAt !== null, stoppedAt });
        });
        return PersonalTaskGetResultSchema.parse({ task: task(owner, row), children,
          nextAfterChildRunId: owned.length > input.limit ? owned[input.limit - 1]!.id : null,
          stopReceipt: input.stopRequestId ? stopReceipt(owner, row, input.stopRequestId) : null });
      });
    },
    requestStop(raw, options) {
      return operation(true, () => {
        const input = parse(PersonalTaskStopRequestSchema, raw), at = parse(time, options.at), owner = work(input.workId), row = attempt(owner, input.attemptId);
        const existing = stopReceipt(owner, row, input.requestId);
        if (existing) {
          const saved = db.query<StopRow, [number, number, string]>(`SELECT request_json,receipt_json FROM invoice_work_attempt_stop_requests
            WHERE work_id=? AND attempt_id=? AND request_id=?`).get(owner.id, row.id, input.requestId)!;
          requireFact(isDeepStrictEqual(input, PersonalTaskStopRequestSchema.parse(JSON.parse(saved.request_json))),
            'request_conflict', 'This stop request identity already records another intent.'); return existing;
        }
        requireFact(owner.revision === input.expectedRevision && (owner.current_attempt_id === row.id || row.stopped_at !== null));
        const accepted = row.stopped_at === null;
        if (accepted && row.stop_requested_at === null) {
          requireFact(owner.revision < Number.MAX_SAFE_INTEGER);
          db.query('UPDATE invoice_work_attempts SET stop_requested_at=? WHERE id=?').run(at, row.id);
          db.query('UPDATE invoice_works SET revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(at, owner.id, owner.revision);
        }
        const receipt = PersonalTaskStopReceiptSchema.parse({ workId: owner.id, attemptId: row.id, requestId: input.requestId,
          receivedAt: at, accepted, stopConfirmed: row.stopped_at !== null, stoppedAt: row.stopped_at });
        db.query(`INSERT INTO invoice_work_attempt_stop_requests(work_id,attempt_id,request_id,request_json,receipt_json,received_at)
          VALUES(?,?,?,?,?,?)`).run(owner.id, row.id, input.requestId, JSON.stringify(input), JSON.stringify(receipt), at);
        return receipt;
      });
    },
    finish(raw) {
      return operation(true, () => {
        const input = parse(finishSchema, raw), owner = work(input.workId), row = attempt(owner, input.attemptId);
        requireFact(input.runId === row.run_id, 'source_invalid', 'The closure belongs to another product Run.');
        if (input.stopResult) requireFact(input.stopResult.workId === owner.id && input.stopResult.sessionId === owner.session_id
          && input.stopResult.attemptId === row.id, 'source_invalid', 'The native stop belongs to another attempt.');
        const projected = task(owner, row);
        const blocked = (reason: InvoiceWorkAttemptFinishResult['reason']): InvoiceWorkAttemptFinishResult => ({ closed: false, task: projected, reason });
        if (row.stopped_at !== null) return { closed: true, task: projected, reason: null };
        const run = row.run_id === null ? null : need(runs.get(row.run_id));
        if (run && (run.status === 'created' || run.status === 'running')) return blocked('run-active');
        if (run && !(run.cleanup.stopped && run.stoppedAt !== null && !run.cleanup.lateObservationRequired) && input.stopResult?.stopped !== true)
          return blocked('root-stop-unconfirmed');
        if (db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? AND closed_at IS NULL LIMIT 1').get(row.id)) return blocked('phase-unclosed');
        if (executions(row).some(child => {
          if (child.id === row.run_id) return false;
          const cleanup = executionCleanupSchema.parse(JSON.parse(child.cleanup_json));
          return ['created', 'running'].includes(child.status) || child.stopped_at === null || !cleanup.stopped || cleanup.lateObservationRequired;
        }))
          return blocked('owned-execution-unclosed');
        const tools = row.run_id === null ? [] : db.query<ToolRow, [number]>(`${ownedSql}
          SELECT t.* FROM tool_calls t JOIN owned o ON o.id=t.run_id ORDER BY t.id`).all(row.run_id);
        for (const call of tools) {
          const cleanup = ToolCallCleanupSchema.parse(JSON.parse(call.cleanup_json));
          if (['requested', 'running'].includes(call.status) || call.stopped_at === null || !cleanup.stopped
            || cleanup.nativeProcesses?.some(process => !process.stopped)) return blocked('tool-execution-unclosed');
          if (call.runtime_observation_json !== null
            && ToolRuntimeObservationSchema.parse(JSON.parse(call.runtime_observation_json)).commit === 'unknown') {
            if (call.effect === 'PURE' || call.effect === 'READ') continue;
            if (call.effect === 'LOCAL_WRITE' && call.tool_name === 'save_invoice_candidate') {
              const committed = toolCalls.queryCandidateCommit({ toolCallId: call.id, runId: call.run_id, sessionId: call.session_id });
              if (committed.ok && committed.data !== null) continue;
            }
            return blocked('effects-unconfirmed');
          }
        }
        if (!input.effectsReconciled) return blocked('effects-unconfirmed');
        requireFact(Date.parse(input.at) >= Date.parse(row.created_at) && (!run?.endedAt || Date.parse(input.at) >= Date.parse(run.endedAt)), 'input_invalid');
        db.query('UPDATE invoice_work_attempts SET stopped_at=? WHERE id=? AND stopped_at IS NULL').run(input.at, row.id);
        return { closed: true, task: task(owner, attempt(owner, row.id)), reason: null };
      });
    },
  };
}
