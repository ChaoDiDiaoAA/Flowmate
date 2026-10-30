import { z } from 'zod';
import { appError, fail, ok, AppErrorSchema, DurableRunOutputSchema, DurableWorkBudgetSchema, PersonalTaskIdentitySchema, PersonalTaskListRequestSchema,
  PersonalTaskGetRequestSchema, PersonalTaskStopRequestSchema, type DurableAttemptIdentity, type DurableAttemptStopResult,
  type DurableRuntimePort, type PersonalTasksApi, type PersonalTaskIdentity, type PersonalTaskListRequest,
  type PersonalTaskListResult, type PersonalTaskGetRequest, type PersonalTaskGetResult, type PersonalTaskStopRequest,
  type PersonalTaskStopReceipt, type PersonalHistoryApi, type PersonalHistoryRequest, type PersonalHistoryEntryRequest,
  type PersonalHistoryPage, type PersonalHistoryEntry, type Result } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';
import type { InvoiceWorkAttemptFinishResult } from './attempts.ts';
import type { InvoiceWorkPhaseObserver } from './phase-context.ts';

export type PersonalTasksServiceOptions = {
  database: Pick<DbHandle, 'read' | 'transaction'>;
  now: () => string;
  runtime: Pick<DurableRuntimePort, 'stopAttempt' | 'resumeAttempt' | 'getSubmission'>;
  phaseObserver: Pick<InvoiceWorkPhaseObserver, 'reconcile'>;
  restoreAttempt: (identity: DurableAttemptIdentity) => Result<void> | Promise<Result<void>>;
  verifyModelUse: (identity: DurableAttemptIdentity) => Result<void> | Promise<Result<void>>;
  onChanged: (identity: DurableAttemptIdentity) => void;
  reconcileChildren?: (identity: DurableAttemptIdentity) => Promise<Result<void>>;
  history?: PersonalHistoryApi;
};
type PhaseRow = { request_id: string };
const cleanupSchema = z.object({ version: z.literal(1), stopped: z.boolean(), stopReason: z.string().nullable(),
  errors: z.array(AppErrorSchema), lateObservationRequired: z.boolean() }).strict();
const invalid = () => fail(appError('input_invalid', 'input', 'The personal task request is invalid.'));
const conflict = () => fail(appError('state_conflict', 'runtime', 'This attempt requires an explicit Invoice Work continue command.'));
const writeFailure = () => fail(appError('storage_write_failed', 'storage', 'The task stop could not be confirmed.', true));
const readFailure = () => fail(appError('storage_read_failed', 'storage', 'The original task facts could not be read.', true));

/** Product intent commits before native cleanup; queries never enter native scheduling. */
export class PersonalTasksService implements PersonalTasksApi {
  constructor(private readonly options: PersonalTasksServiceOptions) {}

  async history(input: PersonalHistoryRequest): Promise<Result<PersonalHistoryPage>> {
    return this.options.history?.history(input)
      ?? fail(appError('personal_history_unavailable', 'runtime', 'Durable history is not assembled.'));
  }

  async historyEntry(input: PersonalHistoryEntryRequest): Promise<Result<PersonalHistoryEntry>> {
    return this.options.history?.historyEntry(input)
      ?? fail(appError('personal_history_unavailable', 'runtime', 'Durable history is not assembled.'));
  }

  async reconcileChildren(identity: DurableAttemptIdentity): Promise<Result<void>> {
    try { return await this.options.reconcileChildren?.(identity) ?? ok(undefined); }
    catch { return fail(appError('subagent_observation_unknown', 'runtime', 'Owned child cleanup could not be confirmed.', true)); }
  }

  async list(raw: PersonalTaskListRequest): Promise<Result<PersonalTaskListResult>> {
    const input = PersonalTaskListRequestSchema.safeParse(raw); if (!input.success) return invalid();
    try { return await this.options.database.read(scope => scope.invoiceWorkAttempts.list(input.data)); }
    catch { return readFailure(); }
  }

  async get(raw: PersonalTaskGetRequest): Promise<Result<PersonalTaskGetResult>> {
    const input = PersonalTaskGetRequestSchema.safeParse(raw); if (!input.success) return invalid();
    try { return await this.options.database.read(scope => scope.invoiceWorkAttempts.get(input.data)); }
    catch { return readFailure(); }
  }

  private notify(identity: DurableAttemptIdentity) {
    try { this.options.onChanged(identity); }
    catch { /* Committed stop facts remain available for recovery. */ }
  }

  private async state(input: PersonalTaskIdentity) {
    return this.options.database.read(scope => {
      const task = scope.invoiceWorkAttempts.get(input); if (!task.ok) return task;
      const work = scope.invoiceWorks.get({ view: 'work', workId: input.workId, limit: 1 }); if (!work.ok) return work;
      const original = scope.db.query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(input.workId);
      if (!original) return readFailure();
      const budget = DurableWorkBudgetSchema.parse(JSON.parse(original.budget_json));
      const phases = scope.db.query<PhaseRow, [number, number]>(
        'SELECT request_id FROM invoice_work_phases WHERE work_id=? AND attempt_id=? ORDER BY id').all(input.workId, input.attemptId);
      return ok({ task: task.data.task, work: work.data.work, phases, stopGraceMs: budget.limits.stopGraceMs,
        identity: { ...input, sessionId: task.data.task.sessionId } });
    });
  }

  async stop(raw: PersonalTaskStopRequest): Promise<Result<PersonalTaskStopReceipt>> {
    const input = PersonalTaskStopRequestSchema.safeParse(raw); if (!input.success) return invalid();
    const key = { workId: input.data.workId, attemptId: input.data.attemptId };
    let rejected: Result<never> | undefined, receipt: PersonalTaskStopReceipt;
    try {
      receipt = await this.options.database.transaction(scope => {
        const prior = scope.invoiceWorkAttempts.get({ ...key, stopRequestId: input.data.requestId });
        if (!prior.ok) { rejected = prior; throw Error('personal_task_stop_read_failed'); }
        const saved = scope.invoiceWorkAttempts.requestStop(input.data, { at: this.options.now() });
        if (!saved.ok) { rejected = saved; throw Error('personal_task_stop_rejected'); }
        const task = scope.invoiceWorkAttempts.get(key);
        if (!task.ok) { rejected = task; throw Error('personal_task_stop_read_failed'); }
        const current = task.data.task;
        if (current.attempt.runId !== null && (current.runStatus === 'created' || current.runStatus === 'running')) {
          const cancelled = scope.runs.recordCancel(current.attempt.runId, saved.data.receivedAt);
          if (!cancelled.ok) { rejected = cancelled; throw Error('personal_task_cancel_intent_failed'); }
          if (!cancelled.data) throw Error('personal_task_cancel_intent_unknown');
        }
        if (prior.data.stopReceipt === null) {
          if (!scope.db.afterCommit) throw Error('personal_task_commit_signal_unavailable');
          scope.db.afterCommit(() => this.notify({ ...key, sessionId: current.sessionId }));
        }
        return saved.data;
      });
    } catch {
      if (rejected) return rejected;
      const original = await this.get({ ...key, stopRequestId: input.data.requestId });
      if (!original.ok || original.data.stopReceipt === null) return writeFailure();
      try {
        const replay = await this.options.database.transaction(scope => scope.invoiceWorkAttempts.requestStop(input.data, { at: this.options.now() }));
        if (!replay.ok) return replay;
        receipt = replay.data;
      } catch { return writeFailure(); }
    }
    // Native cleanup failure cannot turn a committed stop request into an unaccepted operation.
    await this.reconcileStop(key);
    return ok(receipt);
  }

  /** Recovery and original execution notifications may retry cleanup; list/get never call this method. */
  async reconcileStop(raw: PersonalTaskIdentity): Promise<Result<InvoiceWorkAttemptFinishResult>> {
    const input = PersonalTaskIdentitySchema.safeParse(raw); if (!input.success) return invalid();
    try {
      const current = await this.state(input.data); if (!current.ok) return current;
      const { task, phases, identity, stopGraceMs } = current.data;
      if (task.stopRequestedAt === null && current.data.work.status !== 'cancelled') return conflict();
      let stopResult: DurableAttemptStopResult | undefined;
      if (task.stoppedAt === null && phases.length > 0) {
        for (const phase of phases) {
          const observed = await this.options.phaseObserver.reconcile({ ...identity, requestId: phase.request_id });
          if (!observed.ok) return observed;
        }
        const stopped = await this.options.runtime.stopAttempt({ ...identity, stopGraceMs });
        if (!stopped.ok) return stopped;
        stopResult = stopped.data;
        if (stopResult.workId !== identity.workId || stopResult.sessionId !== identity.sessionId || stopResult.attemptId !== identity.attemptId)
          return fail(appError('source_invalid', 'runtime', 'The native stop belongs to another attempt.'));
        if (!stopResult.stopped) return ok({ closed: false, task, reason: 'root-stop-unconfirmed' });
        for (const phase of phases) {
          const query = { ...identity, requestId: phase.request_id };
          if (stopResult.reason === 'not-started') {
            const submitted = await this.options.runtime.getSubmission(query); if (!submitted.ok) return submitted;
            if (submitted.data !== null)
              return fail(appError('source_invalid', 'runtime', 'The native not-started proof conflicts with its original submission.'));
            const closed = await this.options.database.transaction(scope => scope.invoiceWorks.closeUnsubmittedPhase({
              ...input.data, requestId: phase.request_id, stopResult: stopResult!, at: this.options.now() }));
            if (!closed.ok) return closed;
            continue;
          }
          const observed = await this.options.phaseObserver.reconcile(query);
          if (!observed.ok) return observed;
          if (observed.data === null) return ok({ closed: false, task, reason: 'phase-unclosed' });
        }
      }
      const children = await this.reconcileChildren(identity); if (!children.ok) return children;
      let rejected: Result<never> | undefined;
      try {
        return await this.options.database.transaction(scope => {
          const now = this.options.now(), latest = scope.invoiceWorkAttempts.get(input.data);
          if (!latest.ok) { rejected = latest; throw Error('personal_task_closure_read_failed'); }
          const runId = latest.data.task.attempt.runId;
          if (latest.data.task.stoppedAt === null && scope.db.query(`SELECT id FROM invoice_work_phases
            WHERE work_id=? AND attempt_id=? AND closed_at IS NULL LIMIT 1`).get(input.data.workId, input.data.attemptId))
            return ok({ closed: false, task: latest.data.task, reason: 'phase-unclosed' as const });
          if (runId !== null && latest.data.task.stoppedAt === null) {
            const found = scope.runs.get(runId); if (!found.ok) { rejected = found; throw Error('personal_task_run_read_failed'); }
            const run = found.data;
            if (run.status === 'created' || run.status === 'running') {
              const saved = scope.runs.finish(runId, { status: 'cancelled', output: run.output === null ? null : DurableRunOutputSchema.parse(run.output),
                error: appError('run_cancelled', 'runtime', 'The user stopped this original task.'), usage: run.usage, tokens: run.tokens,
                cleanup: { ...cleanupSchema.parse(run.cleanup), stopped: true, stopReason: 'user', lateObservationRequired: false },
                cancelRequestedAt: run.cancelRequestedAt ?? task.stopRequestedAt ?? now, endedAt: now, stoppedAt: now,
                durationMs: run.startedAt === null ? null : Math.max(0, Date.parse(now) - Date.parse(run.startedAt)) });
              if (!saved.ok) { rejected = saved; throw Error('personal_task_terminal_failed'); }
              if (!saved.data) throw Error('personal_task_terminal_unknown');
            }
          }
          const closed = scope.invoiceWorkAttempts.finish({ ...input.data, runId, at: now, effectsReconciled: true,
            ...(stopResult ? { stopResult } : {}) });
          if (!closed.ok) { rejected = closed; throw Error('personal_task_closure_failed'); }
          if (closed.data.closed) {
            const reconciled = scope.invoiceWorks.reconcile({ workId: input.data.workId, at: now });
            if (!reconciled.ok) { rejected = reconciled; throw Error('personal_task_work_reconcile_failed'); }
            if (latest.data.task.stoppedAt === null) scope.db.afterCommit?.(() => this.notify(identity));
          }
          return closed;
        });
      } catch { return rejected ?? writeFailure(); }
    } catch { return readFailure(); }
  }

  async resume(raw: PersonalTaskIdentity): Promise<Result<void>> {
    const input = PersonalTaskIdentitySchema.safeParse(raw); if (!input.success) return invalid();
    try {
      const current = await this.state(input.data); if (!current.ok) return current;
      const { task, work, identity } = current.data;
      if (work.status !== 'open' || work.execution.attempt?.attemptId !== input.data.attemptId
        || task.stopRequestedAt !== null || task.stoppedAt !== null || work.execution.requiresContinue || work.execution.stopUnconfirmed
        || task.runStatus !== 'created' && task.runStatus !== 'running' || !task.attempt.runtimeLinked) return conflict();
      const restored = await this.options.restoreAttempt(identity); if (!restored.ok) return restored;
      const allowed = await this.options.verifyModelUse(identity); if (!allowed.ok) return allowed;
      const resumed = await this.options.runtime.resumeAttempt(identity);
      if (resumed.ok) this.notify(identity);
      return resumed;
    } catch { return fail(appError('durable_resume_failed', 'runtime', 'The original task could not be resumed.', true)); }
  }
}
