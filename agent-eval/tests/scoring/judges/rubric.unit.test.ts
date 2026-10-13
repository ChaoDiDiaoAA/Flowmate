import { judgeResponse } from '../../support/judge-response.ts';
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observed, task, projected } from '../../support/fixtures.ts';
import { evaluateAll } from '../../../src/scoring/evaluate.ts';
import { judgeConfig } from '../../../src/scoring/judges/client.ts';
const config = judgeConfig({ FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile', FLOWMATE_JUDGE_API_KEY: 'mock-key', FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1' })!;
test('required Judge with an empty answer cannot become not-applicable and pass', async () => {
    const result = observed();
    result.answer = null;
    result.evidence.answer!.actual = null;
    const judged = await evaluateAll({ task, result, projected, judge: config, fetcher: async () => { throw new Error('must not call'); } }, [{ metric: 'answer-relevance', required: true }]);
    expect(judged.scores[0]!.status).toBe('UNJUDGEABLE');
    expect(judged.judgeCalls).toHaveLength(0);
});
test('Judge runs independently of deterministic high/low scores and never receives Gold or future steps', async () => {
    for (const saved of [true, false]) {
        const result = observed();
        result.evidence['task-facts']!.actual = { saved };
        let calls = 0;
        const output = await evaluateAll({ task, result, projected, judge: config, fetcher: async (_, init) => {
                calls++;
                const request = JSON.parse(String(init.body));
                expect(request.messages[0].content).toContain('untrusted DATA');
                const data = JSON.parse(request.messages[1].content);
                expect(data).not.toHaveProperty('expected');
                expect(data).not.toHaveProperty('steps');
                expect(data.criteria).toEqual({ success: task.expected.success, failure: task.expected.failure });
                return judgeResponse({ choices: [{ message: { content: '{"score":1,"reason":"mock supported"}' }, finish_reason: 'stop' }] });
            } }, [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }, { metric: 'answer-relevance', required: false }]);
        expect(calls).toBe(1);
        expect(output.judgeCalls).toHaveLength(1);
        expect(output.scores[1]!.value).toBe(1);
    }
});
test('missing Judge evidence prevents calls; absent configuration is unmeasured, not zero', async () => {
    for (const ref of ['answer', 'input-projection']) {
        const result = observed();
        delete result.evidence[ref];
        const output = await evaluateAll({ task, result, projected, judge: config, fetcher: async () => { throw new Error('must not call'); } }, [{ metric: 'answer-relevance', required: true }]);
        expect(output.scores[0]!.status).toBe('UNJUDGEABLE');
        expect(output.scores[0]!.value).toBeNull();
        expect(output.judgeCalls).toHaveLength(0);
    }
    const output = await evaluateAll({ task, result: observed(), projected, judge: null }, [{ metric: 'answer-relevance', required: false }]);
    expect(output.scores[0]!.status).toBe('NOT_RUN');
});

test('a cancelled semantic check retains its unmeasured status and never invokes the Judge', async () => {
    const abort = new AbortController(); abort.abort();
    let calls = 0;
    const output = await evaluateAll({ task, result: observed(), projected, judge: config, signal: abort.signal,
        fetcher: async () => { calls++; throw new Error('must not call'); } }, [{ metric: 'answer-relevance', required: true }]);
    expect(output.scores[0]).toMatchObject({ status: 'NOT_RUN', value: null, version: 5 });
    expect(output.judgeCalls).toHaveLength(0);
    expect(calls).toBe(0);
});
test('six historical calibration examples are retained as pending references, not successful calibration', () => {
    const files = readdirSync(join(import.meta.dir, '../../fixtures/judges')).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(6);
    for (const file of files)
        expect(JSON.parse(readFileSync(join(import.meta.dir, '../../fixtures/judges', file), 'utf8')).reference.status).toBe('pending');
});
