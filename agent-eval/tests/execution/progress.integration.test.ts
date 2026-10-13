import { expect, test } from 'bun:test';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLocal, type EvaluationProgress } from '../../src/execution/runner.ts';
import { readReport } from '../../src/reports/store.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';

function product(execute?: () => Promise<void>): AgentKernel {
    return { readiness: () => ({ ready: true, reason: 'synthetic' }), async prepare(trial) {
        expect(trial).not.toHaveProperty('onProgress');
        expect(trial.input).not.toHaveProperty('onProgress');
        const result = observed(); result.identity = trial.identity; result.input = trial.input;
        result.evidence.environment!.actual = { ...trial.identity, fresh: true };
        result.evidence['input-projection']!.actual = trial.input;
        return { input: trial.input, async execute() { await execute?.(); return result; }, snapshot: async () => result,
            cancel: async () => {}, close: async () => ({ present: true, actual: { closed: true, stopped: true }, source: 'synthetic' }) };
    } };
}

function singleCase() {
    const data = structuredClone(dataset); data.cases = data.cases.slice(0, 1);
    data.manifest.members = [`cases/${data.cases[0]!.id}.json`]; data.manifest.smoke = [data.cases[0]!.id];
    return data;
}

test('progress is delivered before Agent completion and only announces saved Trials after readback', async () => {
    const events: EvaluationProgress[] = []; let entered!: () => void, release!: () => void;
    const savedStates: Array<{ trialId: string; status?: string; error?: unknown }> = [];
    const executing = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    let reportPath = '';
    const running = runLocal(fixtureRepo, { dataset: singleCase(), backend: 'local', judge: 'off', executionId: 'progress-' + randomUUID() },
        { env: {}, kernel: product(async () => { entered(); await held; }), onProgress(event) {
            events.push(event);
            if (event.type === 'dataset-start') reportPath = event.reportPath;
            if (event.type === 'trial-end') {
                try { savedStates.push({ trialId: event.trialId, status: readReport(reportPath).trials.find(t => t.trialId === event.trialId)?.status }); }
                catch (error) { savedStates.push({ trialId: event.trialId, error }); }
            }
        } });
    try {
        await executing;
        expect(events.filter(e => e.type === 'trial-phase').map(e => e.phase)).toEqual(['restoring', 'preparing', 'executing']);
        expect(events.some(e => e.type === 'trial-end')).toBe(false);
    } finally { release(); await running; }
    const result = await running;
    expect(savedStates).toEqual([{ trialId: result.report.trials[0]!.trialId, status: result.report.trials[0]!.status }]);
    expect(events.filter(e => e.type === 'trial-phase').map(e => e.phase)).toEqual(['restoring', 'preparing', 'executing', 'cleanup', 'scoring', 'saving']);
    expect(events.filter(e => e.type === 'trial-phase' || e.type === 'agent-end' || e.type === 'scoring-end' || e.type === 'trial-end')
        .map(e => e.type === 'trial-phase' ? e.phase : e.type)).toEqual([
            'restoring', 'preparing', 'executing', 'cleanup', 'agent-end', 'scoring', 'scoring-end', 'saving', 'trial-end',
        ]);
    expect(events.find(e => e.type === 'agent-end')).toMatchObject({ status: result.report.trials[0]!.execution!.status });
    expect(events.find(e => e.type === 'scoring-end')).toMatchObject({ status: result.report.trials[0]!.status });
    const saved = events.find(e => e.type === 'trial-end');
    expect(saved).toMatchObject({ index: 1, total: 1, caseId: result.report.trials[0]!.caseId, status: result.report.trials[0]!.status,
        evidenceDirectory: `evidence/${result.report.trials[0]!.trialId}/` });
    expect(events.at(-1)).toMatchObject({ type: 'dataset-end', reportPath: result.file, stopped: false });
});

test('each Case and repetition keeps a separate evidence directory and matching report references', async () => {
    const data = structuredClone(dataset); data.cases = data.cases.slice(0, 2);
    data.manifest.members = data.cases.map(t => `cases/${t.id}.json`); data.manifest.smoke = data.cases.map(t => t.id);
    const events: EvaluationProgress[] = [];
    const run = await runLocal(fixtureRepo, { dataset: data, repeat: 2, backend: 'local', judge: 'off', executionId: 'directories-' + randomUUID() },
        { env: {}, kernel: product(), onProgress: event => { events.push(event); } });
    const evidence = join(dirname(run.file), 'evidence');
    expect(readdirSync(evidence).sort()).toEqual(run.report.trials.map(t => t.trialId).sort());
    const disk = JSON.parse(readFileSync(run.file, 'utf8'));
    for (const trial of disk.trials) {
        expect(trial.evidence.trial).toBe(`evidence/${trial.trialId}/trial.json`);
        expect(readdirSync(join(evidence, trial.trialId)).filter(name => name !== 'artifacts').sort())
            .toEqual(['events.jsonl', 'observation.json', 'trial.json']);
    }
    expect(readReport(run.file).trials).toHaveLength(4);
    expect(events.filter(e => e.type === 'trial-end').map(e => [e.index, e.total])).toEqual([[1,4],[2,4],[3,4],[4,4]]);
});

test('a broken progress observer does not change scoring, cleanup or the saved report', async () => {
    const run = await runLocal(fixtureRepo, { dataset: singleCase(), backend: 'local', judge: 'off', executionId: 'observer-' + randomUUID() },
        { env: {}, kernel: product(), onProgress() { throw Error('synthetic observer failure'); } });
    expect(run.stopped).toBe(false);
    expect(readReport(run.file).trials[0]!.execution!.evidence.cleanup?.actual).toMatchObject({ closed: true, stopped: true });
    expect(run.report.scoring).toBe('complete');
});

test('a save failure never emits a saved Trial or dataset completion', async () => {
    const events: EvaluationProgress[] = []; let file = '';
    await expect(runLocal(fixtureRepo, { dataset: singleCase(), backend: 'local', judge: 'off', executionId: 'save-error-' + randomUUID() },
        { env: {}, kernel: product(), onProgress(event) {
            events.push(event);
            if (event.type === 'dataset-start') file = event.reportPath;
            if (event.type === 'trial-phase' && event.phase === 'saving') appendFileSync(file, '\n');
        } })).rejects.toThrow('Stale open report');
    expect(events.some(e => e.type === 'trial-end' || e.type === 'dataset-end')).toBe(false);
});

test('cancellation reports remaining Trials as not run and ends with an explicit stopping reason', async () => {
    const controller = new AbortController(), events: EvaluationProgress[] = [];
    const data = structuredClone(dataset); data.cases = data.cases.slice(0, 2);
    data.manifest.members = data.cases.map(t => `cases/${t.id}.json`);
    const run = await runLocal(fixtureRepo, { dataset: data, backend: 'local', judge: 'off', executionId: 'cancel-progress-' + randomUUID() },
        { env: {}, signal: controller.signal, kernel: product(async () => { controller.abort(); }), onProgress: event => { events.push(event); } });
    expect(run.stopped).toBe(true);
    expect(events.filter(e => e.type === 'trial-end')).toHaveLength(2);
    expect(events.find(e => e.type === 'trial-end' && e.index === 2)).toMatchObject({ status: 'NOT_RUN' });
    expect(events.at(-1)).toMatchObject({ type: 'dataset-end', stopped: true, reason: '用户取消评测' });
});
