import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { registerSecrets, scanEvidence } from './execution/evidence-safety.ts';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalExtensionManifest, ExtensionManifestSchema } from '../../packages/contracts/src/extensions.ts';
import { canonicalResourceManifest, ResourceManifestSchema } from '../../packages/contracts/src/resources.ts';
import type { ModelCatalogProvider } from '../../packages/contracts/src/settings.ts';

const repository=fileURLToPath(new URL('../../',import.meta.url));
export function extensionIdentity(ref:{id:string;version:string},repo=repository) {
    const name=ref.id==='invoice-assist'?'invoice-v1.json':ref.id==='subagents'?'subagents-v1.json':undefined;
    if(!name)throw Error('Unknown trusted extension: '+ref.id);
    const manifest=ExtensionManifestSchema.parse(JSON.parse(readFileSync(join(repo,'resources/extensions',name),'utf8')));
    if(manifest.version!==ref.version)throw Error('Extension version differs: '+ref.id);
    return{...ref,manifestHash:createHash('sha256').update(canonicalExtensionManifest(manifest)).digest('hex')};
}
export function evaluationEnv(repo: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const file = join(repo,'agent-eval/configs/.env');
    const values = existsSync(file) ? parseEnv(readFileSync(file,'utf8')) : {};
    const allowed = /^(FLOWMATE_EVAL_AGENT_(BASE_URL|API_KEY|MODEL|API)|FLOWMATE_JUDGE_(PROVIDER|BASE_URL|MODEL|API_KEY|TIMEOUT_MS)|LANGFUSE_(BASE_URL|PUBLIC_KEY|SECRET_KEY))$/;
    if (Object.keys(values).some(key=>!allowed.test(key))) throw Error('configs/.env contains an unsupported variable');
    const merged = {...values,...Object.fromEntries(Object.entries(env).filter(([,value])=>value!==undefined))};
    registerSecrets(['FLOWMATE_EVAL_AGENT_API_KEY', 'FLOWMATE_JUDGE_API_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']
        .map(name => merged[name]?.trim()).filter((value): value is string => !!value));
    return merged;
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
    }), api: agentApiSchema }).strict();
export const agentModelCapabilitiesSchema = z.object({ contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), reasoning: z.boolean(),
    source: z.enum(['pi-sdk-model-catalog', 'deepseek-models-api']), providers: z.array(z.string().min(1)).min(1) }).strict();
export type AgentModelCapabilities = z.infer<typeof agentModelCapabilitiesSchema>;
export function agentConfig(repo: string, env: NodeJS.ProcessEnv = process.env, overrides: { model?: unknown; api?: unknown; baseUrl?: unknown } = {}) {
    env = evaluationEnv(repo, env);
    const apiKey = credential(env, 'FLOWMATE_EVAL_AGENT_API_KEY');
    const parsed = agentConnectionSchema.safeParse({ model: overrides.model ?? env.FLOWMATE_EVAL_AGENT_MODEL,
        baseUrl: overrides.baseUrl ?? env.FLOWMATE_EVAL_AGENT_BASE_URL, api: overrides.api ?? env.FLOWMATE_EVAL_AGENT_API ?? 'openai-completions' });
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
    let models = catalog;
    if (!models) {
        const { createPiModelCatalog } = await import('../../packages/runtime-pi/src/catalog.ts');
        models = await (await createPiModelCatalog()).list();
    }
    const connection = selected.configuration;
    let modelCapabilities: AgentModelCapabilities;
    if (!models.some(p => p.models.some(m => m.id === connection.model && m.api === connection.api)) &&
        /^deepseek-/.test(connection.model) && ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(connection.api)) {
        modelCapabilities = await readDeepSeekModelCapabilities(connection, selected.apiKey, deps);
    } else modelCapabilities = resolveAgentModel(connection, models);
    return { ...selected, configuration: { ...connection, modelCapabilities } };
}
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const langfuseSchema = z.object({ baseUrl: z.string().url(), publicKeyEnv: envName.default('LANGFUSE_PUBLIC_KEY'),
    secretKeyEnv: envName.default('LANGFUSE_SECRET_KEY') }).strict().superRefine((value, context) => {
    const url = new URL(value.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        context.addIssue({ code: 'custom', message: 'Langfuse 地址不能含凭据、查询参数或片段' });
});
export function langfuseConfig(repo: string, env: NodeJS.ProcessEnv = process.env) {
    env=evaluationEnv(repo,env);
    const parsed=langfuseSchema.safeParse({baseUrl:env.LANGFUSE_BASE_URL});
    if(!parsed.success)throw Error('Invalid LANGFUSE_BASE_URL');
    const config=parsed.data;
    return { baseUrl: config.baseUrl, publicKey: credential(env, config.publicKeyEnv), secretKey: credential(env, config.secretKeyEnv) };
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
