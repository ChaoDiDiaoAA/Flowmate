import { z } from 'zod';
import { hash, REPO_ROOT } from '../../dataset-loader/local.ts';
import { evaluationEnv, agentApiSchema, agentModelCapabilitiesSchema, resolveModelCapabilities } from '../../configuration.ts';
import { registerSecrets } from '../../execution/evidence-safety.ts';
import type { PreparedModelRuntime } from '../../../../packages/runtime-pi/src/model-runtime.ts';
import packageJson from '../../../../package.json';

const configSchema = z.object({ provider: z.enum(['anthropic', 'openai-compatible']).optional(), api: agentApiSchema,
    model: z.string().trim().min(1), baseUrl: z.string().url(), apiKey: z.string().trim().min(1),
    timeoutMs: z.number().int().positive().max(300000), modelCapabilities: agentModelCapabilitiesSchema.optional()
}).strict().superRefine((config, context) => {
    const url = new URL(config.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        context.addIssue({ code: 'custom', message: 'Judge Base URL must be an API root without credentials or query' });
    if (url.hostname === 'api.deepseek.com' && /^\/anthropic(?:\/|$)/.test(url.pathname) && config.api !== 'anthropic-messages')
        context.addIssue({ code: 'custom', message: 'DeepSeek /anthropic requires the anthropic-messages API' });
});
export type JudgeConfig = z.infer<typeof configSchema>;
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const prepared = new WeakMap<JudgeConfig, { config: JudgeConfig; model: PreparedModelRuntime }>();
export function judgeConfig(env: NodeJS.ProcessEnv, repo = REPO_ROOT, explicit?: string): JudgeConfig | null {
    if (explicit) throw Error('Judge file configuration is retired; use configs/.env');
    env = evaluationEnv(repo, env);
    const values = (['MODEL', 'BASE_URL', 'API_KEY'] as const).map(key => env[`FLOWMATE_JUDGE_${key}`]?.trim());
    const legacy = env.FLOWMATE_JUDGE_PROVIDER?.trim(), explicitApi = env.FLOWMATE_JUDGE_API?.trim();
    if (values.every(v => !v) && !legacy && !explicitApi) return null;
    if (values.some(v => !v)) throw Error('Incomplete FLOWMATE_JUDGE configuration; no Agent fallback');
    const api = explicitApi || (legacy === 'anthropic' ? 'anthropic-messages' : !legacy || legacy === 'openai-compatible' ? 'openai-completions' : legacy);
    const parsed = configSchema.safeParse({ api, provider: api === 'anthropic-messages' ? 'anthropic' : api.startsWith('openai-') ? 'openai-compatible' : undefined,
        model: values[0], baseUrl: values[1], apiKey: values[2], timeoutMs: Number(env.FLOWMATE_JUDGE_TIMEOUT_MS ?? 180000) });
    if (!parsed.success) throw Error('Invalid FLOWMATE_JUDGE configuration; check API, URL and timeout');
    registerSecrets([parsed.data.apiKey]);
    return parsed.data;
}
export function publicJudgeConfig(config: JudgeConfig, rubric?: { id: string; version: number; prompt: string }) {
    const { apiKey, ...parameters } = config;
    const sdk = prepared.get(config)?.model.snapshot.sdk ?? {
        codingAgent: packageJson.dependencies['@earendil-works/pi-coding-agent'], ai: packageJson.dependencies['@earendil-works/pi-ai'] };
    const safe = { ...parameters, sdk, protocolVersion: 'flowmate-judge/v2', ...(rubric ? { rubric: { id: rubric.id, version: rubric.version, hash: hash(rubric.prompt) } } : {}) };
    return { ...safe, configHash: hash(safe) };
}
async function withJudgeTimeout<T>(config: JudgeConfig, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw Error('Judge cancelled');
    const controller = new AbortController(), cancel = () => controller.abort(Error('Judge cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    let interrupt: () => void, interruptionTimer: ReturnType<typeof setTimeout> | undefined;
    const interruption = new Promise<never>((_, reject) => {
        // Give the SDK a turn to preserve its aborted partial response before bounding an unresponsive transport.
        interrupt = () => { interruptionTimer = setTimeout(() => reject(controller.signal.reason), 0); };
        controller.signal.addEventListener('abort', interrupt, { once: true });
    });
    const timer = setTimeout(() => controller.abort(Error('Judge timeout')), config.timeoutMs);
    try { return await Promise.race([interruption, operation(controller.signal)]); }
    catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
    finally {
        clearTimeout(timer); clearTimeout(interruptionTimer);
        controller.signal.removeEventListener('abort', interrupt!);
        signal?.removeEventListener('abort', cancel);
    }
}
export async function prepareJudge(config: JudgeConfig, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<JudgeConfig> {
    if (signal?.aborted) throw Error('Judge cancelled');
    const cached = prepared.get(config);
    if (cached) return cached.config;
    const selected = configSchema.parse(config);
    return withJudgeTimeout(selected, signal, async signal => {
        const modelCapabilities = await resolveModelCapabilities(selected, selected.apiKey, undefined, { fetcher, signal, timeoutMs: selected.timeoutMs });
        const resolved = { ...selected, modelCapabilities };
        const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
        const { prepareModelRuntime } = await import('../../../../packages/runtime-pi/src/model-runtime.ts');
        const model = await prepareModelRuntime({ version: 1, name: 'Evaluation Judge', revision: 1,
            modelRef: { provider: 'flowmate-judge', model: selected.model }, native: { authPath: 'flowmate-judge-in-memory', modelsPath: null },
            connection: { api: selected.api, baseUrl: selected.baseUrl, contextWindow: modelCapabilities.contextWindow,
                maxTokens: modelCapabilities.maxTokens, reasoning: modelCapabilities.reasoning }, parameters: { maxRetries: 0, maxRetryDelayMs: 0 }
        }, { timeoutMs: selected.timeoutMs, stopGraceMs: 0 }, signal,
        { credentials: new InMemoryCredentialStore(), runtimeApiKey: selected.apiKey });
        if (!model.ok) throw Error(model.error.message);
        const state = { config: resolved, model: model.data };
        prepared.set(config, state); prepared.set(resolved, state);
        return resolved;
    });
}
export async function requestJudge(config: JudgeConfig, system: string, data: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
    configSchema.parse(config);
    config = await prepareJudge(config, fetcher, signal);
    const { observedFetch, normalizeUsage } = await import('../../../../packages/runtime-pi/src/model-runtime.ts');
    const { runtime, model } = prepared.get(config)!.model;
    let transportStatus:number|null=null;
    try{return await withJudgeTimeout(config, signal, async signal => {
        const message = await runtime.completeSimple(model, { systemPrompt: system,
            messages: [{ role: 'user', content: data, timestamp: Date.now() }] }, {
            signal, timeoutMs: config.timeoutMs, maxRetries: 0,
            fetch: observedFetch(config.api, async (url, init) => {
                const response=await fetcher(String(url),init??{});transportStatus=response.status;return response;
            }) });
        const blocks = message.content.filter(block => block.type === 'text');
        const responseComplete = message.stopReason === 'stop' && !message.errorMessage && !message.content.some(block => block.type === 'toolCall');
        return { text: blocks.length ? blocks.map(block => block.text).join('') : null, usage: message.usage,
            usageSource: normalizeUsage(message, { attempts: 1, complete: responseComplete }, false).usage.source === 'sdk' ? 'sdk' as const : 'unknown' as const,
            responseModel: message.responseModel ?? null, stopReason: message.stopReason,
            rawStopReason: message.rawStopReason ?? null, responseComplete,transportStatus,
            error: signal.aborted ? (signal.reason as Error).message : message.errorMessage ?? null };
    });}catch(error){throw Object.assign(error instanceof Error?error:Error(String(error)),{transportStatus});}
}
