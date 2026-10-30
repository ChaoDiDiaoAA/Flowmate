import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, DocumentRefSchema, InvoiceWorkCreateRequestSchema, InvoiceWorkCreateReceiptSchema,
  InvoiceWorkListRequestSchema, InvoiceWorkListResultSchema, InvoiceWorkGetRequestSchema, InvoiceWorkGetResultSchema,
  InvoiceWorkViewSchema, InvoiceWorkItemViewSchema, InvoiceWorkTodoViewSchema, InvoiceWorkOperationReceiptSchema,
  InvoiceWorkQueryOperationRequestSchema, InvoiceWorkContinueRequestSchema, InvoiceWorkCancelRequestSchema,
  InvoiceWorkSupplementRequestSchema, InvoiceWorkSupplementReceiptSchema, InvoiceWorkDispositionDecisionSchema,
  InvoiceWorkDisposeItemRequestSchema, InvoiceWorkDisposeItemReceiptSchema, PersonalAgentConfigurationSchema, RunStatusSchema,
  RUNTIME_CONFIG, RuntimeRequestOverridesSchema, DurableWorkBudgetSchema, InvoiceWorkContextBuildInputSchema,
  InvoiceWorkWorkingContextSchema, invoiceToolSchemas } from '@flowmate/contracts';
import type { AppError, DocumentRef, InvoiceWorkCancelReceipt, InvoiceWorkCancelRequest,
  InvoiceWorkContinueReceipt, InvoiceWorkContinueRequest, InvoiceWorkCreateReceipt, InvoiceWorkCreateRequest,
  InvoiceWorkDisposeItemReceipt, InvoiceWorkDisposeItemRequest, InvoiceWorkGetRequest, InvoiceWorkGetResult,
  InvoiceWorkListRequest, InvoiceWorkListResult, InvoiceWorkOperationReceipt, InvoiceWorkQueryOperationRequest,
  InvoiceWorkSupplementReceipt, InvoiceWorkSupplementRequest, InvoiceWorkTodoView, InvoiceWorkContextBuildInput,
  InvoiceWorkAuthorizedContextInput, DurableAttemptStopResult, DurableSubmissionObservation, JobSnapshot, RuntimeRequestOverrides, Result } from '@flowmate/contracts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';
import { createSessionRepository, createDocumentRepository, createCandidateRepository, createJobRepository } from '../storage/repositories.ts';
import { readTransaction } from '../storage/reads.ts';
import { createPersonalAgentRepository } from './agent-repository.ts';
import { readInvoiceCandidateChildReports } from './candidate-evidence.ts';
import { invoiceWorkPhaseItemProgress } from './tool-scope.ts';
export { createPersonalAgentRepository } from './agent-repository.ts';
export type { PersonalAgentRepository } from './agent-repository.ts';

/** The product service qualifies execution; storage still enforces the original work and stop facts. */
export type InvoiceWorkAdmission = { kind: 'ready' | 'queued' }
  | { kind: 'waiting'; reason: string; todoIds?: readonly number[] }
  | { kind: 'blocked'; reason: AppError };
type CommandOptions = { at: string; admission: InvoiceWorkAdmission };
export type InvoiceWorkTodoDefinition = Omit<InvoiceWorkTodoView, 'todoId' | 'workId' | 'itemId' | 'revision' | 'applicable'>;
export type InvoiceWorkPhaseBasis = { contextSnapshotId: number | null; inputIds: readonly number[];
  documentRefs: readonly DocumentRef[]; configurationRevision: number; itemRevision: number | null };
export type InvoiceWorkPhase = { phaseId: number; workId: number; attemptId: number; itemId: number | null;
  requestId: string; kind: 'prompt'; basis: InvoiceWorkPhaseBasis; createdAt: string;
  nativeConversationId: number | null; nativeSubmissionId: number | null; consumedAt: string | null };
export interface InvoiceWorkRepository {
  create(input: InvoiceWorkCreateRequest, options: CommandOptions & { runtimeDefaults?: RuntimeRequestOverrides }): Result<InvoiceWorkCreateReceipt>;
  list(input: InvoiceWorkListRequest): Result<InvoiceWorkListResult>;
  get(input: InvoiceWorkGetRequest): Result<InvoiceWorkGetResult>;
  queryOperation(input: InvoiceWorkQueryOperationRequest): Result<InvoiceWorkOperationReceipt | null>;
  continueWork(input: InvoiceWorkContinueRequest, options: CommandOptions): Result<InvoiceWorkContinueReceipt>;
  supplement(input: InvoiceWorkSupplementRequest, options: CommandOptions): Result<InvoiceWorkSupplementReceipt>;
  disposeItem(input: InvoiceWorkDisposeItemRequest, options: { at: string }): Result<InvoiceWorkDisposeItemReceipt>;
  cancelWork(input: InvoiceWorkCancelRequest, options: { at: string }): Result<InvoiceWorkCancelReceipt>;
  replaceTodos(input: { workId: number; itemId: number; expectedRevision: number;
    todos: readonly InvoiceWorkTodoDefinition[]; at: string }): Result<readonly InvoiceWorkTodoView[]>;
  freezePhase(input: { workId: number; attemptId: number; itemId: number | null; requestId: string;
    kind: 'prompt'; basis: InvoiceWorkPhaseBasis; at: string }): Result<InvoiceWorkPhase>;
  linkPhase(input: { workId: number; attemptId: number; phaseId: number; nativeConversationId: number;
    nativeSubmissionId: number; at: string }): Result<InvoiceWorkPhase>;
  getPhase(input: { workId: number; attemptId: number; requestId: string }): Result<InvoiceWorkPhase | null>;
  readContextInput(input: { workId: number; attemptId: number; requestId: string;
    remainingBudget: InvoiceWorkContextBuildInput['remainingBudget'] }): Result<InvoiceWorkContextBuildInput>;
  selectPhaseInput(input: { workId: number; attemptId: number; itemId: number }): Result<{ itemId: number; basis: InvoiceWorkPhaseBasis }>;
  recordPhaseObservation(input: { observation: DurableSubmissionObservation; at: string }): Result<InvoiceWorkPhase>;
  closeUnsubmittedPhase(input: { workId: number; attemptId: number; requestId: string;
    stopResult: DurableAttemptStopResult; at: string }): Result<InvoiceWorkPhase>;
  reconcile(input: { workId: number; at: string }): Result<import('@flowmate/contracts').InvoiceWorkView>;
  prepareItemJob(input: { workId: number; itemId: number; expectedRevision: number; at: string }): Result<JobSnapshot>;
}

type WorkRow = { id: number; personal_agent_id: number; session_id: number; agent_revision: number;
  configuration_json: string; budget_json: string; revision: number; goal: string; status: 'open' | 'completed' | 'cancelled';
  source_json: string | null; current_attempt_id: number | null; created_at: string; updated_at: string; ended_at: string | null };
type ItemRow = { id: number; work_id: number; document_id: number; document_version: string; job_id: number | null;
  candidate_id: number | null; candidate_sequence: number | null; revision: number; disposition: 'unresolved' | 'accepted' | 'rejected' | 'excluded';
  decision_json: string | null; disposed_at: string | null; latest_input_id: number | null; updated_at: string };
type AttemptRow = { id: number; work_id: number; previous_attempt_id: number | null; trigger_kind: string;
  trigger_request_id: string; run_id: number | null; created_at: string; stop_requested_at: string | null; stopped_at: string | null };
type PhaseRow = { id: number; work_id: number; attempt_id: number; item_id: number | null; request_id: string; kind: 'prompt';
  basis_json: string; native_conversation_id: number | null; native_submission_id: number | null;
  created_at: string; consumed_at: string | null; closed_at: string | null };
type TodoRow = { id: number; work_id: number; item_id: number; revision: number; definition_json: string;
  created_at: string; superseded_at: string | null };
type InputRow = { id: number; work_id: number; item_id: number; todo_id: number; request_id: string;
  text: string; materials_json: string; created_at: string };
type OperationRow = { personal_agent_id: number; work_id: number; kind: string; request_id: string;
  request_json: string; receipt_json: string };
class WorkFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function requireFact(condition: unknown, code = 'state_conflict', message = 'Invoice work facts have changed.'): asserts condition {
  if (!condition) throw new WorkFault(appError(code,
    code === 'storage_corrupt' || code === 'operation_result_unknown' ? 'storage' : 'input', message));
}
function requireResult<T>(result: Result<T>): T { if (!result.ok) throw new WorkFault(result.error); return result.data; }
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  requireFact(parsed.success, 'input_invalid', 'Invoice work input is invalid.');
  return parsed.data;
}
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const atSchema = z.string().datetime({ offset: true });
const basisSchema = z.object({ contextSnapshotId: id.nullable(), inputIds: z.array(id).refine(ids => new Set(ids).size === ids.length),
  documentRefs: z.array(DocumentRefSchema), configurationRevision: revision, itemRevision: revision.nullable() }).strict();
const phaseInputSchema = z.object({ workId: id, attemptId: id, itemId: id.nullable(), requestId: z.string().min(1).max(128),
  kind: z.literal('prompt'), basis: basisSchema, at: atSchema }).strict();
const observationSchema = z.object({ workId: id, sessionId: id, attemptId: id, requestId: phaseInputSchema.shape.requestId,
  nativeConversationId: id, nativeSubmissionId: id, nativeEntryId: id.nullable(),
  status: z.enum(['queued', 'placed', 'done', 'unanswered']), consumedAt: atSchema.nullable(),
  execution: z.enum(['active', 'closed', 'unknown']) }).strict();
const sourceSnapshotSchema = z.object({ workId: id, items: z.array(z.object({ itemId: id, documentRef: DocumentRefSchema,
  candidateRef: z.object({ id, sequence: id }).strict().nullable(), jobId: id.nullable() }).strict()).min(1) }).strict();

export function createInvoiceWorkRepository(db: SynchronousDatabaseExecutor): InvoiceWorkRepository {
  const sessions = createSessionRepository(db), documents = createDocumentRepository(db), candidates = createCandidateRepository(db),
    jobs = createJobRepository(db);
  const agents = createPersonalAgentRepository(db);
  function operation<T>(write: boolean, action: () => T): Result<T> {
    try {
      if (write) requireFact(db.inTransaction, 'state_conflict', 'Invoice work writes require the product transaction.');
      return ok(write ? db.transaction(action).immediate() : readTransaction(db, action));
    } catch (error) {
      return fail(error instanceof WorkFault ? error.fact : error instanceof z.ZodError || error instanceof SyntaxError
        ? appError('storage_corrupt', 'storage', 'Stored invoice work facts are invalid.')
        : appError(write ? 'storage_write_failed' : 'storage_read_failed', 'storage', 'Invoice work storage is unavailable.', true));
    }
  }
  function agent(agentId: number) {
    requireFact(Number.isSafeInteger(agentId) && agentId === 1, 'personal_agent_not_found', 'Personal Agent does not exist.');
    const found = requireResult(agents.getDefault());
    requireFact(found && found.personalAgentId === agentId, 'personal_agent_not_found', 'Personal Agent does not exist.');
    return found;
  }
  function work(workId: number): WorkRow {
    requireFact(id.safeParse(workId).success, 'input_invalid');
    const row = db.query<WorkRow, [number]>('SELECT * FROM invoice_works WHERE id=?').get(workId);
    requireFact(row, 'invoice_work_not_found', 'Invoice work does not exist.');
    agent(row.personal_agent_id);
    requireFact(revision.safeParse(row.revision).success && ['open', 'completed', 'cancelled'].includes(row.status),
      'storage_corrupt', 'Stored invoice work identity is invalid.');
    PersonalAgentConfigurationSchema.parse(JSON.parse(row.configuration_json));
    DurableWorkBudgetSchema.parse(JSON.parse(row.budget_json));
    if (row.source_json !== null) sourceSnapshotSchema.parse(JSON.parse(row.source_json));
    return row;
  }
  function item(workId: number, itemId: number): ItemRow {
    const row = db.query<ItemRow, [number, number]>('SELECT * FROM invoice_work_items WHERE work_id=? AND id=?').get(workId, itemId);
    requireFact(row, 'invoice_work_item_not_found', 'Invoice work item does not exist.');
    return row;
  }
  function attempt(row: WorkRow): AttemptRow | null {
    if (row.current_attempt_id === null) return null;
    const found = db.query<AttemptRow, [number, number]>('SELECT * FROM invoice_work_attempts WHERE work_id=? AND id=?')
      .get(row.id, row.current_attempt_id);
    requireFact(found, 'storage_corrupt', 'The original execution attempt is unavailable.');
    return found;
  }
  function phase(row: PhaseRow): InvoiceWorkPhase {
    return { phaseId: row.id, workId: row.work_id, attemptId: row.attempt_id, itemId: row.item_id,
      requestId: row.request_id, kind: row.kind, basis: basisSchema.parse(JSON.parse(row.basis_json)), createdAt: row.created_at,
      nativeConversationId: row.native_conversation_id, nativeSubmissionId: row.native_submission_id, consumedAt: row.consumed_at };
  }
  function attemptReference(row: AttemptRow) {
    const linked = db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? AND native_submission_id IS NOT NULL LIMIT 1').get(row.id);
    return { attemptId: row.id, runId: row.run_id, runtimeLinked: linked !== null };
  }
  function runStatus(row: AttemptRow) {
    if (row.run_id === null) return null;
    const run = db.query<{ status: string; session_id: number }, [number]>('SELECT status,session_id FROM runs WHERE id=?').get(row.run_id);
    requireFact(run && run.session_id === work(row.work_id).session_id, 'storage_corrupt');
    return RunStatusSchema.parse(run.status);
  }
  function ownedChildren(row: AttemptRow): number[] {
    if (row.run_id === null) return [];
    const children = db.query<{ id: number }, [number]>(
      "WITH RECURSIVE children(id) AS (SELECT id FROM runs WHERE parent_run_id=? UNION ALL SELECT r.id FROM runs r JOIN children c ON r.parent_run_id=c.id) SELECT r.id FROM runs r JOIN children c ON r.id=c.id WHERE r.status IN ('created','running') OR r.stopped_at IS NULL OR COALESCE(json_extract(r.cleanup_json,'$.stopped'),0)!=1 ORDER BY r.id")
      .all(row.run_id).map(child => child.id);
    requireFact(children.length <= 4, 'storage_corrupt', 'The attempt owns excess child execution capacity.');
    return children;
  }
  function itemView(row: ItemRow): import('@flowmate/contracts').InvoiceWorkItemView {
    const count = db.query<TodoRow, [number]>(
      'SELECT * FROM invoice_work_todos WHERE item_id=? AND superseded_at IS NULL').all(row.id)
      .filter(todo => todoView(todo).applicable).length;
    return InvoiceWorkItemViewSchema.parse({ workId: row.work_id, itemId: row.id, revision: row.revision,
      documentRef: { id: row.document_id, version: row.document_version }, jobId: row.job_id,
      candidateRef: row.candidate_id === null ? null : { id: row.candidate_id, sequence: row.candidate_sequence },
      disposition: row.disposition, decision: row.decision_json === null ? null : JSON.parse(row.decision_json),
      disposedAt: row.disposed_at, todoCount: row.disposition === 'unresolved' && work(row.work_id).status === 'open' ? count : 0,
      latestInputId: row.latest_input_id, updatedAt: row.updated_at });
  }
  function todoView(row: TodoRow): InvoiceWorkTodoView {
    const selected = item(row.work_id, row.item_id);
    const view = InvoiceWorkTodoViewSchema.parse({ ...JSON.parse(row.definition_json), workId: row.work_id, itemId: row.item_id,
      todoId: row.id, revision: row.revision, applicable: row.superseded_at === null && work(row.work_id).status === 'open'
        && selected.disposition === 'unresolved' });
    const basis = view.basis;
    const applicable = view.applicable && (basis.candidateRef === null || selected.candidate_id === basis.candidateRef.id
      && selected.candidate_sequence === basis.candidateRef.sequence) && basis.documentRefs.every(reference => {
      const document = documents.get(reference.id);
      return document.ok && document.data.documentRef.version === reference.version;
    }) && basis.sourceRefs.every(source => {
      const document = documents.get(source.documentId);
      return document.ok && document.data.documentRef.version === source.version && document.data.parsedArtifactId === source.artifactId;
    });
    // New input is not evidence that the business question was resolved; stopped work may receive more than one supplement.
    return { ...view, applicable };
  }
  function view(row: WorkRow): import('@flowmate/contracts').InvoiceWorkView {
    const counts = db.query<{ total: number; unresolved: number; accepted: number; rejected: number; excluded: number }, [number]>(
      "SELECT COUNT(*) total,SUM(disposition='unresolved') unresolved,SUM(disposition='accepted') accepted,SUM(disposition='rejected') rejected,SUM(disposition='excluded') excluded FROM invoice_work_items WHERE work_id=?").get(row.id)!;
    const current = attempt(row), status = current ? runStatus(current) : null;
    const unknown = current !== null && current.stopped_at === null
      && (current.stop_requested_at !== null || status === 'failed' || status === 'cancelled');
    const requiresContinue = row.status === 'open' && current !== null
      && (current.stop_requested_at !== null || status === 'failed' || status === 'cancelled');
    const open = row.status === 'open';
    let stopReason: string | null = null;
    if (current === null || current.stopped_at !== null) stopReason = 'There is no unstopped original attempt.';
    else if (current.stop_requested_at !== null) stopReason = 'The original stop request is awaiting confirmation.';
    return InvoiceWorkViewSchema.parse({ workId: row.id, personalAgentId: row.personal_agent_id, sessionId: row.session_id,
      runtimeKind: 'durable', revision: row.revision, goal: row.goal, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, counts,
      execution: { attempt: current ? attemptReference(current) : null, runStatus: status,
        queued: open && current !== null && current.run_id === null && current.stop_requested_at === null && current.stopped_at === null,
        requiresContinue, stopUnconfirmed: unknown, waitingReason: unknown ? 'Original execution stop is unconfirmed.' : null,
        ownedChildRunIds: current ? ownedChildren(current) : [] },
      actions: [{ kind: open ? 'continue' : 'create-related', enabled: !unknown,
        reason: unknown ? 'Original execution stop must be confirmed.' : null, itemId: null, todoId: null },
      { kind: 'stop', enabled: stopReason === null, reason: stopReason, itemId: null, todoId: null },
      ...(open ? [{ kind: 'cancel', enabled: true, reason: null, itemId: null, todoId: null }] : [])] });
  }
  function checkDocument(reference: DocumentRef) {
    const doc = requireResult(documents.get(reference.id));
    requireFact(doc.documentRef.version === reference.version && doc.status === 'available' && !doc.isHidden
      && doc.parsedArtifactId !== null, 'input_unavailable', 'The selected invoice version is unavailable.');
    return doc;
  }
  function materialAllowed(row: WorkRow, selected: ItemRow, reference: DocumentRef) {
    checkDocument(reference);
    if (selected.document_id === reference.id && selected.document_version === reference.version) return;
    const supplied = db.query<{ materials_json: string }, [number, number]>(
      'SELECT materials_json FROM invoice_work_inputs WHERE work_id=? AND item_id=?').all(row.id, selected.id);
    requireFact(supplied.some(value => z.array(DocumentRefSchema).parse(JSON.parse(value.materials_json))
      .some(original => isDeepStrictEqual(original, reference))), 'source_invalid', 'Material belongs to another invoice context.');
  }
  function bumpItem(row: ItemRow, at: string) {
    requireFact(revision.safeParse(row.revision).success && row.revision < Number.MAX_SAFE_INTEGER);
    requireFact(db.query('UPDATE invoice_work_items SET revision=revision+1,updated_at=? WHERE work_id=? AND id=? AND revision=?')
      .run(at, row.work_id, row.id, row.revision).changes === 1);
    return item(row.work_id, row.id);
  }
  function inputAuthorized(row: InputRow, current: AttemptRow): boolean {
    const received = db.query<{ id: number; receipt_json: string }, [number, string]>(
      "SELECT id,receipt_json FROM invoice_work_operations WHERE work_id=? AND kind='supplement' AND request_id=?")
      .get(row.work_id, row.request_id);
    requireFact(received, 'storage_corrupt', 'Saved input is missing its original command receipt.');
    const receipt = prior<InvoiceWorkSupplementReceipt>({ workId: row.work_id }, 'supplement', row.request_id);
    requireFact(receipt && receipt.inputId === row.id && receipt.itemId === row.item_id, 'storage_corrupt');
    if (receipt.execution.authorizationAccepted && receipt.execution.attempt.attemptId === current.id) return true;
    const continued = db.query<{ request_id: string }, [number, number]>(
      "SELECT request_id FROM invoice_work_operations WHERE work_id=? AND kind='continueWork' AND id>? ORDER BY id")
      .all(row.work_id, received.id);
    return continued.some(value => {
      const original = prior<InvoiceWorkContinueReceipt>({ workId: row.work_id }, 'continueWork', value.request_id);
      requireFact(original, 'storage_corrupt');
      return original.revision > receipt.revision && original.execution.authorizationAccepted
        && original.execution.attempt.attemptId === current.id;
    });
  }
  function inputConsumed(workId: number, inputId: number): boolean {
    return db.query(
      "SELECT p.id FROM invoice_work_phases p,json_each(p.basis_json,'$.inputIds') i WHERE p.work_id=? AND p.consumed_at IS NOT NULL AND i.value=? LIMIT 1")
      .get(workId, inputId) !== null;
  }
  function historicalMaterialAllowed(input: InputRow, reference: DocumentRef, at: string): boolean {
    const consumed = db.query<PhaseRow, [number, number, number]>(`SELECT p.* FROM invoice_work_phases p
      WHERE p.work_id=? AND p.item_id=? AND p.consumed_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(p.basis_json,'$.inputIds') i WHERE i.value=?) ORDER BY p.id`).all(input.work_id, input.item_id, input.id);
    return consumed.some(stored => {
      const original = phase(stored);
      if (original.nativeConversationId === null || original.nativeSubmissionId === null
        || Date.parse(original.consumedAt!) < Date.parse(original.createdAt) || Date.parse(original.consumedAt!) > Date.parse(at)
        || !original.basis.documentRefs.some(saved => isDeepStrictEqual(saved, reference))) return false;
      const owner = db.query<AttemptRow, [number, number]>('SELECT * FROM invoice_work_attempts WHERE work_id=? AND id=?')
        .get(input.work_id, original.attemptId);
      requireFact(owner, 'storage_corrupt', 'Historical material is missing its original execution attempt.');
      return inputAuthorized(input, owner);
    });
  }
  function savedInputNeedsApproval(row: WorkRow, current: AttemptRow) {
    return db.query<InputRow, [number]>('SELECT * FROM invoice_work_inputs WHERE work_id=? ORDER BY id').all(row.id)
      .some(input => item(row.id, input.item_id).disposition === 'unresolved' && !inputConsumed(row.id, input.id)
        && !inputAuthorized(input, current));
  }
  function completeIfClosed(row: WorkRow, at: string) {
    if (row.status !== 'open' || db.query("SELECT id FROM invoice_work_items WHERE work_id=? AND disposition='unresolved' LIMIT 1").get(row.id)) return;
    const current = attempt(row);
    if (current && current.stopped_at === null) {
      const prepared = current.run_id !== null || db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? LIMIT 1').get(current.id) !== null;
      if (prepared) return;
      // No phase or Run was ever admitted; there is no native call whose stop must be guessed.
      db.query('UPDATE invoice_work_attempts SET stopped_at=? WHERE id=?').run(at, current.id);
    }
    if (db.query('SELECT id FROM invoice_work_attempts WHERE work_id=? AND stopped_at IS NULL LIMIT 1').get(row.id)
      || db.query('SELECT id FROM invoice_work_phases WHERE work_id=? AND closed_at IS NULL LIMIT 1').get(row.id)
      || current && ownedChildren(current).length) return;
    db.query("UPDATE invoice_works SET status='completed',ended_at=?,updated_at=? WHERE id=? AND status='open'").run(at, at, row.id);
  }
  function prior<T extends InvoiceWorkOperationReceipt>(scope: { personalAgentId?: number; workId?: number },
    kind: T['operation'], requestId: string, request?: unknown): T | null {
    const found = kind === 'create'
      ? db.query<OperationRow, [number, string]>(
        "SELECT * FROM invoice_work_operations WHERE personal_agent_id=? AND kind='create' AND request_id=?")
        .get(scope.personalAgentId!, requestId)
      : db.query<OperationRow, [number, string, string]>(
        'SELECT * FROM invoice_work_operations WHERE work_id=? AND kind=? AND request_id=?')
        .get(scope.workId!, kind, requestId);
    if (!found) return null;
    if (request !== undefined) requireFact(isDeepStrictEqual(JSON.parse(found.request_json), request), 'state_conflict',
      'The original operation has a different request.');
    const receipt = InvoiceWorkOperationReceiptSchema.parse(JSON.parse(found.receipt_json));
    const owner = work(found.work_id);
    requireFact(found.kind === kind && receipt.operation === kind && receipt.requestId === found.request_id
      && receipt.workId === owner.id && found.personal_agent_id === owner.personal_agent_id, 'storage_corrupt',
    'Stored operation receipt does not belong to its original command.');
    if (receipt.operation === 'create') requireFact(receipt.personalAgentId === found.personal_agent_id
      && receipt.sessionId === owner.session_id, 'storage_corrupt');
    if ('execution' in receipt && receipt.execution.attempt !== null) {
      const saved = db.query<AttemptRow, [number, number]>('SELECT * FROM invoice_work_attempts WHERE id=? AND work_id=?')
        .get(receipt.execution.attempt.attemptId, owner.id);
      requireFact(saved && (receipt.execution.attempt.runId === null || receipt.execution.attempt.runId === saved.run_id),
        'storage_corrupt', 'The receipt execution belongs to another invoice work.');
    }
    if (receipt.operation === 'supplement') {
      const saved = db.query<InputRow, [number, number]>('SELECT * FROM invoice_work_inputs WHERE work_id=? AND id=?')
        .get(owner.id, receipt.inputId);
      requireFact(saved && saved.item_id === receipt.itemId && saved.todo_id === receipt.todoId
        && saved.request_id === receipt.requestId, 'storage_corrupt', 'The receipt input belongs to another command.');
    }
    if (receipt.operation === 'disposeItem')
      requireFact(db.query('SELECT id FROM invoice_work_items WHERE work_id=? AND id=?').get(owner.id, receipt.itemId),
        'storage_corrupt', 'The receipt disposition belongs to another invoice work.');
    return receipt as T;
  }
  function saveOperation(row: WorkRow, request: { requestId: string }, receipt: InvoiceWorkOperationReceipt) {
    const checked = InvoiceWorkOperationReceiptSchema.parse(receipt);
    requireFact(checked.workId === row.id && checked.requestId === request.requestId
      && (checked.operation !== 'create' || checked.personalAgentId === row.personal_agent_id && checked.sessionId === row.session_id),
    'storage_corrupt', 'The operation receipt does not match the command being committed.');
    db.query('INSERT INTO invoice_work_operations(personal_agent_id,work_id,kind,request_id,request_json,receipt_json,received_at) VALUES(?,?,?,?,?,?,?)')
      .run(row.personal_agent_id, row.id, checked.operation, request.requestId, JSON.stringify(request), JSON.stringify(checked), checked.receivedAt);
    return checked;
  }
  function bump(row: WorkRow, at: string) {
    requireFact(row.revision < Number.MAX_SAFE_INTEGER, 'state_conflict', 'Invoice work revision cannot advance.');
    requireFact(db.query('UPDATE invoice_works SET revision=revision+1,updated_at=? WHERE id=? AND revision=?')
      .run(at, row.id, row.revision).changes === 1);
    return work(row.id);
  }
  function decision(row: WorkRow, kind: 'create' | 'continueWork' | 'supplement', requestId: string,
    admission: InvoiceWorkAdmission, at: string): import('@flowmate/contracts').InvoiceWorkExecutionDecision {
    const current = attempt(row), status = current ? runStatus(current) : null;
    if (!db.query("SELECT id FROM invoice_work_items WHERE work_id=? AND disposition='unresolved' LIMIT 1").get(row.id))
      return { kind: 'waiting', authorizationAccepted: false, attempt: current ? attemptReference(current) : null,
        reason: 'Every invoice already has a final disposition. Execution closure is still checked separately.', todoIds: [] };
    if (current && current.stop_requested_at !== null && current.stopped_at === null)
      return { kind: 'blocked', authorizationAccepted: false, attempt: attemptReference(current),
        reason: appError('stop_unconfirmed', 'runtime', 'Original execution stop is unconfirmed.', true) };
    if (kind === 'supplement' && current && (current.stop_requested_at !== null || status === 'failed' || status === 'cancelled'))
      return { kind: 'waiting', authorizationAccepted: false, attempt: attemptReference(current),
        reason: 'Supplement saved. Explicit continue is required after stopping or failure.', todoIds: [] };
    const originalActive = kind === 'continueWork' && current && current.stopped_at === null
      && status !== 'failed' && status !== 'cancelled' && status !== 'completed';
    if (originalActive && !savedInputNeedsApproval(row, current))
      return { kind: 'existing', authorizationAccepted: false, attempt: attemptReference(current), relation: 'original' };
    if (admission.kind === 'blocked') return { ...admission, authorizationAccepted: false, attempt: current ? attemptReference(current) : null };
    if (admission.kind === 'waiting') return { ...admission, authorizationAccepted: false, todoIds: [...admission.todoIds ?? []],
      attempt: current ? attemptReference(current) : null };
    if (originalActive) {
      // This command authorizes newly saved input, using the original attempt rather than a second root.
      const inFlight = db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? AND closed_at IS NULL LIMIT 1').get(current.id) !== null;
      return { kind: inFlight ? 'pending-boundary' : admission.kind === 'queued' ? 'queued' : 'accepted',
        authorizationAccepted: true, attempt: attemptReference(current), relation: 'original' };
    }
    if (current && current.stopped_at === null && (status === 'failed' || status === 'cancelled' || status === 'completed'))
      return { kind: 'blocked', authorizationAccepted: false, attempt: attemptReference(current),
        reason: appError('stop_unconfirmed', 'runtime', 'Failed execution still requires its original closure.', true) };
    if (kind === 'supplement' && current && current.stopped_at === null)
      return { kind: 'pending-boundary', authorizationAccepted: true, attempt: attemptReference(current), relation: 'original' };
    const inserted = db.query('INSERT INTO invoice_work_attempts(work_id,previous_attempt_id,trigger_kind,trigger_request_id,created_at) VALUES(?,?,?,?,?)')
      .run(row.id, current?.id ?? null, kind, requestId, at);
    const attemptId = id.parse(Number(inserted.lastInsertRowid));
    db.query('UPDATE invoice_works SET current_attempt_id=? WHERE id=?').run(attemptId, row.id);
    const next = attempt(work(row.id))!;
    return { kind: admission.kind === 'queued' ? 'queued' : 'accepted', authorizationAccepted: true,
      attempt: attemptReference(next), relation: 'new' };
  }
  return {
    reconcile(input) {
      return operation(true, () => {
        const row = work(parse(id, input.workId)), at = parse(atSchema, input.at);
        completeIfClosed(row, at);
        return view(work(row.id));
      });
    },
    create(raw, options) {
      return operation(true, () => {
        const input = parse(InvoiceWorkCreateRequestSchema, raw), at = parse(atSchema, options.at), owner = agent(input.personalAgentId);
        const existing = prior<InvoiceWorkCreateReceipt>({ personalAgentId: owner.personalAgentId }, 'create', input.requestId, input);
        if (existing) return existing;
        requireFact(owner.revision === input.expectedAgentRevision);
        input.documents.forEach(checkDocument);
        const source = input.source ? work(input.source.workId) : null;
        const sourceItems = input.source?.items.map(reference => {
          const original = item(source!.id, reference.itemId);
          requireFact(original.document_id === reference.documentRef.id && original.document_version === reference.documentRef.version
            && input.documents.some(doc => isDeepStrictEqual(doc, reference.documentRef)));
          if (reference.candidateRef !== null) {
            const saved = db.query<{ job_id: number }, [number]>('SELECT job_id FROM invoice_candidates WHERE id=?')
              .get(reference.candidateRef.id);
            requireFact(saved);
            const inherited = source!.source_json === null ? null : sourceSnapshotSchema.parse(JSON.parse(source!.source_json));
            const fromOriginalSource = inherited?.items.some(value => value.jobId === saved.job_id
              && isDeepStrictEqual(value.documentRef, reference.documentRef)
              && isDeepStrictEqual(value.candidateRef, reference.candidateRef));
            requireFact(saved.job_id === original.job_id || fromOriginalSource);
            const sourceJob = requireResult(jobs.get(saved.job_id));
            requireFact(isDeepStrictEqual(sourceJob.documentRef, reference.documentRef));
            const candidate = requireResult(candidates.readByJob({ jobId: saved.job_id, candidateId: reference.candidateRef.id }));
            requireFact(candidate.candidate.sequence === reference.candidateRef.sequence);
            return { ...original, job_id: saved.job_id };
          }
          return original;
        }) ?? [];
        const sourceSnapshot = input.source ? sourceSnapshotSchema.parse({ workId: input.source.workId,
          items: input.source.items.map((reference, index) => ({ ...reference, jobId: sourceItems[index]!.job_id })) }) : null;
        const session = requireResult(sessions.create({ runtimeKind: 'durable', nativeSessionId: null, title: input.goal.slice(0, 80), at }));
        const defaults = parse(RuntimeRequestOverridesSchema, options.runtimeDefaults ?? {});
        const budget = DurableWorkBudgetSchema.parse({ runtimeBudget: { maxModelCalls: RUNTIME_CONFIG.runBudget.maxModelCalls.workspace,
          maxToolCalls: RUNTIME_CONFIG.runBudget.maxToolCalls, toolTimeoutMs: RUNTIME_CONFIG.runBudget.toolTimeoutMs,
          ...defaults.budget,
          maxToolFeedbackBytes: RUNTIME_CONFIG.runBudget.maxToolFeedbackBytes },
        limits: { timeoutMs: defaults.timeoutMs ?? RUNTIME_CONFIG.request.saveCandidateTimeoutMs,
          stopGraceMs: defaults.stopGraceMs ?? RUNTIME_CONFIG.request.stopGraceMs } });
        const inserted = db.query('INSERT INTO invoice_works(personal_agent_id,session_id,agent_revision,configuration_json,budget_json,goal,status,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(owner.personalAgentId, session.sessionId, owner.revision, JSON.stringify(owner.configuration), JSON.stringify(budget), input.goal, 'open',
            sourceSnapshot ? JSON.stringify(sourceSnapshot) : null, at, at);
        const workId = id.parse(Number(inserted.lastInsertRowid));
        for (const document of input.documents) {
          const original = sourceItems.find(sourceItem => sourceItem.document_id === document.id);
          db.query('INSERT INTO invoice_work_items(work_id,document_id,document_version,job_id,updated_at) VALUES(?,?,?,?,?)')
            .run(workId, document.id, document.version, original?.job_id ?? null, at);
        }
        const row = work(workId), execution = decision(row, 'create', input.requestId, options.admission, at);
        const receipt = InvoiceWorkCreateReceiptSchema.parse({ operation: 'create', personalAgentId: owner.personalAgentId,
          workId, sessionId: session.sessionId, requestId: input.requestId, revision: row.revision, receivedAt: at, execution });
        saveOperation(row, input, receipt);
        return receipt;
      });
    },
    queryOperation(raw) {
      return operation(false, () => {
        const input = parse(InvoiceWorkQueryOperationRequestSchema, raw);
        if (input.operation === 'create') { agent(input.personalAgentId); return prior({ personalAgentId: input.personalAgentId }, input.operation, input.requestId); }
        work(input.workId); return prior({ workId: input.workId }, input.operation, input.requestId);
      });
    },
    list(raw) {
      return operation(false, () => {
        const input = parse(InvoiceWorkListRequestSchema, raw); agent(input.personalAgentId);
        const rows = db.query<WorkRow, [number, number | null, number | null, string | null, string | null, number]>(
          'SELECT * FROM invoice_works WHERE personal_agent_id=? AND (? IS NULL OR id<?) AND (? IS NULL OR status=?) ORDER BY id DESC LIMIT ?')
          .all(input.personalAgentId, input.beforeId ?? null, input.beforeId ?? null, input.status ?? null, input.status ?? null, input.limit + 1);
        const items: import('@flowmate/contracts').InvoiceWorkView[] = [];
        for (const row of rows.slice(0, input.limit)) {
          const next = view(row);
          if (!InvoiceWorkListResultSchema.safeParse({ items: [...items, next], nextBeforeId: row.id }).success) break;
          items.push(next);
        }
        return InvoiceWorkListResultSchema.parse({ items, nextBeforeId: rows.length > items.length ? items.at(-1)?.workId ?? null : null });
      });
    },
    get(raw) {
      return operation(false, () => {
        const input = parse(InvoiceWorkGetRequestSchema, raw), row = work(input.workId), projected = view(row);
        if (input.view === 'work') {
          const rows = db.query<ItemRow, [number, number, number]>('SELECT * FROM invoice_work_items WHERE work_id=? AND id>? ORDER BY id LIMIT ?')
            .all(row.id, input.afterItemId ?? 0, input.limit + 1);
          const items: ReturnType<typeof itemView>[] = [];
          for (const selected of rows.slice(0, input.limit)) {
            const next = itemView(selected);
            if (!InvoiceWorkGetResultSchema.safeParse({ view: 'work', work: projected, items: [...items, next],
              nextAfterItemId: selected.id }).success) {
              requireFact(items.length > 0, 'input_too_large', 'The invoice item cannot fit its public query page.');
              break;
            }
            items.push(next);
          }
          return InvoiceWorkGetResultSchema.parse({ view: 'work', work: projected, items,
            nextAfterItemId: rows.length > items.length ? items.at(-1)?.itemId ?? null : null });
        }
        const selected = item(row.id, input.itemId);
        const rows = db.query<TodoRow, [number, number, number, number]>(
          'SELECT * FROM invoice_work_todos WHERE work_id=? AND item_id=? AND id>? AND superseded_at IS NULL ORDER BY id LIMIT ?')
          .all(row.id, selected.id, input.afterTodoId ?? 0, input.limit + 1);
        const selectedView = itemView(selected), todos: InvoiceWorkTodoView[] = [];
        for (const original of rows.slice(0, input.limit)) {
          const next = todoView(original);
          if (!InvoiceWorkGetResultSchema.safeParse({ view: 'item', work: projected, item: selectedView, todos: [...todos, next],
            nextAfterTodoId: original.id }).success) {
            requireFact(todos.length > 0, 'input_too_large', 'The Todo cannot fit its public query page.');
            break;
          }
          todos.push(next);
        }
        return InvoiceWorkGetResultSchema.parse({ view: 'item', work: projected, item: selectedView, todos,
          nextAfterTodoId: rows.length > todos.length ? todos.at(-1)?.todoId ?? null : null });
      });
    },
    continueWork(raw, options) {
      return operation(true, () => {
        const input = parse(InvoiceWorkContinueRequestSchema, raw), at = parse(atSchema, options.at), row = work(input.workId);
        const existing = prior<InvoiceWorkContinueReceipt>({ workId: row.id }, 'continueWork', input.requestId, input);
        if (existing) return existing;
        requireFact(row.status === 'open' && row.revision === input.expectedRevision && row.current_attempt_id === input.expectedAttemptId);
        const execution = decision(row, 'continueWork', input.requestId, options.admission, at);
        const changed = execution.authorizationAccepted ? bump(work(row.id), at) : row;
        const receipt: InvoiceWorkContinueReceipt = { operation: 'continueWork', workId: row.id, requestId: input.requestId,
          revision: changed.revision, receivedAt: at, execution };
        return saveOperation(changed, input, receipt) as InvoiceWorkContinueReceipt;
      });
    },
    cancelWork(raw, options) {
      return operation(true, () => {
        const input = parse(InvoiceWorkCancelRequestSchema, raw), at = parse(atSchema, options.at), row = work(input.workId);
        const existing = prior<InvoiceWorkCancelReceipt>({ workId: row.id }, 'cancelWork', input.requestId, input);
        if (existing) return existing;
        requireFact(row.status === 'open' && row.revision === input.expectedRevision);
        const changed = bump(row, at);
        db.query("UPDATE invoice_works SET status='cancelled',ended_at=? WHERE id=?").run(at, row.id);
        const current = attempt(changed);
        if (current) {
          const started = current.run_id !== null || db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? LIMIT 1').get(current.id) !== null;
          db.query('UPDATE invoice_work_attempts SET stop_requested_at=COALESCE(stop_requested_at,?),stopped_at=COALESCE(stopped_at,?) WHERE id=?')
            .run(at, started ? null : at, current.id);
        }
        const receipt: InvoiceWorkCancelReceipt = { operation: 'cancelWork', workId: row.id, requestId: input.requestId,
          revision: changed.revision, receivedAt: at, cancelled: true };
        return saveOperation(changed, input, receipt) as InvoiceWorkCancelReceipt;
      });
    },
    selectPhaseInput(input) {
      return operation(false, () => {
        const row = work(parse(id, input.workId)), current = attempt(row), selected = item(row.id, parse(id, input.itemId));
        requireFact(row.status === 'open' && current?.id === parse(id, input.attemptId)
          && current.stop_requested_at === null && current.stopped_at === null && selected.disposition === 'unresolved');
        const inputs = db.query<InputRow, [number, number]>(
          'SELECT * FROM invoice_work_inputs WHERE work_id=? AND item_id=? ORDER BY id').all(row.id, selected.id);
        const authorized = inputs.filter(value => !inputConsumed(row.id, value.id) && inputAuthorized(value, current));
        const todos = db.query<TodoRow, [number, number]>(
          'SELECT * FROM invoice_work_todos WHERE work_id=? AND item_id=? AND superseded_at IS NULL ORDER BY id').all(row.id, selected.id).map(todoView);
        const historical = inputs.filter(value => inputConsumed(row.id, value.id)
          && todos.some(todo => todo.todoId === value.todo_id || todo.basis.inputIds.includes(value.id)));
        const documentRefs: DocumentRef[] = [{ id: selected.document_id, version: selected.document_version }];
        for (const value of [...authorized, ...historical]) {
          for (const reference of parse(z.array(DocumentRefSchema), JSON.parse(value.materials_json))) {
            if (!documentRefs.some(saved => isDeepStrictEqual(saved, reference))) documentRefs.push(reference);
          }
        }
        return { itemId: selected.id, basis: { contextSnapshotId: null, inputIds: authorized.map(value => value.id),
          documentRefs, configurationRevision: row.agent_revision, itemRevision: selected.revision } };
      });
    },
    freezePhase(raw) {
      return operation(true, () => {
        const input = parse(phaseInputSchema, raw), row = work(input.workId);
        const existing = db.query<PhaseRow, [number, string]>('SELECT * FROM invoice_work_phases WHERE attempt_id=? AND request_id=?')
          .get(input.attemptId, input.requestId);
        if (existing) {
          requireFact(existing.work_id === row.id && existing.item_id === input.itemId && existing.kind === input.kind
            && isDeepStrictEqual(JSON.parse(existing.basis_json), input.basis));
          return phase(existing);
        }
        const current = attempt(row);
        requireFact(row.status === 'open' && current?.id === input.attemptId && current.stop_requested_at === null && current.stopped_at === null);
        requireFact(!db.query('SELECT id FROM invoice_work_phases WHERE attempt_id=? AND closed_at IS NULL LIMIT 1').get(current.id),
          'state_conflict', 'The original phase must be reconciled before another phase is frozen.');
        requireFact(db.query("SELECT id FROM invoice_work_items WHERE work_id=? AND disposition='unresolved' LIMIT 1").get(row.id));
        requireFact(input.basis.configurationRevision === row.agent_revision);
        const selected = input.itemId === null ? null : item(row.id, input.itemId);
        requireFact(selected ? selected.disposition === 'unresolved' && selected.revision === input.basis.itemRevision : input.basis.itemRevision === null);
        for (const reference of input.basis.documentRefs) {
          checkDocument(reference);
          const member = db.query('SELECT id FROM invoice_work_items WHERE work_id=? AND document_id=? AND document_version=?')
            .get(row.id, reference.id, reference.version);
          const supplied = db.query<InputRow, [number, number | null, number | null]>(
            'SELECT * FROM invoice_work_inputs WHERE work_id=? AND (? IS NULL OR item_id=?)')
            .all(row.id, input.itemId, input.itemId).some(value =>
              z.array(DocumentRefSchema).parse(JSON.parse(value.materials_json)).some(ref => isDeepStrictEqual(ref, reference))
              && (inputConsumed(row.id, value.id) ? historicalMaterialAllowed(value, reference, input.at) : inputAuthorized(value, current)));
          requireFact(member || supplied, 'source_invalid', 'The phase contains material outside the original invoice authorization.');
          if (selected && member && !supplied) requireFact(reference.id === selected.document_id);
        }
        for (const inputId of input.basis.inputIds) {
          const original = db.query<InputRow, [number, number]>('SELECT * FROM invoice_work_inputs WHERE work_id=? AND id=?').get(row.id, inputId);
          requireFact(original && (input.itemId === null || original.item_id === input.itemId)
            && inputAuthorized(original, current) && !inputConsumed(row.id, original.id), 'source_invalid',
          'The input has not been authorized for this attempt, or was already consumed.');
        }
        if (input.basis.contextSnapshotId !== null) {
          const snapshot = db.query<{ session_id: number }, [number]>('SELECT session_id FROM context_snapshots WHERE id=?').get(input.basis.contextSnapshotId);
          requireFact(snapshot && snapshot.session_id === row.session_id);
        }
        const inserted = db.query('INSERT INTO invoice_work_phases(work_id,attempt_id,item_id,request_id,kind,basis_json,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(row.id, current.id, input.itemId, input.requestId, input.kind, JSON.stringify(input.basis), input.at);
        return phase(db.query<PhaseRow, [number]>('SELECT * FROM invoice_work_phases WHERE id=?').get(Number(inserted.lastInsertRowid))!);
      });
    },
    linkPhase(input) {
      return operation(true, () => {
        const row = work(parse(id, input.workId)), phaseId = parse(id, input.phaseId);
        parse(id, input.attemptId); parse(id, input.nativeConversationId); parse(id, input.nativeSubmissionId); parse(atSchema, input.at);
        const stored = db.query<PhaseRow, [number, number, number]>('SELECT * FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND id=?')
          .get(row.id, input.attemptId, phaseId);
        requireFact(stored);
        requireResult(sessions.bindDurableConversation(row.session_id, input.nativeConversationId, input.at));
        if (stored.native_submission_id !== null) {
          requireFact(stored.native_submission_id === input.nativeSubmissionId && stored.native_conversation_id === input.nativeConversationId);
          return phase(stored);
        }
        db.query('UPDATE invoice_work_phases SET native_conversation_id=?,native_submission_id=? WHERE id=?')
          .run(input.nativeConversationId, input.nativeSubmissionId, phaseId);
        return phase(db.query<PhaseRow, [number]>('SELECT * FROM invoice_work_phases WHERE id=?').get(phaseId)!);
      });
    },
    getPhase(input) {
      return operation(false, () => {
        const row = work(parse(id, input.workId)); parse(id, input.attemptId);
        parse(phaseInputSchema.shape.requestId, input.requestId);
        const stored = db.query<PhaseRow, [number, number, string]>(
          'SELECT * FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
          .get(row.id, input.attemptId, input.requestId);
        return stored ? phase(stored) : null;
      });
    },
    recordPhaseObservation(raw) {
      return operation(true, () => {
        const observed = parse(observationSchema, raw.observation), at = parse(atSchema, raw.at), row = work(observed.workId);
        const stored = db.query<PhaseRow, [number, number, string]>(
          'SELECT * FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
          .get(row.id, observed.attemptId, observed.requestId);
        const session = requireResult(sessions.get(row.session_id));
        requireFact(row.session_id === observed.sessionId && session.runtimeKind === 'durable'
          && session.durableConversationId === observed.nativeConversationId && stored
          && stored.native_conversation_id === observed.nativeConversationId && stored.native_submission_id === observed.nativeSubmissionId,
        'source_invalid', 'The native observation is not bound to this original invoice phase.');
        if (observed.consumedAt !== null) {
          requireFact(observed.nativeEntryId !== null && observed.status !== 'queued'
            && Date.parse(observed.consumedAt) >= Date.parse(stored.created_at) && Date.parse(observed.consumedAt) <= Date.parse(at),
          'source_invalid', 'The native observation does not prove consumption of this submitted input.');
          requireFact(db.query('SELECT id FROM invoice_work_context_snapshots WHERE phase_id=?').get(stored.id),
            'source_invalid', 'The observed phase has no committed working context.');
          requireFact(stored.consumed_at === null || stored.consumed_at === observed.consumedAt,
            'source_invalid', 'The original successful consumption receipt cannot be replaced.');
        }
        const closed = observed.execution === 'closed';
        requireFact(!closed || observed.status === 'done' || observed.status === 'unanswered', 'source_invalid');
        db.query('UPDATE invoice_work_phases SET consumed_at=COALESCE(consumed_at,?),closed_at=COALESCE(closed_at,?) WHERE id=?')
          .run(observed.consumedAt, closed ? at : null, stored.id);
        completeIfClosed(row, at);
        return phase(db.query<PhaseRow, [number]>('SELECT * FROM invoice_work_phases WHERE id=?').get(stored.id)!);
      });
    },
    closeUnsubmittedPhase(input) {
      return operation(true, () => {
        const row = work(parse(id, input.workId)), attemptId = parse(id, input.attemptId), at = parse(atSchema, input.at);
        const proof = parse(z.object({ workId: id, sessionId: id, attemptId: id,
          stopped: z.literal(true), reason: z.literal('not-started') }).strict(), input.stopResult);
        requireFact(proof.workId === row.id && proof.sessionId === row.session_id && proof.attemptId === attemptId,
          'source_invalid', 'The native submission barrier belongs to another Work attempt.');
        const stored = db.query<PhaseRow, [number, number, string]>(
          'SELECT * FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
          .get(row.id, attemptId, parse(phaseInputSchema.shape.requestId, input.requestId));
        requireFact(stored && stored.native_conversation_id === null && stored.native_submission_id === null && stored.consumed_at === null,
          'source_invalid', 'A submitted native phase must close through its original runtime observation.');
        const current = db.query<AttemptRow, [number, number]>(
          'SELECT * FROM invoice_work_attempts WHERE work_id=? AND id=?').get(row.id, attemptId);
        requireFact(current, 'storage_corrupt', 'The unsubmitted phase is missing its original attempt.');
        if (current.stop_requested_at === null && row.status !== 'cancelled') {
          const authorization = DurableWorkBudgetSchema.parse(JSON.parse(row.budget_json));
          const roots = db.query<{ started_at: string | null; stopped_at: string | null; ended_at: string | null; duration_ms: number | null }, [number]>(
            'SELECT r.started_at,r.stopped_at,r.ended_at,r.duration_ms FROM runs r JOIN invoice_work_attempts a ON a.run_id=r.id WHERE a.work_id=? AND r.parent_run_id IS NULL')
            .all(row.id);
          const elapsed = roots.reduce((total, root) => {
            if (root.started_at === null) return total;
            const duration = root.duration_ms ?? Date.parse(root.stopped_at ?? root.ended_at ?? at) - Date.parse(root.started_at);
            requireFact(Number.isSafeInteger(duration) && duration >= 0 && Number.isSafeInteger(total + duration), 'storage_corrupt');
            return total + duration;
          }, 0);
          requireFact(elapsed >= authorization.limits.timeoutMs, 'state_conflict', 'The unsubmitted phase has no stop or expired execution authorization.');
        }
        if (stored.closed_at !== null) return phase(stored);
        requireFact(Date.parse(at) >= Date.parse(stored.created_at), 'input_invalid');
        requireFact(db.query(`UPDATE invoice_work_phases SET closed_at=? WHERE id=? AND closed_at IS NULL
          AND native_conversation_id IS NULL AND native_submission_id IS NULL AND consumed_at IS NULL`).run(at, stored.id).changes === 1);
        return phase(db.query<PhaseRow, [number]>('SELECT * FROM invoice_work_phases WHERE id=?').get(stored.id)!);
      });
    },
    readContextInput(input) {
      return operation(false, () => {
        const row = work(parse(id, input.workId)); parse(id, input.attemptId);
        parse(phaseInputSchema.shape.requestId, input.requestId);
        const stored = db.query<PhaseRow, [number, number, string]>(
          'SELECT * FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
          .get(row.id, input.attemptId, input.requestId);
        const current = attempt(row);
        requireFact(stored && stored.item_id !== null && stored.closed_at === null && current?.id === stored.attempt_id
          && current.stop_requested_at === null && current.stopped_at === null && row.status === 'open');
        const selected = item(row.id, stored.item_id), frozen = phase(stored), projected = view(row);
        const original = db.query<{ context_json: string }, [number]>(
          'SELECT context_json FROM invoice_work_context_snapshots WHERE phase_id=?')
          .get(stored.id);
        const context = original ? InvoiceWorkWorkingContextSchema.parse(JSON.parse(original.context_json)) : null;
        const readable = context && context.phase.phaseId === frozen.phaseId && isDeepStrictEqual(context.phase.basis, frozen.basis)
          && invoiceWorkPhaseItemProgress(db, context, { revision: selected.revision, latestInputId: selected.latest_input_id,
            candidateId: selected.candidate_id, jobId: selected.job_id }).readable;
        requireFact(selected.disposition === 'unresolved' && (selected.revision === frozen.basis.itemRevision || readable)
          && frozen.basis.configurationRevision === row.agent_revision && !projected.execution.requiresContinue);
        const originalInput = (inputId: number, ownerAttempt: number): InvoiceWorkAuthorizedContextInput => {
          const original = db.query<InputRow, [number, number, number]>(
            'SELECT * FROM invoice_work_inputs WHERE work_id=? AND item_id=? AND id=?').get(row.id, selected.id, inputId);
          requireFact(original, 'storage_corrupt', 'The phase input is missing its original invoice.');
          const operationRow = db.query<OperationRow, [number, string]>(
            "SELECT * FROM invoice_work_operations WHERE work_id=? AND kind='supplement' AND request_id=?")
            .get(row.id, original.request_id);
          const receipt = prior<InvoiceWorkSupplementReceipt>({ workId: row.id }, 'supplement', original.request_id);
          requireFact(operationRow && receipt && receipt.inputId === inputId && receipt.itemId === selected.id, 'storage_corrupt');
          const request = parse(InvoiceWorkSupplementRequestSchema, JSON.parse(operationRow.request_json));
          requireFact(request.text === original.text && request.todoId === original.todo_id
            && isDeepStrictEqual(request.materials, JSON.parse(original.materials_json)), 'storage_corrupt');
          let continuedBy: InvoiceWorkContinueReceipt | null = null;
          if (!(receipt.execution.authorizationAccepted && receipt.execution.attempt.attemptId === ownerAttempt)) {
            const commands = db.query<{ request_id: string }, [number]>(
              "SELECT request_id FROM invoice_work_operations WHERE work_id=? AND kind='continueWork' ORDER BY id").all(row.id);
            for (const command of commands) {
              const received = prior<InvoiceWorkContinueReceipt>({ workId: row.id }, 'continueWork', command.request_id);
              requireFact(received, 'storage_corrupt');
              if (received.revision > receipt.revision && received.execution.authorizationAccepted
                && received.execution.attempt.attemptId === ownerAttempt) { continuedBy = received; break; }
            }
            requireFact(continuedBy, 'source_invalid', 'The original input has no authorization for this phase.');
          }
          return { inputId, request, receipt, continuedBy };
        };
        const historicalInputReferences: InvoiceWorkContextBuildInput['historicalInputReferences'][number][] = [];
        const historical = db.query<PhaseRow, [number, number, number]>(
          'SELECT * FROM invoice_work_phases WHERE work_id=? AND item_id=? AND id!=? AND consumed_at IS NOT NULL ORDER BY id')
          .all(row.id, selected.id, stored.id);
        for (const original of historical) {
          const consumed = phase(original);
          for (const inputId of consumed.basis.inputIds) {
            const authorized = originalInput(inputId, consumed.attemptId);
            historicalInputReferences.push({ inputId, request: authorized.request, receipt: authorized.receipt,
              continuedBy: authorized.continuedBy, consumedPhase: consumed });
          }
        }
        const todos = db.query<TodoRow, [number, number]>(
          'SELECT * FROM invoice_work_todos WHERE work_id=? AND item_id=? AND superseded_at IS NULL ORDER BY id')
          .all(row.id, selected.id).map(todoView);
        const selectedView = itemView(selected), confirmedBusinessReferences: InvoiceWorkContextBuildInput['confirmedBusinessReferences'][number][] = [];
        let modelReports: InvoiceWorkContextBuildInput['modelReports'] = [];
        const conflicts: InvoiceWorkContextBuildInput['conflicts'][number][] = [];
        if (selectedView.candidateRef !== null) {
          requireFact(selectedView.jobId !== null, 'storage_corrupt');
          const candidate = requireResult(candidates.readByJob({ jobId: selectedView.jobId, candidateId: selectedView.candidateRef.id }));
          requireFact(candidate.candidate.sequence === selectedView.candidateRef.sequence, 'storage_corrupt');
          confirmedBusinessReferences.push({ kind: 'candidate', workId: row.id, itemId: selected.id,
            documentRef: selectedView.documentRef, jobId: selectedView.jobId, candidateRef: selectedView.candidateRef });
          for (const todo of todos) {
            if (!todo.applicable || todo.fieldPath === null || todo.basis.sourceRefs.length + todo.basis.inputIds.length < 2) continue;
            const [, index, name] = todo.fieldPath.split('.');
            const field = todo.fieldPath.startsWith('fields.')
              ? candidate.candidate.fields[index as keyof typeof candidate.candidate.fields]
              : candidate.candidate.lines[Number(index)]?.[name as keyof typeof candidate.candidate.lines[number]];
            if (field?.state === 'ambiguous') conflicts.push({ workId: row.id, itemId: selected.id, fieldPath: todo.fieldPath,
              origin: todo.basis.origin, problem: todo.problem, sourceRefs: todo.basis.sourceRefs, inputIds: todo.basis.inputIds });
          }
          if (candidate.candidate.toolCallId !== null) {
            const original = db.query<{ args_json: string; phase_id: number; attempt_id: number; run_id: number; context_json: string }, [number]>(
              `SELECT t.args_json,b.phase_id,p.attempt_id,t.run_id,c.context_json FROM tool_calls t
               JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id JOIN invoice_work_phases p ON p.id=b.phase_id
               JOIN invoice_work_context_snapshots c ON c.phase_id=p.id WHERE t.id=? AND t.tool_name='save_invoice_candidate'`)
              .get(candidate.candidate.toolCallId);
            if (original && original.attempt_id === current.id) {
              const originalContext = InvoiceWorkWorkingContextSchema.parse(JSON.parse(original.context_json));
              const args = invoiceToolSchemas.save_invoice_candidate.input.parse(JSON.parse(original.args_json).final);
              if (args.childReportRefs && originalContext.item.latestInputId === selectedView.latestInputId
                && isDeepStrictEqual(originalContext.phase.basis.documentRefs, frozen.basis.documentRefs)) {
                modelReports = requireResult(readInvoiceCandidateChildReports(db, { workId: row.id, itemId: selected.id,
                  attemptId: current.id, phaseId: original.phase_id, runId: original.run_id }, args.childReportRefs,
                args.candidate, selectedView.candidateRef));
              }
            }
          }
        }
        frozen.basis.documentRefs.forEach(checkDocument);
        return parse(InvoiceWorkContextBuildInputSchema, { phase: frozen, work: projected, item: selectedView,
          current: { work: projected, item: selectedView, configurationRevision: row.agent_revision, documentRefs: frozen.basis.documentRefs },
          authorizedInputs: frozen.basis.inputIds.map(inputId => originalInput(inputId, current.id)), historicalInputReferences, todos,
          confirmedBusinessReferences, conflicts, modelReports, evidenceRefs: todos.flatMap(todo => todo.basis.sourceRefs),
          allowedTools: PersonalAgentConfigurationSchema.parse(JSON.parse(row.configuration_json)).tools, remainingBudget: input.remainingBudget });
      });
    },
    replaceTodos(input) {
      return operation(true, () => {
        const row = work(parse(id, input.workId)), selected = item(row.id, parse(id, input.itemId)), at = parse(atSchema, input.at);
        requireFact(row.status === 'open' && selected.disposition === 'unresolved' && selected.revision === input.expectedRevision);
        requireFact(selected.revision < Number.MAX_SAFE_INTEGER);
        const definitions = input.todos.map(definition => {
          const checked = parse(InvoiceWorkTodoViewSchema, { ...definition, workId: row.id, itemId: selected.id,
            todoId: 1, revision: selected.revision + 1, applicable: true });
          for (const reference of checked.basis.documentRefs) materialAllowed(row, selected, reference);
          for (const source of checked.basis.sourceRefs) {
            materialAllowed(row, selected, { id: source.documentId, version: source.version });
            requireFact(checkDocument({ id: source.documentId, version: source.version }).parsedArtifactId === source.artifactId,
              'source_invalid', 'The Todo source artifact differs from the original parsed material.');
          }
          for (const inputId of checked.basis.inputIds)
            requireFact(db.query('SELECT id FROM invoice_work_inputs WHERE work_id=? AND item_id=? AND id=?')
              .get(row.id, selected.id, inputId), 'source_invalid');
          if (checked.basis.candidateRef) {
            requireFact(selected.job_id !== null, 'source_invalid');
            const original = requireResult(candidates.readByJob({ jobId: selected.job_id, candidateId: checked.basis.candidateRef.id }));
            requireFact(original.candidate.sequence === checked.basis.candidateRef.sequence, 'source_invalid');
          }
          const value: InvoiceWorkTodoDefinition = { actor: checked.actor, fieldPath: checked.fieldPath, problem: checked.problem,
            needed: checked.needed, satisfiedBy: checked.satisfiedBy, action: checked.action, basis: checked.basis };
          return value;
        });
        const changedItem = bumpItem(selected, at), changed = bump(row, at);
        db.query('UPDATE invoice_work_todos SET superseded_at=? WHERE item_id=? AND superseded_at IS NULL').run(at, selected.id);
        const values: InvoiceWorkTodoView[] = [];
        for (const definition of definitions) {
          const inserted = db.query('INSERT INTO invoice_work_todos(work_id,item_id,revision,definition_json,created_at) VALUES(?,?,?,?,?)')
            .run(row.id, selected.id, changedItem.revision, JSON.stringify(definition), at);
          const next = todoView(db.query<TodoRow, [number]>('SELECT * FROM invoice_work_todos WHERE id=?').get(Number(inserted.lastInsertRowid))!);
          requireFact(InvoiceWorkGetResultSchema.safeParse({ view: 'item', work: view(changed), item: itemView(changedItem),
            todos: [next], nextAfterTodoId: null }).success, 'input_too_large', 'The Todo cannot fit its public query page.');
          values.push(next);
        }
        return values;
      });
    },
    supplement(raw, options) {
      return operation(true, () => {
        const input = parse(InvoiceWorkSupplementRequestSchema, raw), row = work(input.workId), at = parse(atSchema, options.at);
        const existing = prior<InvoiceWorkSupplementReceipt>({ workId: row.id }, 'supplement', input.requestId, input);
        if (existing) return existing;
        requireFact(row.status === 'open' && row.revision === input.expectedRevision);
        const selected = item(row.id, input.itemId);
        requireFact(selected.disposition === 'unresolved');
        const todo = db.query<TodoRow, [number, number, number]>('SELECT * FROM invoice_work_todos WHERE work_id=? AND item_id=? AND id=?')
          .get(row.id, selected.id, input.todoId);
        requireFact(todo && todo.superseded_at === null);
        checkDocument({ id: selected.document_id, version: selected.document_version });
        input.materials.forEach(checkDocument);
        const inserted = db.query('INSERT INTO invoice_work_inputs(work_id,item_id,todo_id,request_id,text,materials_json,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(row.id, selected.id, todo.id, input.requestId, input.text, JSON.stringify(input.materials), at);
        const inputId = id.parse(Number(inserted.lastInsertRowid));
        db.query('UPDATE invoice_work_items SET latest_input_id=? WHERE id=?').run(inputId, selected.id);
        bumpItem(selected, at);
        const changed = bump(row, at), execution = decision(changed, 'supplement', input.requestId, options.admission, at);
        const receipt = InvoiceWorkSupplementReceiptSchema.parse({ operation: 'supplement', workId: row.id,
          requestId: input.requestId, revision: changed.revision, receivedAt: at, itemId: selected.id, todoId: todo.id,
          inputId, saved: true, execution });
        saveOperation(changed, input, receipt);
        return receipt;
      });
    },
    prepareItemJob(input) {
      return operation(true, () => {
        const row = work(parse(id, input.workId)), selected = item(row.id, parse(id, input.itemId));
        parse(revision, input.expectedRevision); parse(atSchema, input.at);
        const prior = db.query("SELECT job_id FROM business_events WHERE type='task_started' AND operation_ref=?")
          .get('invoice-work:' + row.id + ':item:' + selected.id + ':prepare');
        if (!prior) {
          const current = attempt(row), status = current ? runStatus(current) : null;
          requireFact(row.status === 'open' && selected.disposition === 'unresolved' && selected.revision === input.expectedRevision
            && current && current.stop_requested_at === null && current.stopped_at === null && status !== 'failed'
            && status !== 'cancelled' && status !== 'completed');
          checkDocument({ id: selected.document_id, version: selected.document_version });
        }
        return requireResult(jobs.prepareInvoiceWorkItem(input));
      });
    },
    disposeItem(raw, options) {
      return operation(true, () => {
        const input = parse(InvoiceWorkDisposeItemRequestSchema, raw), row = work(input.workId), at = parse(atSchema, options.at);
        const existing = prior<InvoiceWorkDisposeItemReceipt>({ workId: row.id }, 'disposeItem', input.requestId, input);
        if (existing) return existing;
        requireFact(row.status === 'open' && row.revision === input.expectedRevision);
        const selected = item(row.id, input.itemId), decision = parse(InvoiceWorkDispositionDecisionSchema, input.decision);
        requireFact(selected.disposition === 'unresolved');
        if (decision.kind === 'accepted') {
          const original = requireResult(candidates.queryOperation({ kind: 'accept', request: decision.acceptRequest, at }));
          requireFact(original !== null && 'job' in original && 'candidate' in original,
            'operation_result_unknown', 'The original acceptance must be confirmed before attaching it.');
          requireFact(original.job.documentRef.id === selected.document_id && original.job.documentRef.version === selected.document_version
            && (selected.job_id === null || selected.job_id === original.job.jobId)
            && decision.acceptRequest.jobId === original.job.jobId && decision.candidateRef.id === original.candidate.candidateId
            && decision.candidateRef.sequence === original.candidate.sequence && original.candidate.status === 'accepted'
            && original.job.status === 'completed' && original.job.acceptedCandidateId === original.candidate.candidateId);
          db.query('UPDATE invoice_work_items SET job_id=?,candidate_id=?,candidate_sequence=? WHERE id=?')
            .run(original.job.jobId, original.candidate.candidateId, original.candidate.sequence, selected.id);
        }
        db.query('UPDATE invoice_work_items SET disposition=?,decision_json=?,disposed_at=? WHERE id=?')
          .run(decision.kind, JSON.stringify(decision), at, selected.id);
        db.query('UPDATE invoice_work_todos SET superseded_at=? WHERE item_id=? AND superseded_at IS NULL').run(at, selected.id);
        bumpItem(selected, at);
        const changed = bump(row, at);
        completeIfClosed(changed, at);
        const receipt = InvoiceWorkDisposeItemReceiptSchema.parse({ operation: 'disposeItem', workId: row.id,
          requestId: input.requestId, revision: changed.revision, receivedAt: at, itemId: selected.id, disposition: decision.kind });
        saveOperation(changed, input, receipt);
        return receipt;
      });
    },
  };
}
