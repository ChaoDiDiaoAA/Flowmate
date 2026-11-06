import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, BrowserPageSchema, BrowserReadDecisionQuerySchema, BrowserReadDecisionReceiptSchema, BrowserReadDecisionRequestSchema, BrowserReadListRequestSchema, BrowserReadListResultSchema,
  BrowserReadViewSchema, BrowserTargetSchema, BrowserToolInputSchema, CloudWorkspaceIdSchema, fail, InvoiceWorkPhaseBasisSchema, ok, RunScopeSchema,
  type AppError, type BrowserReadDecisionQuery, type BrowserReadDecisionRequest, type BrowserReadListRequest, type BrowserReadListResult, type BrowserReadView, type BrowserTarget, type Result } from '@flowmate/contracts';
import { createToolCallRepository } from '../storage/repositories.ts';
import { readTransaction } from '../storage/reads.ts';
import { desktopActionContinuationAuthorized } from './desktop-actions.ts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const atSchema = z.string().datetime({ offset: true });
type Row = { id: number; work_id: number; item_id: number; item_revision: number; proposal_tool_call_id: number; target_json: string;
  status: BrowserReadView['status']; decision_request_id: string | null; decision_request_json: string | null;
  decision_receipt_json: string | null; execution_tool_call_id: number | null; created_at: string; updated_at: string };
type Owner = { phase_id: number; work_id: number; item_id: number; closed_at: string | null; scope_json: string;
  run_kind: string; run_status: string; cancel_requested_at: string | null; stop_requested_at: string | null; stopped_at: string | null;
  work_status: string; current_attempt_id: number | null; attempt_id: number; disposition: string; item_revision: number; runtime_kind: string;
  durable_runtime_id: string; phase_runtime_id: string; cloud_workspace_id: string | null; session_status: string };
class BrowserReadFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function requireFact(condition: unknown, code = 'state_conflict', message = 'The original browser read is no longer available.'): asserts condition {
  if (!condition) throw new BrowserReadFault(appError(code, code === 'storage_corrupt' ? 'storage' : 'input', message));
}
function need<T>(result: Result<T>): T { if (!result.ok) throw new BrowserReadFault(result.error); return result.data; }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new BrowserReadFault(appError('input_invalid', 'input', 'The browser read request is invalid.'));
  return result.data;
}

export function createInvoiceWorkBrowserReadRepository(db: SynchronousDatabaseExecutor) {
  const tools = createToolCallRepository(db);
  function operation<T>(write: boolean, action: () => T): Result<T> {
    try {
      if (write) requireFact(db.inTransaction, 'state_conflict', 'Browser read writes require the product transaction.');
      return ok(write ? db.transaction(action).immediate() : readTransaction(db, action));
    } catch (error) {
      if (error instanceof BrowserReadFault) return fail(error.fact);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return fail(appError('storage_corrupt', 'storage', 'Stored browser read facts are invalid.'));
      return fail(appError(write ? 'storage_write_failed' : 'storage_read_failed', 'storage', 'Browser read storage is unavailable.', true));
    }
  }
  function row(workId: number, itemId: number, proposalId: number): Row {
    const found = db.query<Row, [number, number, number]>('SELECT * FROM invoice_work_browser_reads WHERE work_id=? AND item_id=? AND id=?')
      .get(workId, itemId, proposalId);
    requireFact(found, 'browser_read_not_found', 'The original browser read does not exist.'); return found;
  }
  function owner(toolCallId: number, workId: number, itemId: number, name: string, active: boolean) {
    const call = need(tools.getById(toolCallId));
    const found = db.query<Owner, [number]>(`SELECT p.id phase_id,p.work_id,p.item_id,p.closed_at,b.scope_json,
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
      && call.toolName === name && call.effect === 'LOCAL_WRITE', 'tool_access_denied', 'The read does not belong to the original invoice phase.');
    const scope = RunScopeSchema.parse(JSON.parse(found.scope_json));
    requireFact(scope.invoiceWork?.workId === workId && scope.invoiceWork.itemId === itemId
      && scope.invoiceWork.phaseId === found.phase_id && scope.invoiceWork.attemptId === found.attempt_id
      && scope.allowedTools.includes(name), 'storage_corrupt', 'The original browser tool scope is inconsistent.');
    if (active) requireFact(found.closed_at === null && found.run_status === 'running' && found.session_status === 'active'
      && found.work_status === 'open' && found.disposition === 'unresolved' && found.current_attempt_id === found.attempt_id
      && found.cancel_requested_at === null && found.stop_requested_at === null && found.stopped_at === null && call.status === 'running',
    'run_state_invalid', 'The original invoice phase no longer permits browser reads.');
    return { call, owner: found };
  }
  function snapshot(found: Row): BrowserReadView {
    const original = owner(found.proposal_tool_call_id, found.work_id, found.item_id, 'browser_request_read', false);
    const args = BrowserToolInputSchema.parse(original.call.args.final), target = BrowserTargetSchema.parse(JSON.parse(found.target_json));
    requireFact(isDeepStrictEqual(original.call.args.raw, args), 'storage_corrupt', 'The browser request differs from its original call.');
    const result = original.call.result?.status === 'succeeded'
      ? z.object({ proposalId: id }).passthrough().safeParse(original.call.result.data) : null;
    const canReject = found.status === 'waiting' && original.owner.closed_at !== null
      && original.owner.work_status === 'open' && original.owner.disposition === 'unresolved';
    const canDecide = canReject && original.call.status === 'succeeded' && result?.success === true && result.data.proposalId === found.id
      && original.owner.item_revision === found.item_revision;
    return BrowserReadViewSchema.parse({ proposalId: found.id, workId: found.work_id, itemId: found.item_id,
      proposalToolCallId: found.proposal_tool_call_id, target, status: found.status, canDecide, canReject,
      canRevoke: found.status === 'approved' || found.status === 'claimed' || found.status === 'completed', executionToolCallId: found.execution_tool_call_id,
      createdAt: found.created_at, updatedAt: found.updated_at });
  }
  function savedDecision(found: Row) {
    requireFact(found.decision_request_id && found.decision_request_json && found.decision_receipt_json,
      'storage_corrupt', 'The original browser decision is unavailable.');
    const request = BrowserReadDecisionRequestSchema.parse(JSON.parse(found.decision_request_json));
    const receipt = BrowserReadDecisionReceiptSchema.parse(JSON.parse(found.decision_receipt_json));
    const { revision, receivedAt: _receivedAt, ...receivedRequest } = receipt;
    requireFact(request.workId === found.work_id && request.itemId === found.item_id && request.proposalId === found.id
      && request.requestId === found.decision_request_id && revision === request.expectedRevision + 1
      && isDeepStrictEqual(receivedRequest, request), 'storage_corrupt', 'The browser decision differs from its receipt.');
    return { request, receipt };
  }
  return {
    propose(raw: { workId: number; itemId: number; proposalToolCallId: number; target: BrowserTarget; at: string }): Result<BrowserReadView> {
      return operation(true, () => {
        const input = parse(z.object({ workId: id, itemId: id, proposalToolCallId: id, target: BrowserTargetSchema, at: atSchema }).strict(), raw);
        const existing = db.query<Row, [number]>('SELECT * FROM invoice_work_browser_reads WHERE proposal_tool_call_id=?').get(input.proposalToolCallId);
        if (existing) { const saved = snapshot(existing); requireFact(saved.workId === input.workId && saved.itemId === input.itemId
          && isDeepStrictEqual(saved.target, input.target)); return saved; }
        const original = owner(input.proposalToolCallId, input.workId, input.itemId, 'browser_request_read', true);
        const args = BrowserToolInputSchema.parse(original.call.args.final);
        requireFact(isDeepStrictEqual(original.call.args.raw, args), 'state_conflict', 'The browser request changed.');
        requireFact(!db.query("SELECT id FROM invoice_work_browser_reads WHERE work_id=? AND item_id=? AND status IN ('waiting','approved','claimed')")
          .get(input.workId, input.itemId), 'state_conflict', 'Another browser read awaits resolution.');
        const inserted = db.query(`INSERT INTO invoice_work_browser_reads(work_id,item_id,item_revision,proposal_tool_call_id,target_json,status,created_at,updated_at)
          VALUES(?,?,?,?,?,'waiting',?,?)`).run(input.workId, input.itemId, original.owner.item_revision, input.proposalToolCallId,
          JSON.stringify(input.target), input.at, input.at);
        return snapshot(row(input.workId, input.itemId, Number(inserted.lastInsertRowid)));
      });
    },
    get(raw: { workId: number; itemId: number; proposalId: number }): Result<BrowserReadView> {
      return operation(false, () => { const input = parse(z.object({ workId: id, itemId: id, proposalId: id }).strict(), raw);
        return snapshot(row(input.workId, input.itemId, input.proposalId)); });
    },
    list(raw: BrowserReadListRequest): Result<BrowserReadListResult> {
      return operation(false, () => {
        const input = BrowserReadListRequestSchema.parse(raw);
        requireFact(db.query(`SELECT i.id FROM invoice_work_items i JOIN invoice_works w ON w.id=i.work_id
          JOIN sessions s ON s.id=w.session_id WHERE w.id=? AND i.id=? AND s.runtime_kind='durable'`).get(input.workId, input.itemId),
        'invoice_work_item_not_found', 'The invoice item does not exist.');
        const rows = db.query<Row, [number, number, number, number]>(`SELECT * FROM invoice_work_browser_reads
          WHERE work_id=? AND item_id=? AND id>? ORDER BY id LIMIT ?`).all(input.workId, input.itemId, input.afterProposalId ?? 0, input.limit + 1);
        const items: BrowserReadView[] = [];
        for (const candidate of rows.slice(0, input.limit)) {
          const next = snapshot(candidate);
          if (!BrowserReadListResultSchema.safeParse({ workId: input.workId, itemId: input.itemId,
            items: [...items, next], nextAfterProposalId: next.proposalId }).success) {
            requireFact(items.length > 0, 'input_too_large', 'The browser read cannot fit its query page.'); break;
          }
          items.push(next);
        }
        return BrowserReadListResultSchema.parse({ workId: input.workId, itemId: input.itemId, items,
          nextAfterProposalId: rows.length > items.length ? items.at(-1)?.proposalId ?? null : null });
      });
    },
    queryDecision(raw: BrowserReadDecisionQuery) {
      return operation(false, () => { const input = parse(BrowserReadDecisionQuerySchema, raw), found = row(input.workId, input.itemId, input.proposalId);
        return found.decision_request_id === input.requestId ? savedDecision(found).receipt : null; });
    },
    decide(raw: BrowserReadDecisionRequest, at: string) {
      return operation(true, () => {
        const input = parse(BrowserReadDecisionRequestSchema, raw), time = parse(atSchema, at), found = row(input.workId, input.itemId, input.proposalId);
        if (found.decision_request_id === input.requestId) { const saved = savedDecision(found); requireFact(isDeepStrictEqual(saved.request, input)); return saved.receipt; }
        requireFact(found.status === 'waiting' && found.decision_request_id === null);
        const current = snapshot(found);
        if (input.confirmedTarget) requireFact(isDeepStrictEqual(input.confirmedTarget, current.target), 'state_conflict', 'The displayed browser target changed.');
        requireFact(input.decision === 'approve' ? current.canDecide : current.canReject);
        requireFact(!db.query('SELECT id FROM invoice_work_browser_reads WHERE work_id=? AND decision_request_id=?').get(input.workId, input.requestId));
        const work = db.query<{ revision: number }, [number]>("SELECT revision FROM invoice_works WHERE id=? AND status='open'").get(input.workId);
        requireFact(work && work.revision === input.expectedRevision && work.revision < Number.MAX_SAFE_INTEGER);
        const original = owner(found.proposal_tool_call_id, found.work_id, found.item_id, 'browser_request_read', false);
        requireFact(original.owner.item_revision < Number.MAX_SAFE_INTEGER);
        const receipt = BrowserReadDecisionReceiptSchema.parse({ ...input, revision: work.revision + 1, receivedAt: time });
        requireFact(db.query("UPDATE invoice_works SET revision=?,updated_at=? WHERE id=? AND revision=? AND status='open'")
          .run(receipt.revision, time, input.workId, input.expectedRevision).changes === 1);
        requireFact(db.query("UPDATE invoice_work_items SET revision=revision+1,updated_at=? WHERE work_id=? AND id=? AND revision=? AND disposition='unresolved'")
          .run(time, input.workId, input.itemId, original.owner.item_revision).changes === 1);
        requireFact(db.query(`UPDATE invoice_work_browser_reads SET status=?,decision_request_id=?,decision_request_json=?,
          decision_receipt_json=?,updated_at=? WHERE id=? AND status='waiting'`).run(input.decision === 'approve' ? 'approved' : 'rejected',
          input.requestId, JSON.stringify(input), JSON.stringify(receipt), time, found.id).changes === 1);
        return receipt;
      });
    },
    claim(raw: { workId: number; itemId: number; proposalId: number; executionToolCallId: number; at: string }): Result<BrowserReadView> {
      return operation(true, () => {
        const input = parse(z.object({ workId: id, itemId: id, proposalId: id, executionToolCallId: id, at: atSchema }).strict(), raw);
        const found = row(input.workId, input.itemId, input.proposalId);
        requireFact(found.status === 'approved' && found.execution_tool_call_id === null);
        const decision = savedDecision(found);
        requireFact(decision.request.decision === 'approve', 'storage_corrupt', 'The original browser read was not approved.');
        const execution = owner(input.executionToolCallId, input.workId, input.itemId, 'browser_read_approved', true);
        requireFact(execution.owner.item_revision === found.item_revision + 1, 'browser_item_changed', 'The invoice changed after approval.');
        requireFact(desktopActionContinuationAuthorized(db, input.workId, execution.owner.attempt_id, decision.receipt.revision),
          'tool_access_denied', 'The browser approval has no explicit continuation for this attempt.');
        const phase = db.query<{ basis_json: string }, [number]>('SELECT basis_json FROM invoice_work_phases WHERE id=?').get(execution.owner.phase_id);
        requireFact(phase && InvoiceWorkPhaseBasisSchema.parse(JSON.parse(phase.basis_json)).browserProposalId === found.id,
          'tool_access_denied', 'The browser approval is not part of the original execution phase.');
        const args = BrowserToolInputSchema.parse(execution.call.args.final);
        requireFact(isDeepStrictEqual(execution.call.args.raw, args));
        requireFact(db.query("UPDATE invoice_work_browser_reads SET status='claimed',execution_tool_call_id=?,updated_at=? WHERE id=? AND status='approved'")
          .run(input.executionToolCallId, input.at, found.id).changes === 1);
        return snapshot(row(input.workId, input.itemId, input.proposalId));
      });
    },
    revoke(raw: { workId: number; itemId: number; proposalId: number; at: string }): Result<BrowserReadView> {
      return operation(true, () => {
        const input = parse(z.object({ workId: id, itemId: id, proposalId: id, at: atSchema }).strict(), raw);
        const found = row(input.workId, input.itemId, input.proposalId);
        if (['invalidated', 'unknown', 'revoked'].includes(found.status)) return snapshot(found);
        requireFact(['waiting', 'approved', 'claimed', 'completed'].includes(found.status));
        let status = 'invalidated';
        if (found.status === 'claimed') status = 'unknown';
        else if (found.status === 'completed') status = 'revoked';
        requireFact(db.query('UPDATE invoice_work_browser_reads SET status=?,updated_at=? WHERE id=? AND status=?')
          .run(status, input.at, found.id, found.status).changes === 1);
        return snapshot(row(input.workId, input.itemId, input.proposalId));
      });
    },
    revokeWork(raw: { workId: number; itemId?: number; at: string }): Result<void> {
      return operation(true, () => {
        const input = parse(z.object({ workId: id, itemId: id.optional(), at: atSchema }).strict(), raw);
        db.query(`UPDATE invoice_work_browser_reads SET status=CASE
          WHEN status='claimed' THEN 'unknown' WHEN status='completed' THEN 'revoked' ELSE 'invalidated' END,updated_at=?
          WHERE work_id=? AND (? IS NULL OR item_id=?) AND status IN ('waiting','approved','claimed','completed')`)
          .run(input.at, input.workId, input.itemId ?? null, input.itemId ?? null);
      });
    },
    accept(raw: { workId: number; itemId: number; proposalId: number; executionToolCallId: number; page: z.infer<typeof BrowserPageSchema>; at: string }): Result<BrowserReadView> {
      return operation(true, () => {
        const input = parse(z.object({ workId: id, itemId: id, proposalId: id, executionToolCallId: id, page: BrowserPageSchema, at: atSchema }).strict(), raw);
        const found = row(input.workId, input.itemId, input.proposalId);
        requireFact(found.status === 'claimed' && found.execution_tool_call_id === input.executionToolCallId);
        const execution = owner(input.executionToolCallId, input.workId, input.itemId, 'browser_read_approved', true);
        const decision = savedDecision(found), target = BrowserTargetSchema.parse(JSON.parse(found.target_json));
        requireFact(decision.request.decision === 'approve' && isDeepStrictEqual(decision.request.confirmedTarget, target)
          && new URL(input.page.url).origin === target.origin && execution.owner.item_revision === found.item_revision + 1,
        'tool_access_denied', 'The browser result no longer matches its approval.');
        requireFact(desktopActionContinuationAuthorized(db, input.workId, execution.owner.attempt_id, decision.receipt.revision),
          'tool_access_denied', 'The browser continuation is unavailable.');
        const phase = db.query<{ basis_json: string }, [number]>('SELECT basis_json FROM invoice_work_phases WHERE id=?').get(execution.owner.phase_id);
        requireFact(phase && InvoiceWorkPhaseBasisSchema.parse(JSON.parse(phase.basis_json)).browserProposalId === found.id,
          'tool_access_denied', 'The browser result belongs to another phase.');
        requireFact(db.query("UPDATE invoice_work_browser_reads SET status='completed',updated_at=? WHERE id=? AND status='claimed'")
          .run(input.at, found.id).changes === 1);
        return snapshot(row(input.workId, input.itemId, input.proposalId));
      });
    },
    verifyDelivery(raw: { workId: number; itemId: number; proposalId: number; executionToolCallId: number }): Result<void> {
      return operation(false, () => {
        const input = parse(z.object({ workId: id, itemId: id, proposalId: id, executionToolCallId: id }).strict(), raw);
        const found = row(input.workId, input.itemId, input.proposalId);
        requireFact(found.status === 'completed' && found.execution_tool_call_id === input.executionToolCallId,
          'tool_access_denied', 'The browser read is no longer authorized for delivery.');
        const execution = owner(input.executionToolCallId, input.workId, input.itemId, 'browser_read_approved', false);
        requireFact(execution.call.status === 'succeeded' && execution.call.result?.status === 'succeeded',
          'tool_access_denied', 'The browser result is unavailable.');
        const page = BrowserPageSchema.parse(execution.call.result.data);
        const target = BrowserTargetSchema.parse(JSON.parse(found.target_json)), decision = savedDecision(found);
        const phase = db.query<{ basis_json: string }, [number]>('SELECT basis_json FROM invoice_work_phases WHERE id=?').get(execution.owner.phase_id);
        requireFact(decision.request.decision === 'approve' && isDeepStrictEqual(decision.request.confirmedTarget, target)
          && new URL(page.url).origin === target.origin && execution.owner.item_revision === found.item_revision + 1
          && phase && InvoiceWorkPhaseBasisSchema.parse(JSON.parse(phase.basis_json)).browserProposalId === found.id
          && desktopActionContinuationAuthorized(db, input.workId, execution.owner.attempt_id, decision.receipt.revision),
        'tool_access_denied', 'The browser result no longer matches its approval.');
      });
    },
  };
}
export type InvoiceWorkBrowserReadRepository = ReturnType<typeof createInvoiceWorkBrowserReadRepository>;
