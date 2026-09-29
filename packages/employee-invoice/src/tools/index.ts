import { INVOICE_TOOL_NAMES } from '@flowmate/contracts';
import type { ToolDefinition } from '@flowmate/contracts';
import type { DocumentRepository, DocumentService } from '@flowmate/data';
import type { CandidateRepository } from '@flowmate/contracts';
import { listInvoicePages } from './list_invoice_pages.ts';
import { readInvoiceDocument } from './read_invoice_document.ts';
export { projectInvoiceDocumentPage } from './read_invoice_document.ts';
import { searchInvoiceDocument } from './search_invoice_document.ts';
import { listInvoiceTables } from './list_invoice_tables.ts';
import { readInvoiceEvidence } from './read_invoice_evidence.ts';
import { checkInvoiceSources } from './check_invoice_sources.ts';
import { normalizeInvoiceValuesTool } from './normalize_invoice_values.ts';
import { calculateInvoiceAmountsTool } from './calculate_invoice_amounts.ts';
export { normalizeInvoiceValues } from './normalize_invoice_values.ts';
export { calculateInvoiceAmounts } from './calculate_invoice_amounts.ts';
import { validateInvoiceCandidate } from './validate_invoice_candidate.ts';
import { listInvoiceCandidates } from './list_invoice_candidates.ts';
import { getInvoiceCandidate } from './get_invoice_candidate.ts';
import { compareInvoiceCandidates } from './compare_invoice_candidates.ts';
import { saveInvoiceCandidate } from './save_invoice_candidate.ts';

export function createInvoiceTools(services: { documents: DocumentService; documentRepository: DocumentRepository;
  candidates: CandidateRepository; now: () => string }): readonly ToolDefinition<any, any>[] {
  const tools = [listInvoicePages(services.documents), readInvoiceDocument(services.documents), searchInvoiceDocument(services.documents),
    listInvoiceTables(services.documents), readInvoiceEvidence(services.documents), checkInvoiceSources(services.documents, services.documentRepository),
    normalizeInvoiceValuesTool(), calculateInvoiceAmountsTool(), validateInvoiceCandidate(services.documents, services.documentRepository),
    listInvoiceCandidates(services.candidates), getInvoiceCandidate(services.candidates), compareInvoiceCandidates(services.candidates),
    saveInvoiceCandidate(services.documents, services.documentRepository, services.candidates, services.now)];
  if (tools.length !== INVOICE_TOOL_NAMES.length || tools.some((tool, index) => tool.name !== INVOICE_TOOL_NAMES[index])) {
    throw new Error('invoice_tool_manifest_invalid');
  }
  return Object.freeze(tools);
}
