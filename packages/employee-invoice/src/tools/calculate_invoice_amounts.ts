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
  description: 'Calculate sums, products, or tax amounts using exact decimals and explicit rounding.',
  inputSchema: invoiceToolSchemas.calculate_invoice_amounts.input,
  outputSchema: invoiceToolSchemas.calculate_invoice_amounts.output,
  effect: 'PURE',
  executionMode: 'parallel',
  execute: async (input) => calculateInvoiceAmounts(input),
} satisfies ToolDefinition<InvoiceToolInput<'calculate_invoice_amounts'>, InvoiceToolOutput<'calculate_invoice_amounts'>>);
