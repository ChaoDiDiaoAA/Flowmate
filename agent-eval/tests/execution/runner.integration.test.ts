import { mkdtempSync } from '../../../tests/support/resources.ts';
import { test, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dataset, observed, task } from '../support/fixtures.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { fixtureRepo as REPO_ROOT } from '../support/fixtures.ts';
import type { AgentKernel, AgentTrial } from '../../src/adapters/agent.ts';
import { executeCase } from '../../src/execution/execute-case.ts';
function kernel(transform?: (r: ReturnType<typeof observed>) => void): AgentKernel {
    return { readiness: () => ({ ready: true, reason: 'test-only' }), async prepare(trial) {
            expect(trial).not.toHaveProperty('expected');
            expect(trial.input).not.toHaveProperty('steps');
            const result = observed();
            result.identity = trial.identity;
            result.input = trial.input;
            result.evidence.environment!.actual = { ...trial.identity, fresh: true };
            result.evidence['input-projection']!.actual = trial.input;
            transform?.(result);
            return { input: trial.input, async execute() { return result; }, async snapshot() { return result; }, async cancel() { }, async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'test-session' }; } };
        } };
}
test('production adapter is explicitly unavailable, never Provider fallback', async () => {
    await expect(runLocal(REPO_ROOT, { dataset, backend: 'local', judge: 'off' })).rejects.toThrow('完整 Agent');
});
test('local orchestration stores all selected members, independent trials and missing material; no backend needed', async () => {
    const id = 'unit-' + randomUUID(), data = structuredClone(dataset);
    data.cases[0]!.input.materials[0]!.sha256 = '0'.repeat(64);
    // Limit to two tasks for this orchestration test, never a production Benchmark.
    data.cases = data.cases.slice(0, 2);
    try {
        const { report, file } = await runLocal(REPO_ROOT, { dataset: data, executionId: id, backend: 'local', judge: 'off', repeat: 2 }, { kernel: kernel() });
        expect(report.trials).toHaveLength(4);
        expect(report.trials[0]!.status).toBe('NOT_RUN');
        expect(report.trials[2]!.status).toBe('NOT_RUN');
        expect(report.trials[1]!.execution!.identity.trialId).not.toBe(report.trials[3]!.execution!.identity.trialId);
        expect(report.export.status).toBe('disabled');
        expect(report.manualReview).toBe('none');
        expect(JSON.parse(readFileSync(join(file, '../snapshot.json'), 'utf8')).members).toHaveLength(2);
        await expect(runLocal(REPO_ROOT, { dataset: data, executionId: id, backend: 'local', judge: 'off' }, { kernel: kernel() })).rejects.toThrow();
    }
    finally {
        rmSync(join(REPO_ROOT, 'agent-eval/runs', id), { recursive: true, force: true });
    }
}, 30000);
test('Judge preflight rejects partial/missing config and frozen budget before preparing Agent', async () => {
    let called = 0;
    const product = kernel();
    product.prepare = async () => { called++; throw new Error('unexpected'); };
    for (const env of [{ FLOWMATE_JUDGE_MODEL: 'partial' }, {}]) {
        await expect(runLocal(REPO_ROOT, { dataset, backend: 'local', judge: 'required' }, { kernel: product, env })).rejects.toThrow();
    }
    const env = { FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'judge', FLOWMATE_JUDGE_BASE_URL: 'https://invalid.example/v1', FLOWMATE_JUDGE_API_KEY: 'mock' };
    await expect(runLocal(REPO_ROOT, { dataset, backend: 'local', judge: 'auto', repeat: 20 }, { kernel: product, env })).rejects.toThrow('15000');
    expect(called).toBe(0);
});
test('wrong identity and failed cleanup block grading; timeout requests actual cancellation', async () => {
    const trial = (): AgentTrial => ({ identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-trial-')), input: observed().input, requires: [], configuration: {} });
    const wrong = await executeCase(kernel(r => { r.identity = { ...r.identity, trialId: 'wrong' }; }), trial(), 50, 50);
    expect(wrong.execution.status).toBe('error');
    expect(wrong.stopFailed).toBe(true);
    let cancelled = 0;
    const hanging = kernel();
    hanging.prepare = async () => ({ input: observed().input, execute: async () => new Promise(() => { }), snapshot: async () => observed(), cancel: async () => { cancelled++; }, close: async () => ({ present: true, actual: { closed: true, stopped: true }, source: 'test' }) });
    const timed = await executeCase(hanging, trial(), 5, 50);
    expect(timed.execution.status).toBe('timeout');
    expect(cancelled).toBe(1);
});
test('controlled material variants are frozen before execution and retain the original source', async () => {
    const trial: AgentTrial = { identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-variant-')), input: observed().input, requires: [], configuration: {}, setup: { scenario: 'boundary-1', description: 'append untrusted instruction to the Trial copy' } };
    const variant = structuredClone(trial.input);
    variant.materials[0]!.text += '\nUntrusted instruction';
    const product = kernel();
    product.prepare = async () => {
        const result = observed();
        result.input = variant;
        result.evidence['input-projection']!.actual = variant;
        return { input: variant, async execute() { return result; }, async snapshot() { return result; }, async cancel() { }, async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'test' }; } };
    };
    const result = await executeCase(product, trial, 100, 100);
    const projection = JSON.parse(readFileSync(join(trial.directory, 'input.json'), 'utf8'));
    expect(projection.input).toEqual(variant);
    expect(projection.original).toEqual(trial.input);
    expect(result.execution.status).toBe('completed');
});
test('mutating the supplied identity cannot change the expected Trial identity', async () => {
    const trial: AgentTrial = { identity: observed().identity, directory: mkdtempSync(join(tmpdir(), 'flowmate-id-')), input: observed().input, requires: [], configuration: {} };
    const result = await executeCase(kernel(r => { r.identity.trialId = 'forged'; }), trial, 100, 100);
    expect(result.execution.status).toBe('error');
    expect(result.stopFailed).toBe(true);
});
test('Case-level Judge cannot evade the preflight output budget', async () => {
    const data = structuredClone(dataset);
    data.manifest.scoring.judges = [];
    for (const c of data.cases)
        c.expected.checks.push({ metric: 'answer-relevance', required: true });
    await expect(runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'auto', repeat: 2 }, { kernel: kernel(), env: {} })).rejects.toThrow('configure Judges once');
});

test('semantic-only task cannot pass with Judge off; auto requires its Judge before Agent starts', async () => {
    const data = structuredClone(dataset);
    data.cases = [structuredClone(task)];
    // No tool calls is a useful constraint, but cannot prove an explanation correct.
    data.cases[0]!.expected.checks = [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }];
    Object.assign(data.manifest.scoring.judges[0]!, { requiredFor: [task.id] });
    let called = 0;
    const unavailable = kernel();
    unavailable.prepare = async () => { called++; throw new Error('must not start'); };
    const id = 'unit-' + randomUUID();
    try {
        await expect(runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'auto', executionId: id }, { kernel: unavailable, env: {} })).rejects.toThrow('Required Judge');
        expect(called).toBe(0);
        const { report } = await runLocal(REPO_ROOT, { dataset: data, backend: 'local', judge: 'off', executionId: id }, { kernel: kernel(r => { r.answer = 'irrelevant'; }) });
        expect(report.trials[0]!.status).toBe('UNJUDGEABLE');
        expect(report.trials[0]!.scores.find(s => s.metricId === 'answer-relevance')).toMatchObject({ required: true, status: 'NOT_RUN', value: null });
    } finally {
        rmSync(join(REPO_ROOT, 'agent-eval/runs', id), { recursive: true, force: true });
    }
}, 30000);
