import { describe, expect, it } from 'bun:test';
import { addDecimal, multiplyDecimal, parseDecimal, roundDecimal, taxAmount, toDecimalString } from '../../packages/shared/src/decimal.ts';
import { CandidateDraftSchema, invoiceToolSchemas } from '@flowmate/contracts';
import type { CandidateDraft, SourceRef } from '@flowmate/contracts';
import { saveInvoiceCandidate } from '../../packages/employee-invoice/src/tools/save_invoice_candidate.ts';
import { evaluateCandidate } from '../../packages/employee-invoice/src/validation.ts';
import { normalizeInvoiceValues } from '../../packages/employee-invoice/src/tools/normalize_invoice_values.ts';

describe('exact invoice decimal arithmetic', () => {
  it('adds 0.1 and 0.2 exactly without converting the amount to Number', () => {
    expect(addDecimal(['0.1', '0.2'])).toBe('0.3');
  });

  it('rounds negative half units away from zero and emits the requested scale', () => {
    expect(roundDecimal('-1.005', 2)).toBe('-1.01');
    expect(roundDecimal('1.005', 2)).toBe('1.01');
  });

  it('calculates product and tax as exact decimal values', () => {
    expect(multiplyDecimal('12.5', '3.2')).toBe('40');
    expect(taxAmount('100.00', '10')).toBe('10');
  });

  it('normalizes negative zero and rejects exponent notation', () => {
    const zero = parseDecimal('-0.000');
    expect(zero === null ? null : toDecimalString(zero)).toBe('0');
    expect(parseDecimal('1e3')).toBeNull();
  });
});

function value(raw: string | null = null, normalized: string | null = null, state: 'present' | 'missing' = 'missing', sources: SourceRef[] = []) {
  return { raw, normalized, state, alternatives: [], sources };
}

function candidateForHeader(): CandidateDraft {
  const source = (blockId: string, quote: string): SourceRef => ({ documentId: 1, version: 'v1', artifactId: 2,
    page: 1, blockId, quote });
  return { fields: {
    invoiceNumber: value(), issueDate: value(), sellerName: value(), sellerTaxId: value(), buyerName: value(), buyerTaxId: value(),
    currency: value('CNY', 'CNY', 'present', [source('b1', 'CNY')]),
    netAmount: value('100.00', '100.00', 'present', [source('b2', '100.00')]),
    taxAmount: value('10.00', '10.00', 'present', [source('b3', '10.00')]),
    totalAmount: value('115.00', '115.00', 'present', [source('b4', '115.00')]),
  }, lines: [], notes: [] };
}

describe('candidate evaluation', () => {
  it('keeps a detailed invalid candidate inside the public validation output contract', () => {
    const candidate = candidateForHeader();
    candidate.lines = Array.from({ length: 40 }, () => ({
      description: value(), quantity: value(), unit: value(), unitPrice: value(),
      netAmount: value('1', '1', 'present'), taxRate: value(), taxAmount: value(), totalAmount: value(),
    }));
    expect(CandidateDraftSchema.safeParse(candidate).success).toBe(true);
    const result = evaluateCandidate(candidate, Array.from({ length: 4 }, (_, index) => ({ index,
      status: 'valid' as const, code: 'parsed_quote_matched' as const })));
    expect(result.violations.find((item) => item.code === 'present_source_missing')?.fieldPaths).toHaveLength(40);
    expect(result.checks.find((item) => item.rule === 'lines-net-total')?.fieldPaths).toHaveLength(41);
    expect(result.issues.find((item) => item.code === 'lines_net_total_mismatch')?.fieldPaths).toHaveLength(41);
    expect(invoiceToolSchemas.validate_invoice_candidate.output.safeParse({ documentRef: { id: 1, version: 'v1' },
      saveable: false, ...result }).success).toBe(true);
  });

  it('preserves a proposed total and reports the exact header arithmetic discrepancy', () => {
    const candidate = candidateForHeader();
    const result = evaluateCandidate(candidate, Array.from({ length: 4 }, (_, index) => ({ index,
      status: 'valid' as const, code: 'parsed_quote_matched' as const })));
    expect(candidate.fields.totalAmount.normalized).toBe('115.00');
    expect(result.checks.find((check) => check.rule === 'header-total')).toMatchObject({
      status: 'failed', actual: '115.00', expected: '110.00', difference: '5.00', tolerance: '0.01',
    });
    expect(result.issues.some((issue) => issue.code === 'header_total_mismatch')).toBe(true);
  });

  it('does not guess ambiguous dates and does not guess an unknown currency', () => {
    const normalized = normalizeInvoiceValues({ items: [
      { kind: 'date', raw: '01/02/2026' }, { kind: 'currency', raw: '$' }, { kind: 'currency', raw: 'XYZ' },
    ] });
    expect(normalized.items).toEqual([
      { index: 0, kind: 'date', raw: '01/02/2026', status: 'ambiguous', value: null,
        alternatives: ['2026-01-02', '2026-02-01'], reason: 'ambiguous_date_order' },
      { index: 1, kind: 'currency', raw: '$', status: 'unsupported', value: null, alternatives: [], reason: 'unsupported_currency' },
      { index: 2, kind: 'currency', raw: 'XYZ', status: 'unsupported', value: null, alternatives: [], reason: 'unsupported_currency' },
    ]);
  });

  it('rejects a forged original-image source during save before any candidate write', async () => {
    const candidate = candidateForHeader();
    candidate.fields.invoiceNumber = value('INV-OLD', 'INV-OLD', 'present', [
      { documentId: 1, version: 'v1', artifactId: 1, page: 1, blockId: null, quote: null },
    ]);
    let saveCalls = 0;
    const documents = { readParsedForRun: () => ({ ok: true, data: { document: { documentRef: { id: 1, version: 'v1' } }, parsed: {} } }) } as never;
    const documentRepository = { get: () => ({ ok: true, data: { status: 'available', parsedArtifactId: 2 } }) } as never;
    const candidates = { save() { saveCalls += 1; throw new Error('must_not_save'); } } as never;
    const tool = saveInvoiceCandidate(documents, documentRepository, candidates, () => '2026-09-29T00:00:00.000Z');
    const result = tool.execute({ documentId: 1, candidate }, { nativeToolCallId: 'forged-image-source',
      signal: new AbortController().signal }, { runId: 3, sessionId: 4,
      scope: { version: 2, allowedTools: ['save_invoice_candidate'], allowedDocumentIds: [1],
        allowedArtifactIds: [2], allowedResourcePaths: [] } });
    await expect(result).rejects.toMatchObject({ code: 'tool_access_denied' });
    expect(saveCalls).toBe(0);
  });
});
