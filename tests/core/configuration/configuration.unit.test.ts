import { mkdtemp } from '../../support/resources.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { loadProviderConfig } from '../../../packages/core/src/configuration/service.ts';

const config = {
  version: 1 as const,
  name: 'local-p1',
  revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};

describe('provider configuration', () => {
  it('loads only the public provider selection and parameters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-config-'));
    const file = join(root, 'provider.json');
    await writeFile(file, JSON.stringify(config), 'utf8');

    const result = await loadProviderConfig(file);

    expect(result).toEqual({ ok: true, data: config });
  });

  it('rejects a secret field instead of persisting it as configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-config-'));
    const file = join(root, 'provider.json');
    await mkdir(root, { recursive: true });
    await writeFile(file, JSON.stringify({ ...config, apiKey: 'secret' }), 'utf8');

    const result = await loadProviderConfig(file);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('config_invalid');
  });
});
