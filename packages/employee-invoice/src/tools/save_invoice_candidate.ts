import { invoiceToolSchemas } from '@flowmate/contracts';
import type { DocumentRepository, DocumentService } from '@flowmate/data';
import type { CandidateRepository, InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import { appError } from '@flowmate/contracts';
import { unwrap } from './definition.ts';
import { validateInvoiceCandidateResult } from './validate_invoice_candidate.ts';

export const saveInvoiceCandidate = (documents: DocumentService, documentRepository: DocumentRepository,
  candidates: CandidateRepository, now: () => string) => ({
  name: 'save_invoice_candidate',
  version: '1',
  label: 'Save candidate',
  description: 'Revalidate a candidate\'s sources and rules, then save it locally for the current task. This is the only invoice Tool that saves a candidate; saving does not accept it.',
  inputSchema: invoiceToolSchemas.save_invoice_candidate.input,
  outputSchema: invoiceToolSchemas.save_invoice_candidate.output,
  effect: 'LOCAL_WRITE',
  executionMode: 'sequential',
  execute: async (input, call, context) => {
    const validation = unwrap(validateInvoiceCandidateResult(input, call, context, documents, documentRepository));
    if (call.signal.aborted) throw appError('agent_cancelled', 'runtime', 'The run was cancelled; no candidate was saved.', false,
      context.runId, context.sessionId, call.nativeToolCallId);
    if (!validation.saveable) {
      const sourceFailure = validation.violations.some((item) => item.code.startsWith('source_') || item.code === 'present_source_missing');
      throw appError(sourceFailure ? 'source_invalid' : 'tool_invalid_input', sourceFailure ? 'input' : 'tool',
        sourceFailure ? 'Candidate sources failed validation; no candidate was saved.' : 'Candidate structure or normalized values are invalid; no candidate was saved.', false,
        context.runId, context.sessionId, call.nativeToolCallId);
    }
    const saved = unwrap(candidates.save({ runId: context.runId, sessionId: context.sessionId,
      nativeToolCallId: call.nativeToolCallId, documentId: input.documentId, candidate: input.candidate,
      checks: validation.checks, issues: validation.issues, at: now() }));
    return saved.receipt;
  },
} satisfies ToolDefinition<InvoiceToolInput<'save_invoice_candidate'>, InvoiceToolOutput<'save_invoice_candidate'>>);
