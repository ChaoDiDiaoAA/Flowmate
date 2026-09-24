import {
  InMemoryModelsStore,
  type Api,
  type CredentialStore,
  type Model,
  ModelsError,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ProviderConfig, Result } from '@flowmate/contracts';
import type { SafeConfigSnapshot, SdkUsageValues, TokenColumns, UsageRecord } from '@flowmate/contracts';
import type { AssistantMessage } from '@earendil-works/pi-ai';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type PiProviderDependencies = {
  credentials?: CredentialStore;
  fetch?: FetchLike;
  witness?: (value: Readonly<Record<string, unknown>>) => void;
  runtimeApiKey?: string;
  runtimeApiKeyFor?: (config: ProviderConfig) => string | undefined;
};

export type PreparedModelRuntime = {
  runtime: ModelRuntime;
  model: Model<Api>;
  snapshot: SafeConfigSnapshot;
};

export function modelRuntimeSnapshot(
  config: ProviderConfig,
  limits: { timeoutMs: number; stopGraceMs: number },
  model: Model<Api>,
  authSource: 'pi-native' | 'pi-runtime-api-key',
): SafeConfigSnapshot {
  return {
    version: 1,
    name: config.name,
    revision: config.revision,
    requestedModel: config.modelRef,
    resolvedModel: { provider: model.provider, model: model.id },
    api: model.api,
    endpoint: safeUrl(model.baseUrl),
    sdk: { codingAgent: codingAgentVersion, ai: aiVersion },
    parameters: config.parameters,
    limits,
    native: { authSource, modelsSelection: config.native.modelsPath },
  };
}

export function normalizeUsage(
  message: AssistantMessage,
  facts: { attempts: number; complete: boolean },
  canVerifyCost: boolean,
): { usage: UsageRecord; tokens: TokenColumns } {
  const raw = message.usage;
  const values: SdkUsageValues = {
    input: Number.isFinite(raw.input) ? raw.input : null,
    output: Number.isFinite(raw.output) ? raw.output : null,
    cacheRead: Number.isFinite(raw.cacheRead) ? raw.cacheRead : null,
    cacheWrite: Number.isFinite(raw.cacheWrite) ? raw.cacheWrite : null,
    totalTokens: Number.isFinite(raw.totalTokens) ? raw.totalTokens : null,
    costInput: Number.isFinite(raw.cost.input) ? raw.cost.input : null,
    costOutput: Number.isFinite(raw.cost.output) ? raw.cost.output : null,
    costCacheRead: Number.isFinite(raw.cost.cacheRead) ? raw.cost.cacheRead : null,
    costCacheWrite: Number.isFinite(raw.cost.cacheWrite) ? raw.cost.cacheWrite : null,
    costTotal: Number.isFinite(raw.cost.total) ? raw.cost.total : null,
  };
  const reported = [values.input, values.output, values.cacheRead, values.cacheWrite, values.totalTokens]
    .some((value) => value !== null && value > 0);
  const known = reported && facts.complete;
  const costKnown = known && canVerifyCost && values.costTotal !== null;
  const usage: UsageRecord = {
    version: 1,
    source: known ? 'sdk' : 'unknown',
    reason: known ? null : facts.attempts > 0 ? 'sdk-zero-or-missing-presence-proof' : 'request-not-started',
    sdkValues: known ? values : (facts.attempts > 0 ? values : null),
    attempts: facts.attempts > 0 ? facts.attempts : null,
    attemptsComplete: facts.complete,
    costSource: costKnown ? 'pi-sdk-model-catalog-estimate' : null,
    updatedAt: new Date().toISOString(),
  };
  return {
    usage,
    tokens: {
      inputTokens: known ? values.input : null,
      outputTokens: known ? values.output : null,
      totalTokens: known ? values.totalTokens : null,
      cost: costKnown ? String(values.costTotal) : null,
      usageComplete: known,
    },
  };
}

const codingAgentVersion = '0.85.1';
const aiVersion = '0.85.1';
// Pi requires a positive model maxTokens value for custom registrations.
const piCustomModelMaxTokens = 8192;

export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function classifyAuthError(error: unknown): boolean {
  return error instanceof ModelsError && (error.code === 'auth' || error.code === 'oauth');
}

function runtimeApiKey(config: ProviderConfig, dependencies: PiProviderDependencies): string | undefined {
  return dependencies.runtimeApiKeyFor?.(config)
    ?? dependencies.runtimeApiKey
    ?? (config.modelRef.provider === 'flowmate-env' ? process.env.FLOWMATE_LLM_API_KEY : undefined);
}

export async function refreshModelRuntimeAuth(
  runtime: ModelRuntime,
  model: Model<Api>,
  config: ProviderConfig,
  signal: AbortSignal,
  dependencies: PiProviderDependencies,
): Promise<Result<{ authSource: 'pi-native' | 'pi-runtime-api-key' }>> {
  try {
    const apiKey = runtimeApiKey(config, dependencies);
    if (apiKey) await runtime.setRuntimeApiKey(config.modelRef.provider, apiKey, { signal });
    else if (runtime.getProviderAuthStatus(config.modelRef.provider).source === 'runtime') {
      await runtime.removeRuntimeApiKey(config.modelRef.provider, { signal });
    }
    const auth = await runtime.getAuth(model, { signal });
    if (!auth) return fail(appError('provider_auth_failed', 'provider', 'Provider 认证未配置。'));
    return ok({ authSource: apiKey ? 'pi-runtime-api-key' : 'pi-native' });
  } catch (error) {
    if (classifyAuthError(error)) return fail(appError('provider_auth_failed', 'provider', 'Provider 认证失败。'));
    return fail(appError('provider_auth_failed', 'provider', 'Provider 认证不可用。', true));
  }
}

export async function prepareModelRuntime(
  config: ProviderConfig,
  limits: { timeoutMs: number; stopGraceMs: number },
  signal: AbortSignal,
  dependencies: PiProviderDependencies,
  existingRuntime?: ModelRuntime,
): Promise<Result<PreparedModelRuntime>> {
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
    return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 初始化失败.', true));
  }
  if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));
  if (runtime.getError()) return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 配置失败。', true));

  const candidates = config.connection ? runtime.getModels().filter((item) =>
    item.id === config.modelRef.model && item.api === config.connection!.api
    && safeUrl(item.baseUrl)?.replace(/\/$/, '') === safeUrl(config.connection!.baseUrl)?.replace(/\/$/, '')) : [];
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
          maxTokens: modelMaxTokens ?? piCustomModelMaxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      });
    }
  } catch {
    return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 配置失败。', true));
  }

  try {
    const refreshed = await runtime.refresh({ allowNetwork: false, signal });
    if (refreshed.aborted) return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 刷新已取消。', true));
  } catch {
    return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 刷新失败。', true));
  }
  if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));

  const model = runtime.getModel(config.modelRef.provider, config.modelRef.model);
  if (!model) return fail(appError('provider_model_not_found', 'provider', '请求的模型不存在。'));
  const auth = await refreshModelRuntimeAuth(runtime, model, config, signal, dependencies);
  if (!auth.ok) return auth;

  return ok({ runtime, model, snapshot: modelRuntimeSnapshot(config, limits, model, auth.data.authSource) });
}
