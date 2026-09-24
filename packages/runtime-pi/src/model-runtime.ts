import { InMemoryModelsStore, ModelsError, type Api, type CredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ProviderConfig, Result } from '@flowmate/contracts';
import type { SafeConfigSnapshot } from '@flowmate/contracts';

export type PiModelRuntimeDependencies = {
  credentials?: CredentialStore;
  runtimeApiKey?: string;
  runtimeApiKeyFor?: (config: ProviderConfig) => string | undefined;
};

export type PreparedModel = { runtime: ModelRuntime; model: Model<Api>; snapshot: SafeConfigSnapshot };

export function safeModelUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function isAuthError(error: unknown): boolean {
  return error instanceof ModelsError && (error.code === 'auth' || error.code === 'oauth');
}

export async function prepareModelRuntime(
  config: ProviderConfig,
  limits: { timeoutMs: number; stopGraceMs: number },
  signal: AbortSignal,
  dependencies: PiModelRuntimeDependencies,
  existingRuntime?: ModelRuntime,
  onRuntimeCreated?: (runtime: ModelRuntime) => void,
): Promise<Result<PreparedModel>> {
  let runtime: ModelRuntime;
  try {
    runtime = existingRuntime ?? await ModelRuntime.create({
      credentials: dependencies.credentials,
      authPath: config.native.authPath,
      modelsPath: config.native.modelsPath,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal,
    });
  } catch {
    return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 初始化失败。', true));
  }
  if (!existingRuntime) onRuntimeCreated?.(runtime);
  if (runtime.getError()) return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 配置失败。', true));

  const runtimeApiKey = dependencies.runtimeApiKeyFor?.(config)
    ?? dependencies.runtimeApiKey
    ?? (config.modelRef.provider === 'flowmate-env' ? process.env.FLOWMATE_LLM_API_KEY : undefined);
  const candidates = config.connection ? runtime.getModels().filter((item) => item.id === config.modelRef.model
    && item.api === config.connection!.api
    && safeModelUrl(item.baseUrl)?.replace(/\/$/, '') === safeModelUrl(config.connection!.baseUrl)?.replace(/\/$/, '')) : [];
  const catalogModel = config.connection
    ? (candidates.length === 1 ? candidates[0] : undefined)
    : runtime.getModel(config.modelRef.provider, config.modelRef.model);
  const modelMaxTokens = catalogModel && Number.isSafeInteger(catalogModel.maxTokens) && catalogModel.maxTokens > 0
    ? catalogModel.maxTokens : null;
  try {
    if (config.connection) {
      runtime.registerProvider(config.modelRef.provider, {
        baseUrl: config.connection.baseUrl,
        api: config.connection.api,
        models: [{
          id: config.modelRef.model,
          name: config.modelRef.model,
          input: ['text'],
          reasoning: catalogModel?.reasoning ?? false,
          contextWindow: catalogModel?.contextWindow ?? 0,
          maxTokens: modelMaxTokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      });
    }
    if (runtimeApiKey) await runtime.setRuntimeApiKey(config.modelRef.provider, runtimeApiKey, { signal });
  } catch {
    return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 配置失败。', true));
  }
  try {
    const refreshed = await runtime.refresh({ allowNetwork: false, signal });
    if (refreshed.aborted) return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 刷新已取消。', true));
  } catch {
    return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 刷新失败。', true));
  }
  if (signal.aborted) return fail(appError('provider_cancelled', 'provider', 'Provider 请求已中止。'));
  const model = runtime.getModel(config.modelRef.provider, config.modelRef.model);
  if (!model) return fail(appError('provider_model_not_found', 'provider', '请求的模型不存在。'));
  try {
    const auth = await runtime.getAuth(model, { signal });
    if (!auth) return fail(appError('provider_auth_failed', 'provider', 'Provider 认证未配置。'));
  } catch (error) {
    return fail(appError('provider_auth_failed', 'provider', isAuthError(error) ? 'Provider 认证失败。' : 'Provider 认证不可用。', !isAuthError(error)));
  }
  const snapshot: SafeConfigSnapshot = {
    version: 1,
    name: config.name,
    revision: config.revision,
    requestedModel: config.modelRef,
    resolvedModel: { provider: model.provider, model: model.id },
    api: model.api,
    endpoint: safeModelUrl(model.baseUrl),
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: config.parameters,
    limits,
    native: { authSource: runtimeApiKey ? 'pi-runtime-api-key' : 'pi-native', modelsSelection: config.native.modelsPath },
  };
  return ok({ runtime, model, snapshot });
}
