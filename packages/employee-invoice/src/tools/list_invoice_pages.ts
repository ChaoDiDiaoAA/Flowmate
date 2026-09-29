import type { DocumentService } from '@flowmate/data';
import { invoiceToolSchemas } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import { unwrap } from './definition.ts';

export const listInvoicePages = (documents: DocumentService) => ({
  name: 'list_invoice_pages',
  version: '1',
  label: 'List pages',
  description: 'List page, parsed block, and table counts for an authorized invoice.',
  inputSchema: invoiceToolSchemas.list_invoice_pages.input,
  outputSchema: invoiceToolSchemas.list_invoice_pages.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) => {
    const loaded = unwrap(documents.readParsedForRun(input.documentId, context));
    const pages = loaded.parsed.pages.map((page) => ({ page: page.page, blockCount: page.blocks.length,
      tableCount: page.blocks.filter((block) => block.kind === 'table').length }));
    return { documentRef: loaded.document.documentRef, parsedArtifactId: loaded.document.parsedArtifactId,
      pageCount: pages.length, pages };
  },
} satisfies ToolDefinition<InvoiceToolInput<'list_invoice_pages'>, InvoiceToolOutput<'list_invoice_pages'>>);
