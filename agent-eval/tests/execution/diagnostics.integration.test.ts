import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';
import { runLocal, type EvaluationProgress } from '../../src/execution/runner.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';

function kernel(transform?: (result: ReturnType<typeof observed>) => void): AgentKernel {
    return { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare(trial) {
        const result = observed(); result.identity = trial.identity; result.input = trial.input;
        result.evidence.environment!.actual = { ...trial.identity, fresh: true }; result.evidence['input-projection']!.actual = trial.input;
        transform?.(result);
        return { input: trial.input, execute: async () => result, snapshot: async () => result, cancel: async () => {}, close: async () => result.evidence.cleanup! };
    } };
}
function single() { const data = structuredClone(dataset); data.cases = data.cases.slice(0, 1); return data; }

test('whole Dataset workload controls the output folder even when only a business Case is selected', async () => {
    const data = single(), research = structuredClone(data.cases[0]!); research.id = 'research-member'; research.requires = ['agent', 'research'];
    data.cases.push(research); data.manifest.smoke = [data.cases[0]!.id];
    const id = 'mixed-' + randomUUID(), directory = join(fixtureRepo, 'agent-eval/runs/mixed', id);
    try {
        const result = await runLocal(fixtureRepo, { dataset: data, selection: 'smoke', executionId: id, backend: 'local', judge: 'off' }, { kernel: kernel(), env: {} });
        expect(result.file).toBe(join(directory, 'report.json')); expect(result.report.trials).toHaveLength(1);
        expect(existsSync(join(directory, 'badcases.json'))).toBe(true); expect(existsSync(join(directory, 'badcases.md'))).toBe(true);
        const index = JSON.parse(readFileSync(join(directory, 'badcases.json'), 'utf8'));
        expect(index.source.executionId).toBe(id); expect(index.summary.confirmed).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a diagnostic write failure warns separately after the original report was saved', async () => {
    const id = 'sidecar-failure-' + randomUUID(), directory = join(fixtureRepo, 'agent-eval/runs/business', id), events: EvaluationProgress[] = [];
    try {
        const result = await runLocal(fixtureRepo, { dataset: single(), executionId: id, backend: 'local', judge: 'off' }, { kernel: kernel(), env: {}, onProgress(event) {
            events.push(event); if (event.type === 'dataset-start') mkdirSync(join(dirname(event.reportPath), 'badcases.json'));
        } });
        expect(result.report.scoring).toBe('complete'); expect(result.report.endedAt).not.toBeNull();
        expect(JSON.parse(readFileSync(result.file, 'utf8')).executionId).toBe(id);
        expect(events.some(event => event.type === 'diagnostics-end' && !!event.error)).toBe(true);
        expect(result.report.sourceInvalidation).toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('confirmed billing failure stops later dependent Trials while retaining the started Run', async () => {
    const data = structuredClone(dataset), id = 'billing-stop-' + randomUUID(), directory = join(fixtureRepo, 'agent-eval/runs/business', id); let prepared = 0;
    const controlled = kernel(result => {
        prepared++; result.status = 'failed'; result.endpointReached = false;
        result.error = { code: 'provider_billing_failed', message: 'Provider billing unavailable', infrastructure: true };
    });
    try {
        const result = await runLocal(fixtureRepo, { dataset: data, executionId: id, backend: 'local', judge: 'off' }, { kernel: controlled, env: {} });
        expect(result.stopped).toBe(true); expect(prepared).toBe(1); expect(result.report.trials[0]!.execution?.started).toBe(true);
        expect(result.report.trials.slice(1).every(trial => trial.status === 'NOT_RUN' && trial.reason.includes('Provider'))).toBe(true);
        const index = JSON.parse(readFileSync(join(directory, 'badcases.json'), 'utf8'));
        expect(index.candidates.some((candidate: any) => candidate.signals.some((signal: any) => signal.kind === 'blocked-trial'))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
