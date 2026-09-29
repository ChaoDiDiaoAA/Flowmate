import { describe, expect, it } from 'bun:test';
import { addDecimal, multiplyDecimal, parseDecimal, roundDecimal, taxAmount, toDecimalString } from '../../packages/shared/src/decimal.ts';
import type { CandidateDraft, SourceRef } from '@flowmate/contracts';
import { evaluateCandidate, normalizeInvoiceValues } from '../../packages/employee-invoice/src/validation.ts';

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
});
