import { beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvaluationConfigurationSnapshot, EvaluationEvent } from '@flowmate/contracts';
import { createEvaluationService as create, type EvaluationServiceOptions } from '../../src/desktop/service.ts';
import type { runLocal } from '../../src/execution/runner.ts';
import { fixtureDirectory, fixtureRepo, reportFixture } from '../support/fixtures.ts';
import { syntheticNativeModel } from '../support/native-model.ts';

const manifestFile = join(fixtureDirectory, 'dataset.json'), originalManifest = readFileSync(manifestFile, 'utf8');
beforeAll(() => { const manifest = JSON.parse(originalManifest); manifest.scoring.judges = []; writeFileSync(manifestFile, JSON.stringify(manifest)); });
const settings: EvaluationConfigurationSnapshot = { revision: 1,
  agent: { api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-agent' }, judge: null,
  credentials: { agent: 'configured', judge: 'missing' } };
const selection = { datasetId: 'facility-test', selection: 'case', caseId: 'test-lines', repeat: 1, judge: 'required', configuration: {} };
const credentials = { agent: 'synthetic-agent-key', judge: null };
const prepared = { apiKey: credentials.agent, configuration: { ...settings.agent!, modelCapabilities: syntheticNativeModel } };
function service(options: EvaluationServiceOptions = {}) {
  const value = create?.(fixtureRepo, { sessionId: 'worker-1', prepareAgent: async () => prepared, ...options });
  expect(value).toBeDefined(); return value!;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function localResult(stopConfirmed = true): Awaited<ReturnType<typeof runLocal>> {
  const report = reportFixture(); report.dataset.id = 'facility-test';
  report.trials[0]!.execution!.evidence.cleanup = { present: true, actual: { closed: stopConfirmed, stopped: stopConfirmed }, source: 'controlled-stop' };
  return { report, file: join(fixtureRepo, 'synthetic-report.json'), stopped: !stopConfirmed };
}
function finished() {
  const wait = deferred<void>();
  const onEvent = (event: EvaluationEvent) => { if (['finished', 'stop-unconfirmed'].includes(event.control.state)) wait.resolve(); };
  return { onEvent, wait: wait.promise };
}

test('a local preview creates no run and missing necessary settings block all preparation', async () => {
  let preparations = 0;
  const s = service({ prepareAgent: async () => { preparations++; return prepared; } });
  const preview = s.preview(selection, { ...settings, agent: null, credentials: { ...settings.credentials, agent: 'missing' } });
  expect(preview).toMatchObject({ ok: true, data: { ready: false, plan: { total: 1, judgeMaxGenerations: 0 } } });
  if (!preview.ok) return;
  expect(s.start({ previewId: preview.data.previewId, requestId: 'start-1' }, { batchId: 'batch-1', settings, credentials }))
    .toMatchObject({ ok: false });
  expect(preparations).toBe(0); expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
  expect(await s.shutdown()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
});

test('duplicate starts keep one batch and preparing cancellation prevents a delayed Trial from starting', async () => {
  const preparation = deferred<typeof prepared>(); let preparations = 0, trials = 0;
  const s = service({ prepareAgent: async () => { preparations++; return preparation.promise; }, runLocal: async () => { trials++; return localResult(); } });
  const preview = s.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview failed');
  const input = { previewId: preview.data.previewId, requestId: 'start-1' }, context = { batchId: 'batch-1', settings, credentials };
  expect(s.start(input, context)).toMatchObject({ ok: true, data: { state: 'preparing', batchId: 'batch-1' } });
  expect(s.start(input, { ...context, batchId: 'ignored-new-batch' })).toMatchObject({ ok: true, data: { batchId: 'batch-1' } });
  expect(s.start({ ...input, previewId: 'another-view' }, context)).toMatchObject({ ok: false, error: { code: 'evaluation_request_conflict' } });
  expect(s.start({ ...input, requestId: 'second-start' }, context)).toMatchObject({ ok: false, error: { code: 'evaluation_busy' } });
  expect(s.cancel({ batchId: 'batch-1' })).toMatchObject({ ok: true, data: { state: 'cancelling' } });
  expect(s.control({ requestId: 'start-1' })).toMatchObject({ ok: true, data: { batchId: 'batch-1', state: 'cancelling' } });
  preparation.resolve(prepared);
  expect(await s.shutdown()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  expect(s.control({ batchId: 'batch-1' })).toMatchObject({ ok: true, data: { state: 'finished', outcome: 'cancelled', executionIds: [] } });
  expect(preparations).toBe(1); expect(trials).toBe(0);
});

test('a deterministic selection executes the Agent once with an explicit null Judge and consumes its preview', async () => {
  const end = finished(); let trials = 0, judges = 0;
  const s = service({ onEvent: end.onEvent, prepareJudge: async config => { judges++; return config; },
    runLocal: async (_repo, options, deps) => {
      trials++; expect(options.backend).toBe('local'); expect(deps?.preparedJudge).toBeNull();
      expect(deps?.preparedAgent?.apiKey).toBe('synthetic-agent-key'); return localResult();
    } });
  const preview = s.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview failed');
  expect(preview.data).toMatchObject({ ready: true, plan: { judgeMaxGenerations: 0 } });
  s.start({ previewId: preview.data.previewId, requestId: 'start-1' }, { batchId: 'batch-1', settings, credentials });
  await end.wait;
  expect(s.control()).toMatchObject({ ok: true, data: { state: 'finished', outcome: 'completed', stop: 'confirmed', executionIds: ['unit'] } });
  expect(s.start({ previewId: preview.data.previewId, requestId: 'second-start' }, { batchId: 'batch-2', settings, credentials }))
    .toMatchObject({ ok: false, error: { code: 'evaluation_preview_consumed' } });
  expect(trials).toBe(1); expect(judges).toBe(0);
  expect(JSON.stringify(s.control())).not.toContain('synthetic-agent-key');
  await s.shutdown();
});

test('a necessary Judge missing from the selected plan rejects before preparing either model', async () => {
  const stripped = readFileSync(manifestFile, 'utf8'); let preparations = 0;
  try {
    writeFileSync(manifestFile, originalManifest);
    const s = service({ prepareAgent: async () => { preparations++; return prepared; } });
    const preview = s.preview(selection, settings);
    expect(preview).toMatchObject({ ok: true, data: { ready: false, plan: { judgeRequired: true } } });
    if (!preview.ok) return;
    expect(s.start({ previewId: preview.data.previewId, requestId: 'start-1' }, { batchId: 'batch-1', settings, credentials })).toMatchObject({ ok: false });
    expect(preparations).toBe(0); await s.shutdown();
  } finally { writeFileSync(manifestFile, stripped); }
});

test('a same-version requirement changed during asynchronous preparation starts no Trial', async () => {
  const file = join(fixtureDirectory, 'cases/test-lines.json'), before = readFileSync(file, 'utf8');
  const preparation = deferred<typeof prepared>(), entered = deferred<void>(), end = finished(); let trials = 0;
  const s = service({ onEvent: end.onEvent, prepareAgent: async () => { entered.resolve(); return preparation.promise; },
    runLocal: async () => { trials++; return localResult(); } });
  try {
    const preview = s.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview failed');
    s.start({ previewId: preview.data.previewId, requestId: 'start-1' }, { batchId: 'batch-1', settings, credentials }); await entered.promise;
    const changed = JSON.parse(before); changed.expected.success = ['Additional required synthetic condition']; writeFileSync(file, JSON.stringify(changed));
    preparation.resolve(prepared); await end.wait;
    expect(s.control()).toMatchObject({ ok: true, data: { state: 'finished', outcome: 'failed', executionIds: [] } });
    expect(trials).toBe(0); await s.shutdown();
  } finally { writeFileSync(file, before); }
});

test('a returned scheduling stop without cleanup confirmation remains blocked and cannot close successfully', async () => {
  const end = finished(), s = service({ onEvent: end.onEvent, runLocal: async () => localResult(false) });
  const preview = s.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview failed');
  s.start({ previewId: preview.data.previewId, requestId: 'start-1' }, { batchId: 'batch-1', settings, credentials }); await end.wait;
  expect(s.control()).toMatchObject({ ok: true, data: { state: 'stop-unconfirmed', stop: 'unconfirmed' } });
  expect(await s.shutdown()).toMatchObject({ ok: true, data: { closed: false, stopped: false } });
  expect(s.control({ requestId: 'unrelated-start' })).toMatchObject({ ok: false, error: { code: 'evaluation_request_unknown' } });
});

test('a save failure after actual cleanup keeps the failure while allowing a confirmed shutdown', async () => {
  const end = finished(), s = service({ onEvent: end.onEvent, runLocal: async (_repo, _options, deps) => {
    deps?.onProgress?.({ type: 'dataset-start', datasetId: 'facility-test', executionId: 'save-failed', reportPath: 'private-path' });
    deps?.onProgress?.({ type: 'trial-phase', phase: 'preparing', index: 1, total: 1, caseId: 'test-lines', trialId: 'trial-1' });
    deps?.onProgress?.({ type: 'trial-cleanup', executionId: 'save-failed', index: 1, total: 1, caseId: 'test-lines', trialId: 'trial-1', stopConfirmed: true });
    throw Error('Synthetic report save failure');
  } });
  const preview = s.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview failed');
  s.start({ previewId: preview.data.previewId, requestId: 'start-1' }, { batchId: 'batch-1', settings, credentials }); await end.wait;
  expect(s.control()).toMatchObject({ ok: true, data: { state: 'finished', outcome: 'failed', stop: 'confirmed', executionIds: ['save-failed'] } });
  expect(JSON.stringify(s.control())).not.toContain('private-path');
  expect(await s.shutdown()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
});
