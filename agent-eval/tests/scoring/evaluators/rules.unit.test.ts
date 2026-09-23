import { test, expect } from 'bun:test';
import { observed, task, projected, dataset } from '../../support/fixtures.ts';
import { evaluateAll } from '../../../src/scoring/evaluate.ts';
import { aggregate } from '../../../src/scoring/aggregate.ts';
import { EvaluatorRegistry } from '../../../src/scoring/registry.ts';
import { definitions } from '../../../src/scoring/evaluators/index.ts';
import type { Check } from '../../../src/datasets/local.ts';
const check: Check = { metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true };
test('not-started evidence cannot invoke quality graders even with a contradictory completed flag', async () => {
    const result = observed();
    result.started = false;
    expect((await evaluateAll({ task, result, projected, judge: null }, [check])).scores).toHaveLength(0);
});
test('completed tasks: true/false/missing evidence are distinct and hard failure survives missing score', async () => {
    for (const [value, status] of [[true, 'PASS'], [false, 'FAIL'], [undefined, 'UNJUDGEABLE']] as const) {
        const result = observed();
        result.evidence['task-facts']!.actual = { saved: value };
        const { scores } = await evaluateAll({ task, result, projected, judge: null }, [check]);
        expect(scores[0]!.status).toBe(status);
        expect(scores[0]!.value).toBe(value === undefined ? null : value ? 1 : 0);
    }
    const result = observed();
    result.evidence['task-facts']!.actual = { saved: false };
    const { scores } = await evaluateAll({ task, result, projected, judge: null }, [check, { metric: 'reference-fields', required: true }]);
    expect(aggregate(scores, result).status).toBe('FAIL');
});
test('no task quality scores for failed/timeout/cancelled/not-started or intermediate completion', async () => {
    for (const status of ['failed', 'timeout', 'cancelled', 'not-started', 'error', 'completed'] as const) {
        const result = observed();
        result.status = status;
        result.endpointReached = false;
        const judged = await evaluateAll({ task, result, projected, judge: null }, [check, { metric: 'answer-relevance', required: true }]);
        expect(judged.scores).toHaveLength(0);
        expect(judged.judgeCalls).toHaveLength(0);
        expect(aggregate([], result).status).not.toBe('PASS');
    }
});
test('all reusable guards reject wrong or absent facts; registry refuses duplicates and unknown rules', async () => {
    for (const metric of ['task-result', 'input-isolation', 'environment-isolation', 'no-secret', 'closed'] as const) {
        const result = observed();
        const pass = await evaluateAll({ task, result, projected, judge: null }, [{ metric, required: true }]);
        expect(pass.scores[0]!.status).toBe('PASS');
        result.evidence = {};
        const missing = await evaluateAll({ task, result, projected, judge: null }, [{ metric, required: true }]);
        expect(missing.scores[0]!.value).toBeNull();
    }
    const result = observed();
    (result.evidence.environment!.actual as any).trialId = 'another';
    expect((await evaluateAll({ task, result, projected, judge: null }, [{ metric: 'environment-isolation', required: true }])).scores[0]!.status).toBe('FAIL');
    const registry = new EvaluatorRegistry();
    registry.register(definitions[0]!);
    expect(() => registry.register(definitions[0]!)).toThrow();
    expect(() => registry.get('unknown')).toThrow();
    expect(aggregate([], observed()).status).toBe('UNJUDGEABLE');
});
test('line-item grading uses verified row facts, unique matches and distinct missing evidence', async () => {
    const target = structuredClone(dataset.cases.find(c => c.id === 'test-lines')!);
    target.expected.reference!.status = 'verified';
    const rows = structuredClone(target.expected.reference!.lineItems!);
    const result = observed();
    result.evidence['candidate-line-items'] = { present: true, actual: [...rows].reverse(), source: 'candidate-query' };
    const run = () => evaluateAll({ task: target, result, projected, judge: null }, [{ metric: 'line-items', required: true }]);
    expect((await run()).scores[0]!.status).toBe('PASS');
    result.evidence['candidate-line-items']!.actual = [rows[0], rows[0]];
    const wrong = await run();
    expect(wrong.scores[0]!.status).toBe('FAIL');
    expect(wrong.scores[0]!.actual).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    delete result.evidence['candidate-line-items'];
    expect((await run()).scores[0]!.value).toBeNull();
});
test('malformed guard evidence is unknown, never a business zero', async () => {
    for (const [metric, key] of [['task-result', 'task-endpoint'], ['environment-isolation', 'environment'], ['no-secret', 'redaction-scan'], ['closed', 'cleanup']] as const) {
        const result = observed();
        result.evidence[key]!.actual = {};
        const checked = await evaluateAll({ task, result, projected, judge: null }, [{ metric, required: true }]);
        expect(checked.scores[0]!.value).toBeNull();
        expect(checked.scores[0]!.status).toBe('UNJUDGEABLE');
    }
});
