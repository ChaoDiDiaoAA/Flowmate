import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { reportFixture } from '../support/fixtures.ts';
import { readReport, type LocalReport } from '../../src/reports/store.ts';
import { deriveTrialStatistics, type TrialStatistics } from '../../src/reports/trial-statistics.ts';
import { scoreAvailability } from '../../src/scoring/availability.ts';
import { aggregateTrials } from '../../src/scoring/aggregate.ts';

function historicalReport(): LocalReport {
    const report = reportFixture(), trial = report.trials[0]!;
    report.contract = 'flowmate-agent-run/v2'; trial.status = 'FAIL'; trial.reason = 'Original task did not reach its endpoint';
    trial.execution!.status = 'failed'; trial.execution!.endpointReached = false;
    trial.metricPlan = [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 },
        { metricId: 'false-completion', version: 1, unit: '完成声明', denominator: null }];
    trial.semanticPlan = { contract: 'flowmate-semantic-plan/v1', criteria: [{ metricId: 'false-completion', version: 1, unit: '完成声明',
        denominator: null, required: true, trigger: 'started', evidence: ['answer'], rule: 'Inspect original completion claims.' }] };
    trial.scores.push({ metricId: 'false-completion', name: '虚假完成声明率', version: 1, method: 'llm-judge', required: true,
        status: 'UNJUDGEABLE', value: null, reason: 'Original saved zero-opportunity score', evidence: ['answer'],
        statistics: { unit: '完成声明', numerator: 0, denominator: 0, missing: 0 } });
    trial.counts = { PASS: 1, UNJUDGEABLE: 1 };
    const probabilities = [{ k: 1, passAtK: 0, passAllK: 0 }];
    const summary: TrialStatistics = { trialsPerCase: 1, cases: [{ caseId: 'sample', caseVersion: 1, planned: 1, started: 1,
        statuses: { PASS: 0, FAIL: 1, UNJUDGEABLE: 0, ERROR: 0, NOT_RUN: 0 }, complete: true, valid: true, reasons: [],
        trials: [{ trialId: 'trial-1', trialIndex: 1, status: 'FAIL' }], probabilities,
        metrics: [{ metricId: 'task-success', version: 1, name: '任务成功率', unit: 'Trial', numerator: 0, denominator: 1,
            missing: 0, value: 0, unknownDenominators: 0, unknownMissing: 0, zeroDenominators: 0,
            measured: 1, applicable: 1, issues: [], mean: 0, variance: null, standardDeviation: null },
        { metricId: 'false-completion', version: 1, name: '虚假完成声明率', unit: '完成声明', numerator: 0, denominator: 0,
            missing: 0, value: null, unknownDenominators: 0, unknownMissing: 0, zeroDenominators: 1,
            measured: 0, applicable: 1, issues: ['零分母'], mean: null, variance: null, standardDeviation: null }] }],
        dataset: { plannedCases: 1, validCases: 1, metricsPlanned: 2, metricsMeasured: 1, probabilities } };
    report.trialStatistics = summary;
    report.aggregation = aggregateTrials(report);
    return report;
}

function stored(report: LocalReport) {
    const file = join(mkdtempSync(join(tmpdir(), 'flowmate-statistics-policy-')), 'report.json');
    writeFileSync(file, JSON.stringify(report));
    return file;
}

test('unversioned original statistics remain readable without rewriting scores, summaries or saved bytes', () => {
    const original = historicalReport(), file = stored(original), bytes = readFileSync(file, 'utf8');
    const report = readReport(file);
    expect(report.trialStatistics).toEqual(original.trialStatistics);
    expect(report.trials[0]!.scores).toEqual(original.trials[0]!.scores);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
});

test('legacy statistics validation is explicit while default derivation and availability remain strict', () => {
    const report = historicalReport();
    expect(deriveTrialStatistics(report).cases[0]!.valid).toBe(false);
    expect(scoreAvailability(report.trials[0]!.scores[1]!, report.trials[0]!).state).toBe('missing-evidence');
    expect(deriveTrialStatistics(report, { legacyOpportunityPolicy: true })).toEqual(report.trialStatistics!);
});

test('version two statistics cannot claim the legacy zero-opportunity summary', () => {
    const report = historicalReport(); Object.assign(report, { statisticsPolicyVersion: 2 });
    expect(() => readReport(stored(report))).toThrow('Trial statistics differ from original Trial records');
});

test('legacy validation still rejects an altered original probability summary', () => {
    const report = historicalReport(); report.trialStatistics!.cases[0]!.probabilities[0]!.passAtK = 1;
    expect(() => readReport(stored(report))).toThrow('Trial statistics differ from original Trial records');
});
