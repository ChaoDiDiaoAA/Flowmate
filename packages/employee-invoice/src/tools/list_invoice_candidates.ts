import { invoiceToolSchemas } from '@flowmate/contracts';
import type { CandidateRepository, InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import { unwrap } from './definition.ts';

export const listInvoiceCandidates = (candidates: CandidateRepository) => ({
  name: 'list_invoice_candidates',
  version: '1',
  label: 'List candidates',
  description: 'List saved candidates for the current authorized task with pagination.',
  inputSchema: invoiceToolSchemas.list_invoice_candidates.input,
  outputSchema: invoiceToolSchemas.list_invoice_candidates.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) =>
    unwrap(candidates.listForRun({ runId: context.runId, beforeSequence: input.beforeSequence, limit: input.limit })),
} satisfies ToolDefinition<InvoiceToolInput<'list_invoice_candidates'>, InvoiceToolOutput<'list_invoice_candidates'>>);
