import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, DurableRunConfigSnapshotSchema, DurableRunScopeSchema, DurableSubagentRunScopeSchema,
  DurableSubagentConfigSnapshotSchema, DurableWorkBudgetSchema, INVOICE_REVIEW_TOOL_NAMES, SKILL_RESOURCE_TOOL_NAMES, PERSONAL_DESKTOP_TOOL_NAMES, PERSONAL_INVOICE_FORM_TOOL_NAMES, PERSONAL_BROWSER_TOOL_NAMES,
  InvoiceWorkPhaseBasisSchema, InvoiceWorkWorkingContextSchema, PersonalAgentConfigurationSchema, RunScopeSchema,
  BrowserReadDecisionRequestSchema, BrowserReadDecisionReceiptSchema, DesktopActionDecisionRequestSchema, DesktopActionDecisionReceiptSchema,
  InvoiceWorkSupplementRequestSchema, InvoiceWorkSupplementReceiptSchema, InvoiceWorkContinueReceiptSchema,
  type AppError, type DocumentRef, type InvoiceWorkWorkingContext, type ProductToolContext, type Result, type RunScope, type ToolResult } from '@flowmate/contracts';
import type { DurableProductToolCall, DurableProductToolFeedback } from '../../../contracts/src/durable-runtime.ts';
import type { DurableChildToolOwner, DurableProductToolExecution } from '../../../contracts/src/durable-subagents.ts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';
import { inspectApprovalWaitInStore } from './approval-wait.ts';

export type InvoiceWorkToolIdentity = { runId: number; sessionId: number; workId: number; itemId?: number; attemptId: number; requestId: string;
  child?: DurableChildToolOwner };
export type InvoiceWorkToolScope = { scope: RunScope; jobId: number; documentRef: DocumentRef; workingDirectory: string | null };
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const childOwnerSchema = z.object({ childRunId: id, childSessionId: id, originToolCallId: id }).strict();
const identitySchema = z.object({ runId: id, sessionId: id, workId: id, itemId: id.optional(), attemptId: id, requestId: z.string().min(1).max(128),
  child: childOwnerSchema.optional() }).strict();
class ToolScopeFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function requireFact(value: unknown, code = 'tool_access_denied', message = 'The invoice tool does not belong to its original active phase.'): asserts value {
  if (!value) throw new ToolScopeFault(appError(code, code === 'storage_corrupt' ? 'storage' : 'runtime', message));
}

/** Pending authorized input can advance an active invoice without rewriting its original model payload. */
export function invoiceWorkPhaseItemProgress(db: SynchronousDatabaseExecutor, context: InvoiceWorkWorkingContext,
  current: { revision: number; latestInputId: number | null; candidateId: number | null; jobId: number | null }) {
  const unavailable = { current: false, readable: false }, original = context.item;
  if (current.jobId !== original.jobId || context.phase.basis.itemRevision !== original.revision) return unavailable;
  const writes = current.jobId === null ? { count: 0, latest_id: null } : db.query<{ count: number; latest_id: number | null }, [number, number]>(
    `SELECT COUNT(*) count,MAX(c.id) latest_id FROM invoice_candidates c JOIN invoice_work_tool_calls t ON t.tool_call_id=c.tool_call_id
     WHERE t.phase_id=? AND c.job_id=? AND c.origin='model'`).get(context.phase.phaseId, current.jobId);
  if (!writes || current.candidateId !== (writes.count > 0 ? writes.latest_id : original.candidateRef?.id ?? null)) return unavailable;
  let decisionsCount = 0;
  if (context.phase.basis.executionMode === 'item-lane-approval-v1') {
    const decisions = db.query<{ kind: 'browser' | 'desktop'; id: number; item_revision: number; status: string;
      decision_request_id: string | null; decision_request_json: string | null; decision_receipt_json: string | null }, [number, number]>(`
      SELECT 'browser' kind,a.id,a.item_revision,a.status,a.decision_request_id,a.decision_request_json,a.decision_receipt_json
        FROM invoice_work_browser_reads a JOIN invoice_work_tool_calls b ON b.tool_call_id=a.proposal_tool_call_id WHERE b.phase_id=?
      UNION ALL SELECT 'desktop' kind,a.id,a.item_revision,a.status,a.decision_request_id,a.decision_request_json,a.decision_receipt_json
        FROM invoice_work_desktop_actions a JOIN invoice_work_tool_calls b ON b.tool_call_id=a.proposal_tool_call_id WHERE b.phase_id=?`)
      .all(context.phase.phaseId, context.phase.phaseId);
    const revisions: number[] = [];
    for (const decision of decisions) {
      if (decision.decision_request_id === null) {
        if (decision.decision_request_json !== null || decision.decision_receipt_json !== null) return unavailable;
        continue;
      }
      if (!decision.decision_request_json || !decision.decision_receipt_json || decision.item_revision < original.revision
        || decision.item_revision >= current.revision || revisions.includes(decision.item_revision)
        || !['approved', 'rejected', 'claimed', 'dispatched', 'completed'].includes(decision.status)) return unavailable;
      const request = (decision.kind === 'browser' ? BrowserReadDecisionRequestSchema : DesktopActionDecisionRequestSchema)
        .parse(JSON.parse(decision.decision_request_json));
      const receipt = (decision.kind === 'browser' ? BrowserReadDecisionReceiptSchema : DesktopActionDecisionReceiptSchema)
        .parse(JSON.parse(decision.decision_receipt_json));
      const { revision: receiptRevision, receivedAt: _receivedAt, ...receivedRequest } = receipt;
      if (request.workId !== context.work.workId || request.itemId !== original.itemId || request.proposalId !== decision.id
        || request.requestId !== decision.decision_request_id || receiptRevision !== request.expectedRevision + 1
        || !isDeepStrictEqual(request, receivedRequest)
        || request.decision !== (decision.status === 'rejected' ? 'reject' : 'approve')) return unavailable;
      revisions.push(decision.item_revision); decisionsCount++;
    }
  }
  const revision = original.revision + writes.count + decisionsCount;
  if (current.revision === revision && current.latestInputId === original.latestInputId) return { current: true, readable: true };
  const pending = db.query<{ id: number; todo_id: number; request_id: string; text: string; materials_json: string;
    operation_id: number | null; request_json: string | null; receipt_json: string | null; consumed: number }, [number, number, number]>(
    `SELECT i.id,i.todo_id,i.request_id,i.text,i.materials_json,o.id operation_id,o.request_json,o.receipt_json,
       EXISTS (SELECT 1 FROM invoice_work_phases p,json_each(p.basis_json,'$.inputIds') consumed
         WHERE p.work_id=i.work_id AND p.consumed_at IS NOT NULL AND consumed.value=i.id) consumed
     FROM invoice_work_inputs i LEFT JOIN invoice_work_operations o ON o.work_id=i.work_id AND o.kind='supplement' AND o.request_id=i.request_id
     WHERE i.work_id=? AND i.item_id=? AND i.id>? ORDER BY i.id`).all(context.work.workId, original.itemId, original.latestInputId ?? 0);
  if (pending.length === 0 || current.revision !== revision + pending.length || current.latestInputId !== pending.at(-1)!.id) return unavailable;
  for (const input of pending) {
    if (input.consumed !== 0 || input.operation_id === null || input.request_json === null || input.receipt_json === null) return unavailable;
    const request = InvoiceWorkSupplementRequestSchema.parse(JSON.parse(input.request_json));
    const receipt = InvoiceWorkSupplementReceiptSchema.parse(JSON.parse(input.receipt_json));
    if (request.workId !== context.work.workId || request.itemId !== original.itemId || request.todoId !== input.todo_id
      || request.requestId !== input.request_id || request.text !== input.text || !isDeepStrictEqual(request.materials, JSON.parse(input.materials_json))
      || receipt.workId !== request.workId || receipt.itemId !== request.itemId || receipt.todoId !== request.todoId
      || receipt.requestId !== request.requestId || receipt.inputId !== input.id) return unavailable;
    if (receipt.execution.authorizationAccepted && receipt.execution.attempt.attemptId === context.phase.attemptId) continue;
    const continued = db.query<{ receipt_json: string }, [number, number]>(
      "SELECT receipt_json FROM invoice_work_operations WHERE work_id=? AND kind='continueWork' AND id>? ORDER BY id")
      .all(context.work.workId, input.operation_id).some(row => {
        const continuation = InvoiceWorkContinueReceiptSchema.parse(JSON.parse(row.receipt_json));
        return continuation.workId === context.work.workId && continuation.revision > receipt.revision
          && continuation.execution.authorizationAccepted && continuation.execution.attempt.attemptId === context.phase.attemptId;
      });
    if (!continued) return unavailable;
  }
  return { current: false, readable: true };
}

/** A root Durable Run stays scope 4 and job NULL; only this saved phase exposes a single-invoice scope 2. */
export function resolveInvoiceWorkToolScope(db: SynchronousDatabaseExecutor, raw: InvoiceWorkToolIdentity): Result<InvoiceWorkToolScope> {
  try {
    const input = identitySchema.parse(raw);
    const row = db.query(`SELECT p.id phase_id,p.item_id,p.basis_json,p.closed_at,c.context_json,
      w.configuration_json,w.agent_revision,w.status work_status,w.current_attempt_id,
      a.stop_requested_at,a.stopped_at,r.scope_json,r.config_json,r.status run_status,r.cancel_requested_at,
      s.status session_status,s.metadata_json,s.durable_runtime_id,i.job_id,i.document_id,i.document_version,i.disposition,
      i.revision item_revision,i.latest_input_id,i.candidate_id,
      j.status job_status,j.input_json job_input_json,j.document_id job_document_id,j.hidden_at job_hidden_at
      FROM invoice_work_phases p JOIN invoice_works w ON w.id=p.work_id
      JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=w.id
      JOIN runs r ON r.id=a.run_id AND r.session_id=w.session_id AND r.kind='agent' AND r.job_id IS NULL
      JOIN sessions s ON s.id=w.session_id AND s.runtime_kind='durable'
      JOIN invoice_work_items i ON i.id=p.item_id AND i.work_id=w.id JOIN jobs j ON j.id=i.job_id
      JOIN invoice_work_context_snapshots c ON c.phase_id=p.id AND c.work_id=w.id AND c.attempt_id=a.id AND c.item_id=i.id AND c.session_id=s.id
      WHERE w.id=? AND a.id=? AND p.request_id=? AND r.id=? AND s.id=?`)
      .get(input.workId, input.attemptId, input.requestId, input.runId, input.sessionId) as {
        phase_id: number; item_id: number; basis_json: string; closed_at: string | null; context_json: string;
        configuration_json: string; agent_revision: number; work_status: string; current_attempt_id: number;
        stop_requested_at: string | null; stopped_at: string | null; scope_json: string; config_json: string;
        run_status: string; cancel_requested_at: string | null; session_status: string; metadata_json: string; durable_runtime_id: string;
        job_id: number; document_id: number; document_version: string; disposition: string; job_status: string;
        item_revision: number; latest_input_id: number | null; candidate_id: number | null;
        job_input_json: string; job_document_id: number; job_hidden_at: string | null;
      } | null;
    requireFact(row);
    requireFact(row.work_status === 'open' && row.current_attempt_id === input.attemptId && row.closed_at === null
      && row.run_status === 'running' && row.session_status === 'active' && row.disposition === 'unresolved'
      && row.job_hidden_at === null && ['pending', 'running', 'waiting'].includes(row.job_status), 'run_state_invalid');
    requireFact(row.stop_requested_at === null && row.stopped_at === null && row.cancel_requested_at === null, 'agent_cancelled');
    const metadata = z.object({ model_use_blocked: z.unknown().nullable(), delete_pending: z.literal(true).optional() }).passthrough()
      .parse(JSON.parse(row.metadata_json));
    requireFact(metadata.model_use_blocked === null && !metadata.delete_pending, 'session_scope_revoked');
    const jobInput = z.object({ version: z.literal(2), workId: id, itemId: id }).passthrough().parse(JSON.parse(row.job_input_json));
    requireFact(jobInput.workId === input.workId && jobInput.itemId === row.item_id && row.job_document_id === row.document_id);
    const scope = DurableRunScopeSchema.parse(JSON.parse(row.scope_json)), config = DurableRunConfigSnapshotSchema.parse(JSON.parse(row.config_json));
    const workConfig = PersonalAgentConfigurationSchema.parse(JSON.parse(row.configuration_json));
    const basis = InvoiceWorkPhaseBasisSchema.parse(JSON.parse(row.basis_json));
    requireFact(input.itemId === undefined || basis.executionMode === 'item-lane-approval-v1' && input.itemId === row.item_id);
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(row.context_json));
    requireFact(scope.workId === input.workId && scope.attemptId === input.attemptId
      && config.durable.workId === input.workId && config.durable.attemptId === input.attemptId
      && config.durable.configurationRevision === row.agent_revision && basis.configurationRevision === row.agent_revision
      && isDeepStrictEqual(basis, context.phase.basis) && context.work.workId === input.workId && context.work.sessionId === input.sessionId
      && context.phase.phaseId === row.phase_id && context.phase.attemptId === input.attemptId && context.phase.requestId === input.requestId
      && context.item.workId === input.workId && context.item.itemId === row.item_id && context.item.jobId === row.job_id
      && context.item.documentRef.id === row.document_id && context.item.documentRef.version === row.document_version);
    requireFact(invoiceWorkPhaseItemProgress(db, context, { revision: row.item_revision, latestInputId: row.latest_input_id,
      candidateId: row.candidate_id, jobId: row.job_id }).readable, 'state_conflict', 'The original invoice phase has unrelated item changes.');
    const allowedArtifactIds: number[] = [];
    for (const ref of basis.documentRefs) {
      const document = db.query('SELECT version,status,hidden_at,original_artifact_id,parsed_artifact_id FROM documents WHERE id=?').get(ref.id) as {
        version: string; status: string; hidden_at: string | null; original_artifact_id: number; parsed_artifact_id: number } | null;
      requireFact(document && document.version === ref.version && document.status === 'available' && document.hidden_at === null, 'input_unavailable');
      requireFact(ref.id === row.document_id
        || context.userInputs.some(value => value.documentRefs.some(material => isDeepStrictEqual(material, ref)))
        || context.historicalInputReferences.some(value => value.content?.documentRefs.some(material => isDeepStrictEqual(material, ref))));
      allowedArtifactIds.push(document.original_artifact_id, document.parsed_artifact_id);
    }
    requireFact(basis.documentRefs.some(ref => ref.id === row.document_id && ref.version === row.document_version));
    let allowedTools = scope.allowedTools.filter((name: string) => workConfig.tools.includes(name) && context.actions.tools.includes(name)
      && (name === 'Agent' || (INVOICE_REVIEW_TOOL_NAMES as readonly string[]).includes(name) || (SKILL_RESOURCE_TOOL_NAMES as readonly string[]).includes(name)
        || !input.child && ((PERSONAL_DESKTOP_TOOL_NAMES as readonly string[]).includes(name) || (PERSONAL_BROWSER_TOOL_NAMES as readonly string[]).includes(name)
          || row.durable_runtime_id === 'local' && (PERSONAL_INVOICE_FORM_TOOL_NAMES as readonly string[]).includes(name))));
    let allowedDocumentIds = basis.documentRefs.map(ref => ref.id), artifacts = [...new Set(allowedArtifactIds)], allowedResourcePaths: string[] = [];
    if (input.child) {
      const child = db.query<{ scope_json: string; config_json: string; status: string; cancel_requested_at: string | null;
        stopped_at: string | null; session_status: string; metadata_json: string }, [number, number, number, number]>(`SELECT r.scope_json,r.config_json,r.status,
        r.cancel_requested_at,r.stopped_at,s.status session_status,s.metadata_json FROM runs r JOIN sessions s ON s.id=r.session_id
        WHERE r.id=? AND r.session_id=? AND r.parent_run_id=? AND r.origin_tool_call_id=? AND r.kind='subagent' AND s.runtime_kind='durable'`)
        .get(input.child.childRunId, input.child.childSessionId, input.runId, input.child.originToolCallId);
      requireFact(child && child.status === 'running' && child.cancel_requested_at === null && child.stopped_at === null
        && child.session_status === 'active', 'run_state_invalid');
      const childMetadata = z.object({ model_use_blocked: z.unknown().nullable(), delete_pending: z.literal(true).optional() }).passthrough()
        .parse(JSON.parse(child.metadata_json));
      requireFact(childMetadata.model_use_blocked === null && !childMetadata.delete_pending, 'session_scope_revoked');
      const childScope = DurableSubagentRunScopeSchema.parse(JSON.parse(child.scope_json));
      const childConfig = DurableSubagentConfigSnapshotSchema.parse(JSON.parse(child.config_json));
      requireFact(childScope.parentRunId === input.runId && childScope.originToolCallId === input.child.originToolCallId
        && childScope.workId === input.workId && childScope.attemptId === input.attemptId && childScope.phaseId === row.phase_id
        && childScope.itemId === row.item_id && childScope.parentRequestId === input.requestId
        && isDeepStrictEqual(childConfig.subagent, { parentRunId: childScope.parentRunId, originToolCallId: childScope.originToolCallId,
          phaseId: childScope.phaseId, itemId: childScope.itemId, parentRequestId: childScope.parentRequestId, role: childScope.role })
        && childConfig.durable.workId === input.workId && childConfig.durable.attemptId === input.attemptId);
      requireFact(childScope.allowedTools.every((name: string) => name !== 'Agent' && allowedTools.includes(name))
        && childScope.allowedDocumentIds.every((value: number) => allowedDocumentIds.includes(value))
        && childScope.allowedArtifactIds.every((value: number) => artifacts.includes(value))
        && childScope.allowedResourcePaths.every((value: string) => allowedResourcePaths.includes(value)));
      allowedTools = [...childScope.allowedTools]; allowedDocumentIds = [...childScope.allowedDocumentIds];
      artifacts = [...childScope.allowedArtifactIds]; allowedResourcePaths = [...childScope.allowedResourcePaths];
    }
    return ok({ scope: RunScopeSchema.parse({ version: 2, allowedTools, allowedDocumentIds,
      allowedArtifactIds: artifacts, allowedResourcePaths,
      invoiceWork: { workId: input.workId, attemptId: input.attemptId, phaseId: row.phase_id, itemId: row.item_id } }),
    jobId: row.job_id, documentRef: { id: row.document_id, version: row.document_version }, workingDirectory: config.workingDirectory });
  } catch (error) {
    return fail(error instanceof ToolScopeFault ? error.fact : appError('storage_corrupt', 'storage', 'The original invoice phase scope could not be verified.'));
  }
}

export function verifyInvoiceWorkToolScope(db: SynchronousDatabaseExecutor, context: ProductToolContext): Result<InvoiceWorkToolScope> {
  try {
    const phase = context.scope.invoiceWork;
    if (!phase) return fail(appError('tool_access_denied', 'runtime', 'The Durable tool has no original invoice phase.'));
    const row = db.query<{ request_id: string }, [number, number, number, number]>(
      'SELECT request_id FROM invoice_work_phases WHERE id=? AND work_id=? AND attempt_id=? AND item_id=?')
      .get(phase.phaseId, phase.workId, phase.attemptId, phase.itemId);
    if (!row) return fail(appError('tool_access_denied', 'runtime', 'The original invoice phase does not exist.'));
    const owner = db.query<{ parent_run_id: number | null; parent_session_id: number | null; origin_tool_call_id: number | null }, [number]>(
      `SELECT r.parent_run_id,p.session_id parent_session_id,r.origin_tool_call_id FROM runs r LEFT JOIN runs p ON p.id=r.parent_run_id WHERE r.id=?`).get(context.runId);
    requireFact(owner);
    const resolved = resolveInvoiceWorkToolScope(db, { runId: owner.parent_run_id ?? context.runId,
      sessionId: owner.parent_session_id ?? context.sessionId, workId: phase.workId, attemptId: phase.attemptId, requestId: row.request_id,
      ...(owner.parent_run_id === null ? {} : { child: { childRunId: context.runId, childSessionId: context.sessionId, originToolCallId: owner.origin_tool_call_id! } }) });
    return !resolved.ok || isDeepStrictEqual(resolved.data.scope, context.scope) ? resolved
      : fail(appError('tool_access_denied', 'runtime', 'The tool scope differs from its original invoice phase.'));
  } catch { return fail(appError('storage_corrupt', 'storage', 'The original invoice tool scope is unavailable.')); }
}

/** Recheck inside the candidate commit transaction; a pending clarification belongs to its later phase. */
export function verifyInvoiceWorkCandidateScope(db: SynchronousDatabaseExecutor, context: ProductToolContext): Result<InvoiceWorkToolScope> {
  const verified = verifyInvoiceWorkToolScope(db, context);
  if (!verified.ok) return verified;
  try {
    const row = db.query<{ context_json: string; revision: number; latest_input_id: number | null;
      candidate_id: number | null; job_id: number | null }, [number]>(
      `SELECT c.context_json,i.revision,i.latest_input_id,i.candidate_id,i.job_id FROM invoice_work_context_snapshots c
       JOIN invoice_work_items i ON i.id=c.item_id AND i.work_id=c.work_id WHERE c.phase_id=?`).get(context.scope.invoiceWork!.phaseId);
    requireFact(row, 'storage_corrupt');
    const original = InvoiceWorkWorkingContextSchema.parse(JSON.parse(row.context_json));
    requireFact(invoiceWorkPhaseItemProgress(db, original, { revision: row.revision, latestInputId: row.latest_input_id,
      candidateId: row.candidate_id, jobId: row.job_id }).current, 'state_conflict', 'New invoice input cannot be overwritten by its previous phase.');
    return verified;
  } catch (error) {
    return fail(error instanceof ToolScopeFault ? error.fact : appError('storage_corrupt', 'storage', 'The current invoice candidate basis could not be verified.'));
  }
}

const nativeCallSchema = identitySchema.omit({ runId: true }).extend({ itemId: id.optional(), nativeConversationId: id, nativeTaskId: id,
  nativeToolCallId: z.string().min(1).max(256), name: z.string().min(1).max(128), arguments: z.unknown(), parentNativeTaskId: id.optional() }).strict();
const productCallId = (input: DurableProductToolCall) => `durable-task:${input.nativeTaskId}`;
function originalPhase(db: SynchronousDatabaseExecutor, input: DurableProductToolCall) {
  nativeCallSchema.parse(input);
    const row = db.query<{ run_id: number; phase_id: number; native_conversation_id: number; item_id: number | null;
      scheduler_state: string; durable_conversation_id: number | null }, [number, number, number, string]>(`SELECT a.run_id,p.id phase_id,p.native_conversation_id,
      p.item_id,p.scheduler_state,s.durable_conversation_id
    FROM invoice_work_phases p JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=p.work_id
    JOIN invoice_works w ON w.id=p.work_id JOIN sessions s ON s.id=w.session_id
    JOIN runs r ON r.id=a.run_id AND r.session_id=s.id AND s.runtime_kind='durable'
    WHERE p.work_id=? AND p.attempt_id=? AND w.session_id=? AND p.request_id=?
      AND p.native_conversation_id IS NOT NULL AND p.native_submission_id IS NOT NULL`)
    .get(input.workId, input.attemptId, input.sessionId, input.requestId);
  requireFact(row && (row.scheduler_state === 'legacy' ? input.itemId === undefined && row.native_conversation_id === row.durable_conversation_id
    : row.item_id !== null && row.item_id === input.itemId));
  if (row.scheduler_state !== 'legacy' && (input.name === 'desktop_execute_approved' || input.name === 'browser_read_approved')) {
    requireFact(input.parentNativeTaskId !== undefined && !input.child && row.scheduler_state === 'active');
    const browser = input.name === 'browser_read_approved';
    const parent = db.query<{ proposal_id: number; status: string }, [number, number, string]>(`SELECT approval.id proposal_id,approval.status
      FROM invoice_work_tool_calls binding JOIN tool_calls parent ON parent.id=binding.tool_call_id
      JOIN ${browser ? 'invoice_work_browser_reads' : 'invoice_work_desktop_actions'} approval ON approval.proposal_tool_call_id=parent.id
      WHERE binding.phase_id=? AND parent.run_id=? AND parent.native_tool_call_id=? AND parent.status='succeeded'`)
      .get(row.phase_id, row.run_id, `durable-task:${input.parentNativeTaskId}`);
    requireFact(parent && ['approved', 'claimed', 'completed', 'dispatched', 'unknown', 'revoked'].includes(parent.status)
      && isDeepStrictEqual(input.arguments, browser ? {} : { proposalId: parent.proposal_id }));
  } else requireFact(input.parentNativeTaskId === undefined);
  if (!input.child) { requireFact(row.native_conversation_id === input.nativeConversationId); return { ...row, parent_run_id: row.run_id, session_id: input.sessionId }; }
  const child = db.query<{ scope_json: string; durable_conversation_id: number | null }, [number, number, number, number]>(`SELECT r.scope_json,s.durable_conversation_id
    FROM runs r JOIN sessions s ON s.id=r.session_id AND s.runtime_kind='durable' WHERE r.kind='subagent'
    AND r.id=? AND r.session_id=? AND r.parent_run_id=? AND r.origin_tool_call_id=?`)
    .get(input.child.childRunId, input.child.childSessionId, row.run_id, input.child.originToolCallId);
  requireFact(child && child.durable_conversation_id === input.nativeConversationId);
  const scope = DurableSubagentRunScopeSchema.parse(JSON.parse(child.scope_json));
  requireFact(scope.workId === input.workId && scope.attemptId === input.attemptId && scope.parentRequestId === input.requestId
    && scope.phaseId === row.phase_id && scope.parentRunId === row.run_id && scope.originToolCallId === input.child.originToolCallId);
  return { ...row, parent_run_id: row.run_id, run_id: input.child.childRunId, session_id: input.child.childSessionId };
}

function readOriginalToolResult(repository: Pick<SqlDatabaseStore['toolCalls'], 'queryCandidateCommit'>,
  call: import('@flowmate/contracts').ToolCallSnapshot | null): Result<ToolResult<unknown> | null> {
  if (!call) return ok(null);
  if (call.toolName === 'personal_fill_invoice_form') {
    const receipt = call.formApplication;
    if (receipt?.outcome === 'applied') return ok({ status: 'succeeded', data: { candidateId: receipt.candidateId,
      candidateSequence: receipt.candidateSequence, applied: true } });
    if (receipt?.outcome === 'unknown' || call.startedAt !== null && !receipt) return ok(null);
  }
  if (call.toolName === 'save_invoice_candidate' && (call.result === null || call.runtimeObservation?.commit === 'unknown')) {
    const committed = repository.queryCandidateCommit({ toolCallId: call.toolCallId, runId: call.runId, sessionId: call.sessionId });
    if (!committed.ok) return committed;
    if (committed.data) return ok({ status: 'succeeded', data: committed.data });
  }
  if (call.runtimeObservation?.commit === 'unknown' || call.result === null) return ok(null);
  const saved = call.result;
  return ok(saved.status === 'succeeded' ? { status: saved.status, data: saved.data }
    : { status: saved.status, error: saved.error, ...(saved.data === undefined ? {} : { data: saved.data }) });
}

function readOriginal(store: SqlDatabaseStore, call: DurableProductToolCall) {
  const phase = originalPhase(store.db, call);
  const original = store.toolCalls.get({ runId: phase.run_id, sessionId: phase.session_id, nativeToolCallId: productCallId(call) });
  if (!original.ok) {
    if (original.error.code === 'tool_call_not_found') return { phase, call: null };
    throw new ToolScopeFault(original.error);
  }
  const binding = store.db.query<{ phase_id: number }, [number]>('SELECT phase_id FROM invoice_work_tool_calls WHERE tool_call_id=?')
    .get(original.data.toolCallId);
  requireFact(binding?.phase_id === phase.phase_id && original.data.toolName === call.name
    && isDeepStrictEqual(original.data.args.raw, call.arguments), 'state_conflict', 'The native task already belongs to a different product tool call.');
  return { phase, call: original.data };
}

export function readInvoiceWorkToolResult(store: SqlDatabaseStore, call: DurableProductToolCall): Result<ToolResult<unknown> | null> {
  try {
    const { phase, call: original } = readOriginal(store, call);
    if (original?.toolName === 'browser_read_approved') {
      if (original.result?.status === 'succeeded') {
        const read = store.db.query<{ id: number; item_id: number }, [number]>(
          'SELECT id,item_id FROM invoice_work_browser_reads WHERE execution_tool_call_id=?').get(original.toolCallId);
        requireFact(read && !call.child, 'tool_access_denied', 'The browser result has no original approval.');
        const scope = resolveInvoiceWorkToolScope(store.db, { runId: phase.parent_run_id, sessionId: call.sessionId,
          workId: call.workId, attemptId: call.attemptId, requestId: call.requestId });
        if (!scope.ok) return scope;
        requireFact(scope.data.scope.invoiceWork?.itemId === read.item_id && scope.data.scope.allowedTools.includes(call.name));
        const verified = store.invoiceWorkBrowserReads.verifyDelivery({ workId: call.workId, itemId: read.item_id,
          proposalId: read.id, executionToolCallId: original.toolCallId });
        if (!verified.ok) return verified;
      } else if (original.result) return ok({ status: original.result.status, error: original.result.error });
    }
    if (original?.toolName === 'desktop_execute_approved') {
      const action = store.db.query<{ status: string }, [number]>('SELECT status FROM invoice_work_desktop_actions WHERE execution_tool_call_id=?')
        .get(original.toolCallId);
      if (action?.status === 'claimed' || action?.status === 'unknown'
        || action?.status === 'dispatched' && original.result?.status !== 'succeeded') return ok(null);
    }
    return readOriginalToolResult(store.toolCalls, original);
  }
  catch (error) { return fail(error instanceof ToolScopeFault ? error.fact : appError('storage_read_failed', 'storage', 'The original product tool receipt is unavailable.', true)); }
}

function approvalFeedback(store: SqlDatabaseStore, call: DurableProductToolCall,
  original: import('@flowmate/contracts').ToolCallSnapshot, historical = false): Result<ToolResult<unknown> | null> {
  try {
    const proposal = original.result?.status === 'succeeded' ? z.object({ proposalId: id }).passthrough().safeParse(original.result.data) : null;
    requireFact(proposal?.success && call.itemId !== undefined);
    const browser = call.name === 'browser_request_read';
    const phase = originalPhase(store.db, call);
    if (historical) {
      const row = store.db.query<{ status: string; decision_request_id: string | null; execution_tool_call_id: number | null }, [number, number]>(
        `SELECT status,decision_request_id,execution_tool_call_id FROM ${browser ? 'invoice_work_browser_reads' : 'invoice_work_desktop_actions'}
         WHERE id=? AND proposal_tool_call_id=?`).get(proposal.data.proposalId, original.toolCallId);
      requireFact(row?.decision_request_id);
      const target = { workId: call.workId, itemId: call.itemId, proposalId: proposal.data.proposalId, requestId: row.decision_request_id };
      const decision = browser ? needToolCall(store.invoiceWorkBrowserReads.queryDecision(target))
        : needToolCall(store.invoiceWorkDesktopActions.queryDecision(target));
      requireFact(decision);
      if (row.status === 'rejected' && decision.decision === 'reject') return ok({ status: 'failed',
        error: appError('approval_rejected', 'runtime', 'The original action was rejected by the user.') });
      requireFact(decision.decision === 'approve' && row.status === (browser ? 'completed' : 'dispatched') && row.execution_tool_call_id !== null);
      const nested = needToolCall(store.toolCalls.getById(row.execution_tool_call_id));
      const binding = store.db.query<{ phase_id: number }, [number]>('SELECT phase_id FROM invoice_work_tool_calls WHERE tool_call_id=?').get(nested.toolCallId);
      requireFact(binding?.phase_id === phase.phase_id && nested.runId === original.runId && nested.sessionId === original.sessionId
        && nested.toolName === (browser ? 'browser_read_approved' : 'desktop_execute_approved') && nested.status === 'succeeded');
      return readOriginalToolResult(store.toolCalls, nested);
    }
    const state = inspectApprovalWaitInStore(store, { workId: call.workId, sessionId: call.sessionId, itemId: call.itemId,
      attemptId: call.attemptId, phaseId: phase.phase_id, requestId: call.requestId, nativeConversationId: call.nativeConversationId,
      nativeTaskId: call.nativeTaskId, proposalId: proposal.data.proposalId, kind: browser ? 'browser' : 'desktop' });
    requireFact(state.scheduling === 'active');
    if (state.status === 'rejected') return ok({ status: 'failed',
      error: appError('approval_rejected', 'runtime', 'The original action was rejected by the user.') });
    requireFact(state.status === 'approved');
    const row = store.db.query<{ execution_tool_call_id: number | null }, [number, number]>(`SELECT execution_tool_call_id
      FROM ${browser ? 'invoice_work_browser_reads' : 'invoice_work_desktop_actions'} WHERE id=? AND proposal_tool_call_id=?`)
      .get(proposal.data.proposalId, original.toolCallId);
    if (!row?.execution_tool_call_id) return ok(null);
    const nested = needToolCall(store.toolCalls.getById(row.execution_tool_call_id));
    const task = /^durable-task:([1-9]\d*)$/.exec(nested.nativeToolCallId);
    requireFact(task && Number.isSafeInteger(Number(task[1])));
    return readInvoiceWorkToolResult(store, { ...call, nativeTaskId: Number(task[1]), parentNativeTaskId: call.nativeTaskId,
      nativeToolCallId: `${call.nativeToolCallId}/approved-execution`, name: browser ? 'browser_read_approved' : 'desktop_execute_approved',
      arguments: nested.args.raw });
  } catch (error) { return fail(error instanceof ToolScopeFault ? error.fact
    : appError('tool_commit_unconfirmed', 'runtime', 'The original approval result is unavailable.', true)); }
}

function needToolCall<T>(value: Result<T>): T { if (!value.ok) throw new ToolScopeFault(value.error); return value.data; }

/** Original product receipts remain readable after a phase closes; execution still needs its live scope. */
export function createInvoiceWorkToolBridge(input: { database: Pick<DbHandle, 'read' | 'transaction'>; executor: ToolExecutor }) {
  async function readToolResult(call: DurableProductToolCall): Promise<Result<ToolResult<unknown> | null>> {
    try {
      return await input.database.read(store => readInvoiceWorkToolResult(store, call));
    } catch (error) { return fail(error instanceof ToolScopeFault ? error.fact : appError('storage_read_failed', 'storage', 'The original product tool receipt is unavailable.', true)); }
  }
  async function executeTool(call: DurableProductToolExecution): Promise<Result<ToolResult<unknown>>> {
    const { signal, nativeDelegate, ...identity } = call;
    try {
      const prior = await readToolResult(identity);
      if (!prior.ok) return prior;
      if (prior.data !== null) return ok(prior.data);
      const prepared = await input.database.transaction(store => {
        const phase = originalPhase(store.db, identity);
        const scope = resolveInvoiceWorkToolScope(store.db, { runId: phase.parent_run_id, sessionId: call.sessionId,
          workId: call.workId, attemptId: call.attemptId, requestId: call.requestId, ...(call.child ? { child: call.child } : {}) });
        if (!scope.ok) return scope;
        const existing = readOriginal(store, identity).call;
        const context = { runId: phase.run_id, sessionId: phase.session_id, scope: scope.data.scope,
          nativeToolCallId: productCallId(call), signal, ...(nativeDelegate ? { nativeDelegate } : {}) };
        if (!existing) {
          const budget = DurableWorkBudgetSchema.parse(JSON.parse(store.db.query<{ budget_json: string }, [number]>(
            'SELECT budget_json FROM invoice_works WHERE id=?').get(call.workId)!.budget_json));
          const used = store.db.query<{ count: number }, [number]>(`WITH RECURSIVE owned(id) AS (
            SELECT run_id FROM invoice_work_attempts WHERE work_id=? AND run_id IS NOT NULL
            UNION SELECT r.id FROM runs r JOIN owned p ON r.parent_run_id=p.id)
            SELECT COUNT(*) count FROM tool_calls t JOIN owned o ON o.id=t.run_id`).get(call.workId)!.count;
          requireFact(used < budget.runtimeBudget.maxToolCalls, 'tool_budget_exceeded', 'The shared Work tool budget is exhausted.');
          const requested = input.executor.observeRequest(call.name, call.arguments, context, store);
          if (!requested.ok) throw new ToolScopeFault(requested.error);
        }
        return ok({ context, resume: existing?.toolName === 'Agent' && existing.status === 'running' });
      });
      if (!prepared.ok) return prepared;
      const result = prepared.data.resume ? await input.executor.resumeDelegation(prepared.data.context)
        : await input.executor.execute(call.name, call.arguments, prepared.data.context);
      if (call.name === 'desktop_execute_approved' || call.name === 'personal_fill_invoice_form' || call.name === 'browser_read_approved') {
        const original = await readToolResult(identity);
        return !original.ok ? original : original.data !== null ? ok(original.data)
          : fail(appError('tool_commit_unconfirmed', 'runtime', 'The original desktop input outcome is unknown.'));
      }
      if (result.call.runtimeObservation?.commit === 'unknown') {
        const committed = await readToolResult(identity);
        return !committed.ok ? committed : committed.data !== null ? ok(committed.data)
          : fail(appError('tool_commit_unconfirmed', 'runtime', 'The original product write outcome is unknown.'));
      }
      if (result.call.result === null) return fail(result.result.status === 'succeeded'
        ? appError('tool_commit_unconfirmed', 'runtime', 'The product tool result is not committed.') : result.result.error);
      const outcome = result.result;
      return ok(outcome.status === 'succeeded' ? { status: outcome.status, data: outcome.data }
        : { status: outcome.status, error: outcome.error, ...(outcome.data === undefined ? {} : { data: outcome.data }) });
    } catch (error) { return fail(error instanceof ToolScopeFault ? error.fact : appError('tool_commit_unconfirmed', 'runtime', 'The original product tool result could not be confirmed.', true)); }
  }
  return { executeTool, readToolResult,
    onToolFeedback: (feedback: DurableProductToolFeedback) => input.database.transaction(store => recordInvoiceWorkToolFeedback(store.db, feedback, store.toolCalls, store)) };
}

export function recordInvoiceWorkToolFeedback(db: SynchronousDatabaseExecutor, input: DurableProductToolFeedback,
  repository: Pick<SqlDatabaseStore['toolCalls'], 'getById' | 'queryCandidateCommit' | 'recordDelivery'>, store?: SqlDatabaseStore): Result<void> {
  try {
    requireFact(db.inTransaction, 'state_conflict', 'Native tool feedback requires the product transaction.');
    return db.transaction(() => {
    const { nativeEntryId, feedbackJson, ...call } = input;
    id.parse(nativeEntryId);
    const phase = originalPhase(db, call);
    const row = db.query<{ tool_call_id: number; tool_name: string; args_json: string;
      feedback_native_entry_id: number | null; feedback_bytes: number | null }, [number, number, string]>(`SELECT b.tool_call_id,t.tool_name,t.args_json,
      b.feedback_native_entry_id,b.feedback_bytes FROM invoice_work_tool_calls b JOIN tool_calls t ON t.id=b.tool_call_id
      WHERE b.phase_id=? AND t.run_id=? AND t.native_tool_call_id=?`).get(phase.phase_id, phase.run_id, productCallId(call));
    requireFact(row && row.tool_name === call.name && isDeepStrictEqual(JSON.parse(row.args_json).raw, call.arguments));
    const message = z.object({ role: z.literal('toolResult'), toolCallId: z.string(), toolName: z.string(), isError: z.boolean(),
      content: z.array(z.unknown()), details: z.unknown() }).passthrough().parse(JSON.parse(feedbackJson));
    requireFact(message.toolCallId === call.nativeToolCallId && message.toolName === call.name);
    const bytes = new TextEncoder().encode(feedbackJson).byteLength;
    requireFact(bytes > 0 && Number.isSafeInteger(bytes));
    if (row.feedback_native_entry_id !== null)
      requireFact(row.feedback_native_entry_id === nativeEntryId && row.feedback_bytes === bytes, 'state_conflict');
    const original = repository.getById(row.tool_call_id);
    if (!original.ok) return original;
    let result: Result<ToolResult<unknown> | null>;
    const savedPhase = db.query<{ basis_json: string }, [number]>('SELECT basis_json FROM invoice_work_phases WHERE id=?').get(phase.phase_id);
    const itemApproval = savedPhase && InvoiceWorkPhaseBasisSchema.parse(JSON.parse(savedPhase.basis_json)).executionMode === 'item-lane-approval-v1'
      && (call.name === 'browser_request_read' || call.name === 'desktop_propose_action');
    if (itemApproval) result = store ? approvalFeedback(store, call, original.data, row.feedback_native_entry_id !== null)
      : fail(appError('tool_access_denied', 'runtime', 'Approval feedback needs its original product owner.'));
    else if (call.name === 'browser_read_approved') result = store ? readInvoiceWorkToolResult(store, call)
      : fail(appError('tool_access_denied', 'runtime', 'Browser feedback needs its original authorization.'));
    else result = readOriginalToolResult(repository, original.data);
    if (!result.ok) return result;
    requireFact(result.data !== null, 'tool_commit_unconfirmed', 'The original product tool result is still unknown.');
    requireFact(message.isError === (result.data.status !== 'succeeded') && isDeepStrictEqual(message.details, result.data), 'tool_invalid_output');
    if (row.feedback_native_entry_id !== null) return ok(undefined);
    db.query('UPDATE invoice_work_tool_calls SET feedback_native_entry_id=?,feedback_bytes=? WHERE tool_call_id=?')
      .run(nativeEntryId, bytes, row.tool_call_id);
    if (original.data.delivery.state === 'not_attempted') {
      const saved = repository.recordDelivery({ toolCallId: row.tool_call_id, delivery: { version: 1, state: 'message_observed',
        messageObservedAt: new Date().toISOString(), includedInCallSequence: null, requestDispatchedAt: null, error: null } });
      if (!saved.ok) throw new ToolScopeFault(saved.error);
    }
    return ok(undefined);
    }).immediate();
  } catch (error) { return fail(error instanceof ToolScopeFault ? error.fact : appError('storage_write_failed', 'storage', 'Native tool feedback could not be recorded.', true)); }
}
