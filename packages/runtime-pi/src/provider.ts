import {
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type CredentialStore,
  type FetchFunction,
  type Model,
  ModelsError,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok } from '@flowmate/contracts';
import type {
  ProviderConfig,
  Result,
  UsageRecord,
  SdkUsageValues,
  TokenColumns,
} from '@flowmate/contracts';
import type {
  NativeInput,
  NativeObservation,
  NativeOutcome,
  PreparedProvider,
  ProviderPort,
  SafeConfigSnapshot,
} from '@flowmate/contracts';

export type PiProviderDependencies = {
  credentials?: CredentialStore;
  fetch?: FetchLike;
  witness?: (value: Readonly<Record<string, unknown>>) => void;
  runtimeApiKey?: string;
};

/** A portable fetch shape; Bun's optional `preconnect` property is not needed by Pi. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FetchFacts = {
  attempts: number;
  responseStatus: number | null;
  requestStarted: boolean;
  responseStarted: boolean;
  complete: boolean;
};

const codingAgentVersion = '0.85.1';
const aiVersion = '0.85.1';
const maxOutputBytes = 256 * 1024;

function safeUrl(value: string): string | null {
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

function normalizeText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function emptySdkUsage(): SdkUsageValues {
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    totalTokens: null,
    costInput: null,
    costOutput: null,
    costCacheRead: null,
    costCacheWrite: null,
    costTotal: null,
  };
}

function normalizeUsage(
  message: AssistantMessage,
  facts: FetchFacts,
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
    reason: known ? null : facts.requestStarted ? 'sdk-zero-or-missing-presence-proof' : 'request-not-started',
    sdkValues: known ? values : (facts.requestStarted ? values : null),
    attempts: facts.attempts > 0 ? facts.attempts : null,
    attemptsComplete: facts.complete,
    costSource: costKnown ? 'pi-sdk-model-catalog-estimate' : null,
    updatedAt: new Date().toISOString(),
  };
  const tokens: TokenColumns = {
    inputTokens: known ? values.input : null,
    outputTokens: known ? values.output : null,
    totalTokens: known ? values.totalTokens : null,
    cost: costKnown ? String(values.costTotal) : null,
    usageComplete: known,
  };
  return { usage, tokens };
}

function mapPiFailure(
  facts: { responseStatus: number | null; responseStarted: boolean; aborted: boolean; stopReason: string; text: string },
): ReturnType<typeof appError> {
  if (facts.aborted || facts.stopReason === 'aborted') {
    return appError('provider_cancelled', 'provider', 'Provider 请求已中止。');
  }
  if (facts.responseStatus === 401 || facts.responseStatus === 403) {
    return appError('provider_auth_failed', 'provider', 'Provider 认证失败。');
  }
  if (facts.responseStatus === 429) {
    return appError('provider_rate_limited', 'provider', 'Provider 请求受到限流。', true);
  }
  if (facts.stopReason === 'output_limit') {
    return appError('provider_output_limit', 'provider', 'Provider 响应超过输出限制。', false);
  }
  if (!facts.responseStarted && facts.stopReason === 'error') {
    return appError('provider_network_error', 'provider', 'Provider 请求未建立响应。', true);
  }
  if (facts.stopReason === 'length' || facts.stopReason === 'toolUse' || facts.stopReason === 'deferred' || !facts.text) {
    return appError('provider_incomplete_response', 'provider', 'Provider 未返回完整文本。');
  }
  return appError(
    facts.responseStarted ? 'provider_stream_interrupted' : 'provider_network_error',
    'provider',
    facts.responseStarted ? 'Provider 响应流中断。' : 'Provider 请求未建立响应。',
    true,
  );
}

function projectUserText(input: NativeInput): string {
  return `${input.goal}\n\n${input.text}`;
}

export class PiProviderAdapter implements ProviderPort {
  private readonly dependencies: PiProviderDependencies;

  public constructor(dependencies: PiProviderDependencies = {}) {
    this.dependencies = dependencies;
  }

  public async prepare(
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedProvider>> {
    let runtime: ModelRuntime;
    try {
      runtime = await ModelRuntime.create({
        credentials: this.dependencies.credentials,
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
    const runtimeError = runtime.getError();
    if (runtimeError) {
      return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 配置失败。', true));
    }
    const runtimeApiKey = this.dependencies.runtimeApiKey
      ?? (config.modelRef.provider === 'flowmate-env' ? process.env.FLOWMATE_LLM_API_KEY : undefined);
    try {
      if (config.connection) {
        runtime.registerProvider(config.modelRef.provider, {
          baseUrl: config.connection.baseUrl,
          api: config.connection.api,
          models: [{
            id: config.modelRef.model,
            name: config.modelRef.model,
            input: ['text'],
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 2_048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        });
      }
      if (runtimeApiKey) {
        await runtime.setRuntimeApiKey(config.modelRef.provider, runtimeApiKey, { signal });
      }
    } catch {
      return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 配置失败。', true));
    }
    const model = runtime.getModel(config.modelRef.provider, config.modelRef.model);
    if (!model) {
      return fail(appError('provider_model_not_found', 'provider', '请求的模型不存在。'));
    }
    try {
      const auth = await runtime.getAuth(model, { signal });
      if (!auth) return fail(appError('provider_auth_failed', 'provider', 'Provider 认证未配置。'));
    } catch (error) {
      if (classifyAuthError(error)) return fail(appError('provider_auth_failed', 'provider', 'Provider 认证失败。'));
      return fail(appError('provider_auth_failed', 'provider', 'Provider 认证不可用。', true));
    }

    const snapshot: SafeConfigSnapshot = {
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
      native: {
        authSource: runtimeApiKey ? 'pi-runtime-api-key' : 'pi-native',
        modelsSelection: config.native.modelsPath,
      },
    };

    return ok({
      snapshot,
      execute: async (input, executionSignal, observe) => this.execute(runtime, model, config, input, executionSignal, observe),
    });
  }

  private async execute(
    runtime: ModelRuntime,
    model: Model<Api>,
    config: ProviderConfig,
    input: NativeInput,
    signal: AbortSignal,
    observe: (event: NativeObservation) => void,
  ): Promise<NativeOutcome> {
    const facts: FetchFacts = { attempts: 0, responseStatus: null, requestStarted: false, responseStarted: false, complete: false };
    const baseFetch: FetchLike = this.dependencies.fetch ?? ((request, init) => globalThis.fetch(request, init));
    const fetch: FetchLike = async (request, init) => {
      facts.attempts += 1;
      facts.requestStarted = true;
      const requestUrl = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      this.dependencies.witness?.({ type: 'fetch_entered', attempt: facts.attempts, url: safeUrl(requestUrl), at: new Date().toISOString() });
      observe({ type: 'request_dispatched', at: new Date().toISOString(), monotonicMs: performance.now(), data: { attempt: facts.attempts, url: safeUrl(requestUrl) } });
      try {
        const response = await baseFetch(request, init);
        facts.responseStatus = response.status;
        facts.responseStarted = true;
        this.dependencies.witness?.({ type: 'fetch_response', attempt: facts.attempts, status: response.status });
        return response;
      } catch (error) {
        this.dependencies.witness?.({ type: 'fetch_error', attempt: facts.attempts, aborted: signal.aborted });
        throw error;
      }
    };

    let finalMessage: AssistantMessage | undefined;
    let streamError: AssistantMessage | undefined;
    let text = '';
    let outputLimitExceeded = false;
    let streamFailed = false;
    try {
      const stream = runtime.streamSimple(model, {
        messages: [{ role: 'user', content: projectUserText(input), timestamp: input.messageTimestamp }],
        tools: [],
      }, {
        signal,
        fetch: fetch as FetchFunction,
        maxTokens: config.parameters.maxTokens,
        maxRetries: config.parameters.maxRetries,
        maxRetryDelayMs: config.parameters.maxRetryDelayMs,
        onResponse: (response) => {
          facts.responseStatus = response.status;
          facts.responseStarted = true;
          observe({ type: 'response_started', at: new Date().toISOString(), monotonicMs: performance.now(), data: { status: response.status } });
        },
        onPayload: (payload) => {
          if (payload && typeof payload === 'object') {
            const record = payload as Record<string, unknown>;
            observe({ type: 'request_dispatched', at: new Date().toISOString(), monotonicMs: performance.now(), data: { model: model.id, keys: Object.keys(record).sort() } });
          }
          return undefined;
        },
      });
      for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
        if (event.type === 'text_delta') {
          text += event.delta;
          observe({ type: 'text_delta', at: new Date().toISOString(), monotonicMs: performance.now(), data: { length: event.delta.length } });
          if (new TextEncoder().encode(text).byteLength > maxOutputBytes) {
            outputLimitExceeded = true;
            break;
          }
        }
        if (event.type === 'start') facts.responseStarted = true;
        if (event.type === 'error') streamError = event.error;
        if (event.type === 'done') finalMessage = event.message;
      }
      if (!outputLimitExceeded) finalMessage ??= await stream.result();
      facts.complete = !outputLimitExceeded;
    } catch (error) {
      streamFailed = true;
      const fallback = error instanceof Error ? error.message : '';
      streamError ??= {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: fallback, timestamp: Date.now(),
      };
    }

    if (streamFailed || (!facts.responseStarted && streamError?.stopReason === 'error')) facts.complete = false;

    if (outputLimitExceeded) {
      const error = mapPiFailure({ responseStatus: facts.responseStatus, responseStarted: facts.responseStarted, aborted: signal.aborted, stopReason: 'output_limit', text });
      observe({ type: 'native_terminal', at: new Date().toISOString(), monotonicMs: performance.now(), data: { stopReason: 'output_limit' } });
      return {
        text,
        partial: true,
        stopReason: 'output_limit',
        responseId: null,
        responseModel: model.id,
        error,
        usage: { version: 1, source: 'unknown', reason: 'output-limit', sdkValues: null, attempts: facts.attempts || null, attemptsComplete: false, costSource: null, updatedAt: new Date().toISOString() },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        stopped: false,
        cleanupErrors: [],
      };
    }
    const message = finalMessage ?? streamError;
    if (!message) {
      const error = mapPiFailure({ responseStatus: facts.responseStatus, responseStarted: facts.responseStarted, aborted: signal.aborted, stopReason: 'error', text });
      observe({ type: 'native_terminal', at: new Date().toISOString(), monotonicMs: performance.now(), data: { stopReason: 'error' } });
      return { text, partial: text.length > 0, stopReason: 'error', responseId: null, responseModel: null, error, usage: { version: 1, source: 'unknown', reason: 'no-final-message', sdkValues: null, attempts: facts.attempts || null, attemptsComplete: facts.complete, costSource: null, updatedAt: new Date().toISOString() }, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false }, stopped: facts.complete, cleanupErrors: [] };
    }
    const finalText = text || normalizeText(message);
    const error = message.stopReason === 'stop' && finalText.length > 0 ? null : mapPiFailure({ responseStatus: facts.responseStatus, responseStarted: facts.responseStarted, aborted: signal.aborted, stopReason: message.stopReason, text: finalText });
    const usage = normalizeUsage(message, facts, config.connection === undefined);
    observe({ type: 'native_terminal', at: new Date().toISOString(), monotonicMs: performance.now(), data: { stopReason: message.stopReason, responseId: message.responseId ?? null } });
    return {
      text: finalText,
      partial: finalText.length > 0 && error !== null,
      stopReason: message.stopReason,
      responseId: message.responseId ?? null,
      responseModel: message.responseModel ?? null,
      error,
      usage: usage.usage,
      tokens: usage.tokens,
      stopped: facts.complete,
      cleanupErrors: [],
    };
  }

  public async close(): Promise<{ stopped: boolean; closed: boolean; errors: readonly never[] }> {
    return { stopped: true, closed: true, errors: [] };
  }
}
