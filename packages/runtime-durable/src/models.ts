import { createModels, createProvider, InMemoryCredentialStore, InMemoryModelsStore, lazyApi, lazyStream,
  type Api, type FetchFunction, type Message, type Model, type MutableModels, type ProviderStreams, type UserMessage,
  type SimpleStreamOptions, type StreamOptions, type TranscriptContext } from '@earendil-works/pi-ai';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok, ProviderConfigSchema, RUNTIME_CONFIG, type ProviderConfig, type Result } from '@flowmate/contracts';
import { DurableModelBindingSchema, type DurableModelBinding } from '../../contracts/src/durable-runtime.ts';
import type { InvoiceWorkWorkingContext } from '../../contracts/src/personal-context.ts';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { formatInvoiceWorkContext, formatInvoiceWorkInstructions } from './context.ts';
import { assessDurableContextCapacity } from './context-capacity.ts';

export type DurableWorkingContext = { workingContext: InvoiceWorkWorkingContext; messages: Message[]; systemPrompt?: string; summary?: UserMessage };
export type DurableCompactionModelUse = { verify(): Promise<Result<void>>; reserve(): Promise<Result<void>>; entered(): Promise<void> };

export type DurableModelAccess = {
  readApiKey(config: ProviderConfig): string | undefined | Promise<string | undefined>;
  verifyModelUse(signal?: AbortSignal): Result<void> | Promise<Result<void>>;
  reserveModelRequest(signal?: AbortSignal): Result<void> | Promise<Result<void>>;
  readWorkingContext?(nativeContext: TranscriptContext, signal?: AbortSignal): Result<DurableWorkingContext> | Promise<Result<DurableWorkingContext>>;
  readCompactionUse?(signal: AbortSignal | undefined, binding: DurableModelBinding): Result<DurableCompactionModelUse | null> | Promise<Result<DurableCompactionModelUse | null>>;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const drivers: Record<string, ProviderStreams> = {
  'openai-completions': lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
  'openai-responses': lazyApi(() => import('@earendil-works/pi-ai/api/openai-responses')),
  'azure-openai-responses': lazyApi(() => import('@earendil-works/pi-ai/api/azure-openai-responses')),
  'openai-codex-responses': lazyApi(() => import('@earendil-works/pi-ai/api/openai-codex-responses')),
  'anthropic-messages': lazyApi(() => import('@earendil-works/pi-ai/api/anthropic-messages')),
  'bedrock-converse-stream': lazyApi(() => import('@earendil-works/pi-ai/api/bedrock-converse-stream')),
  'google-generative-ai': lazyApi(() => import('@earendil-works/pi-ai/api/google-generative-ai')),
  'google-vertex': lazyApi(() => import('@earendil-works/pi-ai/api/google-vertex')),
  'mistral-conversations': lazyApi(() => import('@earendil-works/pi-ai/api/mistral-conversations')),
  'pi-messages': lazyApi(() => import('@earendil-works/pi-ai/api/pi-messages')),
};

const secretHeader = /authorization|cookie|api[-_]?key|token|secret|credential/i;
const unsafeHeader = (name: string, value: string | null) => secretHeader.test(name) || value !== null && (value.startsWith('!') || value.includes('$'));
const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValue), z.record(jsonValue)]));
const modelSchema = z.object({ id: z.string().min(1), name: z.string(), api: z.string().min(1), provider: z.string().min(1),
  baseUrl: z.string().url(), input: z.array(z.enum(['text', 'image'])), reasoning: z.boolean(),
  contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), tiers: jsonValue.optional() }).strict(),
  type: z.literal('chat').optional(), inputLimits: jsonValue.optional(), thinkingLevelMap: jsonValue.optional(), promptCache: jsonValue.optional(),
  samplingParams: jsonValue.optional(), samplingParamsByThinkingLevel: jsonValue.optional(), compat: jsonValue.optional() }).strict();
export const durableModelBindingSchema = DurableModelBindingSchema;

export function readDurableModelBinding(raw: unknown): Result<{ binding: DurableModelBinding; selected: Model<Api> }> {
  try {
    const binding = durableModelBindingSchema.parse(raw), selected = modelSchema.parse(JSON.parse(binding.modelJson));
    if (selected.provider !== binding.configuration.modelRef.provider || selected.id !== binding.configuration.modelRef.model)
      throw Error('Model binding mismatch');
    if (!Object.hasOwn(drivers, selected.api)) return fail(appError('provider_api_unsupported', 'provider', 'The selected model API is unavailable.'));
    return ok({ binding, selected: selected as Model<Api> });
  } catch { return fail(appError('provider_model_configuration_unavailable', 'input', 'The original resolved model configuration is unavailable.')); }
}

export async function prepareDurableModelBinding(raw: ProviderConfig): Promise<Result<DurableModelBinding>> {
  const parsed = ProviderConfigSchema.safeParse(raw);
  if (!parsed.success) return fail(appError('input_invalid', 'input', 'Durable model configuration is invalid.'));
  const config = structuredClone(parsed.data);
  let native: ModelRuntime | undefined, catalog: Model<Api> | undefined, originalFile: string | undefined, path: string | undefined;
  if (config.native.modelsPath !== null) {
    try {
      path = config.native.modelsPath.startsWith('file://') ? fileURLToPath(config.native.modelsPath)
        : config.native.modelsPath.replace(/^~(?=$|[/\\])/, () => homedir());
      // Pi treats a missing models.json as defaults; an explicit product reference must remain available.
      originalFile = await readFile(path, 'utf8');
      const document: unknown = JSON.parse(originalFile);
      const providers = z.object({ providers: z.record(z.object({ headers: z.record(z.string()).optional(),
        models: z.array(z.object({ id: z.string(), headers: z.record(z.string()).optional() }).passthrough()).optional(),
        modelOverrides: z.record(z.object({ headers: z.record(z.string()).optional() }).passthrough()).optional() }).passthrough()).optional() })
        .passthrough().parse(document).providers;
      const provider = providers?.[config.modelRef.provider];
      for (const headers of [provider?.headers, ...provider?.models?.filter(model => model.id === config.modelRef.model).map(model => model.headers) ?? [],
        provider?.modelOverrides?.[config.modelRef.model]?.headers])
        if (Object.entries(headers ?? {}).some(([name, value]) => unsafeHeader(name, value))) throw Error('Unsafe persistent headers');
      native = await ModelRuntime.create({ modelsPath: path, credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
      if (native.getError()) throw Error('Invalid model configuration');
      catalog = native.getModel(config.modelRef.provider, config.modelRef.model);
    } catch {
      return fail(appError('provider_model_configuration_unavailable', 'input', 'The explicit model configuration is unavailable.'));
    }
  } else {
    const provider = getBuiltinProviders().find(id => id === config.modelRef.provider);
    catalog = provider ? getBuiltinModels(provider).find(model => model.id === config.modelRef.model) : undefined;
  }
  const matching = !config.connection || catalog?.api === config.connection.api
    && catalog.baseUrl.replace(/\/$/, '') === config.connection.baseUrl.replace(/\/$/, '') ? catalog : undefined;
  const contextWindow = config.connection?.contextWindow ?? matching?.contextWindow;
  const maxTokens = config.connection?.maxTokens ?? matching?.maxTokens;
  if (config.connection && (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens)
    || (contextWindow ?? 0) <= 0 || (maxTokens ?? 0) <= 0))
    return fail(appError('provider_model_limits_missing', 'input', 'The custom model needs its actual context and output limits.'));
  if (!config.connection && !catalog) return fail(appError('provider_model_not_found', 'provider', 'The selected model is unavailable.'));
  const selected: Model<Api> = config.connection ? {
    id: config.modelRef.model, provider: config.modelRef.provider, name: config.modelRef.model,
    api: config.connection.api, baseUrl: config.connection.baseUrl, input: ['text'],
    reasoning: config.connection.reasoning ?? matching?.reasoning ?? false, contextWindow: contextWindow!, maxTokens: maxTokens!,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } : structuredClone(catalog!);
  try {
    const configured = native?.getCompatibilityRequestConfig(selected);
    const { id, name, api, provider, baseUrl, input, reasoning, contextWindow, maxTokens, cost,
      type, inputLimits, thinkingLevelMap, promptCache, samplingParams, samplingParamsByThinkingLevel, compat } = selected;
    // Persist model facts only; authentication and dynamic headers remain outside the durable binding.
    const binding: DurableModelBinding = { version: 1, configuration: config, modelJson: JSON.stringify({ id, name, api, provider, baseUrl,
      input, reasoning, contextWindow, maxTokens, cost, type, inputLimits, thinkingLevelMap, promptCache, samplingParams, samplingParamsByThinkingLevel, compat }),
      request: { authHeader: configured?.authHeader ?? false, headers: { ...selected.headers, ...configured?.headers } } };
    if (path && await readFile(path, 'utf8') !== originalFile) throw Error('Model configuration changed during preparation');
    const checked = readDurableModelBinding(binding); if (!checked.ok) return checked;
    const resolved = checked.data.selected;
    if (resolved.compat && 'allowedFallbackModels' in resolved.compat) {
      resolved.compat = { ...resolved.compat, allowedFallbackModels: [] };
      checked.data.binding.modelJson = JSON.stringify(resolved);
    }
    return ok(checked.data.binding);
  } catch { return fail(appError('provider_model_configuration_unavailable', 'input', 'The explicit model configuration cannot be safely persisted.')); }
}

export async function createDurableModels(raw: ProviderConfig, access: DurableModelAccess, saved?: DurableModelBinding): Promise<Result<{
  models: MutableModels; modelRef: { provider: string; modelId: string };
}>> {
  const prepared = saved ? ok(saved) : await prepareDurableModelBinding(raw); if (!prepared.ok) return prepared;
  const checked = readDurableModelBinding(prepared.data); if (!checked.ok) return checked;
  const { selected, binding } = checked.data, config = binding.configuration;
  if (!ProviderConfigSchema.safeParse(raw).success || !isDeepStrictEqual(raw, config))
    return fail(appError('state_conflict', 'input', 'The model binding does not match the original configuration.'));
  const driver = Object.hasOwn(drivers, selected.api) ? drivers[selected.api] : undefined;
  if (!driver) return fail(appError('provider_api_unsupported', 'provider', 'The selected model API is unavailable.'));
  const summaryUse = async (signal?: AbortSignal) => {
    const result = await access.readCompactionUse?.(signal, binding); if (result && !result.ok) throw Error(result.error.code); return result?.data ?? null;
  };
  const checkUse = async (signal?: AbortSignal) => {
    signal?.throwIfAborted(); const summary = await summaryUse(signal), result = summary ? await summary.verify() : await access.verifyModelUse(signal);
    if (!result.ok) throw Error(result.error.code);
  };
  const readKey = async () => {
    const key = await access.readApiKey(config);
    if (!key?.trim()) throw Error('provider_auth_failed');
    return key;
  };
  const customFetch = !['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(selected.api);
  const stream = (model: Model<Api>, context: Parameters<ProviderStreams['stream']>[1], options: StreamOptions | SimpleStreamOptions | undefined, simple: boolean) =>
    lazyStream(model, async () => {
      const verify = () => checkUse(options?.signal);
      const summary = await summaryUse(options?.signal);
      if (model.id !== selected.id || model.provider !== selected.provider || model.api !== selected.api || model.baseUrl !== selected.baseUrl)
        throw Error('provider_model_not_found');
      await verify();
      let requestContext = context;
      if (summary && (getCurrentTools(context.messages).length > 0 || context.messages.some(message => message.role !== 'system' && message.role !== 'user')))
        throw Error('context_binding_conflict');
      if (!summary && access.readWorkingContext) {
        const saved = await access.readWorkingContext(context, options?.signal);
        if (!saved.ok) throw Error(saved.error.code);
        const formatted = formatInvoiceWorkContext(saved.data.workingContext);
        if (!formatted.ok) throw Error(formatted.error.code);
        const instructions = saved.data.systemPrompt === undefined ? formatInvoiceWorkInstructions(saved.data.workingContext.instructions)
          : new TextEncoder().encode(saved.data.systemPrompt).byteLength <= RUNTIME_CONFIG.llmPayload.maxWorkspaceContextBytes
            ? ok(saved.data.systemPrompt) : fail(appError('context_evidence_too_large', 'runtime', 'The child instructions exceed their UTF-8 byte limit.'));
        if (!instructions.ok) throw Error(instructions.error.code);
        if (saved.data.messages.some(message => message.role !== 'assistant' && message.role !== 'toolResult'))
          throw Error('context_binding_conflict');
        const allowed = new Set<string>(saved.data.workingContext.actions.tools);
        requestContext = normalizeContext({ systemPrompt: instructions.data,
          tools: getCurrentTools(context.messages).filter(tool => allowed.has(tool.name)),
          messages: [{ role: 'user', content: formatted.data, timestamp: 0 }, ...(saved.data.summary ? [saved.data.summary] : []), ...saved.data.messages] });
      }
      const capacity = assessDurableContextCapacity(requestContext, selected, options?.maxTokens); if (!capacity.ok) throw Error(capacity.error.code);
      await verify(); const key = await readKey(); await verify();
      const configured = binding.request;
      const headers = { ...configured?.headers, ...options?.headers };
      if (configured?.authHeader) headers.Authorization = `Bearer ${key}`;
      let reserved = false;
      const reserve = async () => {
        await verify();
        if (!reserved) { const result = summary ? await summary.reserve() : await access.reserveModelRequest(options?.signal); if (!result.ok) throw Error(result.error.code); reserved = true; }
        await verify();
      };
      const fetch: FetchFunction = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const currentKey = await readKey(); await verify();
        if (currentKey !== key) throw Error('provider_auth_failed');
        await reserve(); if (summary) { await summary.entered(); await verify(); } return (access.fetch ?? globalThis.fetch)(input, init);
      // Bun's fetch contract includes preconnect; product calls do not warm connections.
      }, { preconnect: () => {} });
      const request = { ...options, apiKey: key, maxRetries: 0, transport: 'sse' as const,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(customFetch ? { fetch } : {}),
        onPayload: async (payload: unknown, candidate: Model<Api>) => {
          const transformed = await options?.onPayload?.(payload, candidate) ?? payload;
          await verify();
          const currentKey = await readKey(); await verify();
          if (currentKey !== key) throw Error('provider_auth_failed');
          if (transformed && typeof transformed === 'object' && 'model' in transformed && transformed.model !== selected.id)
            throw Error('provider_model_not_found');
          if (!customFetch) await reserve();
          return transformed;
        } };
      // These SDK clients hide their fetch: reserve conservatively while keeping observed HTTP attempts unknown.
      if (summary && !customFetch) await reserve();
      return simple ? driver.streamSimple(selected, requestContext, request) : driver.stream(selected, requestContext, request);
    });
  const registered = createProvider({ id: selected.provider, models: [structuredClone(selected)],
    auth: { apiKey: { name: 'Product credential', resolve: async ({ signal }) => {
      await checkUse(signal);
      const key = await access.readApiKey(config);
      await checkUse(signal);
      return key?.trim() ? { auth: { apiKey: key }, source: 'product' } : undefined;
    } } },
    api: { stream: (model, context, options) => stream(model, context, options, false),
      streamSimple: (model, context, options) => stream(model, context, options, true) } });
  const models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider({ ...registered, getModels: () => [structuredClone(selected)], getAllModels: () => [structuredClone(selected)] });
  return ok({ models, modelRef: { provider: selected.provider, modelId: selected.id } });
}
