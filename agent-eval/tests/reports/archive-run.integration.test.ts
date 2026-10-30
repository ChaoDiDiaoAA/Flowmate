import { expect, test } from 'bun:test';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLocal } from '../../src/execution/runner.ts';
import { readReport } from '../../src/reports/store.ts';
import { archiveFile, readArchive, readSnapshot } from '../../src/reports/archive.ts';
import { buildObservationTree } from '../../src/langfuse/otel.ts';
import { dataset, fixtureRepo, observed, reportFixture } from '../support/fixtures.ts';
import { runExperiment, compareExperiment, createBaseline, checkGate } from '../../src/experiments/index.ts';

test('Runner writes one inline Run and retains the original replay conditions', async () => {
    const data = structuredClone(dataset); data.cases = data.cases.slice(0, 1);
    data.manifest.members = data.cases.map(task => 'cases/' + task.id + '.json');
    const result = await runLocal(fixtureRepo, { dataset: data, executionId: 'inline-' + randomUUID(), judge: 'off', backend: 'local' }, {
        env: {}, kernel: { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare(trial) {
            const execution = observed(); execution.identity = trial.identity; execution.input = trial.input;
            execution.evidence.environment!.actual = { ...trial.identity, fresh: true };
            execution.evidence['input-projection']!.actual = trial.input;
            return { input: trial.input, execute: async () => execution, snapshot: async () => execution, cancel: async () => {},
                close: async () => ({ present: true, actual: { closed: true, stopped: true }, source: 'controlled' }) };
        } },
    });
    expect(result.file).toContain('run.json#executions=');
    expect(readdirSync(dirname(result.file)).sort()).toEqual(['README.md', 'run.json']);
    expect(readReport(result.file).trials).toHaveLength(1);
    expect(readArchive(archiveFile(result.file)).status).toBe('complete');
    expect(readSnapshot(result.file).cases).toHaveLength(1);
    expect(existsSync(join(fixtureRepo, 'agent-eval/traces'))).toBe(false);
});

test('every exported observation carries the real Trial Session, demo User and parent Run', () => {
    const report = reportFixture(); report.runId = 'Run-2026-10-28_120000-smoke-compare-01'; report.userId = 'eval-demo-user';
    report.trials[0]!.sessionId = 'Eval-session-one';
    for (const node of buildObservationTree(report)) expect(node.metadata).toMatchObject({ runId: report.runId,
        userId: 'eval-demo-user', sessionId: 'Eval-session-one', executionId: report.executionId, trialId: report.trials[0]!.trialId });
});

test('an experiment shares one Run, comparison and Gate, with a single Baseline collection', async () => {
    mkdirSync(join(fixtureRepo, 'apps/host'), { recursive: true });
    writeFileSync(join(fixtureRepo, 'apps/host/main.ts'), '// Controlled source captured by the real source recorder.\n');
    const data = structuredClone(dataset); data.cases = data.cases.slice(0, 1); data.manifest.scoring.judges = [];
    data.manifest.members = data.cases.map(task => 'cases/' + task.id + '.json'); data.manifest.smoke = data.cases.map(task => task.id);
    data.cases[0]!.expected.checks = [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }];
    const record = await runExperiment(fixtureRepo, { benchmark: { id: 'baseline', revision: 1, selection: 'smoke' }, repeats: 1,
        axes: ['model'], control: { id: 'control' }, candidates: [{ id: 'candidate' }] }, { env: {}, loadBenchmark: () => [data],
        kernel: { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare(trial) {
            const execution = observed(); execution.identity = trial.identity; execution.input = trial.input;
            execution.evidence.environment!.actual = { ...trial.identity, fresh: true }; execution.evidence['input-projection']!.actual = trial.input;
            return { input: trial.input, execute: async () => execution, snapshot: async () => execution, cancel: async () => {},
                close: async () => ({ present: true, actual: { closed: true, stopped: true }, source: 'controlled' }) };
        } } });
    expect(record.status).toBe('complete');
    const comparison = compareExperiment(fixtureRepo, record.id)[0]!;
    expect(comparison.reasons).toEqual([]); expect(comparison.status).toBe('comparable');
    const baseline = createBaseline(fixtureRepo, { experimentId: record.id, armId: 'control' });
    expect(checkGate(fixtureRepo, { baselineId: baseline.id, experimentId: record.id, armId: 'candidate' }).status).toBe('pass');
    expect(existsSync(join(fixtureRepo, 'agent-eval/experiments'))).toBe(false);
    expect(existsSync(join(fixtureRepo, 'agent-eval/baselines'))).toBe(false);
    expect(existsSync(join(fixtureRepo, 'agent-eval/baselines.json'))).toBe(true);
});
