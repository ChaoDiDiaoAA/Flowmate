import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchWorkflow } from '../../src/desktop/workflow.ts';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';

function pureDataset() {
    const value = structuredClone(dataset); value.manifest.scoring.judges = [];
    value.cases = value.cases.slice(0, 1); value.manifest.smoke = value.cases.map(task => task.id);
    value.cases[0]!.expected.checks = [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }];
    return value;
}
test('workflow preview is read-only and repeated explicit experiment requests return their original execution identities', async () => {
    let executions = 0;
    const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'Controlled in-process test provider' }), async prepare(trial) {
        executions++; const result = observed(); result.identity = trial.identity; result.input = trial.input;
        result.evidence.environment!.actual = { ...trial.identity, fresh: true }; result.evidence['input-projection']!.actual = trial.input;
        return { input: trial.input, async execute() { return result; }, async snapshot() { return result; }, async cancel() {},
            async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'Controlled stopped provider' }; } };
    } };
    const plan = { id: 'workflow-' + randomUUID(), benchmark: { id: 'baseline', revision: 1, selection: 'smoke' },
        repeats: 1, axes: ['model'], control: { id: 'control' }, candidates: [{ id: 'candidate' }] };
    const deps = { env: {}, experiments: { kernel, loadBenchmark: () => [pureDataset()] } };
    const preview = await dispatchWorkflow(fixtureRepo, { action: 'experiment.preview', plan }, deps);
    expect(preview.action).toBe('experiment.preview');
    if (preview.action !== 'experiment.preview') throw Error('Wrong response');
    expect(preview.data.preview.totalTrials).toBe(2); expect(executions).toBe(0);
    expect(existsSync(join(fixtureRepo, 'agent-eval/experiments', plan.id, 'experiment.json'))).toBe(false);
    const first = await dispatchWorkflow(fixtureRepo, { action: 'experiment.run', plan }, deps);
    if (first.action !== 'experiment.run') throw Error('Wrong response');
    expect(first.data.experiment.status).toBe('complete'); expect(executions).toBe(2);
    const second = await dispatchWorkflow(fixtureRepo, { action: 'experiment.run', plan }, deps);
    expect(second.data).toEqual(first.data); expect(executions).toBe(2);
    const shown = await dispatchWorkflow(fixtureRepo, { action: 'experiment.show', experimentId: plan.id }, deps);
    expect(shown.data).toEqual(first.data);
    await expect(dispatchWorkflow(fixtureRepo, { action: 'experiment.run', plan: { ...plan, repeats: 2 } }, deps)).rejects.toThrow('identity');
    const comparison = await dispatchWorkflow(fixtureRepo, { action: 'experiment.compare', experimentId: plan.id }, deps);
    expect(comparison.exitCode).toBe(2);
    const baselines = await dispatchWorkflow(fixtureRepo, { action: 'baseline.list' }, deps);
    expect(baselines.data).toEqual({ items: [] });
    await expect(dispatchWorkflow(fixtureRepo, { action: 'baseline.create', experimentId: plan.id, armId: 'control' }, deps)).rejects.toThrow('Baseline requires');
}, 45000);
