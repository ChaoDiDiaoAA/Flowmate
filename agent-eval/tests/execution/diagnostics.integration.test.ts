import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';
import { runLocal, type EvaluationProgress } from '../../src/execution/runner.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';
import { archiveFile, archiveReference, readArchivePart } from '../../src/reports/archive.ts';
import { readReport } from '../../src/reports/store.ts';

function kernel(transform?: (result: ReturnType<typeof observed>) => void): AgentKernel {
    return { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare(trial) {
        const result = observed(); result.identity = trial.identity; result.input = trial.input;
        result.evidence.environment!.actual = { ...trial.identity, fresh: true }; result.evidence['input-projection']!.actual = trial.input;
        transform?.(result);
        return { input: trial.input, execute: async () => result, snapshot: async () => result, cancel: async () => {}, close: async () => result.evidence.cleanup! };
    } };
}
function single() { const data = structuredClone(dataset); data.cases = data.cases.slice(0, 1); return data; }

test('a mixed Dataset keeps selected business evidence and diagnostics in one readable Run', async () => {
    const data = single(), research = structuredClone(data.cases[0]!); research.id = 'research-member'; research.requires = ['agent', 'research'];
    data.cases.push(research); data.manifest.smoke = [data.cases[0]!.id];
    const id = 'mixed-' + randomUUID(); let directory = '';
    try {
        const result = await runLocal(fixtureRepo, { dataset: data, selection: 'smoke', executionId: id, backend: 'local', judge: 'off' }, { kernel: kernel(), env: {} });
        directory = dirname(archiveFile(result.file));
        expect(result.file).toBe(archiveReference(join(directory, 'run.json'), 'executions', id)); expect(result.report.trials).toHaveLength(1);
        expect(readdirSync(directory).sort()).toEqual(['README.md', 'run.json']);
        const index = readArchivePart(archiveReference(result.file, 'diagnostics', id));
        expect(index.source.executionId).toBe(id); expect(index.summary.confirmed).toBe(0);
    } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
});

test('inline diagnostics ignore an occupied obsolete sidecar location after saving original results', async () => {
    const id = 'sidecar-failure-' + randomUUID(), events: EvaluationProgress[] = []; let directory = '';
    try {
        const result = await runLocal(fixtureRepo, { dataset: single(), executionId: id, backend: 'local', judge: 'off' }, { kernel: kernel(), env: {}, onProgress(event) {
            events.push(event); if (event.type === 'dataset-start') {
                directory = dirname(archiveFile(event.reportPath)); mkdirSync(join(directory, 'badcases.json'));
            }
        } });
        expect(result.report.scoring).toBe('complete'); expect(result.report.endedAt).not.toBeNull();
        expect(readReport(result.file).executionId).toBe(id);
        expect(events.find(event => event.type === 'diagnostics-end')).toMatchObject({ json: archiveReference(result.file, 'diagnostics', id) });
        expect(events.some(event => event.type === 'diagnostics-end' && !!event.error)).toBe(false);
        expect(readArchivePart(archiveReference(result.file, 'diagnostics', id)).source.executionId).toBe(id);
        expect(result.report.sourceInvalidation).toBeUndefined();
    } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
});

test('confirmed billing failure stops later dependent Trials while retaining the started Run', async () => {
    const data = structuredClone(dataset), id = 'billing-stop-' + randomUUID(); let directory = '', prepared = 0;
    const controlled = kernel(result => {
        prepared++; result.status = 'failed'; result.endpointReached = false;
        result.error = { code: 'provider_billing_failed', message: 'Provider billing unavailable', infrastructure: true };
    });
    try {
        const result = await runLocal(fixtureRepo, { dataset: data, executionId: id, backend: 'local', judge: 'off' }, { kernel: controlled, env: {} });
        expect(result.stopped).toBe(true); expect(prepared).toBe(1); expect(result.report.trials[0]!.execution?.started).toBe(true);
        expect(result.report.trials.slice(1).every(trial => trial.status === 'NOT_RUN' && trial.reason.includes('Provider'))).toBe(true);
        directory = dirname(archiveFile(result.file));
        const index = readArchivePart(archiveReference(result.file, 'diagnostics', id));
        expect(index.candidates.some((candidate: any) => candidate.signals.some((signal: any) => signal.kind === 'blocked-trial'))).toBe(true);
    } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
});
