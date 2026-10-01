import { invoiceToolSchemas } from '@flowmate/contracts';
import type { FillInvoiceFormInput, FillInvoiceFormOutput, ProductToolContext, ToolCallContext, ToolDefinition } from '@flowmate/contracts';

type FillService = { apply(input: FillInvoiceFormInput, call: ToolCallContext, context: ProductToolContext): Promise<FillInvoiceFormOutput> };
export const fillInvoiceForm = (service: FillService) => ({
  name: 'fill_invoice_form', version: '1', label: 'Fill invoice form',
  description: 'Apply the candidate fixed for this Run to the controlled invoice form. Returns success only after a matching actual application receipt. Does not save or accept the candidate.',
  inputSchema: invoiceToolSchemas.fill_invoice_form.input, outputSchema: invoiceToolSchemas.fill_invoice_form.output,
  effect: 'LOCAL_WRITE', executionMode: 'sequential',
  execute: (input, call, context) => service.apply(input, call, context),
} satisfies ToolDefinition<FillInvoiceFormInput, FillInvoiceFormOutput>);
