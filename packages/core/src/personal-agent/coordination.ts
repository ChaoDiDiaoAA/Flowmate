import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, AppErrorSchema, DurableRunConfigSnapshotSchema, DurableWorkBudgetSchema, PersonalAgentConfigurationSchema,
  type InvoiceWorkContextBuildInput, type AppError, type DurableAttemptIdentity, type DurableAttemptStopResult, type DurableModelBinding, type DurableRunConfigSnapshot,
  type DurableRuntimePort, type DurableSubmissionQuery, type DurableSubmissionView, type PersonalAgentConfiguration,
  type PersonalTaskView, type Result, type UsageRecord } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';
import type { DurableInvoiceGovernor } from './admission.ts';
import type { InvoiceWorkModelService } from './models.ts';
import type { InvoiceWorkContextSnapshot, InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from './phase-context.ts';
import type { InvoiceWorkPhase, InvoiceWorkTodoDefinition } from './repository.ts';
import type { PersonalTasksService } from './tasks.ts';
import { invoiceCandidateTodos } from './invoice-todos.ts';

export type InvoiceWorkCoordinatorOptions = {
  database: Pick<DbHandle, 'read' | 'transaction' | 'recoveryError'>;
  runtime: DurableRuntimePort;
  modelService: Pick<InvoiceWorkModelService, 'prepare' | 'restore'>;
  contexts: Pick<InvoiceWorkPhaseContextService, 'freezeInStore' | 'recoverFrozen'>;
  phaseObserver: Pick<InvoiceWorkPhaseObserver, 'reconcile'>;
  governor: DurableInvoiceGovernor;
  tasks: Pick<PersonalTasksService, 'reconcileStop' | 'reconcileChildren'>;
  now: () => string;
  sdk: DurableRunConfigSnapshot['sdk'];
  verifyResources: (configuration: PersonalAgentConfiguration, configurationRevision: number) => Result<void> | Promise<Result<void>>;
  onError?: (error: AppError) => void;
};
type WorkRow = { id: number; session_id: number; current_attempt_id: number | null; status: string;
  configuration_json: string; budget_json: string; agent_revision: number; goal: string; created_at: string };
type State = { row: WorkRow; task: PersonalTaskView; phases: Array<InvoiceWorkPhase & { closedAt: string | null }> };
class CoordinationFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function need<T>(value: Result<T>): T { if (!value.ok) throw new CoordinationFault(value.error); return value.data; }
const active = (status: string | null) => status === 'created' || status === 'running';
const identity = (state: State): DurableAttemptIdentity => ({ workId: state.row.id, sessionId: state.row.session_id,
  attemptId: state.task.attempt.attemptId });
const query = (state: State, phase: InvoiceWorkPhase): DurableSubmissionQuery => ({ ...identity(state), requestId: phase.requestId });

/** Reconcile persisted business commands at native boundaries; native Harness remains the execution scheduler. */
export class InvoiceWorkCoordinator {
  private pending = false;
  private recovering = false;
  private closed = false;
  private running: Promise<Result<void>> | null = null;
  private readonly ownedDeadlines = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly timedOut = new Set<number>();

  constructor(private readonly options: InvoiceWorkCoordinatorOptions) {}

  wake(): void {
    if (this.closed) return;
    this.pending = true;
    if (this.running) return;
    this.running = this.pump().finally(() => {
      this.running = null;
      if (this.pending && !this.closed) this.wake();
    });
  }

  async drain(): Promise<Result<void>> {
    let result: Result<void> = ok(undefined);
    while (this.running) {
      const next = await this.running;
      if (!next.ok) result = next;
    }
    return result;
  }

  startRecovery(): Result<void> {
    if (this.closed) return fail(appError('durable_runtime_closed', 'runtime', 'Invoice Work coordination is closed.'));
    this.recovering = true;
    this.wake();
    return ok(undefined);
  }

  async recover(): Promise<Result<void>> {
    const started = this.startRecovery();
    return started.ok ? this.drain() : started;
  }

  async close(): Promise<Result<void>> {
    this.closed = true;
    this.pending = false;
    for (const timer of this.ownedDeadlines.values()) clearTimeout(timer);
    this.ownedDeadlines.clear();
    return this.drain();
  }

  private report(error: AppError): void {
    try { this.options.onError?.(error); } catch { /* The original persisted facts remain available for recovery. */ }
  }

  private async pump(): Promise<Result<void>> {
    let first: AppError | null = null;
    while (this.pending && !this.closed) {
      this.pending = false;
      const recovering = this.recovering;
      this.recovering = false;
      try {
        if (this.options.database.recoveryError) throw new CoordinationFault(this.options.database.recoveryError);
        const attempts = await this.options.database.read(scope => scope.db.query<{ work_id: number; id: number }, []>(
          `SELECT a.work_id,a.id FROM invoice_work_attempts a JOIN invoice_works w ON w.id=a.work_id
           WHERE a.stopped_at IS NULL ORDER BY w.created_at,w.id,a.id`).all());
        for (const attempt of attempts) {
          if (this.closed) break;
          try { await this.advance(attempt.work_id, attempt.id, recovering); }
          catch (error) {
            if (this.closed) break;
            const fact = error instanceof CoordinationFault ? error.fact : appError('invoice_work_coordination_failed', 'runtime',
              'The original invoice Work could not be advanced.', true);
            first ??= fact; this.report(fact);
          }
        }
      } catch (error) {
        if (!this.closed) {
          const fact = error instanceof CoordinationFault ? error.fact : appError('storage_read_failed', 'storage',
            'Persisted invoice Work coordination facts could not be read.', true);
          first ??= fact; this.report(fact);
        }
      }
    }
    return first ? fail(first) : ok(undefined);
  }

  private state(workId: number, attemptId: number): Promise<State> {
    return this.options.database.read(scope => {
      const row = scope.db.query<WorkRow, [number]>('SELECT * FROM invoice_works WHERE id=?').get(workId);
      if (!row) throw new CoordinationFault(appError('invoice_work_not_found', 'input', 'The original invoice Work does not exist.'));
      const task = need(scope.invoiceWorkAttempts.get({ workId, attemptId })).task;
      const phases = scope.db.query<{ request_id: string; closed_at: string | null }, [number, number]>(
        'SELECT request_id,closed_at FROM invoice_work_phases WHERE work_id=? AND attempt_id=? ORDER BY id').all(workId, attemptId)
        .map(value => ({ ...need(scope.invoiceWorks.getPhase({ workId, attemptId, requestId: value.request_id }))!, closedAt: value.closed_at }));
      return { row, task, phases };
    });
  }

  private async advance(workId: number, attemptId: number, recovering: boolean): Promise<void> {
    let state = await this.state(workId, attemptId);
    need(await this.options.tasks.reconcileChildren(identity(state)));
    if (state.task.stoppedAt !== null) return;
    if (state.task.stopRequestedAt !== null || state.row.status === 'cancelled') {
      this.clearDeadline(attemptId); need(await this.options.tasks.reconcileStop({ workId, attemptId })); return;
    }
    if (state.row.status !== 'open' || state.row.current_attempt_id !== attemptId) return;
    if (state.task.runStatus !== null && !active(state.task.runStatus)) {
      for (const phase of state.phases.filter(phase => phase.closedAt === null)) need(await this.options.phaseObserver.reconcile(query(state, phase)));
      await this.finish(state, null); return;
    }
    while (!this.closed) {
      state = await this.state(workId, attemptId);
      if (state.task.stopRequestedAt !== null || state.row.status === 'cancelled') {
        this.clearDeadline(attemptId); need(await this.options.tasks.reconcileStop({ workId, attemptId })); return;
      }
      if (state.task.stoppedAt !== null || state.row.status !== 'open' || state.row.current_attempt_id !== attemptId) return;
      if (this.timedOut.has(attemptId)) {
        await this.finish(state, appError('agent_timeout', 'runtime', 'The authorized invoice Work time budget ended.')); return;
      }
      if (recovering && state.task.runStatus === 'running') {
        const remaining = need(await this.options.governor.remainingBudget(workId));
        if (remaining.timeoutMs === 0) {
          await this.finish(state, appError('agent_timeout', 'runtime', 'The original invoice Work time budget ended before recovery.')); return;
        }
      }
      const existing = state.phases.find(phase => phase.closedAt === null);
      let phase: InvoiceWorkPhase | undefined = existing;
      if (!phase) {
        const last = state.phases.at(-1);
        if (last) {
          const original = need(await this.options.runtime.getSubmission(query(state, last)));
          if (original?.status === 'done') await this.recordWaiting(state, last);
          else if (original?.status === 'unanswered') {
            await this.finish(state, appError('durable_phase_unanswered', 'runtime', original.reason ?? 'The original invoice phase failed.')); return;
          }
        }
        const assessed = need(await this.options.governor.assess(workId));
        if (assessed.kind !== 'ready') {
          if (state.task.attempt.runId !== null && assessed.kind === 'waiting') await this.finish(state, null);
          else if (state.task.attempt.runId !== null && assessed.kind === 'blocked') await this.finish(state, assessed.reason);
          return;
        }
        const selected = await this.options.database.read(scope => need(this.options.governor.nextItemInStore(scope, workId)));
        if (selected.itemId === null) return;
        const configuration = PersonalAgentConfigurationSchema.parse(JSON.parse(state.row.configuration_json));
        need(await this.options.verifyResources(configuration, state.row.agent_revision));
        if (this.closed) return;
        const preparation = { ...identity(state), requestId: `invoice-item:${selected.itemId}` };
        const binding = need(await this.options.modelService.prepare(preparation));
        if (this.closed) return;
        if (state.task.attempt.runId === null) {
          const budget = need(await this.options.governor.remainingBudget(workId));
          await this.createRun(state, binding, budget);
          state = await this.state(workId, attemptId);
        } else if (state.task.runStatus === 'created') {
          await this.options.database.transaction(scope => {
            const run = need(scope.runs.get(state.task.attempt.runId!));
            need(scope.runs.start(run.runId, DurableRunConfigSnapshotSchema.parse(run.config), this.options.now()));
          });
        }
        const prepared = await this.options.database.transaction(scope => {
          const selection = need(this.options.governor.nextItemInStore(scope, workId));
          if (selection.itemId === null) return null;
          const current = need(scope.invoiceWorks.get({ view: 'item', workId, itemId: selection.itemId }));
          if (current.view !== 'item') throw Error('invoice_item_required');
          need(scope.invoiceWorks.prepareItemJob({ workId, itemId: current.item.itemId, expectedRevision: current.item.revision, at: this.options.now() }));
          return need(scope.invoiceWorks.selectPhaseInput({ workId, attemptId, itemId: current.item.itemId }));
        });
        if (!prepared || this.closed) return;
        const remainingBudget = need(await this.options.governor.remainingBudget(workId));
        const freezeRequest = { workId, attemptId, itemId: prepared.itemId,
          requestId: `invoice-item:${prepared.itemId}:revision:${prepared.basis.itemRevision}`, kind: 'prompt' as const,
          basis: prepared.basis, remainingBudget };
        let frozen: InvoiceWorkContextSnapshot | null;
        try {
          frozen = await this.options.database.transaction(scope => {
            const admission = need(this.options.governor.assessInStore(scope, workId));
            return admission.kind === 'ready' ? need(this.options.contexts.freezeInStore(scope, freezeRequest)) : null;
          });
        } catch (error) {
          if (error instanceof CoordinationFault) throw error;
          frozen = need(await this.options.contexts.recoverFrozen(freezeRequest));
        }
        if (!frozen || this.closed) return;
        phase = need(await this.options.database.read(scope => scope.invoiceWorks.getPhase({ workId, attemptId,
          requestId: frozen.context.phase.requestId })))!;
        state = await this.state(workId, attemptId);
      }
      const completed = await this.executePhase(state, phase, recovering);
      recovering = false;
      if (!completed || this.closed) return;
    }
  }

  private async createRun(state: State, binding: DurableModelBinding,
    remaining: InvoiceWorkContextBuildInput['remainingBudget']): Promise<void> {
    const fixed = PersonalAgentConfigurationSchema.parse(JSON.parse(state.row.configuration_json));
    const originalBudget = DurableWorkBudgetSchema.parse(JSON.parse(state.row.budget_json)), provider = binding.configuration;
    if (remaining.toolFeedbackBytes <= 0) throw new CoordinationFault(appError('tool_context_limit', 'runtime', 'The shared Work tool feedback budget is exhausted.'));
    const config = DurableRunConfigSnapshotSchema.parse({ version: 3, runtimeKind: 'durable', name: provider.name, revision: provider.revision,
      requestedModel: provider.modelRef, resolvedModel: null, api: provider.connection?.api ?? null, endpoint: provider.connection?.baseUrl ?? null,
      sdk: this.options.sdk, parameters: provider.parameters,
      runtimeBudget: { ...originalBudget.runtimeBudget, maxModelCalls: remaining.modelCalls, maxToolCalls: remaining.toolCalls,
        maxToolFeedbackBytes: remaining.toolFeedbackBytes }, limits: originalBudget.limits,
      durable: { workId: state.row.id, attemptId: state.task.attempt.attemptId, configurationRevision: state.row.agent_revision },
      resources: fixed.resources, extensions: fixed.extensions, workingDirectory: fixed.workingDirectory });
    await this.options.database.transaction(scope => {
      const admitted = need(this.options.governor.assessInStore(scope, state.row.id));
      if (admitted.kind !== 'ready') throw new CoordinationFault(admitted.kind === 'blocked' ? admitted.reason
        : appError('invoice_work_admission_waiting', 'runtime', 'Another qualified execution owns admission.', true));
      const at = this.options.now(), usage: UsageRecord = { version: 1, source: 'not-requested', reason: 'durable-not-started',
        sdkValues: null, attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at };
      const runId = need(scope.runs.createDurable({ workId: state.row.id, attemptId: state.task.attempt.attemptId, config,
        input: { version: 1, goal: state.row.goal, text: state.row.goal, messageTimestamp: Date.parse(state.row.created_at) }, usage,
        cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: at }));
      need(scope.runs.start(runId, config, at));
    });
  }

  private async executePhase(state: State, phase: InvoiceWorkPhase, recovering: boolean): Promise<boolean> {
    const original = query(state, phase);
    need(await this.options.verifyResources(PersonalAgentConfigurationSchema.parse(JSON.parse(state.row.configuration_json)), state.row.agent_revision));
    if (this.closed) return false;
    let submission = need(await this.options.runtime.getSubmission(original));
    if (this.closed) return false;
    const current = await this.state(state.row.id, state.task.attempt.attemptId);
    if (current.task.stopRequestedAt !== null || current.row.status === 'cancelled') {
      need(await this.options.tasks.reconcileStop({ workId: state.row.id, attemptId: state.task.attempt.attemptId })); return false;
    }
    if (current.task.stoppedAt !== null) return false;
    if (submission) {
      need(await this.options.modelService.restore(original));
      need(await this.options.phaseObserver.reconcile(original));
      if (recovering && (submission.status === 'queued' || submission.status === 'placed')) {
        need(await this.options.governor.verifyModelUse(identity(state)));
        need(await this.options.runtime.resumeAttempt(identity(state)));
      }
    } else {
      if (phase.nativeSubmissionId !== null) throw new CoordinationFault(appError('storage_corrupt', 'storage', 'The original native phase receipt is unavailable.'));
      const binding = need(await this.options.modelService.prepare(original));
      if (this.closed) return false;
      need(await this.options.runtime.openConversation({ workId: state.row.id, sessionId: state.row.session_id }));
      submission = need(await this.options.runtime.submit({ ...original, config: binding.configuration, binding,
        thinkingLevel: PersonalAgentConfigurationSchema.parse(JSON.parse(state.row.configuration_json)).thinkingLevel,
        text: `Process the committed invoice phase ${phase.phaseId}; read its saved working context.` }));
      if (this.closed) return false;
      need(await this.options.phaseObserver.reconcile(original));
    }
    let failure: AppError | null = null;
    if (submission.status === 'queued' || submission.status === 'placed') {
      const remaining = need(await this.options.governor.remainingBudget(state.row.id));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([this.options.runtime.waitForSubmission(original),
          new Promise<Result<DurableSubmissionView>>(resolve => {
            timer = setTimeout(() => resolve(fail(appError('agent_timeout', 'runtime', 'The authorized invoice Work time budget ended.'))), remaining.timeoutMs);
          })]);
        if (this.closed) return false;
        if (settled.ok) submission = settled.data;
        else failure = settled.error;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    if (this.closed) return false;
    const latest = await this.state(state.row.id, state.task.attempt.attemptId);
    if (latest.task.stopRequestedAt !== null || latest.row.status === 'cancelled') {
      need(await this.options.tasks.reconcileStop({ workId: state.row.id, attemptId: state.task.attempt.attemptId })); return false;
    }
    if (latest.task.stoppedAt !== null) return false;
    if (failure) { await this.finish(state, failure); return false; }
    need(await this.options.phaseObserver.reconcile(original));
    const observed = need(await this.options.runtime.observeSubmission(original));
    if (this.closed || !observed) return false;
    if (observed.execution !== 'closed') {
      if (submission.status === 'done' || submission.status === 'unanswered') {
        const attemptId = state.task.attempt.attemptId;
        if (!this.ownedDeadlines.has(attemptId)) {
          const remaining = need(await this.options.governor.remainingBudget(state.row.id));
          this.ownedDeadlines.set(attemptId, setTimeout(() => {
            this.ownedDeadlines.delete(attemptId); this.timedOut.add(attemptId); this.wake();
          }, remaining.timeoutMs));
        }
      }
      return false;
    }
    this.clearDeadline(state.task.attempt.attemptId);
    if (submission.status === 'unanswered') {
      await this.finish(state, appError('durable_phase_unanswered', 'runtime', submission.reason ?? 'The original invoice phase failed.'));
      return false;
    }
    await this.recordWaiting(state, phase);
    return true;
  }

  private clearDeadline(attemptId: number): void {
    const timer = this.ownedDeadlines.get(attemptId);
    if (timer !== undefined) clearTimeout(timer);
    this.ownedDeadlines.delete(attemptId);
  }

  private async recordWaiting(state: State, phase: InvoiceWorkPhase): Promise<void> {
    if (phase.itemId === null) return;
    await this.options.database.transaction(scope => {
      const found = need(scope.invoiceWorks.get({ view: 'item', workId: state.row.id, itemId: phase.itemId! }));
      if (found.view !== 'item' || found.item.disposition !== 'unresolved' || found.work.execution.requiresContinue) return;
      const input = need(scope.invoiceWorks.selectPhaseInput({ workId: state.row.id, attemptId: state.task.attempt.attemptId, itemId: phase.itemId! }));
      if (input.basis.inputIds.some(inputId => !phase.basis.inputIds.includes(inputId))) return;
      const candidate = found.item.candidateRef;
      if (candidate === null && found.item.revision !== phase.basis.itemRevision) return;
      const todos = scope.db.query<{ id: number; revision: number; definition_json: string }, [number, number]>(
        'SELECT id,revision,definition_json FROM invoice_work_todos WHERE work_id=? AND item_id=? AND superseded_at IS NULL ORDER BY id')
        .all(state.row.id, phase.itemId!);
      const human: InvoiceWorkTodoDefinition[] = todos.map(todo => JSON.parse(todo.definition_json)).filter(todo => todo.actor === 'user');
      for (const todo of human) {
        if (todo.basis.origin !== 'rule') return;
        if (todo.fieldPath === null && (todo.problem === 'An original invoice candidate awaits human review.'
          || todo.problem === 'The completed model phase saved no invoice candidate.')) continue;
        if (todo.basis.candidateRef === null || found.item.jobId === null) return;
        const original = need(scope.candidates.readByJob({ jobId: found.item.jobId, candidateId: todo.basis.candidateRef.id }));
        const prior = invoiceCandidateTodos({ candidate: original.candidate, documentRefs: todo.basis.documentRefs, inputIds: todo.basis.inputIds });
        // Replace only this rule's original facts; externally supplied human Todos keep their own authority.
        if (!prior.some(definition => isDeepStrictEqual(definition, todo))) return;
      }
      let definitions: InvoiceWorkTodoDefinition[];
      if (candidate && found.item.jobId !== null) {
        const original = need(scope.candidates.readByJob({ jobId: found.item.jobId, candidateId: candidate.id }));
        definitions = invoiceCandidateTodos({ candidate: original.candidate, documentRefs: phase.basis.documentRefs, inputIds: phase.basis.inputIds });
      } else definitions = [{ actor: 'user', action: 'continue', fieldPath: null,
        problem: 'The completed model phase saved no invoice candidate.', needed: 'Review the original invoice or explicitly continue.',
        satisfiedBy: 'A new explicit continuation or original clarification is accepted.',
        basis: { origin: 'rule', documentRefs: [found.item.documentRef], sourceRefs: [], inputIds: [...phase.basis.inputIds], candidateRef: candidate } }];
      if (isDeepStrictEqual(todos.map(todo => JSON.parse(todo.definition_json)), definitions)) return;
      need(scope.invoiceWorks.replaceTodos({ workId: state.row.id, itemId: phase.itemId!, expectedRevision: found.item.revision,
        at: this.options.now(), todos: definitions }));
    });
  }

  private async finish(state: State, failure: AppError | null): Promise<void> {
    if (this.closed || state.task.attempt.runId === null) return;
    const latest = await this.state(state.row.id, state.task.attempt.attemptId);
    if (latest.task.stopRequestedAt !== null || latest.row.status === 'cancelled') {
      need(await this.options.tasks.reconcileStop({ workId: state.row.id, attemptId: state.task.attempt.attemptId })); return;
    }
    const run = need(await this.options.database.read(scope => scope.runs.get(latest.task.attempt.runId!)));
    const config = DurableRunConfigSnapshotSchema.parse(run.config);
    let stopResult: DurableAttemptStopResult | undefined;
    if (failure && active(run.status) && latest.phases.length > 0) {
      const stopped = need(await this.options.runtime.stopAttempt({ ...identity(latest), stopGraceMs: config.limits.stopGraceMs }));
      if (!stopped.stopped || this.closed) return;
      stopResult = stopped;
    }
    for (const phase of latest.phases) {
      if (stopResult?.reason === 'not-started') {
        if (need(await this.options.runtime.getSubmission(query(latest, phase))) !== null)
          throw new CoordinationFault(appError('source_invalid', 'runtime', 'The native not-started proof conflicts with its original submission.'));
        need(await this.options.database.transaction(scope => scope.invoiceWorks.closeUnsubmittedPhase({ workId: state.row.id,
          attemptId: state.task.attempt.attemptId, requestId: phase.requestId, stopResult: stopResult!, at: this.options.now() })));
        continue;
      }
      need(await this.options.phaseObserver.reconcile(query(latest, phase)));
      if (active(run.status)) {
        const observed = need(await this.options.runtime.observeSubmission(query(latest, phase)));
        if (!observed || observed.execution !== 'closed') return;
      }
    }
    if (this.closed) return;
    need(await this.options.tasks.reconcileChildren(identity(latest)));
    const last = latest.phases.at(-1), result = last ? need(await this.options.runtime.getSubmission(query(latest, last))) : null;
    await this.options.database.transaction(scope => {
      const current = need(scope.invoiceWorkAttempts.get({ workId: state.row.id, attemptId: state.task.attempt.attemptId })).task;
      if (current.stopRequestedAt !== null || current.stoppedAt !== null) return;
      const original = need(scope.runs.get(run.runId)), at = this.options.now();
      if (active(original.status)) {
        // A supplement committing before this transaction keeps its original root and is selected next.
        if (!failure && need(this.options.governor.nextItemInStore(scope, state.row.id)).itemId !== null) { this.pending = true; return; }
        const finished = need(scope.runs.finish(run.runId, { status: failure ? 'failed' : 'completed',
          output: result?.answer === null || !result ? null : { version: 3, text: result.answer, partial: failure !== null,
            stopReason: failure?.code ?? 'phase-boundary', responseId: null, responseModel: null,
            durable: { workId: state.row.id, attemptId: current.attempt.attemptId } }, error: failure,
          usage: original.usage, tokens: original.tokens, cleanup: { version: 1, errors: z.array(AppErrorSchema).parse(original.cleanup.errors), stopped: true,
            stopReason: failure?.code ?? 'native-scope-closed', lateObservationRequired: false }, endedAt: at, stoppedAt: at,
          durationMs: original.startedAt === null ? null : Math.max(0, Date.parse(at) - Date.parse(original.startedAt)) }));
        if (!finished) throw new CoordinationFault(appError('operation_result_unknown', 'storage', 'The original root outcome could not be confirmed.', true));
      }
      const closed = need(scope.invoiceWorkAttempts.finish({ workId: state.row.id, attemptId: current.attempt.attemptId,
        runId: run.runId, at, effectsReconciled: true }));
      if (closed.closed) {
        need(scope.invoiceWorks.reconcile({ workId: state.row.id, at }));
        this.clearDeadline(current.attempt.attemptId); this.timedOut.delete(current.attempt.attemptId);
      }
    });
  }
}
