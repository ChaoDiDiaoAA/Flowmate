import { expect, test } from 'bun:test';
import { createBenchmarkPlan, benchmarkExitCode } from '../../src/execution/benchmark.ts';
import { reportFixture } from '../support/fixtures.ts';
import type { ExperimentRecord } from '../../../packages/contracts/src/evaluation-experiments.ts';
import { runProgress } from '../../src/reports/readme.ts';
import { EvaluationWorkflowResultSchema } from '../../../packages/contracts/src/evaluation-workflow.ts';

const connection = { model: 'gpt-6-luna', api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:8767/v1', reasoning: 'max' as const };
const control = { ...connection, model: 'gpt-6.1-sol' };
test('the two shortcuts declare one model-axis experiment and exactly one repeat per Case', () => {
    for (const selection of ['smoke', 'full'] as const) {
        const plan = createBenchmarkPlan(selection, connection, control);
        expect(plan.benchmark).toEqual({ id: 'baseline', revision: 1, selection });
        expect(plan.repeats).toBe(1); expect(plan.axes).toEqual(['model']);
        expect(plan.control).toEqual({ id: 'sol', model: control });
        expect(plan.candidates).toHaveLength(1); expect(plan.candidates[0]!.model).toEqual(connection);
    }
});

test('control quality failures do not hide a valid candidate; unavailable evidence remains blocked', () => {
    const control = reportFixture(), candidate = reportFixture(); control.executionId = 'control'; candidate.executionId = 'candidate';
    control.trials[0]!.status = 'FAIL';
    const record: ExperimentRecord = { contract: 'flowmate-experiment/v1', id: 'run', createdAt: new Date().toISOString(),
        plan: createBenchmarkPlan('smoke', connection, { ...connection, model: 'gpt-6.1-sol' }), attribution: 'single-axis', status: 'complete',
        arms: [{ id: 'sol', status: 'complete', executionIds: ['control'] }, { id: 'luna', status: 'complete', executionIds: ['candidate'] }] };
    expect(benchmarkExitCode(record, [control, candidate], 'pass', true)).toBe(0);
    expect(benchmarkExitCode(record, [control, candidate], 'fail', true)).toBe(1);
    expect(benchmarkExitCode(record, [control, candidate], 'blocked', true)).toBe(2);
    expect(benchmarkExitCode(record, [control, candidate], 'pass', false)).toBe(2);
    candidate.trials[0]!.status = 'FAIL';
    expect(benchmarkExitCode(record, [control, candidate], 'pass', true)).toBe(1);
    expect(benchmarkExitCode(record, [control], 'pass', true)).toBe(2);
});

test('benchmark refuses a substituted model, effort or non-local control endpoint', () => {
    for (const changed of [{ ...control, model: 'deepseek-flash' }, { ...control, reasoning: 'medium' },
        { ...control, baseUrl: 'https://other.example.com/v1' }])
        expect(() => createBenchmarkPlan('smoke', connection, changed)).toThrow();
});

test('planned Trial slots never count as started, finished, scored or stopped execution', () => {
    const report = reportFixture(), planned = structuredClone(report.trials[0]!);
    report.trials[0]!.scores.push({ ...report.trials[0]!.scores[0]!, metricId: 'false-completion', value: null, status: 'UNJUDGEABLE',
        statistics: { unit: 'opportunity', numerator: 0, denominator: 0, missing: 0 } });
    planned.trialId = 'not-started'; planned.execution = null; planned.scores = []; planned.status = 'NOT_RUN';
    report.trials.push(planned);
    expect(runProgress([report])).toMatchObject({ storedTrials: 2, startedTrials: 1, endedTrials: 1, stopConfirmedTrials: 1, scoredTrials: 0, unjudgeableTrials: 1,
        judgeTasksSubmitted: 0, judgeTasksCompleted: 0, verifiedTrials: 0 });
    report.trials[0]!.execution!.evidence.cleanup = { present: false, actual: null, source: 'missing' };
    expect(runProgress([report]).stopConfirmedTrials).toBe(0);
});

test('the public workflow accepts the final Benchmark progress returned by the service', () => {
    const progress = runProgress([reportFixture()]);
    const result = { action: 'benchmark.run', exitCode: 2, data: { run: { runId: 'Run-controlled', selection: 'smoke', expectedCases: 7,
        plannedTrials: 14, observedTrials: 1, progress, executionComplete: false, scoringComplete: true, exportComplete: false,
        gate: 'blocked', exitCode: 2, reportPath: 'agent-eval/runs/Run-controlled/run.json', readmePath: 'agent-eval/runs/Run-controlled/README.md' } } };
    expect(EvaluationWorkflowResultSchema.safeParse(result).success).toBe(true);
    expect(EvaluationWorkflowResultSchema.safeParse({ ...result, data: { run: { ...result.data.run, progress: { ...progress, startedTrials: -1 } } } }).success).toBe(false);
});
