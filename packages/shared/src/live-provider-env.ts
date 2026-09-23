import { join } from 'node:path';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ProductPaths, ProviderApi, ProviderConfig, Result } from '@flowmate/contracts';

const defaultApi: ProviderApi = 'openai-completions';
const providerApis = new Set<ProviderApi>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);

export type LiveProviderEnvironment = {
  config: ProviderConfig;
  apiKey: string;
};

function required(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function safeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0
    ) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function loadLiveProviderEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  paths: ProductPaths,
): Result<LiveProviderEnvironment> {
  const baseUrlText = required(env, 'FLOWMATE_LLM_BASE_URL');
  const model = required(env, 'FLOWMATE_LLM_MODEL');
  const apiKey = required(env, 'FLOWMATE_LLM_API_KEY');
  if (!baseUrlText || !model || !apiKey) {
    return fail(appError(
      'config_env_missing',
      'input',
      '必须配置 FLOWMATE_LLM_BASE_URL、FLOWMATE_LLM_MODEL 和 FLOWMATE_LLM_API_KEY。',
    ));
  }
  const baseUrl = safeBaseUrl(baseUrlText);
  const api = (env.FLOWMATE_LLM_API?.trim() || defaultApi) as ProviderApi;
  if (!baseUrl || !providerApis.has(api)) {
    return fail(appError(
      'config_env_invalid',
      'input',
      'FLOWMATE_LLM_BASE_URL 或 FLOWMATE_LLM_API 无效。',
    ));
  }
  return ok({
    apiKey,
    config: {
      version: 1,
      name: 'p1-env-provider',
      revision: 1,
      modelRef: { provider: 'flowmate-env', model },
      native: { authPath: join(paths.runtimeDir, 'pi-auth.json'), modelsPath: null },
      connection: { baseUrl, api },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 },
    },
  });
}
