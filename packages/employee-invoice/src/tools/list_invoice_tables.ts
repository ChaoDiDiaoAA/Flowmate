import { invoiceToolSchemas } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import type { DocumentService } from '@flowmate/data';
import { appError } from '@flowmate/contracts';
import { unwrap } from './definition.ts';
import { MAX_RESULT_BYTES, sourceFor } from './source.ts';

export const listInvoiceTables = (documents: DocumentService) => ({
  name: 'list_invoice_tables',
  version: '1',
  label: 'List tables',
  description: 'List parsed table blocks and their previews without inferring table structure.',
  inputSchema: invoiceToolSchemas.list_invoice_tables.input,
  outputSchema: invoiceToolSchemas.list_invoice_tables.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) => {
    const loaded = unwrap(documents.readParsedForRun(input.documentId, context));
    if (input.page !== null && !loaded.parsed.pages.some((page) => page.page === input.page)) {
      throw appError('tool_invalid_input', 'input', 'The requested page does not exist.');
    }
    const blocks = loaded.parsed.pages.filter((page) => input.page === null || page.page === input.page)
      .flatMap((page) => page.blocks.map((block) => ({ page: page.page, block })));
    const cursorIndex = input.afterBlockId === null ? -1 : blocks.findIndex(({ block }) => block.id === input.afterBlockId);
    if (input.afterBlockId !== null && cursorIndex < 0) throw appError('tool_invalid_input', 'input', 'The page cursor is invalid.');
    const tables = blocks.slice(cursorIndex + 1).filter(({ block }) => block.kind === 'table');
    const items = tables.slice(0, input.limit).map(({ page, block }) => ({
      page, blockId: block.id, sourceType: block.sourceType, textLength: block.text.length,
      preview: block.text.slice(0, 256), source: sourceFor(loaded.document, page, block.id, block.text),
    }));
    const response = { documentRef: loaded.document.documentRef, parsedArtifactId: loaded.document.parsedArtifactId,
      tables: items, nextAfterBlockId: tables.length > items.length ? items.at(-1)?.blockId ?? null : null,
      complete: tables.length <= items.length };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) throw appError('tool_result_too_large', 'runtime', 'The table list exceeds the size limit.');
    return response;
  },
} satisfies ToolDefinition<InvoiceToolInput<'list_invoice_tables'>, InvoiceToolOutput<'list_invoice_tables'>>);
