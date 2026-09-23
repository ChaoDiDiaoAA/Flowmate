import { expect, test } from 'bun:test';
import { judgeConfig, requestJudge } from '../../../src/scoring/judges/client.ts';
import { parseJudgment } from '../../../src/scoring/judges/harness.ts';
import { runJudge } from '../../../src/scoring/judges/harness.ts';
test('Judge never inherits Agent credentials and rejects partial configuration', () => {
    expect(judgeConfig({ FLOWMATE_LLM_MODEL: 'agent', FLOWMATE_LLM_API_KEY: 'agent-secret' })).toBeNull();
    expect(() => judgeConfig({ FLOWMATE_JUDGE_MODEL: 'judge' })).toThrow('Incomplete');
});
test('Anthropic root, timeout, HTTP errors and malformed output are recorded without retry', async () => {
    const config = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'anthropic', FLOWMATE_JUDGE_MODEL: 'judge', FLOWMATE_JUDGE_BASE_URL: 'https://example.com/v1', FLOWMATE_JUDGE_API_KEY: 'judge-key', FLOWMATE_JUDGE_TIMEOUT_MS: '5' })!;
    let calls = 0;
    const malformed = await runJudge(config, 'rubric', 'data', async (url, init) => { calls++; expect(url).toBe('https://example.com/v1/messages'); expect((init.headers as any)['x-api-key']).toBe('judge-key'); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'not JSON' }], usage: { output_tokens: 2 } })); });
    expect(malformed.judgment).toBeNull();
    expect(malformed.raw).toBe('not JSON');
    expect(malformed.usage).toEqual({ output_tokens: 2 });
    expect(calls).toBe(1);
    const http = await runJudge(config, 'rubric', 'data', async () => new Response('provider detail', { status: 500 }));
    expect(http.error).toBe('Judge HTTP 500');
    expect(http.judgment).toBeNull();
    const timeout = await runJudge(config, 'rubric', 'data', async () => new Promise(() => { }));
    expect(timeout.error).toContain('timeout');
    expect(timeout.judgment).toBeNull();
});
test('strict structured score rejects malformed, out-of-range and empty explanations', () => {
    expect(parseJudgment('{"score":0.5,"reason":"Partial evidence"}').score).toBe(0.5);
    for (const text of ['bad', '{}', '{"score":2,"reason":"x"}', '{"score":1,"reason":" "}', '{"score":"1","reason":"x"}'])
        expect(() => parseJudgment(text)).toThrow();
});
test('Judge API root and credentials are independent; one call with bounded output', async () => {
    const config = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'judge', FLOWMATE_JUDGE_BASE_URL: 'https://example.com/v1', FLOWMATE_JUDGE_API_KEY: 'judge-key' })!;
    let calls = 0;
    const result = await requestJudge(config, 'rubric', 'untrusted evidence', async (url, init) => {
        calls++;
        expect(String(url)).toBe('https://example.com/v1/chat/completions');
        expect(JSON.parse(String(init?.body)).max_tokens).toBe(256);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":1,"reason":"Supported"}' } }], usage: { prompt_tokens: 10, completion_tokens: 8 } }));
    });
    expect(calls).toBe(1);
    expect(result.text).toContain('Supported');
});
