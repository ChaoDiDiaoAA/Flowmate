import { mkdtemp } from '../support/resources.ts';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, mock } from 'bun:test';
import { providerCommand, providerQueryCommand } from '../../apps/cli/commands/provider.ts';
import type { Application } from '../../packages/contracts/src/runtime.ts';

const config = {
  version: 1,
  name: 'cli',
  revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};

const io = () => ({ out: mock(), err: mock(), signal: new AbortController().signal });

describe('P1 CLI provider commands', () => {
  it('prints a completed result and returns zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-cli-'));
    const configFile = join(root, 'config.json');
    const inputFile = join(root, 'invoice.txt');
    await writeFile(configFile, JSON.stringify(config), 'utf8');
    await writeFile(inputFile, '合成发票', 'utf8');
    const app: Application = {
      callProvider: mock(async () => ({ ok: true as const, data: { runId: 3, status: 'completed' as const, text: '完成', error: null, stopped: true, cleanupErrors: [] } })),
      queryRun: mock(),
      close: mock(),
    };
    const output = io();

    const code = await providerCommand({ configFile, inputFile, goal: '概述' }, app, output);

    expect(code).toBe(0);
    expect(output.out).toHaveBeenCalledWith(expect.stringContaining('runId=3'));
    expect(output.out).toHaveBeenCalledWith(expect.stringContaining('完成'));
  });

  it('loads a Base URL, API type, model and API key from the environment when no config file is supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-cli-env-'));
    const inputFile = join(root, 'invoice.txt');
    await writeFile(inputFile, '合成发票', 'utf8');
    const prior = {
      APPDATA: process.env.APPDATA,
      FLOWMATE_LLM_BASE_URL: process.env.FLOWMATE_LLM_BASE_URL,
      FLOWMATE_LLM_MODEL: process.env.FLOWMATE_LLM_MODEL,
      FLOWMATE_LLM_API_KEY: process.env.FLOWMATE_LLM_API_KEY,
      FLOWMATE_LLM_API: process.env.FLOWMATE_LLM_API,
    };
    Object.assign(process.env, {
      APPDATA: root,
      FLOWMATE_LLM_BASE_URL: 'https://llm.example.com/v1',
      FLOWMATE_LLM_MODEL: 'invoice-model',
      FLOWMATE_LLM_API_KEY: 'CLI_ENV_TEST_KEY',
      FLOWMATE_LLM_API: 'openai-completions',
    });
    const callProvider = mock(async () => ({ ok: true as const, data: { runId: 5, status: 'completed' as const, text: '完成', error: null, stopped: true, cleanupErrors: [] } }));
    const app: Application = {
      callProvider,
      queryRun: mock(),
      close: mock(),
    };
    const output = io();
    try {
      await expect(providerCommand({ inputFile, goal: '概述' }, app, output)).resolves.toBe(0);
      expect(app.callProvider).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({
          modelRef: { provider: 'flowmate-env', model: 'invoice-model' },
          connection: { baseUrl: 'https://llm.example.com/v1', api: 'openai-completions' },
        }),
      }), expect.anything());
      const firstRequest = (callProvider as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls[0]?.[0];
      expect(JSON.stringify(firstRequest)).not.toContain('CLI_ENV_TEST_KEY');
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('returns a nonzero status for a product failed outcome and can query a Run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-cli-'));
    const configFile = join(root, 'config.json');
    const inputFile = join(root, 'invoice.txt');
    await writeFile(configFile, JSON.stringify(config), 'utf8');
    await writeFile(inputFile, '合成发票', 'utf8');
    const app: Application = {
      callProvider: mock(async () => ({ ok: true as const, data: { runId: 4, status: 'failed' as const, text: '', error: { code: 'provider_auth_failed', category: 'provider' as const, message: 'Provider 认证失败。', retryable: false }, stopped: true, cleanupErrors: [] } })),
      queryRun: mock(async () => ({ ok: true as const, data: { runId: 4, status: 'failed' as const, error: { code: 'provider_auth_failed', category: 'provider' as const, message: 'Provider 认证失败。', retryable: false } } as never })),
      close: mock(),
    };
    const output = io();

    await expect(providerCommand({ configFile, inputFile, goal: '概述' }, app, output)).resolves.toBe(1);
    await expect(providerQueryCommand(4, app, output)).resolves.toBe(0);
    expect(output.err).toHaveBeenCalledWith(expect.stringContaining('provider_auth_failed'));
  });
});
