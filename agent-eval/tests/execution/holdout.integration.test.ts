import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';
import { hash, selectCases } from '../../src/dataset-loader/local.ts';
import { main } from '../../src/cli.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { readReport } from '../../src/reports/store.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';
import {withoutHashes} from '../../src/artifacts.ts';
import {publicVersions} from '../../src/reports/files.ts';

test('explicit Case selection cannot cross the declared Smoke and holdout boundary', () => {
    const smoke = dataset.manifest.smoke[0]!;
    const held = dataset.cases.find(task => !dataset.manifest.smoke.includes(task.id))!.id;
    expect(selectCases(dataset, 'holdout').map(task => task.id)).toEqual([held]);
    expect(selectCases(dataset, 'full', smoke).map(task => task.id)).toEqual([smoke]);
    expect(selectCases(dataset, 'holdout', held).map(task => task.id)).toEqual([held]);
    expect(() => { selectCases(dataset, 'holdout', smoke); }).toThrow('outside selected');
    expect(() => { selectCases(dataset, 'smoke', held); }).toThrow('outside selected');
    expect(() => { Reflect.apply(selectCases, undefined, [dataset, 'development']); }).toThrow('Invalid selection');
});

test('CLI accepts holdout but does not bypass absent data or production readiness', async () => {
    await expect(main(['run', '--selection', 'holdout', '--dataset', 'absent-holdout-fixture', '--backend', 'local', '--judge', 'off'], fixtureRepo))
        .rejects.toThrow('Dataset absent-holdout-fixture 不存在');
    await expect(main(['run', '--selection', 'development', '--backend', 'local', '--judge', 'off'], fixtureRepo))
        .rejects.toThrow('Invalid backend/judge/selection');
});

test('holdout repeat preserves successful, failed and infrastructure-error Trials and report readback', async () => {
    const data = structuredClone(dataset), held = data.cases.find(task => !data.manifest.smoke.includes(task.id))!;
    held.expected.checks = [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }];
    data.hash = hash({ manifest: data.manifest, cases: data.cases });
    const prepared: string[] = [];
    const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'synthetic-only' }), async prepare(trial) {
        prepared.push(trial.identity.caseId);
        const result = observed(); result.identity = trial.identity; result.input = trial.input;
        result.evidence.environment!.actual = { ...trial.identity, fresh: true };
        result.evidence['input-projection']!.actual = trial.input;
        if (prepared.length === 2) { result.endpointReached = false; result.evidence['task-endpoint']!.actual = false; }
        if (prepared.length === 3) { result.status = 'error'; result.error = { code: 'synthetic-unavailable', message: 'Synthetic infrastructure failure', infrastructure: true }; }
        return { input: trial.input, async execute() { return result; }, async snapshot() { return result; }, async cancel() {},
            async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'synthetic-session' }; } };
    } };
    const run = await runLocal(fixtureRepo, { dataset: data, selection: 'holdout', repeat: 3,
        executionId: 'holdout-' + randomUUID(), backend: 'local', judge: 'off' }, { kernel });
    expect(prepared).toEqual([held.id, held.id, held.id]);
    expect(run.report.selection).toBe('holdout');
    expect(run.report.trials.map(trial => trial.partition)).toEqual(['holdout', 'holdout', 'holdout']);
    expect(run.report.trials.map(trial => trial.repetition)).toEqual([1, 2, 3]);
    expect(run.report.trials.map(trial => trial.status)).toEqual(['PASS', 'FAIL', 'ERROR']);
    expect(publicVersions(readReport(run.file))).toEqual(publicVersions(JSON.parse(JSON.stringify(withoutHashes(run.report)))));
    const snapshot = JSON.parse(readFileSync(join(run.file, '..', 'snapshot.json'), 'utf8'));
    expect(snapshot.selection).toBe('holdout');
    expect(snapshot.cases.map((task: { id: string }) => task.id)).toEqual([held.id]);
    const tampered = structuredClone(run.report); tampered.trials[0]!.partition = 'smoke';
    writeFileSync(run.file, JSON.stringify(tampered));
    expect(() => { readReport(run.file); }).toThrow('holdout');
});

test('empty holdout cannot create an Execution or prepare an Agent', async () => {
    const data = structuredClone(dataset); data.manifest.smoke = data.cases.map(task => task.id);
    let prepared = 0;
    const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'synthetic-only' }),
        async prepare() { prepared++; throw new Error('must not prepare'); } };
    const id = 'empty-holdout-' + randomUUID();
    await expect(runLocal(fixtureRepo, { dataset: data, selection: 'holdout', executionId: id, backend: 'local', judge: 'off' }, { kernel }))
        .rejects.toThrow('No Cases in selected');
    expect(prepared).toBe(0);
    expect(existsSync(join(fixtureRepo, 'agent-eval/runs/business', id))).toBe(false);
});
