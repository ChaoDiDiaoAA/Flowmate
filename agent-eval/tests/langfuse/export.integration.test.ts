import { mkdtempSync } from '../../../tests/support/resources.ts';
import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { exportEvents, validateReceipt, exportReport } from '../../src/langfuse/export.ts';
import { reportFixture } from '../support/fixtures.ts';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { metricCatalog } from '../../src/scoring/catalog.ts';
import { readReport,saveReport } from '../../src/reports/store.ts';
import { syntheticNativeModel } from '../support/native-model.ts';
import { registerSecrets } from '../../src/execution/evidence-safety.ts';
import { syntheticLangfuseExport } from '../support/langfuse.ts';

test('Agent native capacity metadata is exported without keys or private configuration', () => {
    const report = reportFixture();
    registerSecrets(['synthetic-export-agent-key']);
    report.trials[0]!.execution!.configuration = { model: 'native-model', api: 'openai-completions',
        baseUrl: 'https://proxy.invalid/v1/synthetic-export-agent-key', modelCapabilities: syntheticNativeModel,
        apiKey: 'synthetic-export-agent-key', privateController: 'PRIVATE_FUTURE_SCRIPT' };
    const events = exportEvents(report);
    const agent = (events.find(event => event.type === 'trace-create')!.body.metadata as any).agent;
    expect(agent).toMatchObject({ model: 'native-model', api: 'openai-completions', modelCapabilities: { contextWindow: 131072,
        maxTokens: 32768, source: 'pi-sdk-model-catalog', providers: ['synthetic'] } });
    expect(agent).not.toHaveProperty('apiKey');
    expect(JSON.stringify(events)).not.toContain('synthetic-export-agent-key');
    expect(JSON.stringify(events)).not.toContain('PRIVATE_FUTURE_SCRIPT');
});

test('explicit platform projection contains all 39 metric identities without private payloads', () => {
    const report = reportFixture(), trial = report.trials[0]!, execution = trial.execution!;
    execution.input.prompt = 'PRIVATE_FUTURE_INPUT'; execution.answer = 'PRIVATE_ANSWER';
    execution.artifacts[0]!.content = { gold: 'PRIVATE_ARTIFACT_GOLD' };
    execution.observations = [{ id: 'run', kind: 'generation', name: 'Agent reasoning', startedAt: report.startedAt, endedAt: report.endedAt,
        input: 'PRIVATE_OBSERVATION_INPUT', output: 'PRIVATE_OBSERVATION_OUTPUT', parameters: { controller: 'PRIVATE_CONTROLLER' }, usage: { input: 10, hidden: 123 } }];
    trial.scores = metricCatalog.map(m => ({ metricId: m.id, name: m.name, version: m.version, method: 'deterministic', required: false,
        value: 1, status: 'PASS', reason: 'PRIVATE_GOLD_REASON', evidence: [], actual: 'PRIVATE_ACTUAL', expected: 'PRIVATE_EXPECTED',
        statistics: { unit: m.unit, numerator: 1, denominator: 1, missing: 0 } }));
    trial.judgeCalls = [{ callId: randomUUID(), configuration: { provider: 'openai-compatible', model: 'fixture', baseUrl: 'https://unused.invalid', temperature: 0, maxTokens: 256, timeoutMs: 1,  protocolVersion: 'fixture' },
        startedAt: report.startedAt, endedAt: report.endedAt!, attempts: 1, usage: { output: 12 }, responseModel: 'fixture', raw: 'PRIVATE_JUDGE_RAW', error: null, judgment: null,
        request: { system: 'PRIVATE_JUDGE_SYSTEM', data: 'PRIVATE_JUDGE_GOLD',  redacted: false }, finishReason: 'stop', responseComplete: true, compact: undefined }];
    const events = exportEvents(report), wire = JSON.stringify(events);
    assert.equal(wire.includes('PRIVATE_'), false);
    assert.equal(wire.includes('hidden'), false);
    assert.deepEqual(events.filter(e => e.type === 'score-create').map(e => (e.body.metadata as any).metricId), metricCatalog.map(m => m.id));
    const other = structuredClone(report); other.executionId = 'other-execution';
    assert.equal(exportEvents(other).some(e => events.some(first => first.id === e.id)), false);
});

test('partial receipts persist accepted IDs; duplicate and foreign receipt identities are refused', async () => {
    const report = reportFixture(), events = exportEvents(report), file = join(mkdtempSync(join(tmpdir(), 'eval-partial-')), 'summary.json');
    saveReport(file,report);
    const first = events[0]!.id;
    assert.throws(() => validateReceipt(events, { successes: [...events.map(e => ({ id: e.id })), { id: first }], errors: [] }));
    assert.throws(() => validateReceipt(events, { successes: [...events.map(e => ({ id: e.id })), { id: 'foreign' }], errors: [] }));
    await exportReport(report, file, async batch => ({ successes: [{ id: batch[0]!.id }], errors: [{ id: batch[1]!.id }] }), undefined, syntheticLangfuseExport);
    assert.equal(report.export.status, 'partial');
    assert.deepEqual(report.export.progress?.acceptedEventIds, [first]);
    assert.equal(readReport(file).export.status, 'partial');
    await exportReport(report, file, async () => { throw new Error('offline'); }, undefined, syntheticLangfuseExport);
    assert.equal(report.export.status, 'partial');
    const original = JSON.stringify(report.trials);
    await exportReport(report, file, async batch => ({ successes: batch.map(e => ({ id: e.id })), errors: [] }), undefined, syntheticLangfuseExport);
    assert.equal(report.export.status, 'complete');
    assert.equal(JSON.stringify(report.trials), original);
    assert.equal(report.export.progress?.acceptedEventIds.length, events.length);
    await exportReport(report, file, async () => { throw new Error('offline after complete'); }, undefined, syntheticLangfuseExport);
    assert.equal(report.export.status, 'complete');
});

test('successful early batch survives a later batch failure', async () => {
    const report = reportFixture(), trial = report.trials[0]!;
    trial.execution!.observations = Array.from({ length: 60 }, (_, i) => ({ id: String(i), kind: 'span', name: 'Run', startedAt: report.startedAt, endedAt: report.endedAt }));
    let sent = 0;
    const file=join(mkdtempSync(join(tmpdir(),'eval-batches-')),'report.json');saveReport(file,report);
    await exportReport(report, file, async () => { if (sent++) throw new Error('offline'); }, undefined, syntheticLangfuseExport);
    assert.equal(report.export.status, 'partial'); assert.equal(report.export.progress?.acceptedEventIds.length, 50);
});
test('optional export preserves hierarchy, API score identity and null absence', () => {
    const report = reportFixture(), execution = report.trials[0]!.execution!;
    execution.observations = [
        { id: 'task', kind: 'span', name: 'Agent task', startedAt: report.startedAt, endedAt: report.endedAt! },
        { id: 'model', parentId: 'task', kind: 'generation', name: 'Agent reasoning', startedAt: report.startedAt, endedAt: report.endedAt!, model: 'actual-model', usage: { input: 10, output: 5 } }
    ];
    report.trials[0]!.scores.push({ ...report.trials[0]!.scores[0]!, metricId: 'missing', value: null, status: 'UNJUDGEABLE' });
    const a = exportEvents(report), b = exportEvents(report);
    assert.deepEqual(a, b);
    const span = a.find(e => e.body.name === 'Agent task')!, generation = a.find(e => e.type === 'generation-create')!;
    assert.equal(generation.body.parentObservationId, span.body.id);
    assert.equal(a.filter(e => e.type === 'score-create').length, 1);
    assert.equal((a[0]!.body.metadata as any).mode, undefined);
    assert.equal((a[0]!.body.metadata as any).judge_enabled, undefined);
    assert.throws(() => validateReceipt(a, { successes: [], errors: [] }));
    validateReceipt(a, { successes: a.map(e => ({ id: e.id })), errors: [] });
});
test('failed export and idempotent resend do not change scores or call models', async () => {
    const report = reportFixture(), scores = structuredClone(report.trials[0]!.scores);
    const file = join(mkdtempSync(join(tmpdir(), 'flowmate-export-')), 'summary.json');
    saveReport(file,report);
    await exportReport(report, file, async () => { throw new Error('offline'); }, undefined, syntheticLangfuseExport);
    assert.equal(report.export.status, 'error');
    assert.deepEqual(report.trials[0]!.scores, scores);
    const sent: string[][] = [];
    for (let i = 0; i < 2; i++)
        await exportReport(report, file, async (events) => { sent.push(events.map(e => e.id)); }, undefined, syntheticLangfuseExport);
    assert.equal(sent.length,1);
    assert.equal(readReport(file).export.status, 'complete');
});

test('controller raw tool evidence stays local and is absent from the platform projection', () => {
    const report = reportFixture();
    report.trials[0]!.execution!.evidence['tool-evidence'] = { present: true, source: 'original product query',
        actual: { calls: [{ tool: { args: { raw: { private: 'LOCAL_RAW_TOOL_CANARY' } }, result: { data: 'LOCAL_RAW_RESULT_CANARY' } } }] } };
    const exported = JSON.stringify(exportEvents(report));
    assert.equal(exported.includes('LOCAL_RAW_TOOL_CANARY'), false);
    assert.equal(exported.includes('LOCAL_RAW_RESULT_CANARY'), false);
});
