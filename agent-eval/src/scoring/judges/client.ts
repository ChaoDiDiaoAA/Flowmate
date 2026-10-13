import { z } from 'zod';
import { hash, REPO_ROOT } from '../../dataset-loader/local.ts';
import { evaluationEnv, readDeepSeekModelCapabilities } from '../../configuration.ts';
import { registerSecrets } from '../../execution/evidence-safety.ts';

const modelCapabilitiesSchema = z.object({ modelId: z.string().trim().min(1),
    maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), source: z.enum(['anthropic-models-api','deepseek-models-api']) }).strict();
const configSchema = z.object({ provider: z.enum(['anthropic', 'openai-compatible']), model: z.string().min(1), baseUrl: z.string().url(),
    apiKey: z.string().min(1), timeoutMs: z.number().int().positive().max(300000), modelCapabilities: modelCapabilitiesSchema.optional()
}).strict().superRefine((config, context) => {
    const url = new URL(config.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        context.addIssue({ code: 'custom', message: 'Judge Base URL must be an API root without credentials or query' });
    if (config.provider !== 'anthropic' && config.modelCapabilities)
        context.addIssue({ code: 'custom', message: 'Model capability metadata only applies to Anthropic' });
});
export type JudgeConfig = z.infer<typeof configSchema>;
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export function judgeConfig(env: NodeJS.ProcessEnv, repo = REPO_ROOT, explicit?: string): JudgeConfig | null {
    if (explicit) throw Error('Judge file configuration is retired; use configs/.env');
    env = evaluationEnv(repo, env);
    const values = (['PROVIDER', 'MODEL', 'BASE_URL', 'API_KEY'] as const).map(key => env[`FLOWMATE_JUDGE_${key}`]);
    if (values.every(v => !v?.trim())) return null;
    if (values.some(v => !v?.trim())) throw Error('Incomplete FLOWMATE_JUDGE configuration; no Agent fallback');
    const parsed = configSchema.safeParse({ provider: values[0], model: values[1], baseUrl: values[2], apiKey: values[3],
        timeoutMs: Number(env.FLOWMATE_JUDGE_TIMEOUT_MS ?? 30000) });
    if (!parsed.success) throw Error('Invalid FLOWMATE_JUDGE configuration; check provider, URL and timeout');
    registerSecrets([parsed.data.apiKey]);
    return parsed.data;
}
export function publicJudgeConfig(config: JudgeConfig, rubric?: { id: string; version: number; prompt: string }) {
    const { apiKey, ...parameters } = config;
    const safe = { ...parameters, protocolVersion: 'flowmate-judge/v2', ...(rubric ? { rubric: { id: rubric.id, version: rubric.version, hash: hash(rubric.prompt) } } : {}) };
    return { ...safe, configHash: hash(safe) };
}
async function requestJson(config: JudgeConfig, path: string, body: unknown, fetcher: Fetcher, signal: AbortSignal | undefined, label: string) {
    if (signal?.aborted) throw Error('Judge cancelled');
    const controller = new AbortController(), cancel = () => controller.abort(Error('Judge cancelled'));
    let interrupted: () => void;
    const interruption = new Promise<never>((_, reject) => {
        interrupted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', interrupted, { once: true });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(Error(label + ' timeout')), config.timeoutMs);
    try {
        return await Promise.race([interruption, (async () => {
            const root = config.baseUrl.replace(/\/+$/, '');
            const endpoint = config.provider === 'anthropic' && !new URL(root).pathname.endsWith('/v1') ? root + '/v1' : root;
            const response = await fetcher(endpoint + path, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { 'content-type': 'application/json', ...(config.provider === 'anthropic'
                    ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${config.apiKey}` }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
            if (!response.ok) throw Error(label + ' HTTP ' + response.status);
            try { return await response.json(); }
            catch { throw Error(label + ' response is not valid JSON'); }
        })()]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', interrupted!);
    }
}
export async function prepareJudge(config: JudgeConfig, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<JudgeConfig> {
    config = configSchema.parse(config);
    if (signal?.aborted) throw Error('Judge cancelled');
    if (config.provider !== 'anthropic' || config.modelCapabilities) return config;
    if (new URL(config.baseUrl).hostname === 'api.deepseek.com' && /^deepseek-/.test(config.model)) {
        const native = await readDeepSeekModelCapabilities(config, config.apiKey, {fetcher,signal,timeoutMs:config.timeoutMs});
        return {...config,modelCapabilities:{modelId:config.model,maxOutputTokens:native.maxTokens,source:'deepseek-models-api'}};
    }
    const value = await requestJson(config, '/models/' + encodeURIComponent(config.model), undefined, fetcher, signal, 'Judge model metadata');
    const parsed = z.object({ id: z.string().trim().min(1), max_tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).safeParse(value);
    if (!parsed.success) throw Error('Judge model metadata lacks valid id or max_tokens; no fallback output limit');
    return { ...config, modelCapabilities: { modelId: parsed.data.id, maxOutputTokens: parsed.data.max_tokens, source: 'anthropic-models-api' } };
}
export async function requestJudge(config: JudgeConfig, system: string, data: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
    config = configSchema.parse(config);
    if (signal?.aborted) throw Error('Judge cancelled');
    const anthropic = config.provider === 'anthropic';
    if (anthropic && !config.modelCapabilities) throw Error('Anthropic Judge requires prepared model capability; no fallback output limit');
    // Anthropic requires this protocol field; its model capability is not an evaluation budget.
    const body = anthropic ? { model: config.model, max_tokens: config.modelCapabilities!.maxOutputTokens, system, messages: [{ role: 'user', content: data }] }
        : { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: data }] };
    const value = await requestJson(config, anthropic ? '/messages' : '/chat/completions', body, fetcher, signal, 'Judge') as any;
    const choice = Array.isArray(value.choices) && value.choices.length === 1 ? value.choices[0] : undefined;
    const blocks = Array.isArray(value.content) ? value.content : null;
    const text = anthropic ? (blocks && blocks.every((v: any) => v?.type !== 'text' || typeof v.text === 'string')
        ? blocks.filter((v: any) => v?.type === 'text').map((v: any) => v.text).join('') : null) : choice?.message?.content;
    const reason = anthropic ? value.stop_reason : choice?.finish_reason, finishReason = typeof reason === 'string' ? reason : null;
    const responseComplete = anthropic ? blocks !== null && ['end_turn', 'stop_sequence'].includes(finishReason ?? '') &&
        !blocks.some((v: any) => v?.type === 'tool_use') : finishReason === 'stop' && !choice?.message?.refusal &&
        (choice?.message?.tool_calls == null || Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length === 0) &&
        choice?.message?.function_call == null;
    return { text: typeof text === 'string' ? text : null, usage: value.usage ?? null, responseModel: value.model ?? null,
        finishReason, responseComplete: Boolean(responseComplete) };
}
