import { invoiceToolSchemas } from '@flowmate/contracts';
import type { InvoiceToolInput, InvoiceToolOutput, ToolDefinition } from '@flowmate/contracts';
import { addDecimal, multiplyDecimal, roundDecimal, taxAmount } from '@flowmate/shared';

export function calculateInvoiceAmounts(input: InvoiceToolInput<'calculate_invoice_amounts'>): InvoiceToolOutput<'calculate_invoice_amounts'> {
  const exact = input.operation === 'sum' ? addDecimal(input.values)
    : input.operation === 'product' ? multiplyDecimal(input.quantity, input.unitPrice)
      : taxAmount(input.netAmount, input.taxRate);
  return { operation: input.operation, exact, rounded: input.scale === null ? null : roundDecimal(exact, input.scale),
    scale: input.scale, rounding: input.scale === null ? null : 'half_away_from_zero' };
}

export const calculateInvoiceAmountsTool = () => ({
  name: 'calculate_invoice_amounts',
  version: '1',
  label: 'Calculate amounts',
  description: 'Calculate exact decimal strings; no commas, exponents or numeric JSON values. Choose one strict branch and always provide scale (null or integer 0-6): sum {"operation":"sum","values":["100.00","10.00"],"scale":2}; product {"operation":"product","quantity":"2","unitPrice":"12.50","scale":2}; tax {"operation":"tax","netAmount":"100.00","taxRate":"10","scale":2}. taxRate is a percentage: 10 means 10%, while 0.1 means 0.1%. Do not mix branch fields. Sum accepts 1-200 values; decimals have at most 18 integer and 6 fractional digits. Round only the exact final result.',
  inputSchema: invoiceToolSchemas.calculate_invoice_amounts.input,
  outputSchema: invoiceToolSchemas.calculate_invoice_amounts.output,
  effect: 'PURE',
  executionMode: 'parallel',
  execute: async (input) => calculateInvoiceAmounts(input),
} satisfies ToolDefinition<InvoiceToolInput<'calculate_invoice_amounts'>, InvoiceToolOutput<'calculate_invoice_amounts'>>);
