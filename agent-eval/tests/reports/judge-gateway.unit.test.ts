import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { judgeConfig, publicJudgeConfig, requestJudge } from '../../src/scoring/judges/client.ts';
import { readLocalCodexModelCapabilities } from '../../src/configuration.ts';
import { LOCAL_NO_AUTH_API_KEY } from '../../src/execution/evidence-safety.ts';
import { judgeResponse } from '../support/judge-response.ts';

const connection = { model: 'gpt-6.1-terra', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' };
const env = { FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_API: connection.api, FLOWMATE_JUDGE_MODEL: connection.model,
    FLOWMATE_JUDGE_BASE_URL: connection.baseUrl, FLOWMATE_JUDGE_REASONING_EFFORT: 'max', FLOWMATE_JUDGE_TIMEOUT_MS: '180000' };

test('Terra Judge uses only the verified local gateway without requiring or forwarding a remote key', () => {
    const root = mkdtempSync(join(tmpdir(), 'judge-gateway-'));
    const config = judgeConfig({ ...env, FLOWMATE_JUDGE_API_KEY: 'must-not-forward-old-provider-key' }, root)!;
    expect(config).toMatchObject({ ...connection, provider: 'openai-compatible', apiKey: LOCAL_NO_AUTH_API_KEY, reasoningEffort: 'max' });
    expect(publicJudgeConfig(config)).not.toHaveProperty('apiKey');
    expect(publicJudgeConfig(config)).toMatchObject({ model: connection.model, reasoningEffort: 'max' });
    expect(() => judgeConfig({ ...env, FLOWMATE_JUDGE_BASE_URL: 'https://other.invalid/v1' }, root)).toThrow('Incomplete');
});

test('gateway Terra capabilities come from its exact CLI cache and preserve the transport limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'judge-cache-')), cache = join(root, 'models_cache.json');
    writeFileSync(cache, JSON.stringify({ models: [{ slug: connection.model, context_window: 500000, supported_reasoning_levels: [{ effort: 'max' }] }] }));
    expect(readLocalCodexModelCapabilities(connection, cache)).toMatchObject({ contextWindow: 500000, maxTokens: 128000,
        transport: { maxTokens: 32768 }, reasoning: true });
});

test('HTTP Judge sends the configured max effort through the real SDK and retains it in reported parameters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'judge-wire-')), previous = process.env.CODEX_HOME;
    writeFileSync(join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: connection.model, context_window: 500000,
        supported_reasoning_levels: [{ effort: 'max' }] }] }));
    process.env.CODEX_HOME = root;
    try {
        const config = judgeConfig(env, root)!; const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
        const result = await requestJudge(config, 'Return the supplied JSON.', '{"ok":true}', async (url, init) => {
            seen.push({ url, body: JSON.parse(String(init.body)) });
            return judgeResponse({ model: connection.model, choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
        });
        expect(seen).toHaveLength(1); expect(seen[0]!.url).toBe(connection.baseUrl + '/chat/completions');
        expect(seen[0]!.body).toMatchObject({ model: connection.model, reasoning_effort: 'max' });
        const limit = seen[0]!.body.max_completion_tokens ?? seen[0]!.body.max_tokens;
        expect(limit === undefined || Number(limit) <= 32768).toBe(true);
        expect(result).toMatchObject({ responseComplete: true, text: '{"ok":true}', error: null });
    } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
}, 15000);
