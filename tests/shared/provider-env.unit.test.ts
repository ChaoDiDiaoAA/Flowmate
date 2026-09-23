import { describe, expect, test } from 'bun:test';
import { loadLiveProviderEnvironment } from '@flowmate/shared';
import type { ProductPaths } from '@flowmate/contracts';

const paths: ProductPaths = {
  root: 'C:/Temp/Flowmate',
  databaseFile: 'C:/Temp/Flowmate/data/app.sqlite',
  logsDir: 'C:/Temp/Flowmate/logs',
  artifactsDir: 'C:/Temp/Flowmate/artifacts',
  outputsDir: 'C:/Temp/Flowmate/outputs',
  runtimeDir: 'C:/Temp/Flowmate/runtime',
};

describe('Live Provider environment configuration', () => {
  test('builds a public Pi custom-provider configuration without persisting the API key', () => {
    const result = loadLiveProviderEnvironment({
      FLOWMATE_LLM_BASE_URL: 'https://llm.example.com/v1',
      FLOWMATE_LLM_MODEL: 'invoice-model',
      FLOWMATE_LLM_API_KEY: 'test-live-secret',
    }, paths);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.config.modelRef).toEqual({ provider: 'flowmate-env', model: 'invoice-model' });
    expect(result.data.config.connection).toEqual({
      baseUrl: 'https://llm.example.com/v1',
      api: 'openai-completions',
    });
    expect(result.data.config.native.authPath).toBe('C:\\Temp\\Flowmate\\runtime\\pi-auth.json');
    expect(result.data.apiKey).toBe('test-live-secret');
    expect(result.data.config.parameters.maxTokens).toBeUndefined();
    expect(JSON.stringify(result.data.config)).not.toContain('test-live-secret');
  });

  test('accepts an explicit output budget and rejects invalid budgets before execution', () => {
    const env = { FLOWMATE_LLM_BASE_URL: 'https://llm.example.com/v1', FLOWMATE_LLM_MODEL: 'invoice-model', FLOWMATE_LLM_API_KEY: 'test-secret' };
    const configured = loadLiveProviderEnvironment({ ...env, FLOWMATE_LLM_MAX_TOKENS: '1024' }, paths);
    expect(configured.ok && configured.data.config.parameters.maxTokens).toBe(1024);
    expect(loadLiveProviderEnvironment({ ...env, FLOWMATE_LLM_MAX_TOKENS: '16384' }, paths).ok).toBe(true);
    expect(loadLiveProviderEnvironment({ ...env, FLOWMATE_LLM_MAX_TOKENS: '' }, paths)).toMatchObject({ ok: true });
    for (const value of ['0', '-1', '9007199254740992', '1.5', 'NaN', '512oops']) {
      expect(loadLiveProviderEnvironment({ ...env, FLOWMATE_LLM_MAX_TOKENS: value }, paths)).toMatchObject({ ok: false, error: { code: 'config_env_invalid' } });
    }
  });

  test('rejects an incomplete or unsafe live endpoint before a Provider request starts', () => {
    const missing = loadLiveProviderEnvironment({
      FLOWMATE_LLM_BASE_URL: '',
      FLOWMATE_LLM_MODEL: 'invoice-model',
      FLOWMATE_LLM_API_KEY: 'test-live-secret',
    }, paths);
    const unsafe = loadLiveProviderEnvironment({
      FLOWMATE_LLM_BASE_URL: 'https://name:password@llm.example.com/v1?token=secret',
      FLOWMATE_LLM_MODEL: 'invoice-model',
      FLOWMATE_LLM_API_KEY: 'test-live-secret',
      FLOWMATE_LLM_API: 'openai-completions',
    }, paths);
    const unknownApi = loadLiveProviderEnvironment({
      FLOWMATE_LLM_BASE_URL: 'https://llm.example.com/v1',
      FLOWMATE_LLM_MODEL: 'invoice-model',
      FLOWMATE_LLM_API_KEY: 'test-live-secret',
      FLOWMATE_LLM_API: 'guess-from-url',
    }, paths);

    expect(missing).toMatchObject({ ok: false, error: { code: 'config_env_missing' } });
    expect(unsafe).toMatchObject({ ok: false, error: { code: 'config_env_invalid' } });
    expect(unknownApi).toMatchObject({ ok: false, error: { code: 'config_env_invalid' } });
  });
});
