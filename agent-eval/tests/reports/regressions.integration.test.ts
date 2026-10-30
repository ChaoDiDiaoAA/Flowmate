import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLocal } from '../../src/execution/runner.ts';
import { main } from '../../src/cli.ts';
import { readReport, saveReport, comparison } from '../../src/reports/store.ts';
import { archiveFile } from '../../src/reports/archive.ts';
import { recordRegressions, regressionView } from '../../src/reports/regressions.ts';
import { exportEvents } from '../../src/langfuse/export.ts';
import type { RegressionOrigin } from '../../src/dataset-loader/regression-origin.ts';
import { dataset, fixtureRepo, observed, reportFixture } from '../support/fixtures.ts';

const origin: RegressionOrigin = { batch: 'controlled-enrollment', issueId: 'BC-1', sourceExecutionId: 'original', sourceTrialId: 'original-trial', sourceCaseId: 'FM-001',
    sourceCaseVersion: 1, metricIds: ['task-result'], verification: { kind: 'engineering', reviewer: 'Controlled test', at: '2026-10-14T00:00:00Z', basis: 'Synthetic source reference.' } };

function savedReference(kind: 'controlled' | 'model' = 'controlled', started = true, referenceOrigin = origin, caseId = 'sample') {
    const value = reportFixture(), id = 'record-reference-' + randomUUID(); value.executionId = id;
    value.dataset.id = 'historical-regression-fixture';
    value.executionKind = kind; value.repeat = 3; const first = value.trials[0]!;
    value.trials = [1, 2, 3].map(repetition => {
        const trial = structuredClone(first); trial.trialId = id + '-trial-' + repetition; trial.repetition = repetition;
        trial.traceId = randomUUID().replaceAll('-', ''); trial.partition = 'badcase'; trial.regressionOrigins = [referenceOrigin]; trial.caseId = caseId;
        trial.scores = referenceOrigin.metricIds.map(metricId => ({ ...structuredClone(first.scores[0]!), metricId })); trial.counts = { PASS: trial.scores.length };
        trial.execution!.identity = { executionId: id, trialId: trial.trialId, caseId: trial.caseId, caseVersion: 1 };
        if (!started) { trial.execution = null; trial.status = 'NOT_RUN'; trial.reason = 'Blocked before start'; trial.counts = {}; trial.scores = []; }
        return trial;
    });
    if (!started) value.executionComplete = false;
    const directory = join(fixtureRepo, 'agent-eval/runs/business', id); mkdirSync(directory, { recursive: true });
    const file = join(directory, 'report.json'); saveReport(file, value); return { file, report: value };
}

test('report readback retains quality-only origins and rejects changing an open declared origin', () => {
    const value = reportFixture(), directory = join(fixtureRepo, 'regression-report-' + randomUUID()); mkdirSync(directory);
    Object.assign(value, { executionKind: 'controlled' }); Object.assign(value.trials[0]!, { partition: 'badcase', regressionOrigins: [origin] });
    const file = join(directory, 'report.json');
    expect(() => saveReport(file, value)).not.toThrow();
    expect(readReport(file)).toHaveProperty('trials.0.regressionOrigins.0.issueId', 'BC-1');
    const open = reportFixture(); open.endedAt = null; open.scoring = 'pending';
    Object.assign(open, { executionKind: 'controlled' }); Object.assign(open.trials[0]!, { partition: 'badcase', regressionOrigins: [origin] });
    const openFile = join(directory, 'open.json'); saveReport(openFile, open);
    const changed = readReport(openFile); Object.assign(changed.trials[0]!, { regressionOrigins: [{ ...origin, issueId: 'BC-2' }] });
    expect(() => saveReport(openFile, changed)).toThrow('plan');
});

test('controlled supplemental run saves origins, records only started attempts and exposes read-only linkage', async () => {
    const data = structuredClone(dataset); data.manifest.id = 'historical-regression-fixture';
    Object.assign(data.manifest, { suite: 'badcase', smoke: [] }); Object.assign(data, { regressionOrigins: { [data.cases[0]!.id]: [origin] } });
    const executedInputs: unknown[] = [];
    const run = await runLocal(fixtureRepo, { dataset: data, caseId: data.cases[0]!.id, executionId: 'enrollment-' + randomUUID(), repeat: 3, backend: 'local', judge: 'off' }, {
        env: {}, kernel: { readiness: () => ({ ready: true, reason: 'Controlled scene' }), async prepare(trial) {
            executedInputs.push(trial); const result = observed(); result.identity = trial.identity; result.input = trial.input;
            result.evidence.environment!.actual = { ...trial.identity, fresh: true };
            return { input: trial.input, execute: async () => result, snapshot: async () => result, cancel: async () => {}, close: async () => ({ present: true, actual: { closed: true, stopped: true }, source: 'Controlled stop' }) };
        } }
    });
    expect(JSON.stringify(executedInputs)).not.toContain('BC-1'); expect(JSON.stringify(executedInputs)).not.toContain('regressionOrigins');
    expect(run.report).toHaveProperty('trials.0.regressionOrigins.0.sourceTrialId', 'original-trial');
    expect(run.report.trials[0]!.partition).toBe('badcase');
    const file = join(fixtureRepo, 'agent-eval/records/controlled-enrollment/reruns.csv'); expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
    const before = readFileSync(archiveFile(run.file)), rows = readFileSync(file), output = spyOn(console, 'log').mockImplementation(() => {}), exit = process.exitCode;
    try {
        await main(['status', '--execution-id', run.report.executionId], fixtureRepo);
        const status = JSON.parse(String(output.mock.calls.at(-1)![0]));
        expect(status.regressions.entries[0]).toMatchObject({ enrolled: true, stable: false });
        expect(status.regressions.entries[0].reruns.map((row: { executionKind: string }) => row.executionKind)).toEqual(['controlled', 'controlled', 'controlled']);
        expect(readFileSync(archiveFile(run.file)).equals(before)).toBe(true); expect(readFileSync(file).equals(rows)).toBe(true);
        expect(existsSync(join(dirname(run.file), 'exposure.csv'))).toBe(false);
    } finally { output.mockRestore(); process.exitCode = exit ?? 0; }
});

test('origins require an execution kind', () => {
    const root = join(fixtureRepo, 'origin-contract-' + randomUUID()); mkdirSync(root);
    const value = reportFixture(); value.trials[0]!.partition = 'badcase'; value.trials[0]!.regressionOrigins = [origin];
    expect(() => saveReport(join(root, 'missing-kind.json'), value)).toThrow('execution kind');
});
test('one declared origin cannot be duplicated', () => {
    const root = join(fixtureRepo, 'origin-duplicate-' + randomUUID()); mkdirSync(root);
    const value = reportFixture(); value.executionKind = 'controlled'; value.trials[0]!.partition = 'badcase'; value.trials[0]!.regressionOrigins = [origin, origin];
    expect(() => saveReport(join(root, 'duplicate.json'), value)).toThrow('Duplicate');
});
test('controlled and model reports cannot be compared as equivalent execution conditions', () => {
    const value = reportFixture(); value.executionKind = 'controlled'; const other = structuredClone(value); other.executionKind = 'model';
    expect(() => comparison(value, other)).toThrow('execution kind');
});

test('recording is idempotent and stable claims require every model-classified attempt verified against its saved report', () => {
    // The model classification is synthetic input to this contract test, never a real generation.
    const { file, report } = savedReference('model'); expect(recordRegressions(fixtureRepo, file)).toMatchObject({ saved: true, count: 3 });
    const csv = join(fixtureRepo, 'agent-eval/records/controlled-enrollment/reruns.csv'), before = readFileSync(csv);
    expect(recordRegressions(fixtureRepo, file)).toMatchObject({ saved: true, count: 0 }); expect(readFileSync(csv).equals(before)).toBe(true);
    expect(regressionView(fixtureRepo, report).entries[0]).toMatchObject({ stable: true });
    try {
        writeFileSync(csv, readFileSync(csv, 'utf8').replaceAll('"model"', '"controlled"'));
        const view = regressionView(fixtureRepo, report).entries[0]!;
        expect(view.stable).toBe(false); expect(view.warnings.length).toBeGreaterThan(0);
    } finally { writeFileSync(csv, before); }
});

test('changing a saved report target cannot inherit stability from earlier passing targets', () => {
    // Every report here is synthetic; the classification exercises the real stability join.
    const { file } = savedReference('model', true, origin, 'FM-001'); expect(recordRegressions(fixtureRepo, file).saved).toBe(true);
    const source = readReport(file);
        expect(regressionView(fixtureRepo, source).entries[0]?.stable).toBe(true);
        const metrics = [...origin.metricIds, 'input-isolation'];
        for (const trial of source.trials) trial.regressionOrigins = [{ ...origin, metricIds: metrics }];
        const current = regressionView(fixtureRepo, source).entries[0]!;
        expect(current.stable).toBe(false);
        expect(current.reruns).toContainEqual(expect.objectContaining({ matchesCurrentTarget: false, metricIds: origin.metricIds }));
        const fresh = savedReference('model', true, { ...origin, metricIds: metrics }, 'FM-001');
        expect(recordRegressions(fixtureRepo, fresh.file)).toMatchObject({ saved: true, count: 3 });
        const verified = regressionView(fixtureRepo, source).entries[0]!;
        expect(verified.stable).toBe(true); expect(verified.warnings).toEqual([]);
        expect(verified.reruns).toContainEqual(expect.objectContaining({ matchesCurrentTarget: true, metricIds: metrics }));
});

test.each([{ sourceCaseId: 'FM-002' }, { sourceCaseVersion: 2 }])('different source Case identity cannot inherit stable evidence: %j', changed => {
    const { file, report } = savedReference('model'); expect(recordRegressions(fixtureRepo, file).saved).toBe(true);
    const current = structuredClone(report);
    for (const trial of current.trials) trial.regressionOrigins = [{ ...origin, ...changed }];
    const view = regressionView(fixtureRepo, current).entries[0]!;
    expect(view.stable).toBe(false); expect(view.reruns).toContainEqual(expect.objectContaining({ matchesCurrentTarget: false }));
});

test('blocked attempts create no rerun and a record-write failure preserves the original final report', () => {
    const stopped = savedReference('controlled', false); expect(recordRegressions(fixtureRepo, stopped.file)).toEqual({ saved: true, count: 0 });
    const { file } = savedReference(); const original = readFileSync(file);
    const directory = join(fixtureRepo, 'agent-eval/records/controlled-enrollment'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'reruns.csv.writing'), 'Occupied by another writer');
    try {
        expect(recordRegressions(fixtureRepo, file).saved).toBe(false); expect(readFileSync(file).equals(original)).toBe(true);
        expect(readReport(file).trials[0]!.status).toBe('PASS');
    } finally { unlinkSync(join(directory, 'reruns.csv.writing')); }
});

test('explicit platform projection includes regression identities but omits private verification notes', () => {
    const value = reportFixture(); value.executionKind = 'controlled'; value.trials[0]!.partition = 'badcase';
    value.trials[0]!.regressionOrigins = [{ ...origin, verification: { ...origin.verification, basis: 'PRIVATE_REFERENCE_REVIEW_NOTE' } }];
    const events = exportEvents(value), trace = events.find(event => event.type === 'trace-create')!;
    expect(trace.body).toHaveProperty('metadata.regressionOrigins.0.issueId', 'BC-1');
    expect(JSON.stringify(events)).not.toContain('PRIVATE_REFERENCE_REVIEW_NOTE');
    expect(JSON.stringify(events)).not.toContain('verification');
});

test('removed enrollment code is never executed while reading an old report', () => {
    const directory = join(fixtureRepo, 'agent-eval/src/datasets/badcase'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'cases.ts'), 'throw new Error("Controlled unavailable declaration");');
    try {
        const view = regressionView(fixtureRepo, reportFixture()); expect(view.entries).toEqual([]);
        expect(view.warnings).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
