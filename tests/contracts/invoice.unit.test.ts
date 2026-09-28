import { describe, expect, it } from 'bun:test';
import type * as InvoiceContracts from '../../packages/contracts/src/invoice.ts';

const invoiceContractsPromise: Promise<typeof InvoiceContracts | null> = import(
  ['..', '..', 'packages', 'contracts', 'src', 'invoice.ts'].join('/')
).catch(() => null);

const field = {
  raw: null,
  normalized: null,
  state: 'missing',
  alternatives: [],
  sources: [],
} as const;

const candidate = {
  fields: {
    invoiceNumber: field,
    issueDate: field,
    sellerName: field,
    sellerTaxId: field,
    buyerName: field,
    buyerTaxId: field,
    currency: field,
    netAmount: field,
    taxAmount: field,
    totalAmount: field,
  },
  lines: [],
  notes: [],
};

describe('P3 invoice tool contracts', () => {
  it('defines thirteen strict input and output schemas and bounds candidate and arithmetic inputs', async () => {
    const invoiceContracts = await invoiceContractsPromise;
    expect(invoiceContracts).not.toBeNull();
    if (!invoiceContracts) return;
    const { CandidateDraftSchema, INVOICE_TOOL_NAMES, invoiceToolSchemas } = invoiceContracts;
    expect(INVOICE_TOOL_NAMES).toEqual([
      'list_invoice_pages',
      'read_invoice_document',
      'search_invoice_document',
      'list_invoice_tables',
      'read_invoice_evidence',
      'check_invoice_sources',
      'normalize_invoice_values',
      'calculate_invoice_amounts',
      'validate_invoice_candidate',
      'list_invoice_candidates',
      'get_invoice_candidate',
      'compare_invoice_candidates',
      'save_invoice_candidate',
    ]);
    expect(Object.keys(invoiceToolSchemas)).toEqual([...INVOICE_TOOL_NAMES]);
    for (const name of INVOICE_TOOL_NAMES) {
      expect(invoiceToolSchemas[name].input).toBeDefined();
      expect(invoiceToolSchemas[name].output).toBeDefined();
    }

    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: 1, page: 1, afterBlockId: null, limit: 50,
    }).success).toBe(true);
    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: 1, page: 1, afterBlockId: null, limit: 50, path: 'C:\\secret',
    }).success).toBe(false);
    expect(invoiceToolSchemas.read_invoice_document.input.safeParse({
      documentId: '1', page: 1, afterBlockId: null, limit: 50,
    }).success).toBe(false);
    expect(CandidateDraftSchema.safeParse(candidate).success).toBe(true);
    expect(CandidateDraftSchema.safeParse({ ...candidate, status: 'accepted' }).success).toBe(false);
    expect(CandidateDraftSchema.safeParse({
      ...candidate,
      fields: { ...candidate.fields, invoiceNumber: { ...field, extra: 'x' } },
    }).success).toBe(false);
    expect(CandidateDraftSchema.safeParse({
      ...candidate,
      lines: Array.from({ length: 201 }, () => ({})),
    }).success).toBe(false);
    expect(invoiceToolSchemas.calculate_invoice_amounts.input.safeParse({
      operation: 'sum', values: ['0.1', '0.2'], scale: 2,
    }).success).toBe(true);
    expect(invoiceToolSchemas.calculate_invoice_amounts.input.safeParse({
      operation: 'sum', values: ['1e3'], scale: 2,
    }).success).toBe(false);
    expect(invoiceToolSchemas.calculate_invoice_amounts.input.safeParse({
      operation: 'sum', values: ['1'], scale: 2, expression: '1+1',
    }).success).toBe(false);
  });
});
