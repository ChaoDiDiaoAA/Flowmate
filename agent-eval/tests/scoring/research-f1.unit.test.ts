import { expect, test } from 'bun:test';
import { claimF1, deriveResearchF1, assertResearchF1 } from '../../src/scoring/research-f1.ts';
import type { EvaluationScore, MetricPlan } from '../../src/scoring/types.ts';

const plan: MetricPlan[] = [
    { metricId: 'DR01', version: 1, unit: '事实Claim', denominator: 3 },
    { metricId: 'DR02', version: 1, unit: 'Gold Claim', denominator: 2 },
    { metricId: 'DR03', version: 1, unit: '派生F1', denominator: null }
];
const execution = { started: true };
function operands(): EvaluationScore[] {
    return plan.slice(0, 2).map((m, i) => ({ metricId: m.metricId, version: m.version, name: m.metricId, method: 'llm-judge',
        required: !i, value: 1 / m.denominator!, status: 'FAIL', reason: 'Synthetic original matching counts', evidence: ['original'],
        statistics: { unit: m.unit, numerator: 1, denominator: m.denominator!, missing: 0 } }));
}

test('same-Trial F1 keeps original operand counts and has no invented count denominator or Judge call', () => {
    const own = operands(), derived = deriveResearchF1(plan, own, execution)!;
    expect(derived).toMatchObject({ metricId: 'DR03', value: 0.4, status: 'FAIL', method: 'deterministic', required: true,
        statistics: { unit: '派生F1', numerator: null, denominator: null, missing: null }, actual: { contract: 'flowmate-research-f1/v1' } });
    expect(derived.actual).toMatchObject({ operands: own.map(s => ({ metricId: s.metricId, value: s.value, statistics: s.statistics })) });
    expect(derived).not.toHaveProperty('judge');
    expect(claimF1(0, 0)).toBe(0);
    expect(claimF1(0, 1)).toBe(0);
    expect(claimF1(1, 1)).toBe(1);
    for (const n of [NaN, Infinity, -1, 1.01]) expect(() => claimF1(n, 1)).toThrow();
    for (const full of [false, true]) {
        const values = operands();
        for (const s of values) { s.statistics!.numerator = full ? s.statistics!.denominator : 0; s.value = full ? 1 : 0; s.status = full ? 'PASS' : 'FAIL'; }
        expect(deriveResearchF1(plan, values, execution)).toMatchObject({ value: full ? 1 : 0, status: full ? 'PASS' : 'FAIL' });
    }
    const dynamic = structuredClone(plan); dynamic[0]!.denominator = null;
    expect(deriveResearchF1(dynamic, own, execution)?.value).toBe(0.4);
});

test('zero denominator, missing operand and partial known failure cannot become a measured Trial F1', () => {
    for (const gap of ['zero', 'partial', 'unknown-count', 'absent']) {
        const own = operands();
        if (gap === 'absent') own.pop();
        else {
            own[0]!.value = null; own[0]!.status = gap === 'partial' ? 'FAIL' : 'UNJUDGEABLE';
            own[0]!.statistics = { unit: '事实Claim', numerator: gap === 'unknown-count' ? null : 0,
                denominator: gap === 'zero' ? 0 : 3, missing: gap === 'zero' ? 0 : 2 };
        }
        expect(deriveResearchF1(plan, own, execution)).toMatchObject({ value: null, status: 'UNJUDGEABLE' });
    }
});

test('Trial F1 preserves not-started, disabled and error states instead of publishing a numeric result', () => {
    const own = operands(); own[0]!.value = null;
    for (const status of ['NOT_RUN', 'ERROR'] as const) {
        own[0]!.status = status;
        expect(deriveResearchF1(plan, own, execution)).toMatchObject({ value: null, status });
    }
    expect(deriveResearchF1(plan, operands(), { started: false })).toMatchObject({ value: null, status: 'NOT_RUN' });
    expect(deriveResearchF1(plan, operands(), { started: true, error: { code: 'identity', message: 'Foreign Run', infrastructure: true } }))
        .toMatchObject({ value: null, status: 'ERROR' });
});

test('copied values and invalid original counts cannot enter the F1 calculation', () => {
    for (const mutate of [
        (s: EvaluationScore) => { s.value = 0.5; },
        (s: EvaluationScore) => { delete s.statistics; },
        (s: EvaluationScore) => { s.version = 2; },
        (s: EvaluationScore) => { s.statistics!.unit = 'Trial'; },
        (s: EvaluationScore) => { s.statistics!.denominator = 4; s.value = 0.25; },
        (s: EvaluationScore) => { s.statistics!.numerator = -1; },
        (s: EvaluationScore) => { s.statistics!.missing = 1; },
        (s: EvaluationScore) => { s.statistics!.numerator = Number.MAX_SAFE_INTEGER + 1; },
        (s: EvaluationScore) => { s.status = 'UNJUDGEABLE'; }
    ]) {
        const own = operands(); mutate(own[0]!);
        expect(() => deriveResearchF1(plan, own, execution)).toThrow('original same-Trial');
    }
    expect(deriveResearchF1(undefined, operands(), execution)).toBeUndefined();
    expect(deriveResearchF1([{ metricId: 'DR03', version: 1, unit: '派生F1', notApplicable: 'Declared refusal-only case' }], [], execution)).toBeUndefined();
    const counted = structuredClone(plan); counted[2]!.denominator = 1;
    expect(() => deriveResearchF1(counted, operands(), execution)).toThrow('without an opportunity denominator');
});

test('only a genuinely initial Trial can omit its planned F1 record with an empty scores array', () => {
    expect(() => assertResearchF1(plan, [], null)).not.toThrow();
    expect(() => assertResearchF1(plan, [], execution)).toThrow('F1');
    expect(() => assertResearchF1(plan, [], { started: false })).toThrow('F1');
});
