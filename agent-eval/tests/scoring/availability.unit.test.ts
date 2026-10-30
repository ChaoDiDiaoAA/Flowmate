import { expect, test } from 'bun:test';
import { aggregate, dimensions } from '../../src/scoring/aggregate.ts';
import { isRequiredScore, type EvaluationScore } from '../../src/scoring/types.ts';
import { evaluateSemantic } from '../../src/scoring/evaluators/semantic.ts';
import { deriveResearchF1 } from '../../src/scoring/research-f1.ts';
import { scoreAvailability } from '../../src/scoring/availability.ts';
import { runProgress } from '../../src/reports/readme.ts';
import { reportFixture, task } from '../support/fixtures.ts';

function dynamicTrial() {
    const trial = reportFixture().trials[0]!;
    const criterion = { metricId: 'false-completion', version: 1, unit: '完成声明', denominator: null, required: true,
        rule: 'Count original completion claims.', evidence: ['answer'], trigger: 'started' as const };
    trial.metricPlan = [{ metricId: criterion.metricId, version: 1, unit: criterion.unit, denominator: null }];
    trial.semanticPlan = { contract: 'flowmate-semantic-plan/v1', criteria: [criterion] };
    const score: EvaluationScore = { metricId: criterion.metricId, name: criterion.metricId, version: 1, method: 'llm-judge',
        required: true, value: null, status: 'UNJUDGEABLE', reason: 'Original unavailable ratio', evidence: ['answer'],
        statistics: { unit: criterion.unit, numerator: 0, denominator: 0, missing: 0 }, judge: { callId: '10000000-0000-4000-8000-000000000001', criterion: 0 } };
    trial.scores.push(score);
    trial.judgeCalls = [{ callId: '10000000-0000-4000-8000-000000000001',
        configuration: { provider: 'codex-cli', transport: 'codex-cli', model: 'synthetic', reasoningEffort: 'max', timeoutMs: 180000,
            protocolVersion: 'flowmate-judge/v2' },
        startedAt: '2026-10-30T00:00:00Z', endedAt: '2026-10-30T00:00:01Z', attempts: 1, usage: {}, responseModel: 'synthetic',
        raw: 'original response', error: null, request: { system: 'Declared rubric', data: '{}', redacted: false }, judgment: null,
        stopReason: 'stop', rawStopReason: null, usageSource: 'codex-cli', responseComplete: true,
        compact: { plan: structuredClone(trial.semanticPlan), judgment: { v: 1, r: [[0, 0, 0]], f: [] }, validationErrors: {} } }];
    return { trial, score };
}

test('ERROR and FAIL zero-count scores remain necessary and determine the Trial grade', () => {
    for (const status of ['ERROR', 'FAIL'] as const) {
        const { trial, score } = dynamicTrial(); score.status = status;
        expect(isRequiredScore(score, trial)).toBe(true);
        expect(aggregate(trial.scores, trial.execution!, trial).status).toBe(status);
        expect(dimensions(trial.scores, true, trial).result.status).toBe(status);
    }
});

test('zero counts without original Judge proof stay necessary and unjudgeable', () => {
    const { trial, score } = dynamicTrial(); trial.judgeCalls = [];
    expect(isRequiredScore(score)).toBe(true);
    expect(isRequiredScore(score, trial)).toBe(true);
    expect(aggregate(trial.scores, trial.execution!, trial).status).toBe('UNJUDGEABLE');
    expect(dimensions(trial.scores, true, trial).result.status).toBe('UNJUDGEABLE');
    expect(scoreAvailability(score, trial).state).toBe('missing-evidence');
    const report = reportFixture(); report.trials = [trial];
    expect(runProgress([report])).toMatchObject({ processedTrials: 1, scoredTrials: 0, unjudgeableTrials: 1 });
});

test('a completed original dynamic zero row is excluded consistently without rewriting scores', () => {
    const { trial, score } = dynamicTrial(), original = structuredClone(score);
    expect(isRequiredScore(score, trial)).toBe(false);
    expect(aggregate(trial.scores, trial.execution!, trial).status).toBe('PASS');
    expect(dimensions(trial.scores, true, trial).result.status).toBe('PASS');
    expect(scoreAvailability(score, trial).state).toBe('no-opportunity');
    const report = reportFixture(); report.trials = [trial];
    expect(runProgress([report])).toMatchObject({ processedTrials: 1, scoredTrials: 1, unjudgeableTrials: 0 });
    expect(score).toEqual(original);
});

test('incomplete capture, unsubmitted calls and contradictory original declarations cannot prove no opportunity', () => {
    for (const mutate of [
        (trial: ReturnType<typeof dynamicTrial>['trial']) => { trial.judgeCalls[0]!.attempts = 0; },
        (trial: ReturnType<typeof dynamicTrial>['trial']) => { trial.judgeCalls[0]!.responseComplete = false; },
        (trial: ReturnType<typeof dynamicTrial>['trial']) => { trial.execution!.evidence.answer = { present: false, actual: null, source: 'Capture unavailable' }; },
        (trial: ReturnType<typeof dynamicTrial>['trial']) => { trial.execution!.evidence.answer = { present: false, actual: 'Partial response only', source: 'Capture incomplete' }; },
        (trial: ReturnType<typeof dynamicTrial>['trial']) => { trial.judgeCalls.push(structuredClone(trial.judgeCalls[0]!)); },
        (trial: ReturnType<typeof dynamicTrial>['trial']) => { trial.metricPlan![0]!.denominator = 0; },
        (trial: ReturnType<typeof dynamicTrial>['trial']) => { trial.judgeCalls[0]!.compact!.judgment!.f = [[0, 0, 1]]; },
    ]) {
        const { trial, score } = dynamicTrial(); mutate(trial);
        expect(isRequiredScore(score, trial)).toBe(true);
    }
});

test('NOT_APPLICABLE requires a matching original declaration', () => {
    const { trial, score } = dynamicTrial(); score.status = 'NOT_APPLICABLE'; delete score.statistics;
    expect(isRequiredScore(score)).toBe(true);
    expect(isRequiredScore(score, trial)).toBe(true);
    expect(aggregate(trial.scores, trial.execution!, trial).status).toBe('UNJUDGEABLE');
    expect(dimensions(trial.scores, true, trial).result.status).toBe('UNJUDGEABLE');
    trial.metricPlan = [{ metricId: score.metricId, version: 1, unit: '完成声明', notApplicable: 'No declared completion requirement' }];
    expect(isRequiredScore(score, trial)).toBe(false);
    expect(aggregate(trial.scores, trial.execution!, trial).status).toBe('PASS');
});

test('complete no-Report evidence retains recall zero and undefined precision/F1 without accepting unavailable capture', async () => {
    const trial = reportFixture().trials[0]!, result = trial.execution!;
    result.evidence.research = { present: true, actual: null, source: 'Complete original Report query' };
    const gold = { status: 'verified' as const, claims: [{ id: 'required', text: 'An independently required fact.', required: true,
        acceptable: ['An independently required fact.'], conditions: [], entities: [],
        evidence: [{ sample: 'synthetic', start: 0, end: 31, quote: 'An independently required fact.', relation: 'support' as const }] }],
        chains: [], forbidden: [] };
    const item = { ...task, contract: 'flowmate-agent-case/v2' as const, expected: { ...task.expected, metrics: [], research: gold } };
    trial.semanticPlan = { contract: 'flowmate-semantic-plan/v1', criteria: [
        { metricId: 'DR01', version: 1, unit: '事实Claim', denominator: null, required: true,
            rule: 'Count independently correct Report facts.', evidence: ['research-frame', 'gold-research'], trigger: 'started' },
        { metricId: 'DR02', version: 1, unit: 'Gold Claim', denominator: 1, required: true,
            rule: 'Count required Gold facts covered by the Report.', evidence: ['research-frame', 'gold-research'], trigger: 'started' } ] };
    trial.metricPlan = [...trial.semanticPlan.criteria.map(({ metricId, version, unit, denominator }) => ({ metricId, version, unit, denominator })),
        { metricId: 'DR03', version: 1, unit: '派生F1', denominator: null }];
    const evaluated = await evaluateSemantic({ task: item, result, projected: result.input, semanticPlan: trial.semanticPlan, judge: null });
    trial.scores.push(...evaluated.scores, deriveResearchF1(trial.metricPlan, evaluated.scores, result)!);
    const precision = trial.scores.find(score => score.metricId === 'DR01')!, recall = trial.scores.find(score => score.metricId === 'DR02')!,
        f1 = trial.scores.find(score => score.metricId === 'DR03')!;
    expect(precision).toMatchObject({ value: null, status: 'UNJUDGEABLE', statistics: { numerator: 0, denominator: 0, missing: 0 } });
    expect(recall).toMatchObject({ value: 0, status: 'FAIL', statistics: { numerator: 0, denominator: 1, missing: 0 } });
    expect(f1).toMatchObject({ value: null, status: 'UNJUDGEABLE' });
    expect(isRequiredScore(precision, trial)).toBe(false);
    expect(isRequiredScore(recall, trial)).toBe(true); expect(isRequiredScore(f1, trial)).toBe(true);
    expect(scoreAvailability(precision, trial).state).toBe('no-opportunity');
    expect(scoreAvailability(recall, trial).state).toBe('measured'); expect(scoreAvailability(f1, trial).state).toBe('missing-evidence');
    result.evidence.research.present = false;
    expect(isRequiredScore(precision, trial)).toBe(true);
});
