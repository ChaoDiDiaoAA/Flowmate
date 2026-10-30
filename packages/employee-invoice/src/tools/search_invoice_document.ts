import { invoiceToolSchemas, MAX_INVOICE_SEARCH_EXCERPT_CHARS } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import { appError } from '@flowmate/contracts';
import { unwrap, type InvoiceDocumentReader } from './definition.ts';
import { MAX_RESULT_BYTES, sourceFor } from './source.ts';

export const searchInvoiceDocument = (documents: InvoiceDocumentReader) => ({
  name: 'search_invoice_document',
  version: '1',
  label: 'Search invoice',
  description: 'Find exact, case-sensitive text matches in authorized parsed invoice content.',
  inputSchema: invoiceToolSchemas.search_invoice_document.input,
  outputSchema: invoiceToolSchemas.search_invoice_document.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) => {
    if (!input.query.trim()) throw appError('tool_invalid_input', 'input', 'Search text cannot be empty.');
    const loaded = unwrap(await documents.readParsedForRun(input.documentId, context));
    if (input.page !== null && !loaded.parsed.pages.some((page) => page.page === input.page)) {
      throw appError('tool_invalid_input', 'input', 'The requested page does not exist.');
    }
    const flattened = loaded.parsed.pages.flatMap((page) => page.blocks.map((block) => ({ page: page.page, block })))
      .filter((item) => input.page === null || item.page === input.page);
    const cursorIndex = input.afterBlockId === null ? -1 : flattened.findIndex((item) => item.block.id === input.afterBlockId);
    if (input.afterBlockId !== null && cursorIndex < 0) throw appError('tool_invalid_input', 'input', 'The page cursor is invalid.');
    const matches = flattened.slice(cursorIndex + 1).flatMap(({ page, block }) => {
      const index = block.text.indexOf(input.query);
      if (index < 0) return [];
      const excerpt = block.text.slice(index, index + MAX_INVOICE_SEARCH_EXCERPT_CHARS);
      return [{ page, blockId: block.id, kind: block.kind, excerpt, source: sourceFor(loaded.document, page, block.id, excerpt) }];
    });
    const items = matches.slice(0, input.limit);
    const response = { documentRef: loaded.document.documentRef, parsedArtifactId: loaded.document.parsedArtifactId,
      query: input.query, matches: items, nextAfterBlockId: matches.length > items.length ? items.at(-1)?.blockId ?? null : null,
      complete: matches.length <= items.length };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) throw appError('tool_result_too_large', 'runtime', 'Search results exceed the size limit.');
    return response;
  },
} satisfies ToolDefinition<InvoiceToolInput<'search_invoice_document'>, InvoiceToolOutput<'search_invoice_document'>>);
