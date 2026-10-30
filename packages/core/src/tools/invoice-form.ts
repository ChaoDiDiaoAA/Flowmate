import { z } from 'zod';
import { appError, fail, FillInvoiceFormOutputSchema, InvoiceFormApplicationReceiptSchema, ok, WorkspaceContextSchema } from '@flowmate/contracts';
import type { AppError, DbId, FillInvoiceFormInput, FillInvoiceFormOutput,
  InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, ProductToolContext, Result, ToolCallContext } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';

export type InvoiceFormBridge = (request: InvoiceFormBridgeRequest, signal: AbortSignal) => Promise<InvoiceFormApplicationReceipt>;
type Dependencies = { database: Pick<DbHandle, 'read' | 'transaction'>; bridge: InvoiceFormBridge; now: () => string };
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const querySchema = z.object({ runId: id, toolCallId: id }).strict();
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw result.error; return result.data; }

export function createInvoiceFormService(dependencies: Dependencies) {
  async function read<T>(operation: (scope: SqlDatabaseStore) => Result<T>): Promise<Result<T>> {
    try { return await dependencies.database.read(operation); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Form application facts could not be read.', true)); }
  }
  async function write<T>(operation: (scope: SqlDatabaseStore) => Result<T>): Promise<Result<T>> {
    try { return await dependencies.database.transaction(operation); }
    catch { return fail(appError('storage_write_failed', 'storage', 'Form application receipt could not be saved.', true)); }
  }
  function unknown(request: InvoiceFormBridgeRequest): InvoiceFormApplicationReceipt {
    return { runId: request.runId, toolCallId: request.toolCallId, candidateId: request.candidateId,
      candidateSequence: request.candidateSequence, formInstanceId: request.target.formInstanceId,
      observedAt: dependencies.now(), outcome: 'unknown' };
  }
  async function record(request: InvoiceFormBridgeRequest, raw: unknown): Promise<Result<InvoiceFormApplicationReceipt>> {
    const parsed = InvoiceFormApplicationReceiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.runId !== request.runId || parsed.data.toolCallId !== request.toolCallId
      || parsed.data.candidateId !== request.candidateId || parsed.data.candidateSequence !== request.candidateSequence
      || parsed.data.formInstanceId !== request.target.formInstanceId) {
      return fail(appError('state_conflict', 'tool', 'The form receipt does not match the original call.'));
    }
    return write(scope => {
      if (parsed.data.outcome === 'unknown') {
        const existing = scope.toolCalls.getById(request.toolCallId);
        if (!existing.ok) return existing;
        if (existing.data.formApplication) return ok(existing.data.formApplication);
      }
      const saved = scope.toolCalls.recordFormApplication({ toolCallId: request.toolCallId, receipt: parsed.data });
      return saved.ok ? ok(saved.data.formApplication!) : saved;
    });
  }
  async function recordUnknown(request: InvoiceFormBridgeRequest): Promise<Result<InvoiceFormApplicationReceipt>> {
    const saved = await record(request, unknown(request));
    if (saved.ok) return saved;
    // A confirmed receipt can win just before local cancellation. Do not regress it.
    const existing = await read(scope => scope.toolCalls.getById(request.toolCallId));
    return existing.ok && existing.data.formApplication ? ok(existing.data.formApplication) : saved;
  }
  async function exchange(request: InvoiceFormBridgeRequest, signal: AbortSignal): Promise<Result<InvoiceFormApplicationReceipt>> {
    if (signal.aborted) return request.operation === 'apply'
      ? record(request, { ...unknown(request), outcome: 'not_applied', reason: 'agent_cancelled' }) : recordUnknown(request);
    let abort!: () => void;
    const cancelled = new Promise<Result<InvoiceFormApplicationReceipt>>(resolve => {
      abort = () => resolve(recordUnknown(request));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      // Keep observing the original promise after the local wait ends. It can only
      // supplement this call's application fact; it cannot repeat the application.
      let pending: Promise<InvoiceFormApplicationReceipt>;
      try { pending = dependencies.bridge(request, signal); }
      catch { return recordUnknown(request); }
      const observation = pending.then(receipt => record(request, receipt), () => recordUnknown(request));
      return await Promise.race([observation, cancelled]);
    } finally { signal.removeEventListener('abort', abort); }
  }
  function eligibility(request: Extract<InvoiceFormBridgeRequest, { operation: 'apply' }>, context: ProductToolContext,
    call: ToolCallContext, scope: SqlDatabaseStore): AppError | null {
    const run = scope.runs.get(request.runId);
    const session = scope.sessions.get(request.sessionId);
    const document = scope.documents.get(request.documentRef.id);
    const job = scope.jobs.get(request.jobId);
    const candidate = scope.candidates.readByJob({ jobId: request.jobId, candidateId: request.candidateId });
    const workspace = scope.workspace.read(dependencies.now());
    for (const result of [run, session, document, job, candidate, workspace]) if (!result.ok) return result.error;
    if (!run.ok || !session.ok || !document.ok || !job.ok || !candidate.ok || !workspace.ok) return appError('storage_read_failed', 'storage', 'Form prerequisites are unreadable.');
    if (call.signal.aborted || run.data.cancelRequestedAt !== null) return appError('agent_cancelled', 'runtime', 'The call was cancelled before form application.');
    if (call.deadlineAt !== undefined && performance.now() >= call.deadlineAt)
      return appError('tool_timeout', 'tool', 'The form application deadline elapsed before dispatch.', true);
    if (run.data.kind !== 'agent' || run.data.status !== 'running' || run.data.sessionId !== context.sessionId
      || run.data.runId !== context.runId || request.nativeToolCallId !== call.nativeToolCallId
      || context.scope.allowedTools.length !== 1 || context.scope.allowedTools[0] !== 'fill_invoice_form'
      || !context.scope.allowedDocumentIds.includes(request.documentRef.id)) return appError('state_conflict', 'tool', 'The original Fill call is not active.');
    const frozen = WorkspaceContextSchema.safeParse(run.data.config.workspaceContext);
    if (!frozen.success || workspace.data.revision !== frozen.data.revision || workspace.data.sessionId !== request.sessionId
      || workspace.data.documentRef?.id !== request.documentRef.id || workspace.data.documentRef.version !== request.documentRef.version
      || workspace.data.jobId !== request.jobId || workspace.data.candidateRef?.id !== request.candidateId
      || workspace.data.candidateRef.sequence !== request.candidateSequence)
      return appError('state_conflict', 'tool', 'The active Workspace no longer matches the frozen Fill target.');
    if (session.data.status !== 'active' || session.data.modelUseBlocked || session.data.nativeUnusable)
      return appError('session_scope_revoked', 'session', 'The Session no longer permits form application.');
    if (document.data.status !== 'available' || document.data.isHidden || document.data.documentRef.version !== request.documentRef.version
      || job.data.status === 'completed' || job.data.currentCandidateId !== request.candidateId
      || candidate.data.candidate.status !== 'generated' || candidate.data.candidate.sequence !== request.candidateSequence)
      return appError('state_conflict', 'tool', 'The selected invoice candidate is no longer eligible.');
    return null;
  }
  return {
    async apply(input: FillInvoiceFormInput, call: ToolCallContext, context: ProductToolContext): Promise<FillInvoiceFormOutput> {
      const candidateId = input.candidateId;
      const prepared = unwrap(await read(scope => {
        const original = scope.toolCalls.get({ runId: context.runId, sessionId: context.sessionId, nativeToolCallId: call.nativeToolCallId });
        if (!original.ok) return original;
        if (original.data.status !== 'running' || original.data.toolName !== 'fill_invoice_form')
          return fail(appError('state_conflict', 'tool', 'Fill requires the actual running ToolCall.'));
        const request = scope.toolCalls.readFormApplicationRequest(original.data.toolCallId);
        if (!request.ok) return request;
        if (candidateId !== request.data.candidateId) return fail(appError('state_conflict', 'tool', 'The candidate differs from the frozen Fill target.'));
        return ok({ original: original.data, request: request.data, denied: eligibility(request.data, context, call, scope) });
      }));
      const { original, request, denied } = prepared;
      if (denied) {
        unwrap(await record(request, { ...unknown(request), outcome: 'not_applied', reason: denied.code }));
        throw denied;
      }
      const receipt = original.formApplication ?? unwrap(await exchange(request, call.signal));
      if (receipt.outcome === 'not_applied') throw appError('form_not_applied', 'tool', 'The form rejected the original application.');
      if (receipt.outcome === 'unknown') throw appError('operation_result_unknown', 'tool', 'The original form application is unknown. Query this call before trying again.');
      return FillInvoiceFormOutputSchema.parse({ candidateId: receipt.candidateId,
        candidateSequence: receipt.candidateSequence, applied: true });
    },
    async query(raw: { runId: DbId; toolCallId: DbId }): Promise<Result<InvoiceFormApplicationReceipt>> {
      const parsed = querySchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Form application query is invalid.'));
      const stored = await read(scope => {
        const original = scope.toolCalls.getById(parsed.data.toolCallId);
        if (!original.ok) return original;
        if (original.data.runId !== parsed.data.runId) return fail(appError('state_conflict', 'tool', 'The ToolCall belongs to another Run.'));
        const request = scope.toolCalls.readFormApplicationRequest(parsed.data.toolCallId);
        return request.ok ? ok({ original: original.data, request: request.data }) : request;
      });
      if (!stored.ok) return stored;
      const { original, request } = stored.data;
      // This is evidence of the past application, not a promise that an in-memory
      // editing copy still exists after its Renderer instance disappears.
      if (original.formApplication && original.formApplication.outcome !== 'unknown') return ok(original.formApplication);
      const { candidate: _candidate, operation: _operation, ...identity } = request;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try { return await exchange({ ...identity, operation: 'query' }, controller.signal); }
      finally { clearTimeout(timer); }
    },
  };
}
export type InvoiceFormService = ReturnType<typeof createInvoiceFormService>;
