import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { LOCAL_NO_AUTH_API_KEY, registerSecrets, scanEvidence } from './execution/evidence-safety.ts';
import { fileURLToPath } from 'node:url';
import { ExtensionManifestSchema } from '../../packages/contracts/src/extensions.ts';
import { ResourceManifestSchema } from '../../packages/contracts/src/resources.ts';
import type { ModelCatalogProvider } from '../../packages/contracts/src/settings.ts';
import { nativeTextModelConfigSchema, type NativeTextModelConfig } from './text-model/codex.ts';
import { homedir } from 'node:os';
import { EvaluationAgentOverridesSchema } from '../../packages/contracts/src/runtime-evaluation.ts';

const repository=fileURLToPath(new URL('../../',import.meta.url));
export function extensionIdentity(ref:{id:string;version:string},repo=repository) {
    const name=ref.id==='invoice-assist'?'invoice-v1.json':ref.id==='subagents'?'subagents-v1.json':undefined;
    if(!name)throw Error('Unknown trusted extension: '+ref.id);
    const manifest=ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(repo,'resources/extensions',name),'utf8')));
    if(manifest.version!==ref.version)throw Error('Extension version differs: '+ref.id);
    return ref;
}
export function evaluationEnv(repo: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const file = join(repo,'agent-eval/configs/.env');
    const values = existsSync(file) ? parseEnv(readFileSync(file,'utf8')) : {};
    const allowed = /^(FLOWMATE_CODEX_EXECUTABLE|FLOWMATE_EVAL_AGENT_(BASE_URL|API_KEY|MODEL|API|REASONING_EFFORT)|FLOWMATE_EVAL_CONTROL_(BASE_URL|MODEL|API|REASONING_EFFORT)|FLOWMATE_EVAL_DEEPSEEK_API_KEY|FLOWMATE_JUDGE_(API|PROVIDER|BASE_URL|MODEL|API_KEY|TIMEOUT_MS|REASONING_EFFORT)|JUDGE_(MODEL|REASONING_EFFORT|TIMEOUT_MS)|(FLOWMATE_)?MINING_(PROVIDER|MODEL|REASONING_EFFORT|TIMEOUT_MS)|LANGFUSE_(BASE_URL|PUBLIC_KEY|SECRET_KEY))$/;
    if (Object.keys(values).some(key=>!allowed.test(key))) throw Error('configs/.env contains an unsupported variable');
    const merged = {...values,...Object.fromEntries(Object.entries(env).filter(([,value])=>value!==undefined))};
    registerSecrets(['FLOWMATE_EVAL_AGENT_API_KEY', 'FLOWMATE_EVAL_DEEPSEEK_API_KEY', 'FLOWMATE_JUDGE_API_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']
        .map(name => merged[name]?.trim()).filter((value): value is string => !!value));
    return merged;
}
export function miningConfig(repo: string, env: NodeJS.ProcessEnv = process.env): NativeTextModelConfig {
    env = evaluationEnv(repo, env);
    return nativeTextModelConfigSchema.parse({ provider: env.FLOWMATE_MINING_PROVIDER ?? env.MINING_PROVIDER ?? 'codex-cli', executable: env.FLOWMATE_CODEX_EXECUTABLE ?? 'codex',
        model: env.FLOWMATE_MINING_MODEL ?? env.MINING_MODEL ?? 'gpt-6-luna', reasoningEffort: env.FLOWMATE_MINING_REASONING_EFFORT ?? env.MINING_REASONING_EFFORT ?? 'max',
        timeoutMs: Number(env.FLOWMATE_MINING_TIMEOUT_MS ?? env.MINING_TIMEOUT_MS ?? 180000) });
}
export function credential(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new Error(`缺少凭据环境变量 ${name}`);
    registerSecrets([value]);
    return value;
}
export const agentApiSchema = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
const agentConnectionSchema = z.object({ model: z.string().trim().min(1).refine(value => !value.includes('REPLACE_WITH')),
    baseUrl: z.string().url().refine(value => {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && url.hostname !== 'replace.invalid' && !url.username && !url.password && !url.search && !url.hash;
    }), api: agentApiSchema, reasoning: EvaluationAgentOverridesSchema.shape.reasoning }).strict();
export type EvaluationAgentCredential = { connection: z.infer<typeof agentConnectionSchema>; apiKey: string };
export function sameAgentEndpoint(left: { api: string; baseUrl: string }, right: { api: string; baseUrl: string }) {
    try { return left.api === right.api && new URL(left.baseUrl).href.replace(/\/+$/, '') === new URL(right.baseUrl).href.replace(/\/+$/, ''); }
    catch { return false; }
}
export function sameAgentConnection(left: { api: string; baseUrl: string; model: string }, right: { api: string; baseUrl: string; model: string }) {
    return left.model === right.model && sameAgentEndpoint(left, right);
}
export function localAgentCredential(connection: { model?: unknown; api?: unknown; baseUrl?: unknown }): string | null {
    return ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra'].includes(String(connection.model)) && connection.api === 'openai-completions' && typeof connection.baseUrl === 'string'
        && sameAgentEndpoint({ api: connection.api, baseUrl: connection.baseUrl }, { api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' })
        ? LOCAL_NO_AUTH_API_KEY : null;
}
// The existing local gateway validates max_completion_tokens/max_tokens in the inclusive range 1..32768.
const localCodexGatewayTransport = { maxTokens: 32768, source: 'local-codex-gateway-source' as const };
export const agentModelCapabilitiesSchema = z.object({ contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), reasoning: z.boolean(),
    transport: z.object({ maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), source: z.literal('local-codex-gateway-source') }).strict().optional(),
    source: z.enum(['pi-sdk-model-catalog', 'deepseek-models-api', 'codex-cli-cache-and-openai-model-reference']), providers: z.array(z.string().min(1)).min(1) }).strict();
export type AgentModelCapabilities = z.infer<typeof agentModelCapabilitiesSchema>;
export function readLocalCodexModelCapabilities(connection: { model: string; api: string; baseUrl: string },
    cachePath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json')): AgentModelCapabilities {
    if (!localAgentCredential(connection)) throw Error('Local Codex capabilities require a verified local gateway model');
    const cache = z.object({ models: z.array(z.object({ slug: z.string() }).passthrough()) }).parse(JSON.parse(readFileSync(cachePath, 'utf8')));
    const matching = cache.models.filter(model => model.slug === connection.model);
    const model = z.object({ context_window: z.number().int().min(128000),
        supported_reasoning_levels: z.array(z.object({ effort: z.string().min(1) }).passthrough()).min(1) })
        .safeParse(matching.length === 1 ? matching[0] : null);
    if (!model.success) throw Error('Local Codex model metadata lacks an exact identity or context; no fallback limit');
    // Native context comes from the exact CLI cache; the configured models expose 128000 output tokens.
    // https://developers.openai.com/api/docs/models/gpt-6.1-sol (and gpt-6.1-terra, gpt-6-luna).
    return agentModelCapabilitiesSchema.parse({ contextWindow: model.data.context_window, maxTokens: 128000,
        transport: localCodexGatewayTransport,
        reasoning: model.data.supported_reasoning_levels.some(level => !['none', 'off'].includes(level.effort)),
        source: 'codex-cli-cache-and-openai-model-reference', providers: ['codex-cli-local-gateway'] });
}
export function agentConfig(repo: string, env: NodeJS.ProcessEnv = process.env, overrides: { model?: unknown; api?: unknown; baseUrl?: unknown; reasoning?: unknown } = {}) {
    env = evaluationEnv(repo, env);
    const connection = { model: overrides.model ?? env.FLOWMATE_EVAL_AGENT_MODEL,
        baseUrl: overrides.baseUrl ?? env.FLOWMATE_EVAL_AGENT_BASE_URL, api: overrides.api ?? env.FLOWMATE_EVAL_AGENT_API ?? 'openai-completions' };
    const localKey = localAgentCredential(connection);
    const reasoning = overrides.reasoning ?? (localKey ? env.FLOWMATE_EVAL_AGENT_REASONING_EFFORT ?? 'max' : undefined);
    const selected = agentConnection({ ...connection, ...(reasoning === undefined ? {} : { reasoning }) }, localKey ?? credential(env, 'FLOWMATE_EVAL_AGENT_API_KEY'));
    if (!localKey && env.FLOWMATE_EVAL_AGENT_BASE_URL && !sameAgentEndpoint(selected.configuration,
        { baseUrl: env.FLOWMATE_EVAL_AGENT_BASE_URL, api: env.FLOWMATE_EVAL_AGENT_API ?? 'openai-completions' }))
        throw Error('Changed Agent endpoint requires its own explicit credential; default credential cannot be forwarded');
    return selected;
}
export function agentConnection(configuration: unknown, apiKey: string) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw Error('Explicit Agent credential is required; no environment fallback');
    apiKey = apiKey.trim(); registerSecrets([apiKey]);
    const parsed = agentConnectionSchema.safeParse(configuration);
    if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        throw Error('Invalid FLOWMATE_EVAL_AGENT_' + (field === 'baseUrl' ? 'BASE_URL' : String(field ?? 'MODEL').toUpperCase()) + '; actual model, API and credential-free base URL are required');
    }
    if ((scanEvidence(parsed.data).fact.actual as { leaked: boolean }).leaked)
        throw Error('Agent public configuration contains a credential; use FLOWMATE_EVAL_AGENT_API_KEY only');
    const endpoint = new URL(parsed.data.baseUrl);
    if (endpoint.hostname === 'api.deepseek.com' && /^\/anthropic(?:\/|$)/.test(endpoint.pathname) && parsed.data.api !== 'anthropic-messages')
        throw Error('FLOWMATE_EVAL_AGENT_API must be anthropic-messages for the DeepSeek /anthropic URL; no request made');
    return { configuration: parsed.data, apiKey };
}
export function resolveAgentModel(selection: { model: string; api: string; baseUrl: string }, catalog: readonly ModelCatalogProvider[]): AgentModelCapabilities {
    const matches = catalog.flatMap(provider => provider.models.filter(model => model.id === selection.model && model.api === selection.api)
        .map(model => ({ provider: provider.id, model })));
    const endpoint = selection.baseUrl.replace(/\/$/, '');
    const direct = matches.filter(({ model }) => model.endpoint?.replace(/\/$/, '') === endpoint);
    const candidates = direct.length ? direct : matches;
    if (!candidates.length) throw Error('Agent model ID/API is absent from the Pi SDK catalog; native limits are unknown');
    const capabilities = candidates.map(({ model, provider }) => agentModelCapabilitiesSchema.safeParse({ contextWindow: model.contextWindow,
        maxTokens: model.maxTokens, reasoning: model.reasoning, source: 'pi-sdk-model-catalog', providers: [provider] }));
    if (capabilities.some(result => !result.success)) throw Error('Agent model native capabilities are missing or invalid');
    const native = capabilities.map(result => result.data!);
    if (new Set(native.map(({ contextWindow, maxTokens, reasoning }) => JSON.stringify([contextWindow, maxTokens, reasoning]))).size !== 1)
        throw Error('Agent model native capabilities are ambiguous in the Pi SDK catalog');
    return { ...native[0]!, providers: [...new Set(candidates.map(candidate => candidate.provider))].sort() };
}
export async function prepareAgentConfig(repo: string, env: NodeJS.ProcessEnv = process.env,
    overrides: Parameters<typeof agentConfig>[2] = {}, catalog?: readonly ModelCatalogProvider[],
    deps: { fetcher?: (url: string, init: RequestInit) => Promise<Response>; signal?: AbortSignal } = {}) {
    const selected = agentConfig(repo, env, overrides);
    return prepareAgentConnection(selected.configuration, selected.apiKey, catalog, deps);
}
export async function prepareAgentConnection(connection: z.infer<typeof agentConnectionSchema>, apiKey: string,
    catalog?: readonly ModelCatalogProvider[], deps: Parameters<typeof readDeepSeekModelCapabilities>[2] = {}) {
    const selected = agentConnection({ ...connection,
        ...(localAgentCredential(connection) ? { reasoning: connection.reasoning ?? 'max' } : {}) }, apiKey);
    const native = await resolveModelCapabilities(selected.configuration, selected.apiKey, catalog, deps);
    const modelCapabilities = localAgentCredential(selected.configuration) ? { ...native, transport: { ...localCodexGatewayTransport } } : native;
    return { ...selected, configuration: { ...selected.configuration, modelCapabilities } };
}
export async function resolveModelCapabilities(connection: { model: string; api: string; baseUrl: string }, apiKey: string,
    catalog?: readonly ModelCatalogProvider[], deps: Parameters<typeof readDeepSeekModelCapabilities>[2] = {}): Promise<AgentModelCapabilities> {
    let models = catalog;
    if (!models) {
        const { createPiModelCatalog } = await import('../../packages/runtime-pi/src/catalog.ts');
        models = await (await createPiModelCatalog()).list();
    }
    if (localAgentCredential(connection) && !models.some(provider => provider.models.some(model => model.id === connection.model && model.api === connection.api)))
        return readLocalCodexModelCapabilities(connection);
    if (!models.some(p => p.models.some(m => m.id === connection.model && m.api === connection.api)) &&
        /^deepseek-/.test(connection.model) && ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(connection.api)) {
        return readDeepSeekModelCapabilities(connection, apiKey, deps);
    }
    return resolveAgentModel(connection, models);
}
export const langfuseUrlSchema = z.string().url().superRefine((value, context) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        context.addIssue({ code: 'custom', message: 'Langfuse 地址不能含凭据、查询参数或片段' });
}).transform(value => new URL(value).href.replace(/\/+$/, ''));
export const langfuseConnectionSchema = z.object({ baseUrl: langfuseUrlSchema,
    publicKey: z.string().trim().min(1).max(4096), secretKey: z.string().trim().min(1).max(4096) }).strict();
export type LangfuseConnection = z.infer<typeof langfuseConnectionSchema>;
export function langfuseConnection(value: unknown): LangfuseConnection {
    const parsed = langfuseConnectionSchema.safeParse(value);
    if (!parsed.success) throw Error('Invalid Langfuse connection');
    registerSecrets([parsed.data.publicKey, parsed.data.secretKey]);
    if ((scanEvidence(parsed.data.baseUrl).fact.actual as { leaked: boolean }).leaked) throw Error('Langfuse URL contains a configured secret');
    return parsed.data;
}
export function langfuseConfig(repo: string, env: NodeJS.ProcessEnv = process.env) {
    env=evaluationEnv(repo,env);
    const parsed=langfuseUrlSchema.safeParse(env.LANGFUSE_BASE_URL);
    if(!parsed.success)throw Error('Invalid LANGFUSE_BASE_URL');
    return langfuseConnection({ baseUrl: parsed.data, publicKey: credential(env, 'LANGFUSE_PUBLIC_KEY'), secretKey: credential(env, 'LANGFUSE_SECRET_KEY') });
}

export async function readDeepSeekModelCapabilities(selection: {model:string;baseUrl:string}, apiKey:string,
    deps: {fetcher?: (url:string,init:RequestInit)=>Promise<Response>; signal?:AbortSignal; timeoutMs?:number} = {}): Promise<AgentModelCapabilities> {
        const signal = AbortSignal.any([AbortSignal.timeout(deps.timeoutMs ?? 30000), ...(deps.signal ? [deps.signal] : [])]);
        let response: Response;
        try {
            response = await (deps.fetcher ?? fetch)((new URL(selection.baseUrl).hostname === 'api.deepseek.com' ? new URL('/models', selection.baseUrl).href : selection.baseUrl.replace(/\/+$/, '') + '/models'), {
                method: 'GET', headers: { authorization: `Bearer ${apiKey}` }, signal });
        } catch { throw Error('Agent model metadata request failed or cancelled'); }
        if (!response.ok) throw Error('Agent model metadata HTTP ' + response.status);
        let body: unknown;
        try { body = await response.json(); } catch { throw Error('Agent model metadata is not JSON'); }
        const list = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).safeParse(body);
        const exact = list.success ? list.data.data.filter(m => m.id === selection.model) : [];
        const native = z.object({ owned_by: z.literal('deepseek'), context_window: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            max_output_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            effort: z.object({ supported_levels: z.array(z.string().min(1)).min(1) }) }).safeParse(exact.length === 1 ? exact[0] : null);
        if (!native.success || native.data.max_output_tokens > native.data.context_window)
            throw Error('Agent model metadata lacks exact identity or valid native capabilities; no fallback limit');
        return agentModelCapabilitiesSchema.parse({ contextWindow: native.data.context_window,
            maxTokens: native.data.max_output_tokens, reasoning: true, source: 'deepseek-models-api', providers: ['deepseek'] });
}
