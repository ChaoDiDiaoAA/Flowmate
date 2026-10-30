import { z } from 'zod';
import { appError, fail, ok, DurableRunConfigSnapshotSchema, DurableRunScopeSchema, DurableSubagentRunScopeSchema, DurableWorkBudgetSchema,
  PersonalAgentConfigurationSchema, UsageRecordSchema, InvoiceWorkTodoViewSchema } from '@flowmate/contracts';
import type { AppError, DurableAttemptIdentity, DurableProductToolCall, DurableSubagentIdentity, InvoiceWorkContextBuildInput, InvoiceWorkTodoView, Result, UsageRecord } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { InvoiceWorkExecutionCommand } from './invoice-work.ts';
import type { InvoiceWorkAdmission } from './repository.ts';
import { readInvoiceWorkToolResult } from './tool-scope.ts';

type WorkRow = { id: number; personal_agent_id: number; session_id: number; status: string; current_attempt_id: number | null;
  configuration_json: string; budget_json: string; created_at: string };
type AttemptRow = { id: number; work_id: number; run_id: number | null; trigger_kind: string; trigger_request_id: string;
  stop_requested_at: string | null; stopped_at: string | null };
type BudgetRun = { id: number; parent_run_id: number | null; usage_json: string; tool_call_count: number; duration_ms: number | null;
  started_at: string | null; ended_at: string | null; stopped_at: string | null };
type RemainingBudget = InvoiceWorkContextBuildInput['remainingBudget'];
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({ workId: id, sessionId: id, attemptId: id }).strict();
class AdmissionFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function need<T>(result: Result<T>): T { if (!result.ok) throw new AdmissionFault(result.error); return result.data; }
function requireFact(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AdmissionFault(appError(code, 'runtime', message));
}
const activeRun = (status: string) => status === 'created' || status === 'running';

/** Business admission and request reservations share the existing database owner's transaction. */
export class DurableInvoiceGovernor {
  public constructor(private readonly database: Pick<DbHandle, 'read' | 'transaction' | 'recoveryError'>,
    private readonly now: () => string, private readonly foregroundBusy: () => boolean) {}

  private guarded<T>(action: () => T): Result<T> {
    try { return ok(action()); }
    catch (error) {
      return fail(error instanceof AdmissionFault ? error.fact : appError('invoice_work_assessment_unavailable', 'runtime',
        'Durable execution facts could not be verified.', true));
    }
  }

  private work(store: SqlDatabaseStore, workId: number): WorkRow {
    requireFact(id.safeParse(workId).success, 'input_invalid', 'Invoice Work identity is invalid.');
    need(store.invoiceWorks.get({ view: 'work', workId, limit: 1 }));
    const row = store.db.query<WorkRow, [number]>('SELECT * FROM invoice_works WHERE id=?').get(workId);
    requireFact(row, 'invoice_work_not_found', 'Invoice Work does not exist.');
    return row;
  }

  private attempt(store: SqlDatabaseStore, work: WorkRow): AttemptRow | null {
    if (work.current_attempt_id === null) return null;
    const row = store.db.query<AttemptRow, [number, number]>(
      'SELECT * FROM invoice_work_attempts WHERE work_id=? AND id=?').get(work.id, work.current_attempt_id);
    requireFact(row, 'storage_corrupt', 'The original Work attempt is unavailable.');
    return row;
  }

  private runs(store: SqlDatabaseStore, workId: number): BudgetRun[] {
    return store.db.query<BudgetRun, [number]>(`WITH RECURSIVE owned(id) AS (
      SELECT run_id FROM invoice_work_attempts WHERE work_id=? AND run_id IS NOT NULL
      UNION SELECT r.id FROM runs r JOIN owned p ON r.parent_run_id=p.id)
      SELECT r.* FROM runs r JOIN owned o ON r.id=o.id ORDER BY r.id`).all(workId);
  }

  private requestCount(store: SqlDatabaseStore, runId: number, value: UsageRecord): number {
    const usage = UsageRecordSchema.parse(value);
    const reservation = store.db.query<{ count: number }, [number]>(
      'SELECT count FROM invoice_work_model_reservations WHERE run_id=?').get(runId);
    if (reservation) {
      requireFact(Number.isSafeInteger(reservation.count) && reservation.count >= 0,
        'invoice_work_budget_unknown', 'Previously reserved model requests have an invalid count.');
      return reservation.count;
    }
    requireFact(usage.attempts !== null && Number.isSafeInteger(usage.attempts) && usage.attemptsComplete,
      'invoice_work_budget_unknown', 'Previously used model requests have an unknown count.');
    return usage.attempts;
  }

  private budget(store: SqlDatabaseStore, work: WorkRow, at: string, pendingFeedback: readonly DurableProductToolCall[] = []): RemainingBudget {
    const authorization = DurableWorkBudgetSchema.parse(JSON.parse(work.budget_json)), runs = this.runs(store, work.id);
    let modelCalls = 0, toolCalls = 0, toolFeedbackBytes = 0, elapsed = 0;
    const feedbackEntries = new Map<string, number>();
    for (const run of runs) {
      modelCalls += this.requestCount(store, run.id, JSON.parse(run.usage_json));
      const calls = store.db.query<{ native_tool_call_id: string; result_json: string | null; feedback_native_entry_id: number | null;
        feedback_bytes: number | null; work_id: number | null; native_conversation_id: number | null }, [number]>(`SELECT
        t.native_tool_call_id,t.result_json,b.feedback_native_entry_id,b.feedback_bytes,p.work_id,
        CASE WHEN r.kind='subagent' THEN s.durable_conversation_id ELSE p.native_conversation_id END native_conversation_id
        FROM tool_calls t LEFT JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id
        LEFT JOIN invoice_work_phases p ON p.id=b.phase_id JOIN runs r ON r.id=t.run_id
        JOIN sessions s ON s.id=r.session_id WHERE t.run_id=?`).all(run.id);
      toolCalls += Math.max(run.tool_call_count, calls.length);
      for (const call of calls) {
        if (call.result_json === null && call.feedback_native_entry_id === null && call.feedback_bytes === null) continue;
        const pending = pendingFeedback.find(value => value.workId === work.id && value.nativeConversationId === call.native_conversation_id
          && call.native_tool_call_id === `durable-task:${value.nativeTaskId}`);
        // Only original receipt settlement can proceed before its exact native feedback bytes exist.
        if (pending && call.result_json !== null && call.feedback_native_entry_id === null && call.feedback_bytes === null) {
          requireFact(need(readInvoiceWorkToolResult(store, pending)) !== null,
            'invoice_work_budget_unknown', 'The original product result is not confirmed for native feedback recovery.');
          continue;
        }
        requireFact(call.work_id === work.id && call.native_conversation_id !== null && id.safeParse(call.native_conversation_id).success
          && call.feedback_native_entry_id !== null && id.safeParse(call.feedback_native_entry_id).success
          && call.feedback_bytes !== null && id.safeParse(call.feedback_bytes).success,
        'invoice_work_budget_unknown', 'Previous tool feedback has no exact persisted native entry and byte accounting.');
        const entry = `${call.native_conversation_id}:${call.feedback_native_entry_id}`, previous = feedbackEntries.get(entry);
        requireFact(previous === undefined || previous === call.feedback_bytes,
          'invoice_work_budget_unknown', 'The original native feedback entry has conflicting byte accounting.');
        if (previous === undefined) {
          feedbackEntries.set(entry, call.feedback_bytes);
          toolFeedbackBytes += call.feedback_bytes;
        }
      }
      if (run.parent_run_id === null && run.started_at !== null) {
        const duration = run.duration_ms ?? Date.parse(run.stopped_at ?? run.ended_at ?? at) - Date.parse(run.started_at);
        requireFact(Number.isSafeInteger(duration) && duration >= 0, 'invoice_work_budget_unknown',
          'Previously used execution time cannot be verified.');
        elapsed += duration;
      }
    }
    requireFact([modelCalls, toolCalls, toolFeedbackBytes, elapsed].every(Number.isSafeInteger),
      'invoice_work_budget_unknown', 'Accumulated Work usage cannot be represented safely.');
    requireFact(modelCalls <= authorization.runtimeBudget.maxModelCalls,
      'agent_model_call_budget', 'The persisted Work model request count exceeds its authorization.');
    requireFact(toolCalls <= authorization.runtimeBudget.maxToolCalls,
      'tool_budget_exceeded', 'The persisted Work tool call count exceeds its authorization.');
    requireFact(toolFeedbackBytes <= authorization.runtimeBudget.maxToolFeedbackBytes,
      'tool_context_limit', 'The persisted Work tool feedback exceeds its authorized byte budget.');
    const children = store.db.query<{ count: number }, [number]>(`WITH RECURSIVE owned(id) AS (
      SELECT run_id FROM invoice_work_attempts WHERE work_id=? AND run_id IS NOT NULL
      UNION SELECT r.id FROM runs r JOIN owned p ON r.parent_run_id=p.id)
      SELECT COUNT(*) count FROM runs r JOIN owned o ON r.id=o.id WHERE r.parent_run_id IS NOT NULL
      AND (r.status IN ('created','running') OR r.stopped_at IS NULL OR COALESCE(json_extract(r.cleanup_json,'$.stopped'),0)!=1
        OR COALESCE(json_extract(r.cleanup_json,'$.lateObservationRequired'),1)!=0)`).get(work.id)!.count;
    requireFact(children <= 4, 'storage_corrupt', 'The Work owns excess child capacity.');
    return { modelCalls: Math.max(0, authorization.runtimeBudget.maxModelCalls - modelCalls),
      toolCalls: Math.max(0, authorization.runtimeBudget.maxToolCalls - toolCalls),
      toolFeedbackBytes: authorization.runtimeBudget.maxToolFeedbackBytes - toolFeedbackBytes,
      timeoutMs: Math.max(0, authorization.limits.timeoutMs - elapsed), childSlots: 4 - children };
  }

  private hasAuthorizedInput(store: SqlDatabaseStore, work: WorkRow, attempt: AttemptRow | null, itemId: number,
    command?: InvoiceWorkExecutionCommand): boolean {
    if (command?.kind === 'supplement' && command.request.itemId === itemId) return true;
    const inputs = store.db.query<{ id: number; request_id: string }, [number, number]>(`SELECT i.id,i.request_id
      FROM invoice_work_inputs i WHERE i.work_id=? AND i.item_id=? AND NOT EXISTS (
        SELECT 1 FROM invoice_work_phases p,json_each(p.basis_json,'$.inputIds') consumed
        WHERE p.work_id=i.work_id AND p.consumed_at IS NOT NULL AND consumed.value=i.id) ORDER BY i.id`).all(work.id, itemId);
    if (command?.kind === 'continueWork' && inputs.length > 0) return true;
    if (!attempt) return false;
    for (const input of inputs) {
      const receipt = need(store.invoiceWorks.queryOperation({ operation: 'supplement', workId: work.id, requestId: input.request_id }));
      requireFact(receipt?.operation === 'supplement' && receipt.inputId === input.id && receipt.itemId === itemId,
        'storage_corrupt', 'The saved clarification has no matching original receipt.');
      if (receipt.execution.authorizationAccepted && receipt.execution.attempt.attemptId === attempt.id) return true;
      const continued = store.db.query<{ request_id: string }, [number]>(
        "SELECT request_id FROM invoice_work_operations WHERE work_id=? AND kind='continueWork' ORDER BY id").all(work.id);
      for (const original of continued) {
        const approval = need(store.invoiceWorks.queryOperation({ operation: 'continueWork', workId: work.id, requestId: original.request_id }));
        if (approval?.operation === 'continueWork' && approval.revision > receipt.revision
          && approval.execution.authorizationAccepted && approval.execution.attempt.attemptId === attempt.id) return true;
      }
    }
    return false;
  }

  private hasNewContinuation(store: SqlDatabaseStore, work: WorkRow, attempt: AttemptRow | null,
    creatingAttempt: boolean, command?: InvoiceWorkExecutionCommand): boolean {
    if (command) return command.kind === 'continueWork' && creatingAttempt;
    if (!attempt || attempt.trigger_kind !== 'continueWork') return false;
    const continued = need(store.invoiceWorks.queryOperation({ operation: 'continueWork', workId: work.id, requestId: attempt.trigger_request_id }));
    return continued?.operation === 'continueWork' && continued.execution.authorizationAccepted
      && continued.execution.relation === 'new' && continued.execution.attempt.attemptId === attempt.id;
  }

  private hasAuthorizedHistory(store: SqlDatabaseStore, work: WorkRow, attempt: AttemptRow | null, itemId: number,
    todos: readonly InvoiceWorkTodoView[], creatingAttempt: boolean, command?: InvoiceWorkExecutionCommand): boolean {
    if (!attempt || !this.hasNewContinuation(store, work, attempt, creatingAttempt, command)) return false;
    const newContinue = command?.kind === 'continueWork' && creatingAttempt;
    const inputs = store.db.query<{ id: number; todo_id: number; request_id: string }, [number, number]>(`SELECT i.id,i.todo_id,i.request_id FROM invoice_work_inputs i
      WHERE i.work_id=? AND i.item_id=? AND EXISTS (SELECT 1 FROM invoice_work_phases p,json_each(p.basis_json,'$.inputIds') used
        WHERE p.work_id=i.work_id AND p.item_id=i.item_id AND p.consumed_at IS NOT NULL AND used.value=i.id) ORDER BY i.id`).all(work.id, itemId);
    for (const input of inputs) {
      const needed = todos.some(todo => todo.actor === 'user' && ['supplement', 'continue'].includes(todo.action)
        && todo.todoId === input.todo_id && !todo.basis.inputIds.includes(input.id));
      if (!needed) continue;
      const receipt = need(store.invoiceWorks.queryOperation({ operation: 'supplement', workId: work.id, requestId: input.request_id }));
      requireFact(receipt?.operation === 'supplement' && receipt.inputId === input.id && receipt.itemId === itemId && receipt.todoId === input.todo_id,
        'storage_corrupt', 'The historical clarification has no matching original receipt.');
      const processed = store.db.query(`SELECT 1 FROM invoice_candidates candidate JOIN invoice_work_tool_calls binding ON binding.tool_call_id=candidate.tool_call_id
        JOIN invoice_work_phases p ON p.id=binding.phase_id JOIN invoice_work_context_snapshots c ON c.phase_id=p.id
        WHERE p.work_id=? AND p.item_id=? AND (EXISTS (SELECT 1 FROM json_each(p.basis_json,'$.inputIds') used WHERE used.value=?)
          OR EXISTS (SELECT 1 FROM json_each(c.context_json,'$.historicalInputReferences') history
            WHERE json_extract(history.value,'$.inputId')=? AND json_type(history.value,'$.content')='object')) LIMIT 1`)
        .get(work.id, itemId, input.id, input.id);
      if (processed) continue;
      if (!newContinue && store.db.query(`SELECT 1 FROM invoice_work_phases p JOIN invoice_work_context_snapshots c ON c.phase_id=p.id
        WHERE p.work_id=? AND p.attempt_id=? AND p.item_id=? AND p.consumed_at IS NOT NULL
        AND (EXISTS (SELECT 1 FROM json_each(p.basis_json,'$.inputIds') used WHERE used.value=?)
          OR EXISTS (SELECT 1 FROM json_each(c.context_json,'$.historicalInputReferences') history
            WHERE json_extract(history.value,'$.inputId')=? AND json_type(history.value,'$.content')='object')) LIMIT 1`)
        .get(work.id, attempt.id, itemId, input.id, input.id)) continue;
      return true;
    }
    return false;
  }

  private qualifyItem(store: SqlDatabaseStore, work: WorkRow, at: string, command?: InvoiceWorkExecutionCommand,
    requireRequestBudget = true, pendingFeedback: readonly DurableProductToolCall[] = []): Exclude<InvoiceWorkAdmission, { kind: 'ready' | 'queued' }> | { kind: 'queued' } | { kind: 'ready'; itemId: number } {
    if (work.status !== 'open') return { kind: 'blocked', reason: appError('invoice_work_closed', 'runtime', 'Ended invoice work cannot execute.') };
    const session = need(store.sessions.get(work.session_id));
    requireFact(session.runtimeKind === 'durable' && session.status === 'active' && !session.deletePending && !session.modelUseBlocked,
      'session_scope_revoked', 'The original Durable Session is no longer authorized.');
    const configuration = PersonalAgentConfigurationSchema.parse(JSON.parse(work.configuration_json));
    requireFact(configuration.modelId !== null, 'personal_agent_model_unavailable', 'The original explicit model is unavailable.');
    const attempt = this.attempt(store, work);
    let creatingAttempt = false;
    const unconfirmed = store.db.query(`SELECT a.id FROM invoice_work_attempts a LEFT JOIN runs r ON r.id=a.run_id
      WHERE a.work_id=? AND a.stopped_at IS NULL
        AND (a.stop_requested_at IS NOT NULL OR r.status IN ('completed','failed','cancelled')) LIMIT 1`).get(work.id);
    requireFact(!unconfirmed, 'stop_unconfirmed', 'The original attempt still has unconfirmed execution stop.');
    if (attempt?.run_id !== null && attempt?.run_id !== undefined) {
      const run = need(store.runs.get(attempt.run_id));
      if (attempt.stop_requested_at !== null || attempt.stopped_at !== null || !activeRun(run.status)) {
        creatingAttempt = command?.kind === 'continueWork';
        const authorizedSuccessor = command?.kind === 'continueWork'
          || command?.kind === 'supplement' && run.status === 'completed' && attempt.stop_requested_at === null;
        if (!authorizedSuccessor) return { kind: 'waiting', reason: 'The original attempt ended; a newly authorized attempt is required.' };
      }
    } else if (attempt?.stop_requested_at !== null && attempt?.stop_requested_at !== undefined) {
      creatingAttempt = command?.kind === 'continueWork' && attempt.stopped_at !== null;
      if (command?.kind !== 'continueWork') return { kind: 'waiting', reason: 'Explicit continue is required after stopping the original attempt.' };
    }
    if (!attempt && !command) return { kind: 'waiting', reason: 'Execution has not been authorized for this Work.' };
    const remaining = this.budget(store, work, at, pendingFeedback);
    requireFact(remaining.timeoutMs > 0, 'agent_timeout', 'The shared Work execution time budget is exhausted.');
    const ready = (itemId: number) => {
      requireFact(!requireRequestBudget || remaining.modelCalls > 0, 'agent_model_call_budget', 'The shared Work model request budget is exhausted.');
      return { kind: 'ready' as const, itemId };
    };
    const items = store.db.query<{ id: number; document_id: number; document_version: string; candidate_id: number | null }, [number]>(
      "SELECT * FROM invoice_work_items WHERE work_id=? AND disposition='unresolved' ORDER BY id").all(work.id);
    let unavailable = false;
    const waitingTodos: number[] = [];
    for (const item of items) {
      const document = store.documents.get(item.document_id);
      if (!document.ok || document.data.documentRef.version !== item.document_version || document.data.status !== 'available'
        || document.data.isHidden || document.data.parsedArtifactId === null) { unavailable = true; continue; }
      if (!command && attempt && store.db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? AND item_id=? AND closed_at IS NULL')
        .get(attempt.id, item.id)) return ready(item.id);
      if (this.hasAuthorizedInput(store, work, attempt, item.id, command)) return ready(item.id);
      const rows = store.db.query<{ id: number; revision: number; definition_json: string }, [number, number]>(
        'SELECT * FROM invoice_work_todos WHERE work_id=? AND item_id=? AND superseded_at IS NULL ORDER BY id').all(work.id, item.id);
      const todos = rows.map(row => InvoiceWorkTodoViewSchema.parse({ ...JSON.parse(row.definition_json),
        todoId: row.id, workId: work.id, itemId: item.id, revision: row.revision, applicable: true }));
      if (this.hasAuthorizedHistory(store, work, attempt, item.id, todos, creatingAttempt, command)) return ready(item.id);
      const continued = !command && this.hasNewContinuation(store, work, attempt, false)
        && !store.db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? AND item_id=? AND closed_at IS NOT NULL LIMIT 1')
          .get(attempt!.id, item.id);
      if (todos.some(todo => todo.actor === 'agent') || todos.length === 0 && item.candidate_id === null
        || (command?.kind === 'continueWork' || continued) && todos.some(todo => todo.action === 'continue')) return ready(item.id);
      waitingTodos.push(...todos.map(todo => todo.todoId));
    }
    if (unavailable && items.length > 0 && waitingTodos.length === 0)
      return { kind: 'blocked', reason: appError('input_unavailable', 'input', 'The original invoice materials are unavailable.') };
    return { kind: 'waiting', reason: items.length === 0 ? 'All invoices have a final disposition.' : 'Only human invoice actions remain.', todoIds: waitingTodos };
  }

  private qualify(store: SqlDatabaseStore, work: WorkRow, at: string, command?: InvoiceWorkExecutionCommand,
    requireRequestBudget = true, pendingFeedback: readonly DurableProductToolCall[] = []): InvoiceWorkAdmission {
    const checked = this.qualifyItem(store, work, at, command, requireRequestBudget, pendingFeedback);
    return checked.kind === 'ready' ? { kind: 'ready' } : checked;
  }

  /** Phase selection consumes the same invoice qualification used by admission and model transport. */
  public nextItemInStore(store: SqlDatabaseStore, workId: number): Result<{ admission: InvoiceWorkAdmission; itemId: number | null }> {
    return this.guarded(() => {
      const at = z.string().datetime({ offset: true }).parse(this.now());
      const checked = this.qualifyItem(store, this.work(store, workId), at);
      return { admission: checked.kind === 'ready' ? { kind: 'ready' as const } : checked,
        itemId: checked.kind === 'ready' ? checked.itemId : null };
    });
  }

  private occupiedWorks(store: SqlDatabaseStore): Set<number> {
    const rows = store.db.query<{ work_id: number }, []>(`WITH RECURSIVE owned(work_id,id) AS (
      SELECT work_id,run_id FROM invoice_work_attempts WHERE run_id IS NOT NULL AND stopped_at IS NULL
      UNION SELECT p.work_id,r.id FROM runs r JOIN owned p ON r.parent_run_id=p.id)
      SELECT DISTINCT a.work_id FROM invoice_work_attempts a WHERE a.stopped_at IS NULL AND (a.stop_requested_at IS NOT NULL OR a.run_id IS NOT NULL)
      UNION SELECT DISTINCT work_id FROM invoice_work_phases WHERE closed_at IS NULL
      UNION SELECT DISTINCT o.work_id FROM owned o JOIN runs r ON r.id=o.id WHERE r.status IN ('created','running')
        OR r.stopped_at IS NULL OR COALESCE(json_extract(r.cleanup_json,'$.stopped'),0)!=1
        OR COALESCE(json_extract(r.cleanup_json,'$.lateObservationRequired'),1)!=0
      UNION SELECT DISTINCT o.work_id FROM owned o JOIN tool_calls t ON t.run_id=o.id
        WHERE t.status IN ('requested','running') OR COALESCE(json_extract(t.cleanup_json,'$.stopped'),0)!=1
        OR EXISTS (SELECT 1 FROM json_each(t.cleanup_json,'$.nativeProcesses') p WHERE COALESCE(json_extract(p.value,'$.stopped'),0)!=1)`).all();
    return new Set(rows.map(row => row.work_id));
  }

  private assessCurrent(store: SqlDatabaseStore, input: number | InvoiceWorkExecutionCommand, at: string,
    requireRequestBudget = true, admittedPhase = false, pendingFeedback: readonly DurableProductToolCall[] = []): InvoiceWorkAdmission {
    if (this.database.recoveryError) throw new AdmissionFault(this.database.recoveryError);
    const command = typeof input === 'number' ? undefined : input;
    if (command?.kind === 'create') {
      const agent = need(store.personalAgents.getDefault());
      requireFact(agent && agent.personalAgentId === command.request.personalAgentId, 'personal_agent_not_found', 'Personal Agent does not exist.');
      requireFact(agent.configuration.modelId !== null, 'personal_agent_model_unavailable', 'Select an explicit model before executing invoice Work.');
      for (const reference of command.request.documents) {
        const document = need(store.documents.get(reference.id));
        requireFact(document.documentRef.version === reference.version && document.status === 'available' && !document.isHidden
          && document.parsedArtifactId !== null, 'input_unavailable', 'The selected invoice version is unavailable.');
      }
    }
    const work = typeof input === 'number' ? this.work(store, input)
      : input.kind === 'create' ? null : this.work(store, input.request.workId);
    if (work) { const qualified = this.qualify(store, work, at, command, requireRequestBudget, pendingFeedback); if (qualified.kind !== 'ready') return qualified; }
    const occupied = this.occupiedWorks(store);
    if ([...occupied].some(workId => workId !== work?.id)) return { kind: 'queued' };
    const foreground = store.db.query(`SELECT r.id FROM runs r LEFT JOIN sessions s ON s.id=r.session_id
      WHERE (r.kind='provider' OR s.runtime_kind='agent_session')
      AND (r.status IN ('created','running') OR r.stopped_at IS NULL OR COALESCE(json_extract(r.cleanup_json,'$.stopped'),0)!=1
        OR COALESCE(json_extract(r.cleanup_json,'$.lateObservationRequired'),1)!=0)
      UNION SELECT t.run_id FROM tool_calls t JOIN sessions s ON s.id=t.session_id WHERE s.runtime_kind='agent_session'
        AND (t.status IN ('requested','running') OR t.stopped_at IS NULL OR COALESCE(json_extract(t.cleanup_json,'$.stopped'),0)!=1
          OR EXISTS (SELECT 1 FROM json_each(t.cleanup_json,'$.nativeProcesses') p WHERE COALESCE(json_extract(p.value,'$.stopped'),0)!=1)) LIMIT 1`).get();
    if (!admittedPhase && (this.foregroundBusy() || foreground)) return { kind: 'queued' };
    if (work && occupied.has(work.id)) return { kind: 'ready' };
    const queued = store.db.query<WorkRow, []>(`SELECT w.* FROM invoice_works w JOIN invoice_work_attempts a ON a.id=w.current_attempt_id
      WHERE w.status='open' AND a.stop_requested_at IS NULL AND a.stopped_at IS NULL ORDER BY w.created_at,w.id`).all();
    for (const candidate of queued) {
      if (work && (candidate.created_at > work.created_at || candidate.created_at === work.created_at && candidate.id >= work.id)) break;
      const checked = this.guarded(() => this.qualify(store, candidate, at));
      if (checked.ok && checked.data.kind === 'ready') return { kind: 'queued' };
    }
    return { kind: 'ready' };
  }

  /** Use this synchronous seam when the Coordinator also creates the Run in its current owner transaction. */
  public assessInStore(store: SqlDatabaseStore, input: number | InvoiceWorkExecutionCommand): Result<InvoiceWorkAdmission> {
    const checked = this.guarded(() => this.assessCurrent(store, input, z.string().datetime({ offset: true }).parse(this.now())));
    return checked.ok ? checked : ok({ kind: 'blocked', reason: checked.error });
  }

  public async assess(input: number | InvoiceWorkExecutionCommand): Promise<Result<InvoiceWorkAdmission>> {
    try { return await this.database.read(store => this.assessInStore(store, input)); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Work admission could not be read.', true)); }
  }

  private verify(store: SqlDatabaseStore, input: DurableAttemptIdentity, at: string, requireRequestBudget: boolean,
    pendingFeedback: readonly DurableProductToolCall[] = []) {
    const identity = identitySchema.parse(input), work = this.work(store, identity.workId), attempt = this.attempt(store, work);
    requireFact(identity.sessionId === work.session_id && identity.attemptId === attempt?.id && attempt.run_id !== null,
      'state_conflict', 'The model request does not belong to the current product Run.');
    const run = need(store.runs.get(attempt.run_id)), config = DurableRunConfigSnapshotSchema.parse(run.config),
      scope = DurableRunScopeSchema.parse(run.scope);
    requireFact(run.kind === 'agent' && 'runtimeKind' in run && run.runtimeKind === 'durable' && run.status === 'running'
      && run.cancelRequestedAt === null && run.stoppedAt === null && scope.workId === identity.workId && scope.attemptId === identity.attemptId
      && config.durable.workId === identity.workId && config.durable.attemptId === identity.attemptId,
    'run_state_invalid', 'The original Durable Run is not accepting model requests.');
    // Foreground priority applies before a phase; it does not revoke an already admitted native round.
    const admittedPhase = store.db.query('SELECT id FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND closed_at IS NULL')
      .get(identity.workId, identity.attemptId) !== null;
    const admission = this.assessCurrent(store, identity.workId, at, requireRequestBudget, admittedPhase, pendingFeedback);
    if (admission.kind === 'blocked') throw new AdmissionFault(admission.reason);
    if (admission.kind !== 'ready') throw new AdmissionFault(appError('invoice_work_admission_waiting', 'runtime',
      admission.kind === 'waiting' ? admission.reason : 'Another qualified execution currently owns admission.', true));
    const used = this.requestCount(store, run.runId, run.usage);
    requireFact(requireRequestBudget ? used < config.runtimeBudget.maxModelCalls : used <= config.runtimeBudget.maxModelCalls,
      'agent_model_call_budget', 'The current Run model request budget is exhausted.');
    return run;
  }

  public async verifyModelUse(identity: DurableAttemptIdentity): Promise<Result<void>> {
    try { return await this.database.read(store => this.guarded(() => { this.verify(store, identity, this.now(), false); })); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Model execution eligibility could not be verified.', true)); }
  }

  public async verifySchedulingUse(identity: DurableAttemptIdentity, pendingFeedback: readonly DurableProductToolCall[]): Promise<Result<void>> {
    try { return await this.database.read(store => this.guarded(() => { this.verify(store, identity, this.now(), false, pendingFeedback); })); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Original tool feedback recovery eligibility could not be verified.', true)); }
  }

  public async reserveModelRequest(identity: DurableAttemptIdentity): Promise<Result<void>> {
    try {
      return await this.database.transaction(store => this.guarded(() => {
        const at = z.string().datetime({ offset: true }).parse(this.now()), run = this.verify(store, identity, at, true), usage = run.usage;
        const count = this.requestCount(store, run.runId, usage) + 1;
        store.db.query(`INSERT INTO invoice_work_model_reservations(run_id,count) VALUES (?,?)
          ON CONFLICT(run_id) DO UPDATE SET count=excluded.count`).run(run.runId, count);
        // A later eligibility check can still prevent transport; a reservation is not observed model usage.
        const reserved: UsageRecord = { ...usage, attempts: null, attemptsComplete: false, updatedAt: at,
          source: usage.source === 'not-requested' ? 'unknown' : usage.source, reason: 'model-request-reserved' };
        requireFact(store.db.query('UPDATE runs SET usage_json=? WHERE id=? AND status=\'running\' AND cancel_requested_at IS NULL')
          .run(JSON.stringify(reserved), run.runId).changes === 1, 'run_state_invalid', 'The model request reservation was not committed.');
      }));
    } catch { return fail(appError('storage_write_failed', 'storage', 'The model request reservation could not be confirmed.', true)); }
  }

  /** Child creation and the original stop intent are decided by the same SQL owner. */
  public verifySubagentAdmissionInStore(store: SqlDatabaseStore, identity: DurableAttemptIdentity): Result<void> {
    return this.guarded(() => {
      requireFact(store.db.inTransaction, 'state_conflict', 'Child admission requires the product transaction.');
      this.verify(store, identity, this.now(), false);
      const remaining = this.budget(store, this.work(store, identity.workId), this.now());
      requireFact(remaining.childSlots > 0, 'subagent_capacity_exceeded', 'All four child ownership slots remain occupied.');
      requireFact(remaining.modelCalls > 0, 'agent_model_call_budget', 'The shared Work model budget is exhausted.');
    });
  }

  private verifyChild(store: SqlDatabaseStore, identity: DurableSubagentIdentity, reserve: boolean) {
    this.verify(store, { workId: identity.workId, sessionId: identity.sessionId, attemptId: identity.attemptId }, this.now(), false);
    need(store.runs.verifyDurableSubagentAdmission(identity.childRunId));
    const run = need(store.runs.get(identity.childRunId)), scope = DurableSubagentRunScopeSchema.parse(run.scope);
    requireFact(!reserve || run.status === 'running', 'run_state_invalid', 'An unstarted child cannot reserve a model request.');
    requireFact(run.sessionId === identity.childSessionId && scope.workId === identity.workId && scope.attemptId === identity.attemptId
      && scope.originToolCallId === identity.originToolCallId && scope.parentRequestId === identity.requestId,
    'subagent_origin_invalid', 'The native model request belongs to another child.');
    const remaining = this.budget(store, this.work(store, identity.workId), this.now());
    requireFact(!reserve || remaining.modelCalls > 0, 'agent_model_call_budget', 'The shared Work model budget is exhausted.');
    requireFact(remaining.timeoutMs > 0, 'agent_timeout', 'The shared Work execution time budget is exhausted.');
    return run;
  }

  public async verifySubagentModelUse(identity: DurableSubagentIdentity): Promise<Result<void>> {
    try { return await this.database.read(store => this.guarded(() => { this.verifyChild(store, identity, false); })); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Child model eligibility could not be verified.', true)); }
  }

  public async reserveSubagentModelRequest(identity: DurableSubagentIdentity): Promise<Result<void>> {
    try {
      return await this.database.transaction(store => this.guarded(() => {
        const run = this.verifyChild(store, identity, true), at = this.now(), count = this.requestCount(store, run.runId, run.usage) + 1;
        store.db.query(`INSERT INTO invoice_work_model_reservations(run_id,count) VALUES (?,?)
          ON CONFLICT(run_id) DO UPDATE SET count=excluded.count`).run(run.runId, count);
        const usage: UsageRecord = { ...run.usage, attempts: null, attemptsComplete: false, updatedAt: at,
          source: run.usage.source === 'not-requested' ? 'unknown' : run.usage.source, reason: 'model-request-reserved' };
        requireFact(store.db.query("UPDATE runs SET usage_json=? WHERE id=? AND status='running' AND cancel_requested_at IS NULL")
          .run(JSON.stringify(usage), run.runId).changes === 1, 'run_state_invalid', 'The original child model reservation was not committed.');
      }));
    } catch { return fail(appError('storage_write_failed', 'storage', 'The child model reservation could not be confirmed.', true)); }
  }

  public async remainingBudget(workId: number): Promise<Result<RemainingBudget>> {
    try { return await this.database.read(store => this.guarded(() => this.budget(store, this.work(store, workId), this.now()))); }
    catch { return fail(appError('storage_read_failed', 'storage', 'The remaining Work budget could not be read.', true)); }
  }
}
