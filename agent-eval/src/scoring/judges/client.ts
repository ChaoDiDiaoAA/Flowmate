import { z } from 'zod';
import { hash } from '../../datasets/local.ts';
export type JudgeConfig = {
    provider: 'anthropic' | 'openai-compatible';
    model: string;
    baseUrl: string;
    apiKey: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
};
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export function judgeConfig(env: NodeJS.ProcessEnv): JudgeConfig | null {
    const fields = ['PROVIDER', 'MODEL', 'BASE_URL', 'API_KEY'] as const;
    const values = fields.map(key => env[`FLOWMATE_JUDGE_${key}`]);
    if (values.every(v => !v?.trim()))
        return null;
    if (values.some(v => !v?.trim()))
        throw new Error('Incomplete FLOWMATE_JUDGE configuration; no Agent fallback');
    const schema = z.object({ provider: z.enum(['anthropic', 'openai-compatible']), model: z.string().min(1), baseUrl: z.string().url(), apiKey: z.string().min(1), temperature: z.number().min(0).max(2), maxTokens: z.number().int().positive(), timeoutMs: z.number().int().positive().max(300000) });
    const result = schema.parse({ provider: values[0], model: values[1], baseUrl: values[2], apiKey: values[3], temperature: Number(env.FLOWMATE_JUDGE_TEMPERATURE ?? 0.8), maxTokens: Number(env.FLOWMATE_JUDGE_MAX_TOKENS ?? 256), timeoutMs: Number(env.FLOWMATE_JUDGE_TIMEOUT_MS ?? 30000) });
    const url = new URL(result.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('Judge Base URL must be an API root without credentials or query');
    return result;
}
export function publicJudgeConfig(config: JudgeConfig) { const { apiKey, ...safe } = config; return { ...safe, configHash: hash(safe) }; }
export async function requestJudge(config: JudgeConfig, system: string, data: string, fetcher: Fetcher = fetch) {
    const anthropic = config.provider === 'anthropic';
    const url = config.baseUrl.replace(/\/+$/, '') + (anthropic ? '/messages' : '/chat/completions');
    const body = anthropic ? { model: config.model, max_tokens: config.maxTokens, temperature: config.temperature, system, messages: [{ role: 'user', content: data }] } :
        { model: config.model, max_tokens: config.maxTokens, temperature: config.temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: data }] };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Judge timeout')); }, config.timeoutMs); });
    try {
        return await Promise.race([timeout, (async () => {
                const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(anthropic ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${config.apiKey}` }) }, body: JSON.stringify(body), signal: controller.signal });
                if (!response.ok)
                    throw new Error(`Judge HTTP ${response.status}`);
                const value = await response.json() as any;
                const text = anthropic ? value.content?.filter((v: any) => v.type === 'text').map((v: any) => v.text).join('') : value.choices?.[0]?.message?.content;
                if (typeof text !== 'string')
                    throw new Error('Judge response text unavailable');
                return { text, usage: value.usage ?? null, responseModel: value.model ?? null };
            })()]);
    }
    finally {
        clearTimeout(timer!);
    }
}
