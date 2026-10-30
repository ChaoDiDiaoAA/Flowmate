import { invoiceToolSchemas } from '@flowmate/contracts';
import type { StoredParsedDocument } from '@flowmate/data';
import type { DocumentSnapshot, InvoiceToolInput, InvoiceToolOutput, ProductToolContext, Result, SourceRef, ToolDefinition } from '@flowmate/contracts';
import { appError, fail, ok } from '@flowmate/contracts';
import { unwrap, type InvoiceDocumentReader, type InvoiceDocumentRepository } from './definition.ts';

function denied(context: ProductToolContext) {
  return fail(appError('tool_access_denied', 'runtime', 'This run cannot access the document.', false, context.runId, context.sessionId));
}

export function checkSource(source: SourceRef, document: DocumentSnapshot, parsed: StoredParsedDocument):
  { status: 'valid' | 'invalid'; code: 'parsed_quote_matched' | 'reference_mismatch' | 'block_not_found' | 'quote_mismatch' } {
  if (source.documentId !== document.documentRef.id || source.version !== document.documentRef.version
    || source.artifactId !== document.parsedArtifactId) return { status: 'invalid', code: 'reference_mismatch' };
  const page = parsed.pages.find((item) => item.page === source.page);
  const block = page?.blocks.find((item) => item.id === source.blockId);
  if (!block) return { status: 'invalid', code: 'block_not_found' };
  if (!source.quote || !block.text.includes(source.quote)) return { status: 'invalid', code: 'quote_mismatch' };
  return { status: 'valid', code: 'parsed_quote_matched' };
}

export async function checkInvoiceSourcesResult(input: InvoiceToolInput<'check_invoice_sources'>, context: ProductToolContext,
  documents: InvoiceDocumentReader, repository: InvoiceDocumentRepository): Promise<Result<InvoiceToolOutput<'check_invoice_sources'>>> {
  if (!context.scope.allowedDocumentIds.includes(input.documentId)) return denied(context);
  const base = await repository.get(input.documentId);
  if (!base.ok) return base.error.code === 'document_not_found' ? denied(context) : base;
  if (base.data.status !== 'available') return fail(appError('input_unavailable', 'input', 'The document is currently unavailable.', true, context.runId, context.sessionId));
  if (!context.scope.allowedArtifactIds.includes(base.data.parsedArtifactId)) return denied(context);
  if (input.sources.some((source) => source.documentId !== input.documentId
    || !context.scope.allowedDocumentIds.includes(source.documentId)
    || source.artifactId !== base.data.parsedArtifactId
    || !context.scope.allowedArtifactIds.includes(source.artifactId))) return denied(context);
  const loaded = await documents.readParsedForRun(input.documentId, context);
  if (!loaded.ok) return loaded;
  return ok({ documentRef: base.data.documentRef,
    results: input.sources.map((source, index) => ({ index, ...checkSource(source, base.data, loaded.data.parsed) })) });
}

export const checkInvoiceSources = (documents: InvoiceDocumentReader, repository: InvoiceDocumentRepository) => ({
  name: 'check_invoice_sources',
  version: '1',
  label: 'Check sources',
  description: 'Verify candidate sources against the authorized document version, page, block, and quoted text. Copy documentId/version/artifactId exactly from read tools; never shorten or reconstruct version strings. quote must be a nonempty verbatim substring of the referenced block text, not a normalized value, paraphrase or joined text. reference_mismatch means the source identity differs from the returned documentRef; correct the identity before changing the quote.',
  inputSchema: invoiceToolSchemas.check_invoice_sources.input,
  outputSchema: invoiceToolSchemas.check_invoice_sources.output,
  effect: 'READ',
  executionMode: 'parallel',
  execute: async (input, _call, context) => unwrap(await checkInvoiceSourcesResult(input, context, documents, repository)),
} satisfies ToolDefinition<InvoiceToolInput<'check_invoice_sources'>, InvoiceToolOutput<'check_invoice_sources'>>);
