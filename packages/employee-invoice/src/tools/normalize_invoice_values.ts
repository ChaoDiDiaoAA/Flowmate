import { invoiceToolSchemas } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import { parseDecimal, toDecimalString } from '@flowmate/shared';
import { currencyScales, parseDate } from '../validation.ts';

export function normalizeInvoiceValues(input: InvoiceToolInput<'normalize_invoice_values'>): InvoiceToolOutput<'normalize_invoice_values'> {
  return { items: input.items.map(({ kind, raw }, index) => {
    const text = raw.trim();
    if (kind === 'decimal') {
      const value = parseDecimal(text);
      return value
        ? { index, kind, raw, status: 'normalized' as const, value: toDecimalString(value), alternatives: [], reason: null }
        : { index, kind, raw, status: 'unsupported' as const, value: null, alternatives: [], reason: 'unsupported_decimal' };
    }
    if (kind === 'currency') {
      const code = /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : '';
      return code && currencyScales[code] !== undefined
        ? { index, kind, raw, status: 'normalized' as const, value: code, alternatives: [], reason: null }
        : { index, kind, raw, status: 'unsupported' as const, value: null, alternatives: [], reason: 'unsupported_currency' };
    }
    const parsedDate = parseDate(text);
    if (parsedDate.kind === 'valid') return { index, kind, raw, status: 'normalized' as const, value: parsedDate.value, alternatives: [], reason: null };
    if (parsedDate.kind === 'ambiguous') return { index, kind, raw, status: 'ambiguous' as const, value: null,
      alternatives: parsedDate.values, reason: 'ambiguous_date_order' };
    return { index, kind, raw, status: 'unsupported' as const, value: null, alternatives: [], reason: 'unsupported_date' };
  }) };
}

export const normalizeInvoiceValuesTool = () => ({
  name: 'normalize_invoice_values',
  version: '1',
  label: 'Normalize values',
  description: 'Conservatively normalize number, date, or currency text without establishing invoice facts.',
  inputSchema: invoiceToolSchemas.normalize_invoice_values.input,
  outputSchema: invoiceToolSchemas.normalize_invoice_values.output,
  effect: 'PURE',
  executionMode: 'parallel',
  execute: async (input) => normalizeInvoiceValues(input),
} satisfies ToolDefinition<InvoiceToolInput<'normalize_invoice_values'>, InvoiceToolOutput<'normalize_invoice_values'>>);
