import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { dataset, fixtureRepo, observed, task } from '../support/fixtures.ts';
import { judgeResponse, namedJudgment } from '../support/judge-response.ts';
import type { AgentKernel, AgentTrial } from '../../src/adapters/agent.ts';
import { caseV2Schema, manifestSchema } from '../../src/dataset-loader/schema.ts';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { executeCase } from '../../src/execution/execute-case.ts';
import { readReport } from '../../src/reports/store.ts';
import { readSnapshot } from '../../src/reports/archive.ts';

function controlledDataset(semantic: boolean) {
    const criteria = semantic ? [{ metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 1, required: true,
        rule: 'Check the single controlled decision.', evidence: ['task-facts'], trigger: 'started' as const }] : [];
    const item = caseV2Schema.parse({ ...structuredClone(task), contract: 'flowmate-agent-case/v2',
        input: { prompt: 'Execute the synthetic controlled task.', materials: [] }, expected: {
            success: ['The original saved fact is true.'], failure: ['Invent a save.'],
            checks: [{ metric: 'fact-check', required: true, evidence: 'task-facts', path: ['saved'], equals: true }],
            ...(semantic ? { semantic: { contract: 'flowmate-semantic-plan/v1', criteria } } : {}),
            metrics: metricCatalog.map(metric => metric.id === 'task-success' || criteria.some(criterion => criterion.metricId === metric.id)
                ? { metricId: metric.id, version: metric.version, unit: metric.unit, denominator: 1 }
                : { metricId: metric.id, version: metric.version, unit: metric.unit, notApplicable: 'Controlled orchestration fixture.' }) } });
    return { ...structuredClone(dataset), cases: [item], manifest: manifestSchema.parse({ ...dataset.manifest,
        contract: 'flowmate-agent-dataset/v2', members: ['cases/' + item.id + '.json'], smoke: [item.id],
        environment: { profile: 'isolated-agent/v2', source: 'voxel51', risks: ['synthetic-only'] },
        scoring: { ...dataset.manifest.scoring, judges: [{ id: 'semantic-batch', required: semantic }] } }) };
}

function originalStopped(trial: AgentTrial) {
    const result = observed(), at = '2026-10-30T00:00:00Z';
    result.identity = trial.identity; result.input = trial.input; result.configuration = trial.configuration;
    result.evidence.environment!.actual = { ...trial.identity, fresh: true };
    result.evidence['input-projection']!.actual = trial.input;
    result.evidence.runs = { present: true, actual: [{ runId: 1, sessionId: 1, kind: 'agent', status: 'completed',
        endedAt: at, stoppedAt: at, cleanup: { stopped: true, lateObservationRequired: false } }], source: 'Original controlled stopping record' };
    return result;
}

test('Judge dispatch observes a saved stopped execution and submitted checkpoint before final scores exist', async () => {
    const data = controlledDataset(true); let reportFile = '', scene = '', prepared = 0, executed = 0, requests = 0;
    const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare(trial) {
        prepared++; scene = trial.directory; const result = originalStopped(trial);
        return { input: trial.input, async execute() { executed++; return result; }, async snapshot() { return result; }, async cancel() {},
            async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'Controlled close receipt' }; } };
    } };
    const run = await runLocal(fixtureRepo, { dataset: data, backend: 'local', judge: 'required', executionId: 'checkpoint-' + randomUUID() }, {
        kernel, env: { FLOWMATE_JUDGE_API: 'openai-completions', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
            FLOWMATE_JUDGE_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-checkpoint-key' },
        onProgress(event) { if (event.type === 'dataset-start') reportFile = event.reportPath; },
        async fetcher() {
            requests++; expect(reportFile).not.toBe('');
            const saved = readReport(reportFile), trial = saved.trials[0]!;
            expect(saved.scoring).toBe('pending'); expect(trial.scoringState).toBe('submitted');
            expect(trial.scores).toEqual([]); expect(trial.execution).toMatchObject({ started: true, status: 'completed', endpointReached: true });
            expect(trial.execution!.endedAt).not.toBeNull();
            expect(trial.execution!.evidence.cleanup).toMatchObject({ present: true, actual: { stopped: true, closed: true } });
            expect(trial.judgeCalls).toHaveLength(1);
            expect(trial.judgeCalls[0]).toMatchObject({ lifecycle: 'submitted', attempts: 1, raw: null, endedAt: '' });
            expect(existsSync(scene)).toBe(true);
            return judgeResponse({ choices: [{ message: { content: namedJudgment(data.cases[0]!.expected.semantic!, { v: 1, r: [[1, 1, 0]], f: [] }) }, finish_reason: 'stop' }] });
        } });
    const saved = readReport(run.file), trial = saved.trials[0]!;
    expect([prepared, executed, requests]).toEqual([1, 1, 1]);
    expect(saved.scoring).toBe('complete'); expect(trial.scoringState).toBe('complete');
    expect(trial.scores.find(score => score.metricId === 'tool-selection')).toMatchObject({ status: 'PASS', value: 1 });
    expect(trial.judgeCalls[0]).toMatchObject({ lifecycle: 'ended', attempts: 1, error: null });
    expect(existsSync(scene)).toBe(false);
}, 30000);

test('business and research execution profiles reach Agent configuration and saved evidence without replacing tool budgets', async () => {
    const data = controlledDataset(false), research = caseV2Schema.parse({ ...structuredClone(data.cases[0]!), id: 'controlled-research',
        requires: ['agent', 'research'], steps: [{ id: 'plan', action: 'research-plan', instruction: 'Prepare the controlled research plan.' }] });
    data.cases.push(research); data.manifest.members.push('cases/' + research.id + '.json');
    let executed = 0;
    const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare(trial) {
        const result = originalStopped(trial);
        expect(trial.configuration.budget).toMatchObject({ maxToolCalls: 37, toolTimeoutMs: 1300 });
        return { input: trial.input, async execute() { executed++; return result; }, async snapshot() { return result; }, async cancel() {},
            async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'Controlled close receipt' }; } };
    } };
    const run = await runLocal(fixtureRepo, { dataset: data, backend: 'local', judge: 'off', executionId: 'profiles-' + randomUUID(),
        config: { budget: { maxToolCalls: 37, toolTimeoutMs: 1300 } } }, { kernel, env: {} });
    const saved = readReport(run.file), snapshot = readSnapshot(run.file);
    expect(executed).toBe(2);
    for (const [index, profile, trialTimeoutMs, runTimeoutMs, maxModelCalls] of [
        [0, 'business', 600000, 180000, 16], [1, 'research', 900000, 300000, 24] ] as const) {
        expect(saved.trials[index]!.execution!.configuration).toMatchObject({ timeoutMs: runTimeoutMs,
            budget: { maxToolCalls: 37, toolTimeoutMs: 1300, maxModelCalls },
            evaluationBudget: { profile, source: 'evaluation-profile', trialTimeoutMs, runTimeoutMs, maxModelCalls,
                prepareTimeoutMs: 60000, captureTimeoutMs: 60000, stopGraceMs: 5000 } });
        expect(snapshot.configuration.evaluationBudgets[profile]).toMatchObject({ trialTimeoutMs, runTimeoutMs, maxModelCalls });
    }
}, 30000);

function timerTrial(): AgentTrial {
    return { identity: { executionId: 'controlled-timer', trialId: 'trial', caseId: 'timer', caseVersion: 1 },
        directory: join(mkdtempSync(join(tmpdir(), 'flowmate-checkpoint-timer-')), 'scene'), requires: ['agent'],
        input: { prompt: 'Controlled timer protocol.', materials: [] }, configuration: {} };
}

test('a capture budget expiry is evidence_capture_timeout after actors stop', async () => {
    const trial = timerTrial(); let executed = 0;
    const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare() {
        const result = originalStopped(trial);
        return { input: trial.input, async execute(signal, onQuiescent) {
            executed++; onQuiescent?.(result); await delay(10000, undefined, { signal }); return result;
        }, async snapshot() { return result; }, async cancel() {},
        async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'Controlled close receipt' }; } };
    } };
    const outcome = await executeCase(kernel, trial, 2000, 100, undefined, undefined, { prepareTimeoutMs: 1000, captureTimeoutMs: 150 });
    expect(executed).toBe(1); expect(outcome.stopFailed).toBe(false);
    expect(outcome.execution).toMatchObject({ started: true, status: 'error', error: { code: 'evidence_capture_timeout' } });
    expect(outcome.execution.evidence['capture-gaps']?.present).toBe(false);
}, 30000);

test('one continuous Trial deadline covers sequential turns and survives a later completed snapshot', async () => {
    const trial = timerTrial(); let executed = 0, completedTurns = 0;
    trial.configuration = { timeoutMs: 180, evaluationBudget: { trialTimeoutMs: 250, runTimeoutMs: 180 } };
    const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'controlled' }), async prepare() {
        const result = originalStopped(trial);
        return { input: trial.input, async execute(signal) {
            executed++;
            for (let turn = 0; turn < 2; turn++) { await delay(150, undefined, { signal }); completedTurns++; }
            return result;
        }, async snapshot() { return result; }, async cancel() {},
        async close() { return { present: true, actual: { closed: true, stopped: true }, source: 'Controlled close receipt' }; } };
    } };
    const outcome = await executeCase(kernel, trial, 250, 100, undefined, undefined, { prepareTimeoutMs: 1000, captureTimeoutMs: 300 });
    expect([executed, completedTurns]).toEqual([1, 1]); expect(outcome.stopFailed).toBe(false);
    expect(outcome.execution).toMatchObject({ started: true, status: 'timeout', endpointReached: false, error: { code: 'task_timeout' } });
}, 30000);
