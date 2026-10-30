import { invoiceToolSchemas } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import { unwrap, type InvoiceCandidateRepository } from './definition.ts';

export const getInvoiceCandidate = (candidates: InvoiceCandidateRepository) => ({
  name: 'get_invoice_candidate',
  version: '1',
  label: 'Get candidate',
  description: 'Read the immutable details of a saved candidate in the current authorized task.',
  inputSchema: invoiceToolSchemas.get_invoice_candidate.input,
  outputSchema: invoiceToolSchemas.get_invoice_candidate.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) =>
    unwrap(await candidates.readForRun({ runId: context.runId, candidateId: input.candidateId,
      ...(context.scope.invoiceWork ? { invoiceWork: context.scope.invoiceWork } : {}) })),
} satisfies ToolDefinition<InvoiceToolInput<'get_invoice_candidate'>, InvoiceToolOutput<'get_invoice_candidate'>>);
