import { expect, it } from 'bun:test';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createPiModelCatalog } from '../../packages/runtime-pi/src/catalog.ts';
import { safeUrl } from '../../packages/runtime-pi/src/model-runtime.ts';

it('lists installed Pi providers and their model limits without network access', async () => {
  const catalog = await createPiModelCatalog();
  const providers = await catalog.list();
  const deepseek = providers.find((provider) => provider.id === 'deepseek');
  expect(deepseek?.models.some((model) => model.id === 'deepseek-v4-flash' && model.maxTokens > 0)).toBe(true);
  expect(deepseek?.models.find((model) => model.id === 'deepseek-v4-flash')?.endpoint).toBe('https://api.deepseek.com/');
  expect(safeUrl('https://user:secret@example.com/v1?token=secret#private')).toBe('https://example.com/v1');
  expect(safeUrl('not-a-url')).toBeNull();
  expect(deepseek?.authMethods).toContain('api_key');
});

it('lets Pi resolve environment credentials for a provider that also offers API key setup', async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false });
  const auth = runtime.getProvider('deepseek')?.auth.apiKey;
  expect(auth?.login).toBeDefined();
  const resolved = await auth?.resolve({
    ctx: { env: async (name) => name === 'DEEPSEEK_API_KEY' ? 'synthetic-env-key' : undefined,
      fileExists: async () => false },
    signal: new AbortController().signal,
  });
  expect(resolved?.source).toBe('DEEPSEEK_API_KEY');
});
