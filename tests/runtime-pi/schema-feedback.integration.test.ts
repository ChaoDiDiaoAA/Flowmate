import { expect, it } from 'bun:test';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import type { Model } from '@earendil-works/pi-ai';
import { Type } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { invoiceToolSchemas } from '@flowmate/contracts';
import { calculateInvoiceAmountsTool } from '../../packages/employee-invoice/src/tools/calculate_invoice_amounts.ts';
import { toPiParameters } from '../../packages/runtime-pi/src/schema.ts';
import { toPiTool } from '../../packages/runtime-pi/src/tools.ts';

const model: Model<'anthropic-messages'> = { api: 'anthropic-messages', provider: 'controlled', id: 'offline', name: 'Offline',
  baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const properties = ['operation', 'values', 'scale', 'quantity', 'unitPrice', 'netAmount', 'taxRate'];

it('delivers every calculator branch property through the real non-strict Anthropic SDK conversion', async () => {
  let payload: any; let fetches = 0;
  const tool = toPiTool(calculateInvoiceAmountsTool(), async () => { throw new Error('No tool execution.'); });
  await completeSimple(model, { messages: [{ role: 'user', content: 'Use exact decimals.', timestamp: 1 }], tools: [tool] },
    { apiKey: 'synthetic-sdk-key', maxRetries: 0, onPayload(outgoing) { payload = structuredClone(outgoing); throw new Error('Captured before transport.'); },
      fetch: Object.assign(async () => { fetches++; throw new Error('No network permitted.'); }, { preconnect: globalThis.fetch.preconnect }) });
  expect(fetches).toBe(0);
  const definition = payload.tools.find((value: any) => value.name === 'calculate_invoice_amounts');
  expect(definition.strict).toBeUndefined();
  expect(Object.keys(definition.input_schema.properties).sort()).toEqual([...properties].sort());
  expect(definition.input_schema.required).toEqual(['operation', 'scale']);
  expect(JSON.stringify(definition.input_schema.properties.operation)).toContain('product');
  expect(JSON.stringify(definition.input_schema.properties.operation)).toContain('tax');
  const parameters = tool.parameters as any;
  expect(parameters.anyOf).toHaveLength(3); expect(parameters.additionalProperties).toBe(false);
});

it('explains the selected calculator branch without echoing raw values or suggesting unrelated receipts', () => {
  const tool = toPiTool(calculateInvoiceAmountsTool(), async () => { throw new Error('Preparation must reject before execution.'); });
  const raw = { operation: 'product', quantity: 2, unitPrice: 'PRIVATE_INVOICE_BODY_1,000.00' };
  let message = '';
  try { tool.prepareArguments!(raw as never); } catch (error) { message = (error as Error).message; }
  expect(message.length).toBeLessThanOrEqual(4000);
  expect(message).toContain('quantity'); expect(message).toContain('unitPrice'); expect(message).toContain('scale');
  expect(message).toContain('required'); expect(message).toContain('allowedKeys'); expect(message).toContain('pattern');
  expect(message).not.toContain('PRIVATE_INVOICE_BODY'); expect(message).not.toContain('read receipts');
  expect(message).not.toContain('netAmount'); expect(message).not.toContain('taxRate');
});

it('keeps original strict Zod enforcement for calculator branches and decimal boundaries', () => {
  const tool = toPiTool(calculateInvoiceAmountsTool(), async () => { throw new Error('Not executed.'); });
  for (const valid of [{ operation: 'sum', values: ['100.00', '10.00'], scale: 2 },
    { operation: 'product', quantity: '2', unitPrice: '12.50', scale: null },
    { operation: 'tax', netAmount: '100.00', taxRate: '10', scale: 2 }]) {
    expect(tool.prepareArguments!(valid as never)).toEqual(valid);
  }
  for (const invalid of [{ operation: 'sum', values: ['1,000.00'], scale: 2 },
    { operation: 'sum', values: ['1e3'], scale: 2 }, { operation: 'sum', values: [1], scale: 2 },
    { operation: 'sum', values: ['1.00'] }, { operation: 'product', quantity: '2', unitPrice: '1.00', scale: 2, values: ['2'] },
    { operation: 'tax', netAmount: '100', taxRate: '10', scale: 7 }]) {
    expect(() => tool.prepareArguments!(invalid as never)).toThrow('Invalid arguments');
  }
  expect(() => toPiParameters(z.union([z.object({ operation: z.literal('sum') }).strict(), z.string()]))).toThrow('tool_schema_unsupported');
  expect(invoiceToolSchemas.calculate_invoice_amounts.input.safeParse({ operation: 'tax', netAmount: '100', taxRate: '0.1', scale: 2 }).success).toBe(true);
});

it('retains preparation feedback for SDK-backed schemas', () => {
  const native = toPiTool({ name: 'native-fixture', version: '1', description: 'SDK-backed fixture', effect: 'READ', executionMode: 'parallel',
    inputSchema: z.unknown().transform((_raw, context) => { context.addIssue({ code: 'custom', message: 'Native tool arguments do not match the SDK schema.' }); return z.NEVER; }),
    execute: async () => null }, async () => { throw new Error('Not executed.'); }, undefined, Type.Object({ path: Type.String() }));
  expect(() => native.prepareArguments!({} as never)).toThrow('Invalid arguments');
});

it('does not echo unknown input keys or their values in parameter feedback', () => {
  const calculator = toPiTool(calculateInvoiceAmountsTool(), async () => { throw new Error('Not executed.'); });
  let message = '';
  try { calculator.prepareArguments!({ operation: 'sum', values: ['1'], scale: 2, PRIVATE_FIELD_KEY: 'PRIVATE_FIELD_VALUE' } as never); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain('allowedKeys'); expect(message).not.toContain('PRIVATE_FIELD_KEY'); expect(message).not.toContain('PRIVATE_FIELD_VALUE');
});

it('keeps shared property variants and chooses feedback by all literal discriminants', () => {
  const inputSchema=z.union([z.object({kind:z.literal('math'),operation:z.literal('first'),value:z.string(),onlyFirst:z.string()}).strict(),
    z.object({kind:z.literal('math'),operation:z.literal('second'),value:z.number(),onlySecond:z.string()}).strict()]);
  const tool=toPiTool({name:'variants',version:'1',description:'Variants',effect:'PURE',executionMode:'parallel',inputSchema,execute:async()=>null},
    async()=>{throw new Error('Not executed.');});
  expect((tool.parameters as any).properties.value.anyOf).toEqual([{type:'string'},{type:'number'}]);
  expect((tool.parameters as any).required).toEqual(['kind','operation','value']);
  let message='';try{tool.prepareArguments!({kind:'math',operation:'second',value:'PRIVATE_VALUE'} as never);}catch(error){message=(error as Error).message;}
  expect(message).toContain('onlySecond');expect(message).not.toContain('onlyFirst');expect(message).not.toContain('PRIVATE_VALUE');
});
