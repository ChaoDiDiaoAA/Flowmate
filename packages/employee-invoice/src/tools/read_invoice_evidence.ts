import { invoiceToolSchemas } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import type { DocumentService } from '@flowmate/data';
import { appError } from '@flowmate/contracts';
import { unwrap } from './definition.ts';
import { sourceFor } from './source.ts';

export const readInvoiceEvidence = (documents: DocumentService) => ({
  name: 'read_invoice_evidence',
  version: '1',
  label: 'Read evidence',
  description: 'Read the full text and source reference of a parsed evidence block; original images are not available.',
  inputSchema: invoiceToolSchemas.read_invoice_evidence.input,
  outputSchema: invoiceToolSchemas.read_invoice_evidence.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, call, context) => {
    if (call.signal.aborted) throw appError('tool_cancelled', 'runtime', 'Evidence reading was cancelled.', true,
      context.runId, context.sessionId, call.nativeToolCallId);
    if (input.kind !== 'parsed' || typeof input.blockId !== 'string') {
      throw appError('tool_invalid_input', 'input', 'An evidence block is required.');
    }
    const loaded = unwrap(documents.readParsedForRun(input.documentId, context));
    const page = loaded.parsed.pages.find((item) => item.page === input.page);
    const block = page?.blocks.find((item) => item.id === input.blockId);
    if (!page || !block) throw appError('tool_invalid_input', 'input', 'The parsed evidence reference does not exist.');
    return { kind: 'parsed', source: sourceFor(loaded.document, page.page, block.id, block.text),
      text: block.text, sourceType: block.sourceType };
  },
} satisfies ToolDefinition<InvoiceToolInput<'read_invoice_evidence'>, InvoiceToolOutput<'read_invoice_evidence'>>);
