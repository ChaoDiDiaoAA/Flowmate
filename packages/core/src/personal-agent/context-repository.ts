import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, PersonalAgentConfigurationSchema, ResourceBundleManifestSchema, resourceRefKey,
  RUNTIME_CONFIG, type AppError, type Result } from '@flowmate/contracts';
import { InvoiceWorkContextPhaseSchema, InvoiceWorkWorkingContextSchema,
  type InvoiceWorkContextPhase, type InvoiceWorkWorkingContext } from '../../../contracts/src/personal-context.ts';
import { createInvoiceWorkRepository } from './repository.ts';
import { readTransaction } from '../storage/reads.ts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';
import { createManagedFileContents } from '../storage/managed-file-contents.ts';
import { decoder, versionPath } from '../skill-hub/resources.ts';

export type FrozenInvoiceWorkContext = { contextId: number; context: InvoiceWorkWorkingContext };
type ContextKey = { workId: number; attemptId: number; requestId: string };
export interface InvoiceWorkContextRepository {
  save(input: { context: InvoiceWorkWorkingContext; at: string }): Result<FrozenInvoiceWorkContext>;
  get(input: ContextKey): Result<FrozenInvoiceWorkContext | null>;
}

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const keySchema = z.object({ workId: id, attemptId: id,
  requestId: z.string().min(1).max(128).refine(value => value.trim().length > 0) }).strict();
const saveSchema = z.object({ context: InvoiceWorkWorkingContextSchema, at: z.string().datetime({ offset: true }) }).strict();
type SnapshotRow = { id: number; phase_id: number; work_id: number; attempt_id: number; item_id: number;
  session_id: number; request_id: string; context_json: string; created_at: string };
type PhaseRow = { id: number; work_id: number; attempt_id: number; item_id: number | null; request_id: string;
  kind: 'prompt'; basis_json: string; created_at: string; native_conversation_id: number | null;
  native_submission_id: number | null; consumed_at: string | null; closed_at: string | null };
class ContextFault extends Error { constructor(readonly fact: AppError) { super(fact.code); } }
function requireFact(condition: unknown, code = 'context_binding_conflict', message = 'The working context differs from its original product facts.'): asserts condition {
  if (!condition) throw new ContextFault(appError(code, code === 'storage_corrupt' ? 'storage' : 'input', message));
}
function need<T>(result: Result<T>): T { if (!result.ok) throw new ContextFault(result.error); return result.data; }
const provenance = (origin: 'rule' | 'model' | 'user') =>
  origin === 'rule' ? 'business-rule' : origin === 'model' ? 'model-self-report' : 'user-provided';

/** Product phase snapshots share the product transaction, without importing native conversation history. */
export function createInvoiceWorkContextRepository(db: SynchronousDatabaseExecutor): InvoiceWorkContextRepository {
  const works = createInvoiceWorkRepository(db);
  const contents = createManagedFileContents(db);
  function operation<T>(write: boolean, action: () => T): Result<T> {
    try {
      if (write) requireFact(db.inTransaction, 'state_conflict', 'Working context writes require the product transaction.');
      return ok(write ? db.transaction(action).immediate() : readTransaction(db, action));
    } catch (error) {
      return fail(error instanceof ContextFault ? error.fact : error instanceof z.ZodError || error instanceof SyntaxError
        ? appError('storage_corrupt', 'storage', 'Stored working context facts are invalid.')
        : appError(write ? 'storage_write_failed' : 'storage_read_failed', 'storage', 'Working context storage is unavailable.', true));
    }
  }
  function phase(row: PhaseRow): InvoiceWorkContextPhase {
    return InvoiceWorkContextPhaseSchema.parse({ phaseId: row.id, workId: row.work_id, attemptId: row.attempt_id,
      itemId: row.item_id, requestId: row.request_id, kind: row.kind, basis: JSON.parse(row.basis_json), createdAt: row.created_at,
      nativeConversationId: row.native_conversation_id, nativeSubmissionId: row.native_submission_id, consumedAt: row.consumed_at });
  }
  function phaseRow(key: ContextKey): PhaseRow | null {
    return db.query<PhaseRow, [number, number, string]>(
      'SELECT * FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
      .get(key.workId, key.attemptId, key.requestId);
  }
  function checkBinding(context: InvoiceWorkWorkingContext, original: InvoiceWorkContextPhase, code = 'context_binding_conflict') {
    requireFact(context.work.workId === original.workId && context.item.workId === original.workId
      && context.phase.phaseId === original.phaseId && context.phase.attemptId === original.attemptId
      && context.phase.requestId === original.requestId && context.item.itemId === original.itemId
      && context.phase.basis.contextSnapshotId === null && isDeepStrictEqual(context.phase.basis, original.basis)
      && context.item.revision === original.basis.itemRevision
      && original.basis.documentRefs.some(reference => isDeepStrictEqual(reference, context.item.documentRef))
      && isDeepStrictEqual(context.userInputs.map(value => value.inputId), original.basis.inputIds), code);
    requireFact(context.todos.every(value => value.provenance === provenance(value.todo.basis.origin))
      && context.conflicts.every(value => value.provenance === provenance(value.origin)
        && value.sourceRefs.length + value.inputIds.length >= 2)
      && context.confirmedBusinessReferences.every(value => value.provenance ===
        (value.kind === 'user-edit' ? 'user-provided' : 'business-record-reference')), code);
    requireFact(context.todos.every(value => value.todo.workId === original.workId && value.todo.itemId === original.itemId)
      && context.conflicts.every(value => value.workId === original.workId && value.itemId === original.itemId)
      && context.confirmedBusinessReferences.every(value => value.workId === original.workId && value.itemId === original.itemId
        && value.jobId === context.item.jobId && isDeepStrictEqual(value.documentRef, context.item.documentRef)
        && isDeepStrictEqual(value.candidateRef, context.item.candidateRef))
      && context.modelReports.every(value => value.child.workId === original.workId && value.child.itemId === original.itemId
        && value.child.parentAttemptId === original.attemptId), code);
  }
  function checkInstructions(context: InvoiceWorkWorkingContext, code = 'source_invalid') {
    requireFact(context.delegation === undefined && (context.instructions === undefined || context.instructions.role === 'invoice-master'), code);
    const row = db.query<{ configuration_json: string }, [number]>('SELECT configuration_json FROM invoice_works WHERE id=?').get(context.work.workId);
    requireFact(row, code);
    const configuration = PersonalAgentConfigurationSchema.parse(JSON.parse(row.configuration_json)), instructions = context.instructions;
    if (!instructions) {
      requireFact(configuration.preferences === '' && configuration.resources.prompt === null && configuration.resources.enabledSkills.length === 0, code);
      return;
    }
    requireFact(instructions.preferences === configuration.preferences && configuration.extensions.enabledExtensions.length === 0, code);
    const selected = configuration.resources, resources = instructions.resources;
    requireFact(isDeepStrictEqual(resources?.prompt?.ref ?? null, selected.prompt)
      && isDeepStrictEqual(resources?.skills.map(body => body.ref) ?? [], selected.enabledSkills), code);
    if (!resources) return;
    const rawBundle = contents.read({ ownerKind: 'resource-bundle', ownerId: resources.bundleId, relativePath: 'bundle.json' });
    requireFact(rawBundle !== null, code);
    const bundle = ResourceBundleManifestSchema.parse(JSON.parse(decoder.decode(rawBundle)));
    const bodies = [...(resources.prompt ? [resources.prompt] : []), ...resources.skills];
    requireFact(bundle.bundleId === resources.bundleId && bundle.resources.length === bodies.length, code);
    for (const body of bodies) {
      const refKey = resourceRefKey(body.ref), manifest = bundle.resources.find(item => resourceRefKey(item.ref) === refKey)?.manifest;
      const file = bundle.files.find(file => resourceRefKey(file.ref) === refKey && file.path === body.path);
      const original = contents.read({ ownerKind: 'resource-bundle', ownerId: resources.bundleId,
        relativePath: `${versionPath(body.ref)}/${body.path}` });
      requireFact(manifest?.bodyFile === body.path && file && original !== null && file.bytes === original.byteLength
        && decoder.decode(original) === body.text, code);
    }
  }
  function snapshot(row: SnapshotRow): FrozenInvoiceWorkContext {
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(row.context_json));
    const original = phaseRow({ workId: row.work_id, attemptId: row.attempt_id, requestId: row.request_id });
    const owner = db.query<{ personal_agent_id: number; session_id: number }, [number]>(
      "SELECT w.personal_agent_id,w.session_id FROM invoice_works w JOIN sessions s ON s.id=w.session_id WHERE w.id=? AND s.runtime_kind='durable'")
      .get(row.work_id);
    requireFact(id.safeParse(row.id).success && original && original.id === row.phase_id
      && owner?.personal_agent_id === context.work.personalAgentId && owner.session_id === row.session_id
      && row.session_id === context.work.sessionId && row.work_id === context.work.workId
      && row.item_id === context.item.itemId, 'storage_corrupt');
    checkBinding(context, phase(original), 'storage_corrupt');
    if (context.instructions) checkInstructions(context, 'storage_corrupt');
    return { contextId: row.id, context };
  }
  function find(key: ContextKey) {
    const row = db.query<SnapshotRow, [number, number, string]>(
      'SELECT * FROM invoice_work_context_snapshots WHERE work_id=? AND attempt_id=? AND request_id=?')
      .get(key.workId, key.attemptId, key.requestId);
    return row ? snapshot(row) : null;
  }
  function checkCurrent(context: InvoiceWorkWorkingContext, row: PhaseRow, at: string) {
    requireFact(row.closed_at === null && row.consumed_at === null && Date.parse(at) >= Date.parse(row.created_at), 'state_conflict');
    const facts = need(works.readContextInput({ workId: row.work_id, attemptId: row.attempt_id,
      requestId: row.request_id, remainingBudget: context.actions.remainingBudget }));
    const { work, item } = facts;
    requireFact(work.status === 'open' && item.disposition === 'unresolved' && !work.execution.requiresContinue
      && !work.execution.stopUnconfirmed && !['failed', 'cancelled', 'completed'].includes(work.execution.runStatus ?? '')
      && isDeepStrictEqual(context.item, item) && isDeepStrictEqual(context.work, { workId: work.workId,
        personalAgentId: work.personalAgentId, sessionId: work.sessionId, goal: work.goal, status: work.status, counts: work.counts }), 'state_conflict');
    const authorizedInputs = facts.authorizedInputs.map(value => {
      const { request, receipt, continuedBy } = value;
      requireFact(receipt.workId === work.workId && receipt.itemId === item.itemId && receipt.inputId === value.inputId
        && receipt.requestId === request.requestId && receipt.todoId === request.todoId && receipt.revision <= work.revision
        && Date.parse(receipt.receivedAt) <= Date.parse(row.created_at), 'source_invalid');
      requireFact(continuedBy === null
        ? receipt.execution.authorizationAccepted && receipt.execution.attempt.attemptId === row.attempt_id
        : continuedBy.workId === work.workId && continuedBy.execution.authorizationAccepted
          && continuedBy.execution.attempt.attemptId === row.attempt_id && continuedBy.revision > receipt.revision
          && continuedBy.revision <= work.revision && Date.parse(continuedBy.receivedAt) >= Date.parse(receipt.receivedAt)
          && Date.parse(continuedBy.receivedAt) <= Date.parse(row.created_at), 'source_invalid');
      requireFact(!db.query(`SELECT p.id FROM invoice_work_phases p,json_each(p.basis_json,'$.inputIds') i
        WHERE p.work_id=? AND p.consumed_at IS NOT NULL AND i.value=? LIMIT 1`).get(work.workId, value.inputId), 'source_invalid');
      return { provenance: 'user-provided' as const, inputId: value.inputId, requestId: request.requestId,
        todoId: request.todoId, text: request.text, documentRefs: request.materials };
    });
    const historicalInputs = facts.historicalInputReferences.map(value => ({ provenance: 'historical-user-input-reference' as const,
      inputId: value.inputId, requestId: value.receipt.requestId, todoId: value.receipt.todoId,
      phaseId: value.consumedPhase.phaseId, attemptId: value.consumedPhase.attemptId, consumedAt: value.consumedPhase.consumedAt,
      ...(facts.todos.some(todo => todo.applicable && (todo.todoId === value.receipt.todoId || todo.basis.inputIds.includes(value.inputId)))
        ? { content: { provenance: 'user-provided' as const, text: value.request.text, documentRefs: value.request.materials } } : {}) }));
    requireFact(isDeepStrictEqual(context.userInputs, authorizedInputs)
      && isDeepStrictEqual(context.historicalInputReferences, historicalInputs)
      && isDeepStrictEqual(context.todos, facts.todos.map(todo => ({ provenance: provenance(todo.basis.origin), todo })))
      && isDeepStrictEqual(context.confirmedBusinessReferences, facts.confirmedBusinessReferences.map(reference => ({ ...reference,
        provenance: reference.kind === 'user-edit' ? 'user-provided' : 'business-record-reference' })))
      && isDeepStrictEqual(context.conflicts, facts.conflicts.map(conflict => ({ ...conflict, provenance: provenance(conflict.origin) })))
      && isDeepStrictEqual(context.modelReports, facts.modelReports.map(report => ({ ...report, provenance: 'model-self-report' })))
      && isDeepStrictEqual(context.evidenceRefs, facts.evidenceRefs), 'source_invalid');
    requireFact(isDeepStrictEqual(context.actions.tools, facts.allowedTools)
      && isDeepStrictEqual(context.actions.available, work.actions.filter(value => value.itemId === null || value.itemId === item.itemId))
      && context.waitingReason === work.execution.waitingReason, 'source_invalid');
  }
  return {
    save(raw) {
      return operation(true, () => {
        const parsed = saveSchema.safeParse(raw);
        requireFact(parsed.success, 'input_invalid', 'The working context input is invalid.');
        const { context, at } = parsed.data;
        const key = { workId: context.work.workId, attemptId: context.phase.attemptId, requestId: context.phase.requestId };
        const existing = find(key);
        if (existing) {
          requireFact(isDeepStrictEqual(existing.context, context), 'context_binding_conflict', 'The phase request already has a different frozen working context.');
          return existing;
        }
        const original = phaseRow(key);
        requireFact(original, 'context_binding_conflict', 'A working context needs its original frozen product phase.');
        checkBinding(context, phase(original));
        checkCurrent(context, original, at);
        checkInstructions(context);
        const json = JSON.stringify(context);
        requireFact(new TextEncoder().encode(json).byteLength <= RUNTIME_CONFIG.llmPayload.maxWorkspaceContextBytes,
          'context_evidence_too_large', 'The working context exceeds its UTF-8 byte limit.');
        db.query(`INSERT INTO invoice_work_context_snapshots(phase_id,work_id,attempt_id,item_id,session_id,request_id,context_json,created_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(original.id, key.workId, key.attemptId, context.item.itemId,
          context.work.sessionId, key.requestId, json, at);
        const saved = find(key); requireFact(saved, 'storage_corrupt'); return saved;
      });
    },
    get(raw) {
      return operation(false, () => {
        const parsed = keySchema.safeParse(raw); requireFact(parsed.success, 'input_invalid');
        return find(parsed.data);
      });
    },
  };
}
