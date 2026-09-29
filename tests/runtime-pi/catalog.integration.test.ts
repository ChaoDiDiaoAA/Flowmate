import { expect, it } from 'bun:test';
import { createPiModelCatalog } from '../../packages/runtime-pi/src/catalog.ts';

it('lists installed Pi providers and their model limits without network access', async () => {
  const catalog = await createPiModelCatalog();
  const providers = await catalog.list();
  const deepseek = providers.find((provider) => provider.id === 'deepseek');
  expect(deepseek?.models.some((model) => model.id === 'deepseek-v4-flash' && model.maxTokens > 0)).toBe(true);
  expect(deepseek?.authMethods).toContain('api_key');
});
