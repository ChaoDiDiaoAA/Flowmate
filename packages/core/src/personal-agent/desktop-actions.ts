import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CloudWorkspaceIdSchema, fail, ok, DesktopActionDecisionRequestSchema, DesktopActionDecisionQuerySchema, DesktopActionDecisionReceiptSchema,
  DesktopActionExecuteSchema, DesktopActionListRequestSchema, DesktopActionListResultSchema, DesktopActionProposalSchema,
  DesktopActionTargetSchema, DesktopActionViewSchema, InvoiceWorkContinueReceiptSchema, InvoiceWorkContinueRequestSchema, InvoiceWorkPhaseBasisSchema, RunScopeSchema, type AppError, type DesktopActionDecisionQuery,
  type DesktopActionDecisionReceipt, type DesktopActionDecisionRequest, type DesktopActionListRequest, type DesktopActionListResult,
  type DesktopActionTarget, type DesktopActionView, type Result } from '@flowmate/contracts';
import { createToolCallRepository } from '../storage/repositories.ts';
import { readTransaction } from '../storage/reads.ts';
import { approvalWithinBudget } from './approval-wait.ts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const atSchema = z.string().datetime({ offset: true });
type Status = 'waiting' | 'approved' | 'rejected' | 'claimed' | 'dispatched' | 'unknown' | 'invalidated';
type Row = { id: number; work_id: number; item_id: number; item_revision: number; proposal_tool_call_id: number; target_json: string;
  status: Status; decision_request_id: string | null; decision_request_json: string | null; decision_receipt_json: string | null;
  execution_tool_call_id: number | null; created_at: string; updated_at: string };
type CallOwner = { phase_id: number; work_id: number; item_id: number; closed_at: string | null; scope_json: string;
  basis_json: string; scheduler_state: string;
  run_kind: string; run_status: string; cancel_requested_at: string | null; stop_requested_at: string | null; stopped_at: string | null;
  work_status: string; current_attempt_id: number | null; attempt_id: number; disposition: string; item_revision: number; runtime_kind: string;
  durable_runtime_id: string; phase_runtime_id: string; cloud_workspace_id: string | null; session_status: string };
export type InvoiceWorkDesktopAction = DesktopActionView;

class DesktopActionFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function requireFact(condition: unknown, code = 'state_conflict', message = 'The original desktop action is no longer available.'): asserts condition {
  if (!condition) throw new DesktopActionFault(appError(code, code === 'storage_corrupt' ? 'storage' : 'input', message));
}
function need<T>(result: Result<T>): T { if (!result.ok) throw new DesktopActionFault(result.error); return result.data; }
function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DesktopActionFault(appError('input_invalid', 'input', 'The desktop action request is invalid.'));
  return result.data;
}

export function desktopActionContinuationAuthorized(db: SynchronousDatabaseExecutor, workId: number, attemptId: number, decisionRevision: number): boolean {
  return db.query<{ request_id: string; request_json: string; receipt_json: string }, [number]>(
    "SELECT request_id,request_json,receipt_json FROM invoice_work_operations WHERE work_id=? AND kind='continueWork' ORDER BY id")
    .all(workId).some(row => {
      const request = InvoiceWorkContinueRequestSchema.parse(JSON.parse(row.request_json));
      const receipt = InvoiceWorkContinueReceiptSchema.parse(JSON.parse(row.receipt_json));
      requireFact(request.workId === workId && request.requestId === row.request_id && receipt.workId === workId
        && receipt.requestId === request.requestId && receipt.revision === request.expectedRevision + (receipt.execution.authorizationAccepted ? 1 : 0),
      'storage_corrupt', 'The original continuation does not match its receipt.');
      return receipt.workId === workId && receipt.revision > decisionRevision && receipt.execution.authorizationAccepted
        && receipt.execution.attempt.attemptId === attemptId;
    });
}

export function createInvoiceWorkDesktopActionRepository(db: SynchronousDatabaseExecutor) {
  const tools = createToolCallRepository(db);
  function operation<T>(write: boolean, action: () => T): Result<T> {
    try {
      if (write) requireFact(db.inTransaction, 'state_conflict', 'Desktop action writes require the product transaction.');
      return ok(write ? db.transaction(action).immediate() : readTransaction(db, action));
    } catch (error) {
      if (error instanceof DesktopActionFault) return fail(error.fact);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return fail(appError('storage_corrupt', 'storage', 'Stored desktop action facts are invalid.'));
      return fail(appError(write ? 'storage_write_failed' : 'storage_read_failed', 'storage', 'Desktop action storage is unavailable.', true));
    }
  }
  function row(workId: number, itemId: number, proposalId: number): Row {
    const found = db.query<Row, [number, number, number]>('SELECT * FROM invoice_work_desktop_actions WHERE work_id=? AND item_id=? AND id=?')
      .get(workId, itemId, proposalId);
    requireFact(found, 'desktop_action_not_found', 'The original desktop action does not exist.');
    return found;
  }
  function owner(toolCallId: number, workId: number, itemId: number, name: string, active: boolean) {
    const call = need(tools.getById(toolCallId));
    const found = db.query<CallOwner, [number]>(`SELECT p.id phase_id,p.work_id,p.item_id,p.closed_at,p.basis_json,p.scheduler_state,b.scope_json,
      r.kind run_kind,r.status run_status,r.cancel_requested_at,a.stop_requested_at,a.stopped_at,w.status work_status,
      w.current_attempt_id,a.id attempt_id,i.disposition,i.revision item_revision,s.runtime_kind,s.durable_runtime_id,
      p.durable_runtime_id phase_runtime_id,s.cloud_workspace_id,s.status session_status
      FROM invoice_work_tool_calls b JOIN invoice_work_phases p ON p.id=b.phase_id
      JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=p.work_id
      JOIN invoice_works w ON w.id=p.work_id JOIN invoice_work_items i ON i.id=p.item_id AND i.work_id=w.id
      JOIN tool_calls t ON t.id=b.tool_call_id JOIN runs r ON r.id=t.run_id AND r.session_id=t.session_id
      JOIN sessions s ON s.id=r.session_id WHERE b.tool_call_id=?`).get(toolCallId);
    requireFact(found && found.work_id === workId && found.item_id === itemId && found.run_kind === 'agent'
      && found.runtime_kind === 'durable' && found.phase_runtime_id === found.durable_runtime_id
      && (found.durable_runtime_id === 'local' ? found.cloud_workspace_id === null : CloudWorkspaceIdSchema.safeParse(found.cloud_workspace_id).success)
      && call.toolName === name && call.effect === 'LOCAL_WRITE', 'tool_access_denied', 'The action does not belong to the original invoice phase.');
    const scope = RunScopeSchema.parse(JSON.parse(found.scope_json));
    requireFact(scope.invoiceWork?.workId === workId && scope.invoiceWork.itemId === itemId
      && scope.invoiceWork.phaseId === found.phase_id && scope.invoiceWork.attemptId === found.attempt_id
      && scope.allowedTools.includes(name), 'storage_corrupt', 'The original desktop tool scope is inconsistent.');
    if (active) requireFact(found.closed_at === null && found.run_status === 'running' && found.session_status === 'active'
      && found.work_status === 'open' && found.disposition === 'unresolved' && found.current_attempt_id === found.attempt_id
      && found.cancel_requested_at === null && found.stop_requested_at === null && found.stopped_at === null && call.status === 'running',
    'run_state_invalid', 'The original invoice phase no longer permits desktop input.');
    return { call, owner: found };
  }
  function snapshot(found: Row): InvoiceWorkDesktopAction {
    const original = owner(found.proposal_tool_call_id, found.work_id, found.item_id, 'desktop_propose_action', false);
    const action = DesktopActionProposalSchema.parse(original.call.args.final);
    const target = DesktopActionTargetSchema.parse(JSON.parse(found.target_json));
    requireFact(isDeepStrictEqual(original.call.args.raw, action) && target.element.trimStart().startsWith(`[${action.elementIndex}]`),
      'storage_corrupt', 'The desktop target differs from its original proposal.');
    const result = original.call.result?.status === 'succeeded'
      ? z.object({ proposalId: id }).passthrough().safeParse(original.call.result.data) : null;
    const itemLane = InvoiceWorkPhaseBasisSchema.parse(JSON.parse(original.owner.basis_json)).executionMode === 'item-lane-approval-v1';
    const decisionWindow = itemLane ? original.owner.closed_at === null && original.owner.scheduler_state === 'waiting_approval'
      && original.owner.run_status === 'running' && original.owner.session_status === 'active'
      && original.owner.current_attempt_id === original.owner.attempt_id && original.owner.cancel_requested_at === null
      && original.owner.stop_requested_at === null && original.owner.stopped_at === null : original.owner.closed_at !== null;
    const canReject = found.status === 'waiting' && decisionWindow
      && original.owner.work_status === 'open' && original.owner.disposition === 'unresolved';
    const canDecide = canReject && original.call.status === 'succeeded' && result?.success === true && result.data.proposalId === found.id
      && original.owner.item_revision === found.item_revision;
    return DesktopActionViewSchema.parse({ proposalId: found.id, workId: found.work_id, itemId: found.item_id, proposalToolCallId: found.proposal_tool_call_id,
      target, action, status: found.status, canDecide, canReject, ...(itemLane ? { resumeOriginal: true } : {}),
      executionToolCallId: found.execution_tool_call_id, createdAt: found.created_at, updatedAt: found.updated_at });
  }
  function savedDecision(found: Row): { request: DesktopActionDecisionRequest; receipt: DesktopActionDecisionReceipt } {
    requireFact(found.decision_request_id && found.decision_request_json && found.decision_receipt_json,
      'storage_corrupt', 'The original desktop decision is unavailable.');
    const request = DesktopActionDecisionRequestSchema.parse(JSON.parse(found.decision_request_json));
    const receipt = DesktopActionDecisionReceiptSchema.parse(JSON.parse(found.decision_receipt_json));
    const { revision, receivedAt: _receivedAt, ...receivedRequest } = receipt;
    requireFact(request.workId === found.work_id && request.itemId === found.item_id && request.proposalId === found.id
      && request.requestId === found.decision_request_id && request.expectedRevision < Number.MAX_SAFE_INTEGER
      && revision === request.expectedRevision + 1 && isDeepStrictEqual(receivedRequest, request),
    'storage_corrupt', 'The original desktop decision does not match its receipt.');
    return { request, receipt };
  }
  return {
    propose(raw: { workId: number; itemId: number; proposalToolCallId: number; target: DesktopActionTarget; at: string }): Result<InvoiceWorkDesktopAction> {
      return operation(true, () => {
        const input = parseInput(z.object({ workId: id, itemId: id, proposalToolCallId: id, target: DesktopActionTargetSchema, at: atSchema }).strict(), raw);
        const existing = db.query<Row, [number]>('SELECT * FROM invoice_work_desktop_actions WHERE proposal_tool_call_id=?').get(input.proposalToolCallId);
        if (existing) {
          const saved = snapshot(existing);
          requireFact(saved.workId === input.workId && saved.itemId === input.itemId && isDeepStrictEqual(saved.target, input.target));
          return saved;
        }
        const original = owner(input.proposalToolCallId, input.workId, input.itemId, 'desktop_propose_action', true);
        const action = DesktopActionProposalSchema.parse(original.call.args.final);
        requireFact(isDeepStrictEqual(original.call.args.raw, action) && input.target.element.trimStart().startsWith(`[${action.elementIndex}]`),
          'state_conflict', 'The target does not match the original observed control.');
        requireFact(!db.query("SELECT id FROM invoice_work_desktop_actions WHERE work_id=? AND item_id=? AND status IN ('waiting','approved','claimed')")
          .get(input.workId, input.itemId), 'state_conflict', 'Another desktop action still awaits resolution.');
        const inserted = db.query(`INSERT INTO invoice_work_desktop_actions(work_id,item_id,item_revision,proposal_tool_call_id,target_json,status,created_at,updated_at)
          VALUES(?,?,?,?,?,'waiting',?,?)`).run(input.workId, input.itemId, original.owner.item_revision,
          input.proposalToolCallId, JSON.stringify(input.target), input.at, input.at);
        return snapshot(row(input.workId, input.itemId, Number(inserted.lastInsertRowid)));
      });
    },
    get(raw: { workId: number; itemId: number; proposalId: number }): Result<InvoiceWorkDesktopAction> {
      return operation(false, () => { const input = parseInput(z.object({ workId: id, itemId: id, proposalId: id }).strict(), raw);
        return snapshot(row(input.workId, input.itemId, input.proposalId)); });
    },
    list(raw: DesktopActionListRequest): Result<DesktopActionListResult> {
      return operation(false, () => {
        const parsed = DesktopActionListRequestSchema.safeParse(raw);
        requireFact(parsed.success, 'input_invalid', 'The desktop action query is invalid.');
        const input = parsed.data;
        requireFact(db.query(`SELECT i.id FROM invoice_work_items i JOIN invoice_works w ON w.id=i.work_id
          JOIN sessions s ON s.id=w.session_id WHERE w.id=? AND i.id=? AND s.runtime_kind='durable'`)
          .get(input.workId, input.itemId), 'invoice_work_item_not_found', 'The invoice item does not exist.');
        const rows = db.query<Row, [number, number, number, number]>(`SELECT * FROM invoice_work_desktop_actions
          WHERE work_id=? AND item_id=? AND id>? ORDER BY id LIMIT ?`)
          .all(input.workId, input.itemId, input.afterProposalId ?? 0, input.limit + 1);
        const items: InvoiceWorkDesktopAction[] = [];
        for (const candidate of rows.slice(0, input.limit)) {
          const next = snapshot(candidate);
          if (!DesktopActionListResultSchema.safeParse({ workId: input.workId, itemId: input.itemId,
            items: [...items, next], nextAfterProposalId: next.proposalId }).success) {
            requireFact(items.length > 0, 'input_too_large', 'The desktop action cannot fit its query page.');
            break;
          }
          items.push(next);
        }
        return DesktopActionListResultSchema.parse({ workId: input.workId, itemId: input.itemId, items,
          nextAfterProposalId: rows.length > items.length ? items.at(-1)?.proposalId ?? null : null });
      });
    },
    queryDecision(raw: DesktopActionDecisionQuery): Result<DesktopActionDecisionReceipt | null> {
      return operation(false, () => {
        const input = parseInput(DesktopActionDecisionQuerySchema, raw), found = row(input.workId, input.itemId, input.proposalId);
        return found.decision_request_id === input.requestId ? savedDecision(found).receipt : null;
      });
    },
    decide(raw: DesktopActionDecisionRequest, at: string): Result<DesktopActionDecisionReceipt> {
      return operation(true, () => {
        const input = parseInput(DesktopActionDecisionRequestSchema, raw), time = parseInput(atSchema, at);
        const found = row(input.workId, input.itemId, input.proposalId);
        if (found.decision_request_id === input.requestId) {
          const saved = savedDecision(found);
          requireFact(isDeepStrictEqual(saved.request, input));
          return saved.receipt;
        }
        requireFact(found.status === 'waiting' && found.decision_request_id === null);
        requireFact((input.confirmedAction === undefined) === (input.confirmedTarget === undefined));
        if (input.confirmedAction && input.confirmedTarget) {
          const confirmed = snapshot(found);
          requireFact(isDeepStrictEqual(input.confirmedAction, confirmed.action) && isDeepStrictEqual(input.confirmedTarget, confirmed.target),
            'state_conflict', 'The displayed desktop action changed; observe and confirm it again.');
        }
        requireFact(!db.query('SELECT id FROM invoice_work_desktop_actions WHERE work_id=? AND decision_request_id=?')
          .get(input.workId, input.requestId));
        const original = owner(found.proposal_tool_call_id, input.workId, input.itemId, 'desktop_propose_action', false);
        const current = snapshot(found), itemLane = InvoiceWorkPhaseBasisSchema.parse(JSON.parse(original.owner.basis_json)).executionMode === 'item-lane-approval-v1';
        requireFact((input.decision === 'approve' ? current.canDecide : current.canReject)
          && (!itemLane || approvalWithinBudget(db, input.workId, time)) && original.owner.item_revision < Number.MAX_SAFE_INTEGER);
        const work = db.query<{ revision: number }, [number]>('SELECT revision FROM invoice_works WHERE id=? AND status=\'open\'').get(input.workId);
        requireFact(work && work.revision === input.expectedRevision && work.revision < Number.MAX_SAFE_INTEGER);
        const receipt: DesktopActionDecisionReceipt = { ...input, revision: work.revision + 1, receivedAt: time };
        requireFact(db.query('UPDATE invoice_works SET revision=?,updated_at=? WHERE id=? AND revision=? AND status=\'open\'')
          .run(receipt.revision, time, input.workId, input.expectedRevision).changes === 1);
        requireFact(db.query("UPDATE invoice_work_items SET revision=revision+1,updated_at=? WHERE work_id=? AND id=? AND revision=? AND disposition='unresolved'")
          .run(time, input.workId, input.itemId, original.owner.item_revision).changes === 1);
        requireFact(db.query(`UPDATE invoice_work_desktop_actions SET status=?,decision_request_id=?,decision_request_json=?,
          decision_receipt_json=?,updated_at=? WHERE id=? AND status='waiting'`).run(input.decision === 'approve' ? 'approved' : 'rejected',
          input.requestId, JSON.stringify(input), JSON.stringify(receipt), time, found.id).changes === 1);
        if (itemLane) requireFact(db.query("UPDATE invoice_work_phases SET scheduler_state='ready' WHERE id=? AND scheduler_state='waiting_approval' AND closed_at IS NULL")
          .run(original.owner.phase_id).changes === 1);
        return receipt;
      });
    },
    claim(raw: { workId: number; itemId: number; proposalId: number; executionToolCallId: number; at: string }): Result<InvoiceWorkDesktopAction> {
      return operation(true, () => {
        const input = parseInput(z.object({ workId: id, itemId: id, proposalId: id, executionToolCallId: id, at: atSchema }).strict(), raw);
        const found = row(input.workId, input.itemId, input.proposalId);
        requireFact(found.status === 'approved' && found.execution_tool_call_id === null);
        const decision = savedDecision(found);
        requireFact(decision.request.decision === 'approve', 'storage_corrupt', 'The original desktop action was not approved.');
        const execution = owner(input.executionToolCallId, input.workId, input.itemId, 'desktop_execute_approved', true);
        requireFact(execution.owner.item_revision === found.item_revision + 1, 'desktop_item_changed',
          'The invoice changed after the desktop action was approved.');
        const phase = db.query<{ basis_json: string }, [number]>('SELECT basis_json FROM invoice_work_phases WHERE id=?').get(execution.owner.phase_id);
        requireFact(phase);
        const basis = InvoiceWorkPhaseBasisSchema.parse(JSON.parse(phase.basis_json));
        if (basis.executionMode === 'item-lane-approval-v1') {
          const original = owner(found.proposal_tool_call_id, input.workId, input.itemId, 'desktop_propose_action', false);
          requireFact(original.owner.phase_id === execution.owner.phase_id && execution.owner.scheduler_state === 'active'
            && approvalWithinBudget(db, input.workId, input.at), 'tool_access_denied', 'The original desktop approval is no longer active.');
        } else requireFact(basis.desktopProposalId === found.id
          && desktopActionContinuationAuthorized(db, input.workId, execution.owner.attempt_id, decision.receipt.revision),
        'tool_access_denied', 'The desktop approval has no explicit continuation for this attempt.');
        const action = DesktopActionExecuteSchema.parse(execution.call.args.final);
        requireFact(action.proposalId === found.id && isDeepStrictEqual(execution.call.args.raw, action));
        requireFact(db.query("UPDATE invoice_work_desktop_actions SET status='claimed',execution_tool_call_id=?,updated_at=? WHERE id=? AND status='approved'")
          .run(input.executionToolCallId, input.at, found.id).changes === 1);
        return snapshot(row(input.workId, input.itemId, input.proposalId));
      });
    },
    invalidate(raw: { workId: number; itemId: number; proposalId: number; at: string }): Result<InvoiceWorkDesktopAction> {
      return operation(true, () => {
        const input = parseInput(z.object({ workId: id, itemId: id, proposalId: id, at: atSchema }).strict(), raw);
        const found = row(input.workId, input.itemId, input.proposalId);
        if (found.status === 'invalidated') return snapshot(found);
        requireFact(found.status === 'approved' && found.execution_tool_call_id === null);
        requireFact(db.query("UPDATE invoice_work_desktop_actions SET status='invalidated',updated_at=? WHERE id=? AND status='approved'")
          .run(input.at, found.id).changes === 1);
        return snapshot(row(input.workId, input.itemId, input.proposalId));
      });
    },
    finish(raw: { workId: number; itemId: number; proposalId: number; executionToolCallId: number; at: string;
      outcome: 'dispatched' | 'unknown' }): Result<InvoiceWorkDesktopAction> {
      return operation(true, () => {
        const input = parseInput(z.object({ workId: id, itemId: id, proposalId: id, executionToolCallId: id, at: atSchema,
          outcome: z.enum(['dispatched', 'unknown']) }).strict(), raw);
        const found = row(input.workId, input.itemId, input.proposalId);
        requireFact(found.execution_tool_call_id === input.executionToolCallId);
        if (found.status === input.outcome) return snapshot(found);
        requireFact(found.status === 'claimed');
        requireFact(db.query("UPDATE invoice_work_desktop_actions SET status=?,updated_at=? WHERE id=? AND status='claimed'")
          .run(input.outcome, input.at, found.id).changes === 1);
        return snapshot(row(input.workId, input.itemId, input.proposalId));
      });
    },
  };
}

export type InvoiceWorkDesktopActionRepository = ReturnType<typeof createInvoiceWorkDesktopActionRepository>;
