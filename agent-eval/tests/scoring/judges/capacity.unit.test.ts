import { expect, test, spyOn } from 'bun:test';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeConfig, requestJudge, type NativeJudgeConfig } from '../../../src/scoring/judges/client.ts';
import { runJudge, runCompactJudge } from '../../../src/scoring/judges/harness.ts';
import { compactRubricFor, type CompactPlan } from '../../../src/scoring/judges/compact.ts';
import { evaluatorEvidence } from '../../../src/scoring/judges/evaluators.ts';
import { decodeJudgeInput, sharedTextEncoding } from '../../../src/scoring/judges/shared-text.ts';
import { judgeResponse } from '../../support/judge-response.ts';

const repo = join(tmpdir(), 'flowmate-judge-capacity-no-config');
const env = { FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_BASE_URL: 'https://example.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'capacity-fixture-key' };
const config = (extra: NodeJS.ProcessEnv = {}) => judgeConfig({ ...env, ...extra }, repo)!;
const plan: CompactPlan = { contract: 'flowmate-semantic-plan/v1', criteria: [{ metricId: 'completion-verification', version: 1,
    unit: '终结机会', denominator: null, required: true, rule: 'Inspect original evidence.', evidence: ['original'], trigger: 'started' }] };
const result = () => judgeResponse({ choices: [{ message: { content: JSON.stringify({ v: 1, results: [{ metricId: 'completion-verification', counts: null, failures: [] }] }) }, finish_reason: 'stop' }] });
type Call = Awaited<ReturnType<typeof runJudge>>;

test('a fitting combined Judge stays raw and checkpoints its explicit output limit only at actual dispatch', async () => {
    const evidence = { original: '金额😀\r\n' }, updates: Call[] = [];
    const data = JSON.stringify({ plan, evidence: evaluatorEvidence(plan, evidence) });
    let requests = 0;
    const call = await runCompactJudge(config(), plan, evidence, async (_url, init) => {
        requests++;
        expect(updates.map(update => update.lifecycle)).toEqual(['prepared', 'submitted']);
        expect(updates[1]!.attempts).toBe(1);
        const body = JSON.parse(String(init.body));
        expect(body.messages[1].content).toBe(data);
        expect(body.max_completion_tokens).toBe(32768);
        return result();
    }, undefined, undefined, update => updates.push(update));
    expect(requests).toBe(1);
    expect(updates.map(update => [update.lifecycle, update.attempts])).toEqual([['prepared', 0], ['submitted', 1], ['ended', 1]]);
    expect(updates[0]!.endedAt).toBe('');
    expect(updates[0]!.capacity?.actualMaxOutputTokens).toBeNull();
    expect(call).toMatchObject({ lifecycle: 'ended', error: null, attempts: 1, submissionUnknown: false, capacity: { inputChars: data.length,
        inputBytes: Buffer.byteLength(data, 'utf8'), contextWindow: 131072, outputBudget: 32768, actualMaxOutputTokens: 32768, inputEncoding: 'raw' } });
    expect(call.capacity?.inputBytes).toBeGreaterThan(call.capacity!.inputChars);
    expect(call.capacity?.estimatedInputTokens).toBe(estimateContextTokens([
        { role: 'system', content: compactRubricFor(plan).prompt, timestamp: 0 }, { role: 'user', content: data, timestamp: 0 },
    ]).tokens);
});

test('oversized repeated evidence is losslessly encoded once and still sent as one combined Judge task', async () => {
    const source = 'Original 金额😀 evidence.\n'.repeat(10000), evidence = { original: source, copies: [source, source, source] };
    const original = { plan, evidence: evaluatorEvidence(plan, evidence) };
    let requests = 0;
    const call = await runCompactJudge(config(), plan, evidence, async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init.body));
        expect(body.max_completion_tokens).toBe(32768);
        expect(JSON.parse(body.messages[1].content).wireEncoding).toBe(sharedTextEncoding);
        expect(decodeJudgeInput(body.messages[1].content, true)).toEqual(original);
        return result();
    });
    expect(requests).toBe(1);
    expect(call).toMatchObject({ attempts: 1, error: null, capacity: { contextWindow: 131072, outputBudget: 32768, actualMaxOutputTokens: 32768, inputEncoding: sharedTextEncoding },
        compact: { scoringVersion: 2, inputEncoding: sharedTextEncoding } });
    expect(call.capacity!.estimatedInputTokens! + call.capacity!.outputBudget! + 4096).toBeLessThanOrEqual(131072);
    expect(decodeJudgeInput(call.request.data, true)).toEqual(original);
});

test('irreducible overcapacity evidence remains intact with zero submissions and no output-token clamp', async () => {
    const evidence = { original: 'Unique unchanged evidence.\n'.repeat(25000) }, updates: Call[] = [];
    let requests = 0;
    const call = await runCompactJudge(config(), plan, evidence, async () => { requests++; return result(); }, undefined, undefined, update => updates.push(update));
    expect(requests).toBe(0);
    expect(call).toMatchObject({ attempts: 0, errorCode: 'judge_context_capacity', judgment: null, responseComplete: false, submissionUnknown: false,
        capacity: { contextWindow: 131072, outputBudget: 32768, actualMaxOutputTokens: null, inputEncoding: sharedTextEncoding } });
    expect(call.error).toContain('judge_context_capacity');
    expect(call.capacity!.estimatedInputTokens! + 32768 + 4096).toBeGreaterThan(131072);
    expect(decodeJudgeInput(call.request.data, true)).toEqual({ plan, evidence: evaluatorEvidence(plan, evidence) });
    expect(updates.map(update => [update.lifecycle, update.attempts])).toEqual([['prepared', 0], ['ended', 0]]);
});

test('direct Judge requests reject input that leaves no requested output room before invoking HTTP', async () => {
    let requests = 0;
    await expect(requestJudge(config(), 'rubric', 'x'.repeat(400000), async () => { requests++; return result(); }))
        .rejects.toMatchObject({ code: 'judge_context_capacity' });
    expect(requests).toBe(0);
});

test('the configured output ceiling is explicit and a larger catalog maximum cannot replace the default', async () => {
    for (const [extra, expected] of [
        [{ FLOWMATE_JUDGE_MAX_OUTPUT_TOKENS: '12000' }, 12000],
        [{ FLOWMATE_JUDGE_MAX_OUTPUT_TOKENS: '999999' }, 32768],
        [{ FLOWMATE_JUDGE_PROVIDER: 'anthropic', FLOWMATE_JUDGE_MODEL: 'claude-haiku-4-5' }, 32768],
    ] as const) {
        const call = await runJudge(config(extra), 'rubric', '{}', async (_url, init) => {
            const body = JSON.parse(String(init.body));
            expect(body.max_completion_tokens ?? body.max_tokens).toBe(expected);
            return extra.FLOWMATE_JUDGE_PROVIDER === 'anthropic'
                ? judgeResponse({ content: [{ type: 'text', text: '{"score":1,"reason":"Supported"}' }], stop_reason: 'end_turn' })
                : judgeResponse({ choices: [{ message: { content: '{"score":1,"reason":"Supported"}' }, finish_reason: 'stop' }] });
        });
        expect(call).toMatchObject({ error: null, capacity: { outputBudget: expected, actualMaxOutputTokens: expected } });
    }
    for (const value of ['0', '-1', '1.5', 'invalid']) expect(() => config({ FLOWMATE_JUDGE_MAX_OUTPUT_TOKENS: value })).toThrow('Invalid');
});

test.each(['prepared', 'submitted', 'ended'] as const)('a %s checkpoint failure propagates without hiding or repeating a submission', async stage => {
    let requests = 0;
    await expect(runCompactJudge(config(), plan, {}, async () => { requests++; return result(); }, undefined, undefined, call => {
        if (call.lifecycle === stage) throw Error('Controlled checkpoint failure');
    })).rejects.toThrow('Controlled checkpoint failure');
    expect(requests).toBe(stage === 'ended' ? 1 : 0);
});

test('an unobservable Google SDK dispatch records uncertainty before calling the SDK even with zero observed attempts', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const updates: Call[] = [];
    let sdkCalls = 0, customFetchCalls = 0;
    const generation = spyOn(ModelRuntime.prototype, 'completeSimple').mockImplementation(async (_model, _context, options) => {
        sdkCalls++;
        expect(options?.fetch).toBeUndefined();
        expect(updates.at(-1)).toMatchObject({ lifecycle: 'prepared', attempts: 0, submissionUnknown: true });
        throw Error('Controlled unobservable SDK failure');
    });
    try {
        const google = config({ FLOWMATE_JUDGE_API: 'google-generative-ai', FLOWMATE_JUDGE_MODEL: 'gemini-2.5-flash' });
        const call = await runCompactJudge(google, plan, {}, async () => { customFetchCalls++; throw Error('Custom fetch is unavailable'); },
            undefined, undefined, update => updates.push(update));
        expect(sdkCalls).toBe(1); expect(customFetchCalls).toBe(0);
        expect(call).toMatchObject({ lifecycle: 'ended', attempts: 0, submissionUnknown: true, error: 'Controlled unobservable SDK failure',
            capacity: { actualMaxOutputTokens: null } });
    } finally { generation.mockRestore(); }
});

test('native Judge counts only the exec dispatch and preserves unavailable SDK capacity as null', async () => {
    const native: NativeJudgeConfig = { provider: 'codex-cli', executable: 'controlled-codex', model: 'gpt-6.1-terra', reasoningEffort: 'max', timeoutMs: 10000 };
    const updates: Call[] = [];
    let probes = 0, submissions = 0;
    const call = await runCompactJudge(native, plan, {}, undefined, undefined, async (_exe, args) => {
        if (args.includes('--version')) { probes++; expect(updates.at(-1)!.attempts).toBe(0); return { code: 0, stdout: 'controlled codex', stderr: '' }; }
        submissions++;
        expect(updates.at(-1)!.lifecycle).toBe('submitted');
        return { code: 0, stderr: '', stdout: [
            { type: 'item.completed', item: { type: 'agent_message', text: '{"v":1,"results":[{"metricId":"completion-verification","counts":null,"failures":[]}]}' } },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
        ].map(value => JSON.stringify(value)).join('\n') };
    }, update => updates.push(update));
    expect(probes).toBe(1); expect(submissions).toBe(1);
    expect(call).toMatchObject({ error: null, attempts: 1, submissionUnknown: false, capacity: { estimatedInputTokens: null, contextWindow: null, outputBudget: null, actualMaxOutputTokens: null, inputEncoding: 'raw' } });
    expect(updates.map(update => update.lifecycle)).toEqual(['prepared', 'submitted', 'ended']);
});
