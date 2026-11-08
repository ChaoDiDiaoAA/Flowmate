import { z } from 'zod';
import { appError, DurableApprovalWaitIdentitySchema, DurableApprovalWaitStateSchema, DurableWorkBudgetSchema,
  InvoiceWorkPhaseBasisSchema, RunScopeSchema, fail, ok, type AppError, type DurableApprovalWaitIdentity,
  type DurableApprovalWaitState, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';

class WaitFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function requireFact(value: unknown, code = 'state_conflict'): asserts value {
  if (!value) throw new WaitFault(appError(code, 'runtime', 'The original invoice approval cannot be confirmed.'));
}
function need<T>(value: Result<T>): T { if (!value.ok) throw new WaitFault(value.error); return value.data; }

/** The original Work budget includes time spent waiting for the user's decision. */
export function approvalWithinBudget(db: SynchronousDatabaseExecutor, workId: number, at: string): boolean {
  try {
    const work = db.query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(workId);
    if (!work || !z.string().datetime({ offset: true }).safeParse(at).success) return false;
    const budget = DurableWorkBudgetSchema.parse(JSON.parse(work.budget_json));
    const runs = db.query<{ started_at: string | null; stopped_at: string | null; ended_at: string | null; duration_ms: number | null }, [number]>(
      `SELECT r.started_at,r.stopped_at,r.ended_at,r.duration_ms FROM runs r JOIN invoice_work_attempts a ON a.run_id=r.id
       WHERE a.work_id=? AND r.parent_run_id IS NULL`).all(workId);
    let elapsed = 0;
    for (const run of runs) if (run.started_at !== null) {
      const duration = run.duration_ms ?? Date.parse(run.stopped_at ?? run.ended_at ?? at) - Date.parse(run.started_at);
      if (!Number.isSafeInteger(duration) || duration < 0 || !Number.isSafeInteger(elapsed + duration)) return false;
      elapsed += duration;
    }
    return elapsed < budget.limits.timeoutMs;
  } catch { return false; }
}

export function inspectApprovalWaitInStore(store: SqlDatabaseStore, input: DurableApprovalWaitIdentity): DurableApprovalWaitState {
    const row = store.db.query<{ scheduler_state: string; basis_json: string; native_conversation_id: number | null;
      native_submission_id: number | null; item_revision: number; run_id: number; scope_json: string; proposal_call_id: number;
      proposal_revision: number; proposal_status: string; decision_request_id: string | null }, [number, number, number, number, number, string, number]>(`
      SELECT p.scheduler_state,p.basis_json,p.native_conversation_id,p.native_submission_id,i.revision item_revision,a.run_id,
        b.scope_json,t.id proposal_call_id,approval.item_revision proposal_revision,approval.status proposal_status,approval.decision_request_id
      FROM invoice_work_phases p JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=p.work_id
      JOIN invoice_works w ON w.id=p.work_id JOIN invoice_work_items i ON i.id=p.item_id AND i.work_id=w.id
      JOIN sessions s ON s.id=w.session_id JOIN runs r ON r.id=a.run_id AND r.session_id=s.id
      JOIN invoice_work_tool_calls b ON b.phase_id=p.id JOIN tool_calls t ON t.id=b.tool_call_id AND t.run_id=r.id
      JOIN ${input.kind === 'browser' ? 'invoice_work_browser_reads' : 'invoice_work_desktop_actions'} approval ON approval.proposal_tool_call_id=t.id
      WHERE p.id=? AND p.work_id=? AND p.attempt_id=? AND p.item_id=? AND w.session_id=? AND p.request_id=? AND approval.id=?
        AND approval.work_id=w.id AND approval.item_id=i.id AND p.closed_at IS NULL AND w.status='open'
        AND w.current_attempt_id=a.id AND a.stop_requested_at IS NULL AND a.stopped_at IS NULL AND i.disposition='unresolved'
        AND s.runtime_kind='durable' AND s.status='active' AND r.status='running' AND r.cancel_requested_at IS NULL AND r.stopped_at IS NULL`)
      .get(input.phaseId, input.workId, input.attemptId, input.itemId, input.sessionId, input.requestId, input.proposalId);
    requireFact(row && row.native_conversation_id === input.nativeConversationId && row.native_submission_id !== null
      && InvoiceWorkPhaseBasisSchema.parse(JSON.parse(row.basis_json)).executionMode === 'item-lane-approval-v1');
    const session = need(store.sessions.get(input.sessionId));
    requireFact(session.runtimeKind === 'durable' && !session.modelUseBlocked && !session.deletePending);
    const scope = RunScopeSchema.parse(JSON.parse(row.scope_json));
    requireFact(scope.invoiceWork?.workId === input.workId && scope.invoiceWork.attemptId === input.attemptId
      && scope.invoiceWork.phaseId === input.phaseId && scope.invoiceWork.itemId === input.itemId);
    const call = need(store.toolCalls.getById(row.proposal_call_id));
    const name = input.kind === 'browser' ? 'browser_request_read' : 'desktop_propose_action';
    const output = call.result?.status === 'succeeded' ? z.object({ proposalId: z.number().int().positive() }).passthrough().safeParse(call.result.data) : null;
    requireFact(call.runId === row.run_id && call.sessionId === input.sessionId && call.nativeToolCallId === `durable-task:${input.nativeTaskId}`
      && call.toolName === name && call.effect === 'LOCAL_WRITE' && call.status === 'succeeded' && output?.success
      && output.data.proposalId === input.proposalId && scope.allowedTools.includes(name));
    const proposalIdentity = { workId: input.workId, itemId: input.itemId, proposalId: input.proposalId };
    const proposal = input.kind === 'browser' ? need(store.invoiceWorkBrowserReads.get(proposalIdentity)) : need(store.invoiceWorkDesktopActions.get(proposalIdentity));
    requireFact(proposal.proposalId === input.proposalId && proposal.proposalToolCallId === row.proposal_call_id);
    if (row.decision_request_id !== null) {
      const decision = input.kind === 'browser'
        ? need(store.invoiceWorkBrowserReads.queryDecision({ workId: input.workId, itemId: input.itemId, proposalId: input.proposalId, requestId: row.decision_request_id }))
        : need(store.invoiceWorkDesktopActions.queryDecision({ workId: input.workId, itemId: input.itemId, proposalId: input.proposalId, requestId: row.decision_request_id }));
      requireFact(decision && (row.proposal_status !== 'rejected' || decision.decision === 'reject')
        && (!['approved', 'claimed', 'dispatched', 'completed', 'revoked', 'unknown'].includes(row.proposal_status) || decision.decision === 'approve'));
    }
    const status = row.proposal_status === 'waiting' ? 'waiting' : row.proposal_status === 'rejected' ? 'rejected'
      : ['invalidated', 'revoked'].includes(row.proposal_status) ? 'invalidated'
      : ['claimed', 'unknown'].includes(row.proposal_status) ? 'unknown'
      : ['approved', 'dispatched', 'completed'].includes(row.proposal_status) ? 'approved' : null;
    requireFact(status !== null && (status === 'waiting' ? row.decision_request_id === null
      : status === 'invalidated' || row.decision_request_id !== null));
    const revisionMatches = row.item_revision === row.proposal_revision + (row.decision_request_id === null ? 0 : 1);
    return DurableApprovalWaitStateSchema.parse({ status: revisionMatches ? status : 'invalidated', scheduling: row.scheduler_state,
      decisionRequestId: row.decision_request_id });
}

export function createInvoiceWorkApprovalWait(options: { database: Pick<DbHandle, 'read' | 'transaction'>; now(): string; onChanged?(): void }) {
  const original = inspectApprovalWaitInStore;
  const guarded = async <T>(write: boolean, action: (store: SqlDatabaseStore) => T): Promise<Result<T>> => {
    try { return ok(await (write ? options.database.transaction(action) : options.database.read(action))); }
    catch (error) { return fail(error instanceof WaitFault ? error.fact
      : appError(write ? 'storage_write_failed' : 'storage_read_failed', 'storage', 'The original invoice approval is unavailable.', true)); }
  };
  const parse = (raw: DurableApprovalWaitIdentity) => DurableApprovalWaitIdentitySchema.safeParse(raw);
  return {
    async begin(raw: DurableApprovalWaitIdentity): Promise<Result<DurableApprovalWaitState>> {
      const parsed = parse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The approval identity is invalid.'));
      const input = parsed.data, result = await guarded(true, store => {
        const state = original(store, input);
        requireFact(approvalWithinBudget(store.db, input.workId, options.now()), 'agent_timeout');
        if (state.status === 'waiting' && state.scheduling === 'active') {
          requireFact(store.db.query("UPDATE invoice_work_phases SET scheduler_state='waiting_approval' WHERE id=? AND scheduler_state='active' AND closed_at IS NULL")
            .run(input.phaseId).changes === 1);
          return original(store, input);
        }
        return state;
      });
      if (result.ok) options.onChanged?.(); return result;
    },
    async read(raw: DurableApprovalWaitIdentity): Promise<Result<DurableApprovalWaitState>> {
      const parsed = parse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The approval identity is invalid.'));
      return guarded(false, store => {
        const state = original(store, parsed.data);
        requireFact(approvalWithinBudget(store.db, parsed.data.workId, options.now()), 'agent_timeout');
        return state;
      });
    },
    async activate(raw: DurableApprovalWaitIdentity): Promise<Result<{ activated: boolean }>> {
      const parsed = parse(raw); if (!parsed.success) return fail(appError('input_invalid', 'input', 'The approval identity is invalid.'));
      const input = parsed.data, result = await guarded(true, store => {
        const state = original(store, input);
        requireFact(state.status === 'approved' || state.status === 'rejected');
        requireFact(approvalWithinBudget(store.db, input.workId, options.now()), 'agent_timeout');
        if (state.scheduling === 'active') return { activated: true };
        requireFact(state.scheduling === 'ready');
        const changed = store.db.query(`UPDATE invoice_work_phases SET scheduler_state='active' WHERE id=? AND scheduler_state='ready' AND closed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM invoice_work_phases other WHERE other.attempt_id=? AND other.closed_at IS NULL
            AND (other.scheduler_state IN ('active','legacy') OR other.scheduler_state='ready' AND other.id<?))`)
          .run(input.phaseId, input.attemptId, input.phaseId).changes;
        return { activated: changed === 1 };
      });
      if (result.ok && result.data.activated) options.onChanged?.(); return result;
    },
  };
}
