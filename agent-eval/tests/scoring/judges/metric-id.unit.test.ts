import { expect, test } from 'bun:test';
import { judgeConfig } from '../../../src/scoring/judges/client.ts';
import { runCompactJudge } from '../../../src/scoring/judges/harness.ts';
import { compactScores, compactRubricFor, parseCompactJudgment, parseMetricJudgment } from '../../../src/scoring/judges/compact.ts';
import { readFileSync } from 'node:fs';
import { judgeResponse } from '../../support/judge-response.ts';

const config = judgeConfig({ FLOWMATE_JUDGE_API: 'openai-completions', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
    FLOWMATE_JUDGE_API_KEY: 'synthetic-metric-key', FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1' })!;
const plan = { contract: 'flowmate-semantic-plan/v1' as const, criteria: [
    { metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 3, required: true, rule: 'Three decisions.', evidence: ['original'], trigger: 'started' as const },
    { metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 4, required: true, rule: 'Four requests.', evidence: ['original'], trigger: 'started' as const }
] };
const result = (metricId: string, numerator: number, denominator: number, unassessable = 0) => ({ metricId,
    counts: { numerator, denominator, unassessable }, failures: [] });
async function judge(results: unknown[], extra = {}) {
    let requests = 0;
    const call = await runCompactJudge(config, plan, {}, async () => {
        requests++;
        return judgeResponse({ choices: [{ message: { content: JSON.stringify({ v: 1, results, ...extra }) }, finish_reason: 'stop' }] });
    });
    expect(requests).toBe(1);
    return call;
}

test('new generation binds named counts by metric ID in any order with a business-only prompt', async () => {
    const call = await judge([result('tool-arguments', 4, 4), {...result('tool-selection', 2, 3),failures:[{opportunityIndex:2,code:1}]}]);
    expect(call.error).toBeNull();
    expect(call.compact).toMatchObject({ format: 'metric-id/v1', validationErrors: {} });
    expect(compactScores(call)).toMatchObject([{ metricId: 'tool-selection', status: 'FAIL', value: 2 / 3 },
        { metricId: 'tool-arguments', status: 'PASS', value: 1 }]);
    expect(compactRubricFor(plan).prompt).not.toContain('"research"');
    expect(compactRubricFor(plan).prompt).toContain('untrusted DATA');
});

test('missing, duplicate, malformed and contradictory metric results retain the valid sibling', async () => {
    for (const broken of [[], [result('tool-arguments', 4, 4), result('tool-arguments', 4, 4)],
        [{ metricId: 'tool-arguments', counts: [null, null, null], failures: [] }],
        [result('tool-arguments', 4, 4, 1)], [result('tool-arguments', 3, 5)],
        [{ ...result('tool-arguments', 4, 4), failures: [{ opportunityIndex: 0, code: 1 }] }],
        [{ ...result('tool-arguments', 3, 4), failures: [{ opportunityIndex: 4, code: 1 }] }]]) {
        const call = await judge([result('tool-selection', 3, 3), ...broken]);
        expect(call.error).toBeNull();
        expect(compactScores(call)).toMatchObject([{ status: 'PASS', value: 1 }, { status: 'ERROR', value: null }]);
        expect(call.compact?.validationErrors).toHaveProperty('tool-arguments');
    }
});

test('unknown metric identity and business research payload invalidate the envelope without retry', async () => {
    for (const [results, extra] of [[[result('not-a-declared-metric', 1, 1)], {}],
        [[result('tool-selection', 3, 3), result('tool-arguments', 4, 4)], { research: { atoms: [], links: [], chains: [] } }]] as const) {
        const call = await judge([...results], extra);
        expect(call.error).not.toBeNull();
        expect(compactScores(call).every(s => s.status === 'ERROR')).toBe(true);
    }
});

test('named failures preserve declared opportunity identities and partial known failure', async () => {
    const call = await judge([result('tool-selection', 3, 3), { ...result('tool-arguments', 1, 4, 1),
        failures: [{ opportunityIndex: 2, code: 1 },{opportunityIndex:3,code:4}] }]);
    expect(compactScores(call)[1]).toMatchObject({ status: 'FAIL', value: null,
        statistics: { numerator: 1, denominator: 4, missing: 1 }, actual: { failures: [[1, 2, 1],[1,3,4]] } });
});

test('all fourteen structural Smoke failures reproduce under the frozen old parser and are not accepted as named results',()=>{
    const samples=JSON.parse(readFileSync(new URL('../../fixtures/judges/smoke/2026-10-14.json',import.meta.url),'utf8'));
    expect(samples).toHaveLength(14);
    for(const sample of samples){
        expect(()=>parseCompactJudgment(JSON.stringify(sample.raw),sample.plan,sample.frame)).toThrow();
        expect(()=>parseMetricJudgment(JSON.stringify(sample.raw),sample.plan,sample.frame)).toThrow();
    }
    expect(JSON.stringify(samples)).not.toContain('apiKey');
});
