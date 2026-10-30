import { expect, test } from 'bun:test';
import { aggregateTrials } from '../../src/scoring/aggregate.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { reportFixture } from '../support/fixtures.ts';
import type { LocalReport } from '../../src/reports/store.ts';
import { deriveResearchF1 } from '../../src/scoring/research-f1.ts';

function report(statuses = ['PASS', 'PASS', 'PASS', 'FAIL', 'ERROR']): LocalReport {
    const r = reportFixture();
    r.contract = 'flowmate-agent-run/v2';
        const first = r.trials[0]!;
    r.trials = statuses.map((status, i) => ({ ...structuredClone(first), status: status as typeof first.status,
        trialId: 'trial-' + (i + 1), repetition: i + 1, metricPlan: [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }],
        scores: [], execution: status === 'NOT_RUN' ? null : { ...structuredClone(first.execution!),
            identity: { ...first.execution!.identity, trialId: 'trial-' + (i + 1) } } }));
    return r;
}
test('catalog preserves all 33 original formulas and six research metrics', () => {
    expect(metricCatalog).toHaveLength(39);
    expect(new Set(metricCatalog.map(m => m.id)).size).toBe(39);
    expect(metricCatalog.filter(m => m.group === 'research').map(m => m.id)).toEqual(['DR01', 'DR02', 'DR03', 'DR04', 'DR05', 'DR06']);
    expect(metricCatalog.filter(m => m.direction === 'down')).toHaveLength(5);
    expect(metricCatalog.every(m => m.numerator && m.denominator && m.unit && m.formula && m.version === 1)).toBe(true);
});
test('five independent Trials remain one Case and 3/5, including ERROR and original sources', () => {
    const r = report();
    const result = aggregateTrials(r);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({ planned: 5, started: 5, statuses: { PASS: 3, FAIL: 1, ERROR: 1 } });
    const success = result.metrics.find(m => m.metricId === 'task-success')!;
    expect(success).toMatchObject({ numerator: 3, denominator: 5, value: 0.6, missing: 1 });
    expect(success.sources).toHaveLength(5);
    expect(success.sources[4]).toMatchObject({ executionId: r.executionId, trialId: 'trial-5', repetition: 5, status: 'ERROR' });
    expect(result.metrics).toHaveLength(39);
    expect(result.metrics.find(m => m.metricId === 'tool-selection')).toMatchObject({ value: null, unplannedTrials: 5 });
});
test('opportunity counts sum to 2/4 and missing/NOT_RUN opportunities stay in the denominator', () => {
    const r = report(['PASS', 'PASS', 'NOT_RUN']);
    r.trials.forEach((t, i) => {
        t.caseId = 'case-' + i;
        t.metricPlan!.push({ metricId: 'tool-selection', version: 1, unit: '决策点', denominator: i === 0 ? 1 : 3 });
        if (i < 2) t.scores.push({ metricId: 'tool-selection', version: 1, name: '工具选择正确率', method: 'deterministic', required: false,
            status: 'PASS', value: i === 0 ? 1 : 1 / 3, reason: 'observed', evidence: ['product-call'],
            statistics: { unit: '决策点', numerator: 1, denominator: i === 0 ? 1 : 3, missing: 0 } });
    });
    const firstTwo = { ...r, trials: r.trials.slice(0, 2) };
    expect(aggregateTrials(firstTwo).metrics.find(m => m.metricId === 'tool-selection')).toMatchObject({ numerator: 2, denominator: 4, value: 0.5 });
    expect(aggregateTrials(r).metrics.find(m => m.metricId === 'tool-selection')).toMatchObject({ numerator: 2, denominator: 7, value: 2 / 7, missing: 3 });
});
test('Case versions, actual conditions and declared metric plans separate groups; duplicate Trial IDs are rejected', () => {
    const r = report();
    r.trials[1]!.caseVersion++;
    r.trials[2]!.caseConditions = {task:'different'};
    r.trials[3]!.metricPlan!.push({ metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 1 });
    expect(aggregateTrials(r).cases).toHaveLength(4);
    r.trials[4]!.trialId = r.trials[0]!.trialId;
    expect(() => aggregateTrials(r)).toThrow('Duplicate Trial');
});
test('raw missing counts, zero denominators and explicit non-applicability are distinct', () => {
    const r = report(['PASS']);
    r.trials[0]!.metricPlan!.push({ metricId: 'tool-selection', version: 1, unit: '决策点', denominator: null },
        { metricId: 'DR06', version: 1, unit: '必需链', notApplicable: '事前无多跳链' });
    let counts = aggregateTrials(r).metrics;
    expect(counts.find(m => m.metricId === 'tool-selection')).toMatchObject({ value: null, unknownDenominators: 1 });
    expect(counts.find(m => m.metricId === 'DR06')).toMatchObject({ value: null, notApplicable: 1, unplannedTrials: 0 });
    r.trials[0]!.metricPlan![1]!.denominator = 0;
    counts = aggregateTrials(r).metrics;
    expect(counts.find(m => m.metricId === 'tool-selection')).toMatchObject({ value: null, zeroDenominators: 1, unknownDenominators: 0 });
    const legacy = reportFixture();
    expect(() => aggregateTrials(legacy)).toThrow('v2');
});
test('research F1 is derived from cumulative precision and recall counts, never a mean', () => {
    const r = report(['PASS', 'PASS']);
    r.trials.forEach((t, i) => {
        for (const [metricId, numerator, denominator] of [['DR01', 1, i ? 3 : 1], ['DR02', 1, 2]] as const) {
            const unit = metricId === 'DR01' ? '事实Claim' : 'Gold Claim';
            t.metricPlan!.push({ metricId, version: 1, unit, denominator });
            t.scores.push({ metricId, version: 1, name: metricId, method: 'llm-judge', required: false,
                value: numerator / denominator, status: 'PASS', reason: 'independent match', evidence: ['reference'],
                statistics: { unit, numerator, denominator, missing: 0 } });
        }
    });
    expect(aggregateTrials(r).metrics.find(m => m.metricId === 'DR03')).toMatchObject({ value: 0.5, numerator: null, denominator: null,
        derivedFrom: ['DR01', 'DR02'], unplannedTrials: 0, unknownDenominators: 0 });
    r.trials[0]!.scores = [];
    expect(aggregateTrials(r).metrics.find(m => m.metricId === 'DR03')!.value).toBeNull();
});

test('explicit F1 non-applicability excludes its Trial operands while undeclared legacy F1 remains derivable', () => {
    const r = report(['PASS', 'PASS']);
    for (const [i, t] of r.trials.entries()) {
        for (const [metricId, denominator, unit] of [['DR01', i ? 1 : 3, '事实Claim'], ['DR02', i ? 1 : 2, 'Gold Claim']] as const) {
            t.metricPlan!.push({ metricId, version: 1, unit, denominator });
            t.scores.push({ metricId, version: 1, name: metricId, method: 'llm-judge', required: false, value: 1 / denominator,
                status: denominator === 1 ? 'PASS' : 'FAIL', reason: 'Synthetic original counts', evidence: ['original'],
                statistics: { unit, numerator: 1, denominator, missing: 0 } });
        }
        t.metricPlan!.push({ metricId: 'DR03', version: 1, unit: '派生F1', notApplicable: 'Declared explicit F1 exclusion' });
    }
    expect(aggregateTrials(r).metrics.find(m => m.metricId === 'DR03')).toMatchObject({ value: null, notApplicable: 2,
        unknownDenominators: 0, unknownMissing: 0 });
    r.trials[1]!.metricPlan!.pop(); r.trials[1]!.metricPlan!.push({ metricId: 'DR03', version: 1, unit: '派生F1', denominator: null });
    r.trials[1]!.scores.push(deriveResearchF1(r.trials[1]!.metricPlan, r.trials[1]!.scores, r.trials[1]!.execution)!);
    const mixed = aggregateTrials(r).metrics.find(m => m.metricId === 'DR03')!;
    expect(mixed).toMatchObject({ value: 1, notApplicable: 1 });
    expect(mixed.sources.filter(s => s.metricId === 'DR03')).toMatchObject([{ status: 'NOT_APPLICABLE', trialId: r.trials[0]!.trialId }]);
    for (const t of r.trials) { t.metricPlan = t.metricPlan!.filter(m => m.metricId !== 'DR03'); t.scores = t.scores.filter(s => s.metricId !== 'DR03'); }
    const legacy = aggregateTrials(r).metrics.find(m => m.metricId === 'DR03')!;
    expect(legacy.value).toBeCloseTo(4 / 7);
    expect(legacy.notApplicable).toBe(0);
});

test('inconsistent counts, changed units and fabricated non-applicability are rejected', () => {
    const r = report(['PASS']);
    r.trials[0]!.metricPlan!.push({ metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 3 });
    const score = { metricId: 'tool-selection', version: 1, name: '选择', method: 'deterministic' as const, required: false,
        value: 1 / 3, status: 'PASS' as const, reason: 'observed', evidence: ['calls'], statistics: { unit: '决策点', numerator: 1, denominator: 3, missing: 3 } };
    r.trials[0]!.scores = [score];
    expect(() => aggregateTrials(r)).toThrow('counts');
    score.statistics.missing = 0;
    score.statistics.unit = 'Trial';
    expect(() => aggregateTrials(r)).toThrow('unit');
    score.statistics.unit = '决策点';
    score.value = 1;
    expect(() => aggregateTrials(r)).toThrow('ratio');
    score.value = 1 / 3;
    r.trials[0]!.scores[0]!.status = 'NOT_APPLICABLE';
    expect(() => aggregateTrials(r)).toThrow('Non-applicability');
    r.trials[0]!.scores = [];
    r.trials[0]!.status = 'unknown' as any;
    expect(() => aggregateTrials(r)).toThrow('Trial status');
});

test('derived F1 gaps count affected Trials instead of adding incompatible Claim and Gold units', () => {
    const r = report(['NOT_RUN', 'NOT_RUN']);
    r.trials.forEach(t => t.metricPlan!.push(
        { metricId: 'DR01', version: 1, unit: '事实Claim', denominator: 7 },
        { metricId: 'DR02', version: 1, unit: 'Gold Claim', denominator: 3 }));
    expect(aggregateTrials(r).metrics.find(m => m.metricId === 'DR03')).toMatchObject({ value: null, missing: 2, missingUnit: 'Trial' });
    r.trials[0]!.metricPlan![1] = { metricId: 'DR01', version: 1, unit: '事实Claim', notApplicable: 'Synthetic mismatched applicability' };
    r.trials[1]!.metricPlan![2] = { metricId: 'DR02', version: 1, unit: 'Gold Claim', notApplicable: 'Synthetic mismatched applicability' };
    expect(aggregateTrials(r).metrics.find(m => m.metricId === 'DR03')).toMatchObject({ value: null, notApplicable: 0, missing: 2 });
});

test('pending scoring checkpoints preserve original execution before F1 scores exist', () => {
    const r = report(['UNJUDGEABLE']), trial = r.trials[0]!;
    trial.metricPlan!.push({ metricId: 'DR01', version: 1, unit: '事实Claim', denominator: null },
        { metricId: 'DR02', version: 1, unit: 'Gold Claim', denominator: 1 },
        { metricId: 'DR03', version: 1, unit: '派生F1', denominator: null });
    Object.assign(trial, { scoringState: 'prepared' });
    expect(aggregateTrials(r).cases[0]).toMatchObject({ started: 1, planned: 1 });
    expect(trial.execution!.started).toBe(true); expect(trial.scores).toEqual([]);
    Object.assign(trial, { scoringState: 'complete' });
    expect(() => aggregateTrials(r)).toThrow('Trial F1');
});
