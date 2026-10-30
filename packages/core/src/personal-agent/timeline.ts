import { z } from 'zod';
import { appError, fail, ok, InvoiceWorkTimelineRequestSchema, InvoiceWorkTimelinePageSchema, MAX_INVOICE_WORK_TIMELINE_PAGE_BYTES,
  InvoiceWorkTimelineEntrySchema, InvoiceWorkOperationReceiptSchema, InvoiceWorkDispositionDecisionSchema,
  InvoiceWorkTodoViewSchema, PersonalTaskStopReceiptSchema, invoiceToolSchemas,
  type InvoiceWorkTimelineApi, type InvoiceWorkTimelineCursor, type InvoiceWorkTimelineEntry,
  type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import { readTransaction } from '../storage/reads.ts';

type Fact = InvoiceWorkTimelineCursor & { itemId: number | null };
type Refs = InvoiceWorkTimelineEntry['refs'];
const emptyEvidence = () => ({ resultRecorded: false, returnedToParent: false, parentConsumed: false, stopConfirmed: false });
class TimelineFault extends Error {
  constructor(readonly error: ReturnType<typeof appError>) { super(error.code); }
}
function need<T>(value: Result<T>): T { if (!value.ok) throw new TimelineFault(value.error); return value.data; }
function requireFact(value: unknown): asserts value {
  if (!value) throw new TimelineFault(appError('storage_corrupt', 'storage', 'The timeline fact has no matching original owner.'));
}
const factsSql = `WITH RECURSIVE owned(id,attempt_id,item_id) AS (
  SELECT r.id,a.id,NULL FROM invoice_work_attempts a JOIN runs r ON r.id=a.run_id WHERE a.work_id=?1
  UNION ALL SELECT r.id,p.attempt_id,json_extract(r.scope_json,'$.itemId') FROM runs r JOIN owned p ON r.parent_run_id=p.id
), own_jobs AS (
  SELECT i.id item_id,i.job_id FROM invoice_work_items i JOIN jobs j ON j.id=i.job_id WHERE i.work_id=?1
    AND json_extract(j.input_json,'$.version')=2 AND json_extract(j.input_json,'$.workId')=?1
    AND json_extract(j.input_json,'$.itemId')=i.id
), facts(sourceKind,sourceId,kind,occurredAt,itemId) AS (
  SELECT 'operation',id,CASE kind WHEN 'create' THEN 'work_created' WHEN 'continueWork' THEN 'work_continued'
    WHEN 'supplement' THEN 'supplement_received' ELSE 'work_cancelled' END,received_at,
    CASE WHEN kind='supplement' THEN json_extract(receipt_json,'$.itemId') ELSE NULL END
    FROM invoice_work_operations WHERE work_id=?1 AND kind!='disposeItem'
  UNION ALL SELECT 'work',id,'work_completed',ended_at,NULL FROM invoice_works WHERE id=?1 AND status='completed'
  UNION ALL SELECT 'item',id,'item_disposed',disposed_at,id FROM invoice_work_items WHERE work_id=?1 AND disposition!='unresolved'
  UNION ALL SELECT 'todo',id,'todo_created',created_at,item_id FROM invoice_work_todos WHERE work_id=?1
  UNION ALL SELECT 'todo',id,'todo_superseded',superseded_at,item_id FROM invoice_work_todos WHERE work_id=?1 AND superseded_at IS NOT NULL
  UNION ALL SELECT 'attempt',id,'attempt_created',created_at,NULL FROM invoice_work_attempts WHERE work_id=?1
  UNION ALL SELECT 'attempt',id,'attempt_stop_requested',stop_requested_at,NULL FROM invoice_work_attempts WHERE work_id=?1 AND stop_requested_at IS NOT NULL
  UNION ALL SELECT 'attempt',id,'attempt_stopped',stopped_at,NULL FROM invoice_work_attempts WHERE work_id=?1 AND stopped_at IS NOT NULL
  UNION ALL SELECT 'business_event',e.id,e.type,e.occurred_at,j.item_id FROM business_events e JOIN own_jobs j ON j.job_id=e.job_id
    WHERE e.type IN ('candidate_generated','candidate_edited','candidate_accepted','candidate_rejected','candidate_exported')
      AND (e.run_id IS NULL OR EXISTS(SELECT 1 FROM owned WHERE id=e.run_id))
  UNION ALL SELECT 'run',r.id,'run_created',r.created_at,o.item_id FROM runs r JOIN owned o ON o.id=r.id
  UNION ALL SELECT 'run',r.id,'run_started',r.started_at,o.item_id FROM runs r JOIN owned o ON o.id=r.id WHERE r.started_at IS NOT NULL
  UNION ALL SELECT 'run',r.id,'run_'||r.status,r.ended_at,o.item_id FROM runs r JOIN owned o ON o.id=r.id WHERE r.ended_at IS NOT NULL
  UNION ALL SELECT 'run',r.id,'run_stop_requested',r.cancel_requested_at,o.item_id FROM runs r JOIN owned o ON o.id=r.id WHERE r.cancel_requested_at IS NOT NULL
  UNION ALL SELECT 'run',r.id,'run_stop_confirmed',r.stopped_at,o.item_id FROM runs r JOIN owned o ON o.id=r.id
    WHERE r.stopped_at IS NOT NULL AND json_extract(r.cleanup_json,'$.stopped')=1 AND json_extract(r.cleanup_json,'$.lateObservationRequired')=0
  UNION ALL SELECT 'run',r.id,'child_result_recorded',r.ended_at,o.item_id FROM runs r JOIN owned o ON o.id=r.id
    WHERE r.kind='subagent' AND r.output_json IS NOT NULL AND r.ended_at IS NOT NULL
  UNION ALL SELECT 'tool_call',t.id,'child_result_returned',json_extract(t.delivery_json,'$.messageObservedAt'),o.item_id
    FROM runs c JOIN owned o ON o.id=c.id JOIN tool_calls t ON t.id=c.origin_tool_call_id
    JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id WHERE c.kind='subagent' AND c.output_json IS NOT NULL
      AND b.feedback_native_entry_id IS NOT NULL AND json_extract(t.delivery_json,'$.messageObservedAt') IS NOT NULL
  UNION ALL SELECT 'tool_call',t.id,'child_result_consumed',b.parent_received_at,o.item_id
    FROM runs c JOIN owned o ON o.id=c.id JOIN tool_calls t ON t.id=c.origin_tool_call_id
    JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id WHERE c.kind='subagent' AND c.output_json IS NOT NULL
      AND b.feedback_native_entry_id IS NOT NULL AND json_extract(t.delivery_json,'$.messageObservedAt') IS NOT NULL
      AND b.parent_received_model_task_id IS NOT NULL AND b.parent_received_at IS NOT NULL
  UNION ALL SELECT 'tool_call',t.id,'delegation_stop_confirmed',t.stopped_at,o.item_id
    FROM runs c JOIN owned o ON o.id=c.id JOIN tool_calls t ON t.id=c.origin_tool_call_id WHERE c.kind='subagent'
      AND t.stopped_at IS NOT NULL AND json_extract(t.cleanup_json,'$.stopped')=1
      AND c.stopped_at IS NOT NULL AND json_extract(c.cleanup_json,'$.stopped')=1
      AND json_extract(c.cleanup_json,'$.lateObservationRequired')=0
) `;

function invoiceRefs(store: SqlDatabaseStore, workId: number, itemId: number | null): Refs {
  if (itemId === null) return {};
  const item = store.db.query<{ job_id: number | null; document_id: number; document_version: string }, [number, number]>(
    'SELECT job_id,document_id,document_version FROM invoice_work_items WHERE work_id=? AND id=?').get(workId, itemId);
  requireFact(item);
  return { documentRef: { id: item.document_id, version: item.document_version }, ...(item.job_id === null ? {} : { jobId: item.job_id }) };
}

function childEvidence(store: SqlDatabaseStore, childRunId: number) {
  const child = need(store.runs.get(childRunId));
  requireFact(child.kind === 'subagent' && 'runtimeKind' in child && child.runtimeKind === 'durable');
  const call = need(store.toolCalls.getById(child.originToolCallId));
  const binding = store.db.query<{ feedback_native_entry_id: number | null; parent_received_model_task_id: number | null; parent_received_at: string | null }, [number]>(
    'SELECT feedback_native_entry_id,parent_received_model_task_id,parent_received_at FROM invoice_work_tool_calls WHERE tool_call_id=?').get(call.toolCallId);
  requireFact(binding && call.toolName === 'Agent' && call.runId === child.parentRunId);
  const resultRecorded = child.output !== null;
  const returnedToParent = resultRecorded && binding.feedback_native_entry_id !== null && call.delivery.messageObservedAt !== null;
  const parentConsumed = returnedToParent && binding.parent_received_model_task_id !== null && binding.parent_received_at !== null;
  return { child, call, binding, evidence: { resultRecorded, returnedToParent, parentConsumed,
    stopConfirmed: child.cleanup.stopped === true && child.cleanup.lateObservationRequired === false && child.stoppedAt !== null } };
}

function project(store: SqlDatabaseStore, workId: number, fact: Fact): InvoiceWorkTimelineEntry {
  let refs = invoiceRefs(store, workId, fact.itemId), evidence = emptyEvidence();
  let summary: string = fact.kind.replaceAll('_', ' ');
  if (fact.sourceKind === 'operation') {
    const row = store.db.query<{ id: number; request_id: string; receipt_json: string }, [number, number]>(
      'SELECT id,request_id,receipt_json FROM invoice_work_operations WHERE work_id=? AND id=?').get(workId, fact.sourceId);
    requireFact(row);
    const receipt = InvoiceWorkOperationReceiptSchema.parse(JSON.parse(row.receipt_json));
    requireFact(receipt.workId === workId && receipt.requestId === row.request_id);
    refs = { ...refs, operationId: row.id, requestId: row.request_id };
    if ('execution' in receipt && receipt.execution.attempt) refs.attemptId = receipt.execution.attempt.attemptId;
    if (receipt.operation === 'create' || receipt.operation === 'continueWork' || receipt.operation === 'supplement')
      summary = `Original ${receipt.operation} request saved; execution decision: ${receipt.execution.kind}`;
    if (receipt.operation === 'supplement') { refs.todoId = receipt.todoId; refs.inputId = receipt.inputId; }
  } else if (fact.sourceKind === 'item') {
    const row = store.db.query<{ decision_json: string; candidate_id: number | null; candidate_sequence: number | null }, [number, number]>(
      'SELECT decision_json,candidate_id,candidate_sequence FROM invoice_work_items WHERE work_id=? AND id=?').get(workId, fact.sourceId);
    requireFact(row);
    const decision = InvoiceWorkDispositionDecisionSchema.parse(JSON.parse(row.decision_json));
    summary = `Invoice ${decision.kind}`;
    const operation = store.db.query<{ id: number; request_id: string }, [number, number]>(`SELECT id,request_id FROM invoice_work_operations
      WHERE work_id=? AND kind='disposeItem' AND json_extract(receipt_json,'$.itemId')=? ORDER BY id LIMIT 1`).get(workId, fact.sourceId);
    if (operation) { refs.operationId = operation.id; refs.requestId = operation.request_id; }
    if (decision.kind === 'accepted') { refs.candidateRef = decision.candidateRef; refs.operationRef = decision.acceptRequest.operationRef; }
  } else if (fact.sourceKind === 'todo') {
    const row = store.db.query<{ revision: number; definition_json: string; superseded_at: string | null }, [number, number]>(
      'SELECT revision,definition_json,superseded_at FROM invoice_work_todos WHERE work_id=? AND id=?').get(workId, fact.sourceId);
    requireFact(row && fact.itemId !== null);
    const todo = InvoiceWorkTodoViewSchema.parse({ ...JSON.parse(row.definition_json), todoId: fact.sourceId, workId,
      itemId: fact.itemId, revision: row.revision, applicable: row.superseded_at === null });
    refs.todoId = todo.todoId;
    if (todo.basis.candidateRef) refs.candidateRef = todo.basis.candidateRef;
    summary = `${fact.kind === 'todo_created' ? 'Todo created' : 'Todo superseded'}${todo.fieldPath ? `: ${todo.fieldPath}` : ''}`;
  } else if (fact.sourceKind === 'attempt') {
    const row = store.db.query<{ id: number; run_id: number | null; trigger_request_id: string }, [number, number]>(
      'SELECT id,run_id,trigger_request_id FROM invoice_work_attempts WHERE work_id=? AND id=?').get(workId, fact.sourceId);
    requireFact(row); refs.attemptId = row.id;
    if (row.run_id !== null) refs.runId = row.run_id;
    if (fact.kind === 'attempt_created') refs.requestId = row.trigger_request_id;
    if (fact.kind === 'attempt_stop_requested') {
      const original = store.db.query<{ receipt_json: string }, [number, number]>(`SELECT receipt_json FROM invoice_work_attempt_stop_requests
        WHERE work_id=? AND attempt_id=? AND json_extract(receipt_json,'$.accepted')=1 ORDER BY received_at,request_id LIMIT 1`).get(workId, row.id);
      if (original) {
        const receipt = PersonalTaskStopReceiptSchema.parse(JSON.parse(original.receipt_json));
        requireFact(receipt.workId === workId && receipt.attemptId === row.id); refs.requestId = receipt.requestId;
      }
    }
    evidence.stopConfirmed = fact.kind === 'attempt_stopped';
  } else if (fact.sourceKind === 'business_event') {
    const row = store.db.query<{ job_id: number; candidate_id: number | null; artifact_id: number | null; operation_ref: string; run_id: number | null }, [number]>(
      'SELECT job_id,candidate_id,artifact_id,operation_ref,run_id FROM business_events WHERE id=?').get(fact.sourceId);
    requireFact(row && row.candidate_id !== null);
    const original = need(store.candidates.readByJob({ jobId: row.job_id, candidateId: row.candidate_id })), candidate = original.candidate;
    refs = { ...refs, jobId: row.job_id, candidateRef: { id: candidate.candidateId, sequence: candidate.sequence },
      documentRef: original.documentRef, operationRef: row.operation_ref };
    if (row.run_id !== null) refs.runId = row.run_id;
    if (candidate.toolCallId !== null) {
      refs.toolCallId = candidate.toolCallId;
      const call = need(store.toolCalls.getById(candidate.toolCallId));
      const args = invoiceToolSchemas.save_invoice_candidate.input.parse(call.args.final);
      if (args.childReportRefs) refs.childReportRefs = args.childReportRefs;
    }
    if (row.artifact_id !== null) refs.artifactId = row.artifact_id;
    evidence.resultRecorded = true;
    summary = `${fact.kind.replaceAll('_', ' ')}; ${candidate.checks.length} saved checks, ${candidate.checks.filter(check => check.status === 'failed').length} failed; ${candidate.issueCount} issues`;
  } else if (fact.sourceKind === 'run') {
    const run = need(store.runs.get(fact.sourceId));
    requireFact('runtimeKind' in run && run.runtimeKind === 'durable' && run.scope.workId === workId);
    refs.runId = run.runId; refs.attemptId = run.scope.attemptId;
    evidence.resultRecorded = run.output !== null;
    evidence.stopConfirmed = run.cleanup.stopped === true && run.cleanup.lateObservationRequired === false && run.stoppedAt !== null;
    if (run.kind === 'subagent') {
      const actual = childEvidence(store, run.runId); evidence = actual.evidence;
      refs.childRunId = run.runId; refs.parentRunId = run.parentRunId; refs.originToolCallId = run.originToolCallId;
    }
    if (fact.kind === 'run_failed' && run.error) summary += `: ${run.error.code}`;
  } else if (fact.sourceKind === 'tool_call') {
    const child = need(store.runs.getByOriginToolCall(fact.sourceId)); requireFact(child && child.kind === 'subagent');
    const actual = childEvidence(store, child.runId);
    requireFact(actual.child.scope.workId === workId && actual.child.scope.itemId === fact.itemId);
    refs = { ...refs, attemptId: actual.child.scope.attemptId, runId: actual.child.runId, childRunId: actual.child.runId,
      parentRunId: actual.child.parentRunId, originToolCallId: fact.sourceId, toolCallId: fact.sourceId };
    if (actual.binding.feedback_native_entry_id !== null) refs.nativeEntryId = actual.binding.feedback_native_entry_id;
    if (actual.binding.parent_received_model_task_id !== null) refs.nativeModelTaskId = actual.binding.parent_received_model_task_id;
    evidence = actual.evidence;
    if (fact.kind === 'delegation_stop_confirmed') evidence.stopConfirmed &&= actual.call.cleanup.stopped && actual.call.stoppedAt !== null;
  }
  return InvoiceWorkTimelineEntrySchema.parse({ ...fact, workId, summary, refs, evidence,
    key: JSON.stringify([fact.sourceKind, fact.sourceId, fact.kind]) });
}

/** Live committed facts, read under one owner snapshot; refresh merges late proof by its original key. */
export function createInvoiceWorkTimelineService(options: { database: Pick<DbHandle, 'read'> }): InvoiceWorkTimelineApi {
  return { timeline: async raw => {
    const parsed = InvoiceWorkTimelineRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'The timeline request is invalid.'));
    try { return await options.database.read(store => readTransaction(store.db, () => {
      const { workId, before, limit } = parsed.data;
      need(store.invoiceWorks.get({ view: 'work', workId, limit: 1 }));
      if (before) {
        const original = store.db.query<Fact, [number, string, number, string, string]>(factsSql + `SELECT * FROM facts
          WHERE sourceKind=?2 AND sourceId=?3 AND kind=?4 AND julianday(occurredAt)=julianday(?5) LIMIT 1`)
          .get(workId, before.sourceKind, before.sourceId, before.kind, before.occurredAt);
        if (!original) return fail(appError('input_invalid', 'input', 'The timeline cursor does not belong to this Work.'));
      }
      const rows = store.db.query<Fact, [number, string | null, string | null, number | null, string | null, number]>(factsSql + `SELECT * FROM facts
        WHERE ?2 IS NULL OR julianday(occurredAt)<julianday(?2) OR (julianday(occurredAt)=julianday(?2) AND
          (sourceKind<?3 COLLATE BINARY OR (sourceKind=?3 AND (sourceId<?4 OR (sourceId=?4 AND kind<?5 COLLATE BINARY)))))
        ORDER BY julianday(occurredAt) DESC,sourceKind COLLATE BINARY DESC,sourceId DESC,kind COLLATE BINARY DESC LIMIT ?6`)
        .all(workId, before?.occurredAt ?? null, before?.sourceKind ?? null, before?.sourceId ?? null, before?.kind ?? null, limit + 1);
      const entries: InvoiceWorkTimelineEntry[] = [];
      for (const row of rows.slice(0, limit)) {
        const entry = project(store, workId, row);
        const page = { workId, semantics: 'live-facts', entries: [...entries, entry], nextBefore: rows.length > entries.length + 1
          ? { occurredAt: entry.occurredAt, sourceKind: entry.sourceKind, sourceId: entry.sourceId, kind: entry.kind } : null };
        if (new TextEncoder().encode(JSON.stringify(page)).byteLength > MAX_INVOICE_WORK_TIMELINE_PAGE_BYTES) {
          if (entries.length === 0) throw new TimelineFault(appError('storage_corrupt', 'storage', 'The original timeline fact exceeds its page size limit.'));
          break;
        }
        entries.push(entry);
      }
      const last = entries.at(-1), nextBefore = rows.length > entries.length && last
        ? { occurredAt: last.occurredAt, sourceKind: last.sourceKind, sourceId: last.sourceId, kind: last.kind } : null;
      return ok(InvoiceWorkTimelinePageSchema.parse({ workId, semantics: 'live-facts', entries, nextBefore }));
    })); } catch (error) {
      return fail(error instanceof TimelineFault ? error.error : appError(error instanceof z.ZodError ? 'storage_corrupt' : 'storage_read_failed',
        'storage', 'The original committed timeline facts could not be read.', true));
    }
  } };
}
