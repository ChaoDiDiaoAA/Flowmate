import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLocal, type EvaluationProgress } from '../../src/execution/runner.ts';
import { readReport } from '../../src/reports/store.ts';
import { archiveFile, readArchive, writeArchivePart } from '../../src/reports/archive.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';

function product(execute?: () => Promise<void>, transform?: (result: ReturnType<typeof observed>) => void): AgentKernel {
    return { readiness: () => ({ ready: true, reason: 'synthetic' }), async prepare(trial) {
        expect(trial).not.toHaveProperty('onProgress');
        expect(trial.input).not.toHaveProperty('onProgress');
        const result = observed(); result.identity = trial.identity; result.input = trial.input;
        transform?.(result);
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
        evidenceDirectory: `run.json#/executions/${result.report.executionId}/trials/0` });
    expect(events.at(-1)).toMatchObject({ type: 'dataset-end', reportPath: result.file, stopped: false });
});

test('each Case and repetition keeps its original inline evidence and matching report references', async () => {
    const data = structuredClone(dataset); data.cases = data.cases.slice(0, 2);
    data.manifest.members = data.cases.map(t => `cases/${t.id}.json`); data.manifest.smoke = data.cases.map(t => t.id);
    const events: EvaluationProgress[] = [];
    const run = await runLocal(fixtureRepo, { dataset: data, repeat: 2, backend: 'local', judge: 'off', executionId: 'directories-' + randomUUID() },
        { env: {}, kernel: product(), onProgress: event => { events.push(event); } });
    expect(readdirSync(dirname(archiveFile(run.file))).sort()).toEqual(['README.md', 'run.json']);
    const disk = readArchive(run.file).executions[run.report.executionId] as { trials: Array<{ execution: unknown; judgeCalls: unknown }> };
    for (const [index, trial] of disk.trials.entries()) {
        expect(trial.execution).toEqual(run.report.trials[index]!.execution);
        expect(trial.judgeCalls).toEqual(run.report.trials[index]!.judgeCalls);
    }
    expect(readReport(run.file).trials).toHaveLength(4);
    expect(events.filter(e => e.type === 'trial-end').map(e => [e.index, e.total])).toEqual([[1,4],[2,4],[3,4],[4,4]]);
    expect(events.filter(e => e.type === 'trial-end').map(e => [e.trialIndex,e.trialsPerCase])).toEqual([[1,2],[1,2],[2,2],[2,2]]);
    expect(events.filter(e => e.type === 'trial-end').map(e => e.evidenceDirectory)).toEqual(
        run.report.trials.map((_, index) => `run.json#/executions/${run.report.executionId}/trials/${index}`));
    expect(run.report.trialStatistics).toBeDefined();
    expect(events.at(-1)).toMatchObject({type:'dataset-end',statistics:readReport(run.file).trialStatistics});
});

test('a broken progress observer does not change scoring, cleanup or the saved report', async () => {
    const run = await runLocal(fixtureRepo, { dataset: singleCase(), backend: 'local', judge: 'off', executionId: 'observer-' + randomUUID() },
        { env: {}, kernel: product(), onProgress() { throw Error('synthetic observer failure'); } });
    expect(run.stopped).toBe(false);
    expect(readReport(run.file).trials[0]!.execution!.evidence.cleanup?.actual).toMatchObject({ closed: true, stopped: true });
    expect(run.report.scoring).toBe('complete');
});

test.each([false, true])('a hard FAIL also exposes the concurrent Judge error when collection error=%s', async collectionError => {
    const data = singleCase(), events: EvaluationProgress[] = [];
    data.cases[0]!.expected.checks.push({ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: false });
    if (collectionError) data.cases[0]!.expected.checks.push({ metric: 'fact-check', required: true, evidence: 'missing-collection', path: [], equals: true });
    data.manifest.scoring.judges[0]!.required = true;
    const run = await runLocal(fixtureRepo, { dataset: data, backend: 'local', judge: 'required', executionId: 'mixed-progress-' + randomUUID() },
        { kernel: product(undefined, result => {
            if (collectionError) result.evidence['capture-gaps'] = { present: false, actual: ['Controlled collection read failure'], source: 'Original collection error' };
        }), env: { FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
            FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-mixed-judge-key' },
            fetcher: async () => new Response('controlled judge outage', { status: 503 }), onProgress: event => { events.push(event); } });
    const trial = run.report.trials[0]!, error = trial.scores.find(score => score.method === 'llm-judge' && score.status === 'ERROR')!;
    expect(trial.status).toBe('FAIL');
    expect(error).toBeDefined();
    expect(trial.judgeCalls[0]!.attempts).toBe(1);
    const progress = events.find(event => event.type === 'scoring-end')!;
    expect(progress.status).toBe('FAIL');
    expect(progress.reason).toContain('评分异常');
    expect(progress.reason).toContain('Judge 调用失败');
    expect(progress.reason).toContain('详见报告');
    expect(progress.reason).not.toContain('controlled judge outage');
    expect(readReport(run.file).trials[0]!.reason).toBe(trial.reason);
});

test('a save failure never emits a saved Trial or dataset completion', async () => {
    const events: EvaluationProgress[] = []; let file = '';
    await expect(runLocal(fixtureRepo, { dataset: singleCase(), backend: 'local', judge: 'off', executionId: 'save-error-' + randomUUID() },
        { env: {}, kernel: product(), onProgress(event) {
            events.push(event);
            if (event.type === 'dataset-start') file = event.reportPath;
            if (event.type === 'trial-phase' && event.phase === 'saving') {
                const newer = readReport(file); newer.trials[0]!.reason = 'Newer externally saved progress';
                writeArchivePart(file, newer);
            }
        } })).rejects.toThrow('Stale open report');
    expect(events.some(e => e.type === 'trial-end' || e.type === 'dataset-end')).toBe(false);
});

test('cancellation reports remaining Trials as not run and ends with an explicit stopping reason', async () => {
    const controller = new AbortController(), events: EvaluationProgress[] = [];
    const data = structuredClone(dataset); data.cases = data.cases.slice(0, 2);
    data.manifest.members = data.cases.map(t => `cases/${t.id}.json`);
    const run = await runLocal(fixtureRepo, { dataset: data, backend: 'local', judge: 'off', executionId: 'cancel-progress-' + randomUUID() },
        { env: {}, signal: controller.signal, kernel: product(async () => { controller.abort(); }, result => {
            result.evidence.runs = { present: true, actual: [{ runId: 1, sessionId: 1, kind: 'agent', status: 'completed',
                startedAt: result.startedAt, endedAt: result.endedAt, stoppedAt: result.endedAt,
                cleanup: { stopped: true, lateObservationRequired: false } }], source: 'Controlled fixture terminal actor and runtime stop receipt' };
        }), onProgress: event => { events.push(event); } });
    expect(run.stopped).toBe(true);
    expect(events.filter(e => e.type === 'trial-end')).toHaveLength(2);
    expect(events.find(e => e.type === 'trial-end' && e.index === 2)).toMatchObject({ status: 'NOT_RUN' });
    expect(events.at(-1)).toMatchObject({ type: 'dataset-end', stopped: true, reason: '用户取消评测' });
    expect(events.find(event => event.type === 'trial-cleanup')).toMatchObject({ stopConfirmed: true });
});

test('cancellation without original actor stop facts keeps stop unknown despite a successful Host close', async () => {
    const controller = new AbortController(), events: EvaluationProgress[] = [];
    const run = await runLocal(fixtureRepo, { dataset: singleCase(), backend: 'local', judge: 'off', executionId: 'cancel-missing-stop-' + randomUUID() },
        { env: {}, signal: controller.signal, kernel: product(async () => { controller.abort(); }), onProgress: event => { events.push(event); } });
    expect(run.stopped).toBe(true);
    expect(run.report.trials[0]!.execution!.evidence.cleanup).toMatchObject({ present: true, actual: { closed: true, stopped: true } });
    expect(events.find(event => event.type === 'trial-cleanup')).toMatchObject({ stopConfirmed: false });
    expect(events.at(-1)).toMatchObject({ type: 'dataset-end', stopped: true, reason: expect.stringContaining('Prior Trial stopping unconfirmed:') });
});
