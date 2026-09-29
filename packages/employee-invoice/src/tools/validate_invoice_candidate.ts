import { invoiceToolSchemas } from '@flowmate/contracts';
import type { DocumentRepository, DocumentService } from '@flowmate/data';
import type { InvoiceToolInput, InvoiceToolOutput, ProductToolContext, Result, SourceRef, ToolCallContext, ToolDefinition } from '@flowmate/contracts';
import { appError, fail, ok } from '@flowmate/contracts';
import { evaluateCandidate } from '../validation.ts';
import { checkInvoiceSourcesResult } from './check_invoice_sources.ts';
import { unwrap } from './definition.ts';

function candidateSources(candidate: InvoiceToolInput<'validate_invoice_candidate'>['candidate']): SourceRef[] {
  return [...Object.values(candidate.fields), ...candidate.lines.flatMap((line) => Object.values(line))]
    .flatMap((field) => field.sources);
}

export function validateInvoiceCandidateResult(input: InvoiceToolInput<'validate_invoice_candidate'>, call: ToolCallContext,
  context: ProductToolContext, documents: DocumentService, repository: DocumentRepository):
  Result<InvoiceToolOutput<'validate_invoice_candidate'>> {
  const loaded = documents.readParsedForRun(input.documentId, context);
  if (!loaded.ok) return loaded;
  if (call.signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'The run was cancelled; no candidate was saved.', false,
    context.runId, context.sessionId, call.nativeToolCallId));
  const sources = candidateSources(input.candidate);
  const checked = sources.length > 0 ? checkInvoiceSourcesResult({ documentId: input.documentId, sources }, context, documents, repository)
    : ok({ documentRef: loaded.data.document.documentRef, results: [] });
  if (!checked.ok) return checked;
  if (call.signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'The run was cancelled; no candidate was saved.', false,
    context.runId, context.sessionId, call.nativeToolCallId));
  const result = evaluateCandidate(input.candidate, checked.data.results);
  return ok({ documentRef: loaded.data.document.documentRef, saveable: result.violations.length === 0,
    violations: result.violations, checks: result.checks, issues: result.issues });
}

export const validateInvoiceCandidate = (documents: DocumentService, repository: DocumentRepository) => ({
  name: 'validate_invoice_candidate',
  version: '1',
  label: 'Validate candidate',
  description: 'Read-only check of candidate sources, field states, and amount rules. This does not save a candidate.',
  inputSchema: invoiceToolSchemas.validate_invoice_candidate.input,
  outputSchema: invoiceToolSchemas.validate_invoice_candidate.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, call, context) => unwrap(validateInvoiceCandidateResult(input, call, context, documents, repository)),
} satisfies ToolDefinition<InvoiceToolInput<'validate_invoice_candidate'>, InvoiceToolOutput<'validate_invoice_candidate'>>);
