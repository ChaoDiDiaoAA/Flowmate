import { expect, it } from 'bun:test';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { Type } from '@sinclair/typebox';
import { assessDurableContextCapacity } from '../../packages/runtime-durable/src/context-capacity.ts';
import { createDurableModels } from '../../packages/runtime-durable/src/models.ts';
import { ok, type ProviderConfig } from '@flowmate/contracts';

it('counts the effective instructions and tools and never reduces the reserved context space', () => {
  const context = normalizeContext({ systemPrompt: 'Original instructions.', tools: [],
    messages: [{ role: 'user', content: 'Original invoice facts.', timestamp: 0 }] });
  const small = assessDurableContextCapacity(context, { contextWindow: 32768, maxTokens: 8192 });
  expect(small).toMatchObject({ ok: true, data: { reserveTokens: 16384, contextWindow: 32768 } });
  expect(assessDurableContextCapacity(context, { contextWindow: 8192, maxTokens: 1024 })).toMatchObject({ ok: false });
  const tools = normalizeContext({ systemPrompt: 'Original instructions.',
    tools: [{ name: 'read_invoice_document', description: 't'.repeat(100000), parameters: Type.Object({}) }],
    messages: [{ role: 'user', content: 'Original invoice facts.', timestamp: 0 }] });
  expect(assessDurableContextCapacity(tools, { contextWindow: 32768, maxTokens: 8192 })).toMatchObject({ ok: false });
});

it('rejects an oversized final Models payload before reserving a request or entering transport', async () => {
  let reservations = 0, fetches = 0;
  const configuration: ProviderConfig = { version: 1, name: 'capacity-original', revision: 1,
    modelRef: { provider: 'capacity-controlled', model: 'original-model' }, native: { authPath: 'unused.json', modelsPath: null },
    connection: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', contextWindow: 32768, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const prepared = await createDurableModels(configuration, { readApiKey: () => 'synthetic-capacity-key',
    verifyModelUse: async () => ok(undefined), reserveModelRequest: async () => { reservations++; return ok(undefined); },
    fetch: async () => { fetches++; throw Error('Oversized payload reached transport.'); } });
  if (!prepared.ok) throw Error(prepared.error.code);
  const model = prepared.data.models.getModel(prepared.data.modelRef.provider, prepared.data.modelRef.modelId);
  if (!model) throw Error('Expected the original explicit model.');
  const context = normalizeContext({ systemPrompt: 'Original instructions.', tools: [],
    messages: [{ role: 'user', content: '原票材料'.repeat(60000), timestamp: 0 }] });
  const response = await prepared.data.models.completeSimple(model, context);
  expect(response.stopReason).toBe('error'); expect(response.errorMessage).toContain('context_capacity_exceeded');
  expect(reservations).toBe(0); expect(fetches).toBe(0);
});
