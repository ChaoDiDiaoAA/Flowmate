import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, DurableSubagentRunScopeSchema, DurableSubagentRunOutputSchema,
  InvoiceWorkWorkingContextSchema, InvoiceWorkChildReferenceSchema, ToolCallDeliverySchema,
  invoiceToolSchemas, InvoiceCandidateChildReportReferenceSchema, type CandidateDraft, type InvoiceCandidateChildReportReference,
  type InvoiceWorkContextModelReport, type Result, type SourceRef } from '@flowmate/contracts';
import type { SynchronousDatabaseExecutor } from '../storage/write-coordinator.ts';

type Owner = { workId: number; itemId: number; attemptId: number; phaseId: number; runId: number };

/** Adoption is explicit in the original save ToolCall; source matching does not infer a model's conclusion. */
export function readInvoiceCandidateChildReports(db: SynchronousDatabaseExecutor, owner: Owner,
  refs: readonly InvoiceCandidateChildReportReference[], candidate: CandidateDraft,
  candidateRef: { id: number; sequence: number } | null): Result<InvoiceWorkContextModelReport[]> {
  const invalid = () => fail<InvoiceWorkContextModelReport[]>(appError('source_invalid', 'input',
    'The adopted child report does not match this invoice phase, field, original result or evidence.'));
  try {
    const phase = db.query<{ context_json: string }, [number, number, number, number]>(
      'SELECT context_json FROM invoice_work_context_snapshots WHERE phase_id=? AND work_id=? AND attempt_id=? AND item_id=?')
      .get(owner.phaseId, owner.workId, owner.attemptId, owner.itemId);
    if (!phase) return invalid();
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(phase.context_json));
    // The child context omits historical input bodies; the parent seeing one is not proof of child delivery.
    const availableInputs = new Set(context.userInputs.map(value => value.inputId));
    const reports: InvoiceWorkContextModelReport[] = [];
    const unique = new Set<string>();
    for (const ref of z.array(InvoiceCandidateChildReportReferenceSchema).min(1).max(50).parse(refs)) {
      const key = JSON.stringify([ref.childRunId, ref.fieldPath]);
      if (unique.has(key)) return invalid();
      unique.add(key);
      const field = ref.fieldPath.startsWith('fields.')
        ? candidate.fields[ref.fieldPath.slice(7) as keyof CandidateDraft['fields']]
        : (() => { const [, index, name] = ref.fieldPath.split('.');
          return candidate.lines[Number(index)]?.[name as keyof CandidateDraft['lines'][number]]; })();
      if (!field || !('sources' in field) || ref.sourceRefs.some(source => !field.sources.some(value => isDeepStrictEqual(value, source)))
        || ref.inputIds.some(inputId => !availableInputs.has(inputId))) return invalid();
      const child = db.query<{ id: number; parent_run_id: number; origin_tool_call_id: number; status: string;
        scope_json: string; output_json: string | null; cleanup_json: string; stopped_at: string | null }, [number]>(
        "SELECT id,parent_run_id,origin_tool_call_id,status,scope_json,output_json,cleanup_json,stopped_at FROM runs WHERE id=? AND kind='subagent'")
        .get(ref.childRunId);
      if (!child || child.parent_run_id !== owner.runId || child.status !== 'completed' || child.output_json === null) return invalid();
      const scope = DurableSubagentRunScopeSchema.parse(JSON.parse(child.scope_json));
      const output = DurableSubagentRunOutputSchema.parse(JSON.parse(child.output_json));
      const cleanup = z.object({ stopped: z.boolean(), lateObservationRequired: z.boolean() }).passthrough().parse(JSON.parse(child.cleanup_json));
      if (scope.workId !== owner.workId || scope.itemId !== owner.itemId || scope.attemptId !== owner.attemptId || scope.parentRunId !== owner.runId
        || scope.phaseId !== owner.phaseId || scope.originToolCallId !== child.origin_tool_call_id
        || scope.parentRequestId !== context.phase.requestId
        || !cleanup.stopped || cleanup.lateObservationRequired || child.stopped_at === null || output.partial) return invalid();
      const origin = db.query<{ delivery_json: string; result_json: string | null; parent_received_at: string | null }, [number, number, number]>(
        `SELECT t.delivery_json,t.result_json,b.parent_received_at FROM tool_calls t
         JOIN invoice_work_tool_calls b ON b.tool_call_id=t.id WHERE t.id=? AND t.run_id=? AND b.phase_id=?
         AND t.tool_name='Agent' AND t.status='succeeded'`)
        .get(child.origin_tool_call_id, owner.runId, owner.phaseId);
      if (!origin || origin.result_json === null || origin.parent_received_at === null) return invalid();
      const delivery = ToolCallDeliverySchema.parse(JSON.parse(origin.delivery_json));
      if (delivery.messageObservedAt === null) return invalid();
      const reads = db.query<{ tool_name: string; result_json: string }, [number]>(
        "SELECT tool_name,result_json FROM tool_calls WHERE run_id=? AND status='succeeded' AND tool_name IN ('read_invoice_document','read_invoice_evidence')")
        .all(child.id);
      const observedSources: Array<{ source: SourceRef; text: string }> = reads.flatMap(read => {
        const result = JSON.parse(read.result_json);
        if (result.status !== 'succeeded') return [];
        if (read.tool_name === 'read_invoice_document')
          return invoiceToolSchemas.read_invoice_document.output.parse(result.data).blocks.map(block => ({ source: block.source, text: block.text }));
        const evidence = invoiceToolSchemas.read_invoice_evidence.output.parse(result.data);
        return [{ source: evidence.source, text: evidence.text }];
      });
      if (ref.sourceRefs.some(source => !observedSources.some(observed => {
        const { quote, ...identity } = source, { quote: _quote, ...original } = observed.source;
        return quote !== null && isDeepStrictEqual(identity, original) && observed.text.includes(quote);
      }))) return invalid();
      const originalResult = JSON.parse(origin.result_json);
      if (originalResult.status !== 'succeeded' || originalResult.data?.details?.childRunId !== child.id
        || originalResult.data.details.text !== output.text) return invalid();
      reports.push({ child: InvoiceWorkChildReferenceSchema.parse({ runtimeKind: 'durable', kind: 'subagent',
        workId: owner.workId, itemId: owner.itemId, parentAttemptId: owner.attemptId, childRunId: child.id,
        originToolCallId: child.origin_tool_call_id, role: 'invoice-evidence-checker', runStatus: child.status,
        resultRecorded: true, delivery, stopConfirmed: true, stoppedAt: child.stopped_at, parentModelReceivedAt: origin.parent_received_at }),
      candidateRef, fieldPath: ref.fieldPath, summary: output.text.slice(0, 4096), documentRefs: context.phase.basis.documentRefs,
      inputIds: ref.inputIds, sourceRefs: ref.sourceRefs.map(({ quote: _quote, ...source }) => source) });
    }
    return ok(reports);
  } catch { return invalid(); }
}
