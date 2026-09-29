import { invoiceToolSchemas } from '@flowmate/contracts';
import type { DocumentService } from '@flowmate/data';
import type { DocumentSnapshot, InvoiceToolInput, InvoiceToolOutput, ParsedBlock, Result, ToolDefinition } from '@flowmate/contracts';
import type { StoredParsedDocument } from '@flowmate/data';
import { appError, fail, ok } from '@flowmate/contracts';
import { unwrap } from './definition.ts';
import { MAX_RESULT_BYTES, sourceFor } from './source.ts';

export function projectInvoiceDocumentPage(input: InvoiceToolInput<'read_invoice_document'>,
  loaded: { document: DocumentSnapshot; parsed: StoredParsedDocument }): Result<InvoiceToolOutput<'read_invoice_document'>> {
  const page = loaded.parsed.pages.find((candidate) => candidate.page === input.page);
  if (!page) return fail(appError('tool_invalid_input', 'input', 'The requested page does not exist.'));
  let start = 0;
  if (input.afterBlockId !== null) {
    const cursor = page.blocks.findIndex((block) => block.id === input.afterBlockId);
    if (cursor < 0) return fail(appError('tool_invalid_input', 'input', 'The page cursor does not belong to the requested page.'));
    start = cursor + 1;
  }
  const selected: Array<ParsedBlock & { source: ReturnType<typeof sourceFor> }> = [];
  for (const block of page.blocks.slice(start, start + Math.min(input.limit, 50))) {
    const candidate = { ...block, source: sourceFor(loaded.document, page.page, block.id, block.text) };
    const response = { documentRef: loaded.document.documentRef, parsedArtifactId: loaded.document.parsedArtifactId,
      page: page.page, pageCount: loaded.parsed.pages.length, blocks: [...selected, candidate],
      nextAfterBlockId: null, completePage: false };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) {
      if (selected.length === 0) return fail(appError('tool_result_too_large', 'runtime', 'A complete parsed block exceeds the result size limit.'));
      break;
    }
    selected.push(candidate);
  }
  const completePage = start + selected.length >= page.blocks.length;
  return ok({ documentRef: loaded.document.documentRef, parsedArtifactId: loaded.document.parsedArtifactId,
    page: page.page, pageCount: loaded.parsed.pages.length, blocks: selected,
    nextAfterBlockId: completePage ? null : selected.at(-1)?.id ?? input.afterBlockId, completePage });
}

export const readInvoiceDocument = (documents: DocumentService) => ({
  name: 'read_invoice_document',
  version: '1',
  label: 'Read invoice',
  description: 'Read parsed blocks and source references from one invoice page with pagination.',
  inputSchema: invoiceToolSchemas.read_invoice_document.input,
  outputSchema: invoiceToolSchemas.read_invoice_document.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) =>
    unwrap(projectInvoiceDocumentPage(input, unwrap(documents.readParsedForRun(input.documentId, context)))),
} satisfies ToolDefinition<InvoiceToolInput<'read_invoice_document'>, InvoiceToolOutput<'read_invoice_document'>>);
