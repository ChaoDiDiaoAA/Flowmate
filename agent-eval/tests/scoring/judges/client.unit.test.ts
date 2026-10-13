import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeConfig, prepareJudge, requestJudge } from '../../../src/scoring/judges/client.ts';
import { parseJudgment, runJudge } from '../../../src/scoring/judges/harness.ts';

const emptyRepo = join(tmpdir(), 'flowmate-client-unit-no-config');
const env = { FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'judge',
    FLOWMATE_JUDGE_BASE_URL: 'https://example.com/v1', FLOWMATE_JUDGE_API_KEY: 'judge-key' };
const configFor = (provider = 'openai-compatible', timeoutMs = '30000') => judgeConfig({ ...env,
    FLOWMATE_JUDGE_PROVIDER: provider, FLOWMATE_JUDGE_TIMEOUT_MS: timeoutMs }, emptyRepo)!;
const metadata = () => new Response(JSON.stringify({ id: 'canonical-judge', max_tokens: 64000 }));
const answer = (provider: string, text: string, reason: string | undefined, usage: unknown = { output_tokens: 8 }) =>
    new Response(JSON.stringify(provider === 'anthropic' ? { content: [{ type: 'text', text }], stop_reason: reason, usage }
        : { choices: [{ message: { content: text }, finish_reason: reason }], usage }));

test('Judge never inherits Agent credentials and rejects partial configuration', () => {
    expect(judgeConfig({ FLOWMATE_LLM_MODEL: 'agent', FLOWMATE_LLM_API_KEY: 'agent-secret' }, emptyRepo)).toBeNull();
    expect(() => judgeConfig({ FLOWMATE_JUDGE_MODEL: 'judge' }, emptyRepo)).toThrow('Incomplete');
});
test('retired environment variables do not restore temperature or an output budget', () => {
    const config = judgeConfig({ ...env, FLOWMATE_JUDGE_TEMPERATURE: 'invalid-old-value', FLOWMATE_JUDGE_MAX_TOKENS: '256' }, emptyRepo)!;
    expect(config).not.toHaveProperty('temperature');
    expect(config).not.toHaveProperty('maxTokens');
});
test('OpenAI-compatible preparation makes no request and generation omits sampling and token overrides', async () => {
    const config = await prepareJudge(configFor(), async () => { throw Error('Metadata must not be requested'); });
    let calls = 0;
    const result = await requestJudge(config, 'rubric', 'untrusted evidence', async (url, init) => {
        calls++;
        expect(url).toBe('https://example.com/v1/chat/completions');
        const body = JSON.parse(String(init.body));
        for (const field of ['temperature', 'max_tokens', 'max_completion_tokens']) expect(body).not.toHaveProperty(field);
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer judge-key');
        return answer('openai-compatible', '{"score":1,"reason":"Supported"}', 'stop', { prompt_tokens: 10, completion_tokens: 8 });
    });
    expect(calls).toBe(1);
    expect(result.text).toContain('Supported');
});
test('Anthropic prepares model capability once and reuses it for distinct single-attempt generations', async () => {
    let metadataCalls = 0, generationCalls = 0;
    const fetcher = async (url: string, init: RequestInit) => {
        expect((init.headers as Record<string, string>)['x-api-key']).toBe('judge-key');
        if (init.method === 'GET') {
            metadataCalls++;
            expect(url).toBe('https://example.com/v1/models/judge');
            expect(init.body).toBeUndefined();
            return metadata();
        }
        generationCalls++;
        expect(url).toBe('https://example.com/v1/messages');
        const body = JSON.parse(String(init.body));
        expect(body.max_tokens).toBe(64000);
        expect(body).not.toHaveProperty('temperature');
        return answer('anthropic', '{"score":1,"reason":"Supported"}', 'end_turn');
    };
    const config = await prepareJudge(configFor('anthropic'), fetcher);
    expect(config.modelCapabilities).toEqual({ modelId: 'canonical-judge', maxOutputTokens: 64000, source: 'anthropic-models-api' });
    for (let i = 0; i < 2; i++) {
        const call = await runJudge(config, 'rubric', 'data', fetcher);
        expect(call).toMatchObject({ attempts: 1, error: null, judgment: { score: 1, reason: 'Supported' } });
        expect(call.configuration.modelCapabilities).toEqual(config.modelCapabilities);
    }
    expect(metadataCalls).toBe(1);
    expect(generationCalls).toBe(2);
});
test('Anthropic requires prepared capability instead of inventing a fallback limit', async () => {
    let calls = 0;
    const result = await runJudge(configFor('anthropic'), 'rubric', 'data', async () => { calls++; return metadata(); });
    expect(result).toMatchObject({ attempts: 0, judgment: null });
    expect(result.error).toContain('prepared model capability');
    expect(calls).toBe(0);
});
test('missing, invalid or unavailable Anthropic model capability fails without generation or fallback', async () => {
    for (const value of [{ id: 'judge' }, { id: '', max_tokens: 8192 }, ...[null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '8192'].map(max_tokens => ({ id: 'judge', max_tokens }))]) {
        let calls = 0;
        await expect(prepareJudge(configFor('anthropic'), async (_, init) => {
            calls++;
            expect(init.method).toBe('GET');
            return new Response(JSON.stringify(value));
        })).rejects.toThrow('model metadata');
        expect(calls).toBe(1);
    }
    await expect(prepareJudge(configFor('anthropic'), async () => new Response('private provider detail', { status: 404 }))).rejects.toThrow('Judge model metadata HTTP 404');
});
test('model metadata obeys timeout and cancellation without retry', async () => {
    let calls = 0;
    await expect(prepareJudge(configFor('anthropic', '5'), async () => { calls++; return new Promise(() => {}); })).rejects.toThrow('timeout');
    expect(calls).toBe(1);
    const abort = new AbortController(); abort.abort();
    await expect(prepareJudge(configFor('anthropic'), async () => { throw Error('must not call'); }, abort.signal)).rejects.toThrow('cancelled');
});
test('Anthropic malformed output, HTTP errors and timeout retain failed single generation attempts', async () => {
    const config = await prepareJudge(configFor('anthropic', '5'), async () => metadata());
    let calls = 0;
    const malformed = await runJudge(config, 'rubric', 'data', async () => { calls++; return answer('anthropic', 'not JSON', 'end_turn', { output_tokens: 2 }); });
    expect(malformed).toMatchObject({ judgment: null, raw: 'not JSON', usage: { output_tokens: 2 }, attempts: 1 });
    expect(calls).toBe(1);
    const http = await runJudge(config, 'rubric', 'data', async () => new Response('provider detail', { status: 500 }));
    expect(http).toMatchObject({ error: 'Judge HTTP 500', judgment: null, attempts: 1 });
    const timeout = await runJudge(config, 'rubric', 'data', async () => new Promise(() => {}));
    expect(timeout.error).toContain('timeout');
    expect(timeout.judgment).toBeNull();
});
test('strict structured score rejects malformed, out-of-range and empty explanations', () => {
    expect(parseJudgment('{"score":0.5,"reason":"Partial evidence"}').score).toBe(0.5);
    for (const text of ['bad', '{}', '{"score":2,"reason":"x"}', '{"score":1,"reason":" "}', '{"score":"1","reason":"x"}'])
        expect(() => parseJudgment(text)).toThrow();
});
test('direct transport rejects retired configuration fields before dispatch', async () => {
    let calls = 0;
    const config = Object.assign(configFor(), { maxTokens: 256, temperature: 0.8 });
    await expect(requestJudge(config, 'rubric', 'data', async () => { calls++; throw Error('must not call'); })).rejects.toThrow();
    expect(calls).toBe(0);
});
test('truncated or incomplete responses retain original text, usage and stop reason without a judgment or retry', async () => {
    for (const provider of ['openai-compatible', 'anthropic'] as const) {
        const config = await prepareJudge(configFor(provider), async () => metadata());
        for (const reason of [provider === 'anthropic' ? 'max_tokens' : 'length', 'unknown-reason', undefined]) {
            let calls = 0;
            const text = '{"score":1,"reason":"Looks complete but the provider did not complete."}', usage = { input_tokens: 7, output_tokens: 256 };
            const result = await runJudge(config, 'rubric', 'data', async () => { calls++; return answer(provider, text, reason, usage); });
            expect(result).toMatchObject({ judgment: null, raw: text, usage, finishReason: reason ?? null, responseComplete: false, attempts: 1 });
            expect(result.error).toContain('incomplete');
            expect(calls).toBe(1);
        }
    }
});
test('caller cancellation aborts transport and a pre-cancelled call makes zero requests', async () => {
    const config = configFor(), abort = new AbortController();
    let signal: AbortSignal | null | undefined;
    const result = await runJudge(config, 'rubric', 'data', async (_, init) => { signal = init.signal; abort.abort(); return new Promise(() => {}); }, abort.signal);
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({ judgment: null, usage: null, attempts: 1, error: 'Judge cancelled' });
    let calls = 0;
    const before = await runJudge(config, 'rubric', 'data', async () => { calls++; throw Error('must not call'); }, abort.signal);
    expect(before).toMatchObject({ judgment: null, attempts: 0, error: 'Judge cancelled' });
    expect(calls).toBe(0);
});
test('a stop reason cannot certify a Judge response that also requests a tool', async () => {
    const config = configFor(), text = '{"score":1,"reason":"Contradictory response."}', usage = { completion_tokens: 9 };
    for (const extra of [{ tool_calls: [{ id: 'unexpected', type: 'function', function: { name: 'grade', arguments: '{}' } }] },
        { function_call: { name: 'grade', arguments: '{}' } }]) {
        const result = await runJudge(config, 'rubric', 'data', async () => new Response(JSON.stringify({ choices: [{ message: { content: text, ...extra }, finish_reason: 'stop' }], usage })));
        expect(result).toMatchObject({ judgment: null, raw: text, usage, finishReason: 'stop', responseComplete: false, attempts: 1 });
        expect(result.error).toContain('incomplete');
    }
});
