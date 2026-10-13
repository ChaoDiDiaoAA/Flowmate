import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeConfig, prepareJudge, publicJudgeConfig, requestJudge } from '../../../src/scoring/judges/client.ts';
import { parseJudgment, runJudge } from '../../../src/scoring/judges/harness.ts';
import { judgeResponse } from '../../support/judge-response.ts';

const emptyRepo = join(tmpdir(), 'flowmate-client-unit-no-config');
const env = { FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_BASE_URL: 'https://example.com/v1', FLOWMATE_JUDGE_API_KEY: 'judge-key' };
const configFor = (provider = 'openai-compatible', timeoutMs = '180000') => judgeConfig({ ...env,
    FLOWMATE_JUDGE_MODEL: provider === 'anthropic' ? 'claude-haiku-4-5' : env.FLOWMATE_JUDGE_MODEL,
    FLOWMATE_JUDGE_BASE_URL: provider === 'anthropic' ? 'https://example.com' : env.FLOWMATE_JUDGE_BASE_URL,
    FLOWMATE_JUDGE_PROVIDER: provider, FLOWMATE_JUDGE_TIMEOUT_MS: timeoutMs }, emptyRepo)!;
const text = '{"score":1,"reason":"Supported"}';
const answer = (provider: string, content: string, reason?: string, usage: unknown = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }) =>
    judgeResponse(provider === 'anthropic' ? { content: [{ type: 'text', text: content }], stop_reason: reason, usage }
        : { choices: [{ message: { content }, finish_reason: reason }], usage });
const sse = (chunks: unknown[]) => new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
const abortingFetch = (_url: string, init: RequestInit): Promise<Response> => new Promise((_, reject) => {
    if (init.signal?.aborted) reject(init.signal.reason);
    else init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
});

test('Judge uses only its own required connection and defaults to the SDK completions API', () => {
    expect(judgeConfig({ OPENAI_API_KEY: 'ambient-key', FLOWMATE_EVAL_AGENT_API_KEY: 'agent-secret' }, emptyRepo)).toBeNull();
    expect(() => judgeConfig({ FLOWMATE_JUDGE_MODEL: 'judge' }, emptyRepo)).toThrow('Incomplete');
    expect(judgeConfig(env, emptyRepo)).toMatchObject({ api: 'openai-completions', timeoutMs: 180000 });
    expect(() => judgeConfig({ ...env, FLOWMATE_JUDGE_API_KEY: '' }, emptyRepo)).toThrow('Incomplete');
});

test('explicit Judge API overrides legacy provider mapping and invalid APIs or timeouts fail before dispatch', () => {
    expect(judgeConfig({ ...env, FLOWMATE_JUDGE_PROVIDER: 'anthropic' }, emptyRepo)?.api).toBe('anthropic-messages');
    expect(judgeConfig({ ...env, FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_API: 'openai-responses' }, emptyRepo)?.api).toBe('openai-responses');
    expect(judgeConfig({ ...env, FLOWMATE_JUDGE_PROVIDER: 'retired', FLOWMATE_JUDGE_API: 'anthropic-messages' }, emptyRepo)?.api).toBe('anthropic-messages');
    expect(judgeConfig({ ...env, FLOWMATE_JUDGE_PROVIDER: 'anthropic', FLOWMATE_JUDGE_API: '  ' }, emptyRepo)?.api).toBe('anthropic-messages');
    for (const FLOWMATE_JUDGE_TIMEOUT_MS of ['0', '300001', '1.5', 'bad']) expect(() => judgeConfig({ ...env, FLOWMATE_JUDGE_TIMEOUT_MS }, emptyRepo)).toThrow('Invalid');
    expect(() => judgeConfig({ ...env, FLOWMATE_JUDGE_API: 'unknown' }, emptyRepo)).toThrow('Invalid');
    expect(judgeConfig({ ...env, FLOWMATE_JUDGE_TIMEOUT_MS: '300000' }, emptyRepo)?.timeoutMs).toBe(300000);
});

test('SDK completions uses catalog limits, the isolated key and one streamed generation without tools or sampling overrides', async () => {
    const config = await prepareJudge(configFor(), async () => { throw Error('Preparation must stay offline'); });
    let calls = 0;
    const result = await requestJudge(config, 'rubric', 'untrusted evidence', async (url, init) => {
        calls++;
        expect(url).toBe('https://example.com/v1/chat/completions');
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ stream: true, max_completion_tokens: 32768, messages: [{ role: 'system', content: 'rubric' }, { role: 'user', content: 'untrusted evidence' }] });
        for (const field of ['temperature', 'max_tokens', 'tools']) expect(body).not.toHaveProperty(field);
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer judge-key');
        return answer('openai-compatible', text, 'stop');
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ text, stopReason: 'stop', rawStopReason: 'stop', responseComplete: true, usageSource: 'sdk', usage: { input: 10, output: 8, totalTokens: 18 } });
    expect(config.modelCapabilities).toMatchObject({ contextWindow: 131072, maxTokens: 32768, source: 'pi-sdk-model-catalog' });
    expect(JSON.stringify(publicJudgeConfig(config))).not.toContain('judge-key');
    expect(publicJudgeConfig(config)).toMatchObject({ api: 'openai-completions', sdk: { ai: '0.85.1', codingAgent: '0.85.1' } });
    expect(structuredClone(config)).not.toHaveProperty('runtime');
});

test('Anthropic uses the shared catalog and reuses prepared state for distinct single generations', async () => {
    let generationCalls = 0;
    const fetcher = async (url: string, init: RequestInit) => {
        generationCalls++;
        expect(init.method).toBe('POST');
        expect(new URL(url).pathname).toBe('/v1/messages');
        expect(new Headers(init.headers).get('x-api-key')).toBe('judge-key');
        const body = JSON.parse(String(init.body));
        expect(body.max_tokens).toBe(64000);
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('tools');
        return answer('anthropic', text, 'end_turn', { input_tokens: 10, output_tokens: 8 });
    };
    const config = await prepareJudge(configFor('anthropic'), fetcher);
    expect(generationCalls).toBe(0);
    expect(await prepareJudge(config, fetcher)).toBe(config);
    for (let i = 0; i < 2; i++) {
        const call = await runJudge(config, 'rubric', 'data', fetcher);
        expect(call).toMatchObject({ attempts: 1, stopReason: 'stop', rawStopReason: 'end_turn', error: null, judgment: { score: 1, reason: 'Supported' } });
        expect(call.configuration.modelCapabilities).toEqual(config.modelCapabilities);
    }
    expect(generationCalls).toBe(2);
});

test('unknown models fail before generation rather than inventing capabilities', async () => {
    let calls = 0;
    const config = judgeConfig({ ...env, FLOWMATE_JUDGE_MODEL: 'synthetic-unknown-model' }, emptyRepo)!;
    const result = await runJudge(config, 'rubric', 'data', async () => { calls++; throw Error('must not send'); });
    expect(result).toMatchObject({ attempts: 0, judgment: null });
    expect(result.error).toContain('catalog');
    expect(calls).toBe(0);
});

test('DeepSeek native capabilities use the existing metadata resolution without a fallback limit', async () => {
    const config = judgeConfig({ ...env, FLOWMATE_JUDGE_MODEL: 'deepseek-v4-pro', FLOWMATE_JUDGE_API: 'anthropic-messages',
        FLOWMATE_JUDGE_BASE_URL: 'https://api.deepseek.com/anthropic' }, emptyRepo)!;
    let calls = 0;
    const prepared = await prepareJudge(config, async (url, init) => {
        calls++;
        expect(url).toBe('https://api.deepseek.com/models');
        expect(init.method).toBe('GET');
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer judge-key');
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro', owned_by: 'deepseek', context_window: 1048576,
            max_output_tokens: 384000, effort: { supported_levels: ['high'] } }] }));
    });
    expect(prepared.modelCapabilities).toMatchObject({ contextWindow: 1048576, maxTokens: 384000, source: 'deepseek-models-api' });
    expect(calls).toBe(1);
    await expect(prepareJudge({ ...config }, async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] })))).rejects.toThrow('no fallback limit');
});

test('preparation bounds DeepSeek metadata transport and JSON parsing that ignore cancellation', async () => {
    await prepareJudge(configFor());
    const config = judgeConfig({ ...env, FLOWMATE_JUDGE_MODEL: 'deepseek-v4-pro', FLOWMATE_JUDGE_API: 'anthropic-messages',
        FLOWMATE_JUDGE_BASE_URL: 'https://api.deepseek.com/anthropic', FLOWMATE_JUDGE_TIMEOUT_MS: '10' }, emptyRepo)!;
    for (const fetcher of [async () => new Promise<Response>(() => {}), async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response]) {
        await expect(Promise.race([prepareJudge(config, fetcher), new Promise((_, reject) => setTimeout(() => reject(Error('Preparation did not return')), 200))])).rejects.toThrow('Judge timeout');
    }
    const abort = new AbortController(); let calls = 0;
    await expect(prepareJudge({ ...config, timeoutMs: 180000 }, async () => { calls++; abort.abort(); return new Promise(() => {}); }, abort.signal)).rejects.toThrow('Judge cancelled');
    expect(calls).toBe(1);
});

test('malformed judgment text preserves the actual SDK response and usage', async () => {
    const result = await runJudge(configFor('anthropic'), 'rubric', 'data', async () => answer('anthropic', 'not JSON', 'end_turn', { input_tokens: 7, output_tokens: 2 }));
    expect(result).toMatchObject({ judgment: null, raw: 'not JSON', usage: { input: 7, output: 2 }, usageSource: 'sdk', attempts: 1, stopReason: 'stop', responseComplete: true });
    expect(result.error).not.toBeNull();
});

test('SDK HTTP errors stay failed, unmeasured and single attempt without retries', async () => {
    for (const status of [429, 500]) {
        let calls = 0;
        const result = await runJudge(configFor(), 'rubric', 'data', async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Synthetic provider failure' } }), { status }); });
        expect(result).toMatchObject({ judgment: null, responseComplete: false, attempts: 1, stopReason: 'error', usageSource: 'unknown' });
        expect(result.error).toContain(String(status));
        expect(calls).toBe(1);
    }
});

test('SDK length, unknown and missing finish reasons never turn parseable partial output into a judgment', async () => {
    for (const provider of ['openai-compatible', 'anthropic']) for (const reason of [provider === 'anthropic' ? 'max_tokens' : 'length', 'unknown-reason', undefined]) {
        let calls = 0;
        const result = await runJudge(configFor(provider), 'rubric', 'data', async () => { calls++; return answer(provider, text, reason,
            provider === 'anthropic' ? { input_tokens: 7, output_tokens: 9 } : { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 }); });
        expect(result).toMatchObject({ judgment: null, raw: text, usage: { input: 7, output: 9 }, responseComplete: false, attempts: 1 });
        expect(result.stopReason).toBe(reason === 'length' || reason === 'max_tokens' ? 'length' : 'error');
        expect(result.rawStopReason).toBe(reason ?? null);
        expect(result.error).not.toBeNull();
        expect(calls).toBe(1);
    }
});

test('truncated SSE and malformed SSE retain partial text and fail without a retry', async () => {
    for (const suffix of ['', 'data: {bad-json}\n\n']) {
        let calls = 0;
        const response = new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n' + suffix, { headers: { 'content-type': 'text/event-stream' } });
        const result = await runJudge(configFor(), 'rubric', 'data', async () => { calls++; return response; });
        expect(result).toMatchObject({ judgment: null, raw: text, stopReason: 'error', responseComplete: false, attempts: 1 });
        expect(result.error).not.toBeNull();
        expect(calls).toBe(1);
    }
});

test('tool use is incomplete even when a conflicting SDK stop marker is present', async () => {
    for (const reason of ['tool_calls', 'stop']) {
        const result = await runJudge(configFor(), 'rubric', 'data', async () => sse([{ choices: [{ delta: { content: text,
            tool_calls: [{ index: 0, id: 'unexpected', type: 'function', function: { name: 'grade', arguments: '{}' } }] }, finish_reason: reason }] }]));
        expect(result).toMatchObject({ judgment: null, raw: text, stopReason: reason === 'tool_calls' ? 'toolUse' : 'stop', responseComplete: false, attempts: 1 });
        expect(result.error).toContain('incomplete');
    }
});

test('timeout and cancellation abort the SDK transport; a pre-cancelled call sends nothing', async () => {
    const timeout = await runJudge(await prepareJudge(configFor('openai-compatible', '10')), 'rubric', 'data', abortingFetch);
    expect(timeout).toMatchObject({ judgment: null, attempts: 1, stopReason: 'aborted', responseComplete: false });
    expect(timeout.error).toContain('timeout');
    const abort = new AbortController();
    let requests = 0;
    const cancelled = await runJudge(configFor(), 'rubric', 'data', async (url, init) => { requests++; const response = abortingFetch(url, init); abort.abort(); return response; }, abort.signal);
    expect(cancelled).toMatchObject({ judgment: null, attempts: 1, stopReason: 'aborted', error: 'Judge cancelled' });
    const before = await runJudge(configFor(), 'rubric', 'data', async () => { requests++; throw Error('must not send'); }, abort.signal);
    expect(before).toMatchObject({ judgment: null, attempts: 0, error: 'Judge cancelled' });
    expect(requests).toBe(1);
});

test('independent prepared runtimes never share keys or inherit an ambient key', async () => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'ambient-key';
    try {
        const configurations = [await prepareJudge(configFor()), await prepareJudge(judgeConfig({ ...env, FLOWMATE_JUDGE_API_KEY: 'other-judge-key' }, emptyRepo)!)];
        for (const [index, config] of configurations.entries()) {
            const result = await runJudge(config, 'rubric', 'data', async (_, init) => {
                expect(new Headers(init.headers).get('authorization')).toBe(index === 0 ? 'Bearer judge-key' : 'Bearer other-judge-key');
                return answer('openai-compatible', text, 'stop');
            });
            expect(result.judgment?.score).toBe(1);
            expect(JSON.stringify(result)).not.toContain('judge-key');
            expect(JSON.stringify(result)).not.toContain('ambient-key');
        }
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test('an SDK aborted stream retains its partial raw text and token usage', async () => {
    const abort = new AbortController();
    const result = await runJudge(configFor(), 'rubric', 'data', async (_, init) => {
        const body = new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }],
                usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 } }) + '\n\n'));
            init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
            setTimeout(() => abort.abort(), 10);
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }, abort.signal);
    expect(result).toMatchObject({ raw: text, usage: { input: 7, output: 9 }, usageSource: 'sdk', stopReason: 'aborted',
        error: 'Judge cancelled', judgment: null, responseComplete: false, attempts: 1 });
});

test('a JSON-only response never activates a hidden non-SDK generation fallback', async () => {
    let calls = 0;
    const result = await runJudge(configFor(), 'rubric', 'data', async () => { calls++; return Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }); });
    expect(result).toMatchObject({ judgment: null, stopReason: 'error', responseComplete: false, attempts: 1 });
    expect(calls).toBe(1);
});

test('explicit Responses API dispatches through its real SDK adapter', async () => {
    const config = judgeConfig({ ...env, FLOWMATE_JUDGE_MODEL: 'gpt-4o-mini', FLOWMATE_JUDGE_API: 'openai-responses' }, emptyRepo)!;
    const item = { type: 'message', id: 'sdk-responses', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    let calls = 0;
    const result = await runJudge(config, 'rubric', 'data', async (url, init) => {
        calls++;
        expect(url).toBe('https://example.com/v1/responses');
        expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-4o-mini', stream: true, max_output_tokens: 16384 });
        return sse([{ type: 'response.created', response: { id: 'controlled-responses' } },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { id: 'controlled-responses', status: 'completed', output: [item],
                usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 } } }]);
    });
    expect(result).toMatchObject({ judgment: { score: 1 }, stopReason: 'stop', responseComplete: true, usage: { input: 10, output: 8 } });
    expect(calls).toBe(1);
});

test('timeout and cancellation bound a fetch implementation that ignores its AbortSignal', async () => {
    const config = await prepareJudge(configFor('openai-compatible', '10'));
    const timedOut = await runJudge(config, 'rubric', 'data', async () => new Promise(() => {}));
    expect(timedOut).toMatchObject({ attempts: 1, error: 'Judge timeout', stopReason: null, usage: null, judgment: null });
    const abort = new AbortController();
    const cancelled = await runJudge(configFor(), 'rubric', 'data', async () => { abort.abort(); return new Promise(() => {}); }, abort.signal);
    expect(cancelled).toMatchObject({ attempts: 1, error: 'Judge cancelled', stopReason: null, usage: null, judgment: null });
});

test('retired budgets stay absent and direct SDK transport rejects injected retired fields', async () => {
    const config = judgeConfig({ ...env, FLOWMATE_JUDGE_TEMPERATURE: 'invalid', FLOWMATE_JUDGE_MAX_TOKENS: '256' }, emptyRepo)!;
    expect(config).not.toHaveProperty('temperature'); expect(config).not.toHaveProperty('maxTokens');
    let calls = 0;
    await expect(requestJudge(Object.assign(config, { maxTokens: 256, temperature: 0.8 }), 'rubric', 'data', async () => { calls++; throw Error('must not send'); })).rejects.toThrow();
    expect(calls).toBe(0);
});

test('strict structured score rejects malformed, out-of-range and empty explanations', () => {
    expect(parseJudgment('{"score":0.5,"reason":"Partial evidence"}').score).toBe(0.5);
    for (const value of ['bad', '{}', '{"score":2,"reason":"x"}', '{"score":1,"reason":" "}', '{"score":"1","reason":"x"}']) expect(() => parseJudgment(value)).toThrow();
});
