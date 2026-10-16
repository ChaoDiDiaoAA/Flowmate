import { expect, test } from 'bun:test';
import * as configuration from '../../src/configuration.ts';
import * as judge from '../../src/scoring/judges/client.ts';
import type { ModelCatalogProvider } from '@flowmate/contracts';

const connection = { api: 'openai-completions' as const, baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-agent' };
const catalog: ModelCatalogProvider[] = [{ id: 'synthetic', name: 'Synthetic', authMethods: ['api_key'], models: [{
  id: 'synthetic-agent', name: 'Synthetic', api: 'openai-completions', endpoint: 'https://synthetic.invalid/v1',
  contextWindow: 64_000, maxTokens: 16_000, reasoning: false,
}] }];
const prepare = Reflect.get(configuration, 'prepareAgentConnection') as
  ((selection: typeof connection, key: string, models: ModelCatalogProvider[]) => Promise<unknown>) | undefined;
const parseJudge = Reflect.get(judge, 'judgeConnection') as ((value: unknown) => unknown) | undefined;

test('explicit Agent preparation resolves the supplied connection and native limits without environment configuration', async () => {
  expect(await prepare?.(connection, 'synthetic-explicit-key', catalog)).toEqual({ apiKey: 'synthetic-explicit-key', configuration: {
    ...connection, modelCapabilities: { contextWindow: 64_000, maxTokens: 16_000, reasoning: false,
      source: 'pi-sdk-model-catalog', providers: ['synthetic'] },
  } });
});

test('explicit Judge configuration validates its own key, URL and timeout without an Agent or environment fallback', () => {
  const selected = { ...connection, apiKey: 'synthetic-judge-key', timeoutMs: 180_000 };
  expect(parseJudge?.(selected)).toEqual(selected);
  for (const change of [{ apiKey: '' }, { timeoutMs: 300_001 }, { baseUrl: 'https://user:secret@synthetic.invalid/v1' }, { api: 'unsupported' }])
    expect(() => parseJudge?.({ ...selected, ...change })).toThrow();
});
