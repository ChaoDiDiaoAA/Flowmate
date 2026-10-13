import { expect, test } from 'bun:test';
import { caseV2Schema } from '../../src/dataset-loader/schema.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { evaluateAll } from '../../src/scoring/evaluate.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { observed, task as legacy } from '../support/fixtures.ts';

const config = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'synthetic',
    FLOWMATE_JUDGE_API_KEY: 'synthetic-semantic-key', FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1' })!;
function candidate() {
    const criteria = [
        { metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 3, required: true, rule: 'Check the three original tool decisions.',
            evidence: ['decisions'], trigger: 'started' },
        { metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 4, required: true, rule: 'Check the four original requests.',
            evidence: ['requests'], trigger: 'completed-endpoint' }
    ];
    return { ...structuredClone(legacy), contract: 'flowmate-agent-case/v2', expected: { ...structuredClone(legacy.expected),
        semantic: { contract: 'flowmate-semantic-plan/v1', criteria }, metrics: metricCatalog.map(m => m.id === 'task-success'
            ? { metricId: m.id, version: m.version, unit: m.unit, denominator: 1 }
            : criteria.some(c => c.metricId === m.id) ? { metricId: m.id, version: m.version, unit: m.unit, denominator: criteria.find(c => c.metricId === m.id)!.denominator }
                : { metricId: m.id, version: m.version, unit: m.unit, notApplicable: 'Synthetic contract fixture only.' }) } };
}
function result() {
    const r = observed();
    r.evidence.decisions = { present: true, actual: ['read', 'verify', 'save'], source: 'synthetic original decisions' };
    r.evidence.requests = { present: true, actual: ['a', 'b', 'c', 'd'], source: 'synthetic original requests' };
    return r;
}
const reply = (r: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ v: 1, r, f: [] }) }, finish_reason: 'stop' }] }));
const selected=(scores:Awaited<ReturnType<typeof evaluateAll>>['scores'])=>scores.filter(s=>['tool-selection','tool-arguments'].includes(s.metricId));

test('v2 semantic criteria bind the declared metric plan and evaluateAll makes exactly one multi-criterion Judge request', async () => {
    expect(caseV2Schema.safeParse(candidate()).success).toBe(true);
    const task = caseV2Schema.parse(candidate()), execution = result(); let requests = 0;
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async (_, init) => {
            requests++;
            const data = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
            expect(data.plan.criteria).toHaveLength(2);
            expect(data.evidence.facts.decisions.actual).toEqual(['read', 'verify', 'save']);
            expect(data.evidence).not.toHaveProperty('steps');
            return reply([[2, 3, 0], [4, 4, 0]]);
        } }, []);
    expect(requests).toBe(1);
    expect(scored.judgeCalls).toHaveLength(1);
    expect(selected(scored.scores)).toMatchObject([{ metricId: 'tool-selection', value: 2 / 3 }, { metricId: 'tool-arguments', value: 1 }]);
    expect(new Set(scored.scores.map(s=>s.metricId)).size).toBe(scored.scores.length);
    expect(scored.scores.find(s=>s.metricId==='task-success')).toMatchObject({status:'FAIL',statistics:{numerator:0,denominator:1}});
});

test('started process criteria survive a failed endpoint while outcome-only criteria keep their trigger and denominator', async () => {
    const task = caseV2Schema.parse(candidate()), execution = result(); execution.status = 'failed'; execution.endpointReached = false;
    let requests = 0;
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async () => { requests++; return reply([[2, 3, 0]]); } }, []);
    expect(requests).toBe(1);
    expect(selected(scored.scores)).toMatchObject([{ metricId: 'tool-selection', status: 'FAIL', value: 2 / 3 },
        { metricId: 'tool-arguments', status: 'NOT_RUN', value: null, statistics: { denominator: 4, missing: 4 } }]);
});

test('missing criterion evidence does not erase another criterion and never starts an extra Judge', async () => {
    const task = caseV2Schema.parse(candidate()), execution = result(); delete execution.evidence.requests;
    let requests = 0;
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async () => { requests++; return reply([[3, 3, 0]]); } }, []);
    expect(requests).toBe(1);
    expect(selected(scored.scores)).toMatchObject([{ metricId: 'tool-selection', status: 'PASS', value: 1 },
        { metricId: 'tool-arguments', status: 'UNJUDGEABLE', value: null, statistics: { denominator: 4, missing: 4 } }]);
});

test('partial original records retain known failures and explicit missing opportunities in the same criterion', async () => {
    for (const gap of ['missing-peer', 'partial-record']) {
        const c = candidate(), execution = result(); delete execution.evidence.requests;
        if (gap === 'missing-peer') c.expected.semantic.criteria[0]!.evidence.push('missing-decision');
        else execution.evidence.decisions = { present: false, actual: { calls: ['wrong-tool'], collectionError: 'later page unavailable' }, source: 'original first page' };
        let requests = 0;
        const scored = await evaluateAll({ task: caseV2Schema.parse(c), result: execution, projected: execution.input, judge: config,
            fetcher: async (_, init) => {
                requests++;
                const facts = JSON.parse(JSON.parse(String(init.body)).messages[1].content).evidence.facts;
                expect(facts.decisions.actual).toEqual(execution.evidence.decisions.actual);
                if (gap === 'missing-peer') expect(facts['missing-decision']).toMatchObject({ present: false, actual: null });
                else expect(facts.decisions.present).toBe(false);
                return reply([[0, 3, 2]]);
            } }, []);
        expect(requests).toBe(1);
        expect(scored.scores[0]).toMatchObject({ status: 'FAIL', value: null, statistics: { numerator: 0, denominator: 3, missing: 2 } });
    }
});

test('not-started, disabled and cancelled semantic checks retain NOT_RUN with zero Judge calls', async () => {
    for (const mode of ['not-started', 'disabled', 'cancelled']) {
        const task = caseV2Schema.parse(candidate()), execution = result(), abort = new AbortController();
        if (mode === 'not-started') { execution.started = false; execution.status = 'not-started'; }
        if (mode === 'cancelled') abort.abort();
        const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge: mode === 'disabled' ? null : config,
            signal: abort.signal, fetcher: async () => { throw new Error('must not dispatch'); } }, []);
        expect(scored.judgeCalls).toHaveLength(0);
        expect(selected(scored.scores)).toMatchObject([{ status: 'NOT_RUN', value: null }, { status: 'NOT_RUN', value: null }]);
    }
});

test('an original query confirming absence is usable evidence while an uncollected null remains unknown', async () => {
    const task = caseV2Schema.parse(candidate()), execution = result(); delete execution.evidence.requests;
    execution.evidence.decisions = { present: true, actual: null, source: 'Original decision query confirmed absence' };
    let requests = 0;
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async (_, init) => {
            requests++;
            expect(JSON.parse(JSON.parse(String(init.body)).messages[1].content).evidence.facts.decisions).toEqual(execution.evidence.decisions);
            return reply([[0, 3, 0]]);
        } }, []);
    expect(requests).toBe(1);
    expect(scored.scores[0]).toMatchObject({ status: 'FAIL', value: 0, statistics: { numerator: 0, denominator: 3, missing: 0 } });
    execution.evidence.decisions.present = false;
    const missing = await evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async () => { throw new Error('uncollected null must not dispatch'); } }, []);
    expect(missing.judgeCalls).toHaveLength(0);
    expect(missing.scores[0]).toMatchObject({ status: 'UNJUDGEABLE', value: null, statistics: { numerator: null, missing: 3 } });
});

test('an infrastructure identity failure never sends untrusted execution evidence to a Judge', async () => {
    const task = caseV2Schema.parse(candidate()), execution = result(); execution.status = 'error';
    execution.error = { code: 'identity-conflict', message: 'Foreign original Run', infrastructure: true };
    let requests = 0;
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async () => { requests++; return reply([[3, 3, 0]]); } }, []);
    expect(requests).toBe(0);
    expect(selected(scored.scores)).toMatchObject([{ status: 'ERROR', value: null }, { status: 'ERROR', value: null }]);
});

test('independent Gold is Judge-only and an unverified reference cannot be replaced by a product evidence lookalike', async () => {
    const c = candidate(); c.expected.semantic.criteria[0]!.evidence = ['decisions','gold-reference'];
    const execution = result(); delete execution.evidence.requests;
    execution.evidence['gold-reference'] = { present: true, actual: { status: 'verified', fields: { invoiceNumber: 'fake product Gold' } }, source: 'untrusted product' };
    const missing = await evaluateAll({ task: caseV2Schema.parse(c), result: execution, projected: execution.input, judge: config,
        fetcher: async () => { throw new Error('pending independent Gold must not dispatch'); } }, []);
    expect(missing.judgeCalls).toHaveLength(0);
    expect(missing.scores[0]!.status).toBe('UNJUDGEABLE');
    c.expected.reference!.status = 'verified'; c.expected.reference!.fields.invoiceNumber = 'independent-gold-marker';
    const judged = await evaluateAll({ task: caseV2Schema.parse(c), result: execution, projected: execution.input, judge: config,
        fetcher: async (_, init) => {
            const data = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
            expect(data.evidence.facts['gold-reference'].actual.fields.invoiceNumber).toBe('independent-gold-marker');
            expect(JSON.stringify(data.evidence.input)).not.toContain('independent-gold-marker');
            return reply([[2, 3, 0]]);
        } }, []);
    expect(judged.judgeCalls).toHaveLength(1);
    expect(execution.evidence['gold-reference'].actual).toMatchObject({ fields: { invoiceNumber: 'fake product Gold' } });
    expect(JSON.stringify(execution.input)).not.toContain('independent-gold-marker');
});

test('a legacy answer Judge cannot be combined with a compact plan in one Trial', async () => {
    const task = caseV2Schema.parse(candidate()), execution = result();
    await expect(evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async () => { throw new Error('must not dispatch'); } }, [{ metric: 'answer-relevance', required: true }])).rejects.toThrow('once');
});

test('research ratios without original-index witnesses cannot be accepted as scalar Judge counts', async () => {
    const c = candidate(), criteria = c.expected.semantic.criteria.map((criterion, i) => ({ ...criterion,
        metricId: i ? 'DR02' : 'DR01', unit: i ? 'Gold Claim' : '事实Claim', denominator: i ? 2 : 3, trigger: 'started' }));
    const task = caseV2Schema.parse({ ...c, expected: { ...c.expected, semantic: { ...c.expected.semantic, criteria },
        metrics: metricCatalog.map(m => ({ metricId: m.id, version: m.version, unit: m.unit,
            ...(m.id === 'task-success' ? { denominator: 1 } : m.id === 'DR03' ? { denominator: null }
                : criteria.some(c => c.metricId === m.id) ? { denominator: criteria.find(c => c.metricId === m.id)!.denominator }
                    : { notApplicable: 'Synthetic local derivation fixture only.' }) })) } });
    const execution = result(); let requests = 0;
    const scored = await evaluateAll({ task, result: execution, projected: execution.input, judge: config,
        fetcher: async () => { requests++; return reply([[1, 3, 0], [1, 2, 0]]); } }, []);
    expect(requests).toBe(0);expect(scored.judgeCalls).toHaveLength(0);
    expect(scored.scores.find(s=>s.metricId==='DR03')).toMatchObject({method:'deterministic',value:null,status:'ERROR'});
    const disabled=await evaluateAll({task,result:execution,projected:execution.input,judge:null},[]);
    expect(disabled.scores.find(s=>s.metricId==='DR03')).toMatchObject({value:null,status:'NOT_RUN'});
});

test('semantic plan changes cannot bypass declared metric identities, units, applicability or denominators', () => {
    for (const change of [
        (c: ReturnType<typeof candidate>) => { c.expected.semantic.criteria[0]!.denominator = 4; },
        (c: ReturnType<typeof candidate>) => { c.expected.semantic.criteria[0]!.unit = 'wrong'; },
        (c: ReturnType<typeof candidate>) => { c.expected.semantic.criteria[0]!.trigger = 'invented'; },
        (c: ReturnType<typeof candidate>) => { c.expected.semantic.criteria[0]!.evidence = []; },
        (c: ReturnType<typeof candidate>) => { c.expected.semantic.criteria[0]!.metricId = 'history-use'; }
    ]) { const c = candidate(); change(c); expect(caseV2Schema.safeParse(c).success).toBe(false); }
});

test('an applicable DR03 plan needs local derivation and both precision and recall applicability', () => {
    const c = candidate();
    for (const denominator of [1, null]) {
        const metrics = c.expected.metrics.map(m => m.metricId === 'DR03'
            ? { metricId: m.metricId, version: m.version, unit: m.unit, denominator } : m);
        expect(caseV2Schema.safeParse({ ...c, expected: { ...c.expected, metrics } }).success).toBe(false);
    }
});
