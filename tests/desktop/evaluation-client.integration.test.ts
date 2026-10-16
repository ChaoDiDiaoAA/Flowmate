import { expect, test, spyOn } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appError, fail, ok, type EvaluationConfigurationSnapshot, type EvaluationEvent } from '@flowmate/contracts';
import { EvaluationClient as Client } from '../../apps/desktop/main/evaluation-client.ts';
import { fixtureRepo, fixtureDirectory, reportFixture, comparisonFacts } from '../../agent-eval/tests/support/fixtures.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../support/resources.ts';
import { saveReport } from '../../agent-eval/src/reports/store.ts';

const repository = resolve(import.meta.dir, '../..');
const settings: EvaluationConfigurationSnapshot = { revision: 1,
  agent: { api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-agent' }, judge: null,
  credentials: { agent: 'configured', judge: 'missing' } };
const selection = { datasetId: 'facility-test', selection: 'case', caseId: 'test-lines', repeat: 1, judge: 'off', configuration: {} };
function client() { expect(Client).toBeDefined(); return new Client!(repository, fixtureRepo); }

test('Main controls the fixed real Worker and rejects unready or invalid starts before reading any key', async () => {
  const c = client(); let preparations = 0;
  try {
    const preview = await c.preview(selection, { ...settings, agent: null, credentials: { ...settings.credentials, agent: 'missing' } });
    expect(preview).toMatchObject({ ok: true, data: { ready: false } }); if (!preview.ok) return;
    const prepare = async () => { preparations++; return ok({ settings, credentials: { agent: 'synthetic-main-worker-private-key', judge: null } }); };
    expect(await c.start({ previewId: preview.data.previewId, requestId: 'start-1' }, prepare)).toMatchObject({ ok: false, error: { code: 'evaluation_not_ready' } });
    expect(await c.start({ previewId: preview.data.previewId, requestId: 'bad', kernel: 'anything' }, prepare)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(preparations).toBe(0); expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
    expect(await c.control()).toMatchObject({ ok: true, data: { state: 'idle' } });
  } finally { expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
});

test('Main reserves a pending start before asynchronous key reads and cancels it without sending a Trial', async () => {
  const c = client(), events: EvaluationEvent[] = []; c.subscribe(event => events.push(event));
  let release!: () => void, entered!: () => void, preparations = 0;
  const blocked = new Promise<void>(done => { release = done; }), preparing = new Promise<void>(done => { entered = done; });
  try {
    const preview = await c.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview unavailable');
    const input = { previewId: preview.data.previewId, requestId: 'start-1' };
    const prepare = async () => { preparations++; entered(); await blocked; return ok({ settings, credentials: { agent: 'synthetic-main-worker-private-key', judge: null } }); };
    const first = c.start(input, prepare), duplicate = c.start(input, prepare); await preparing;
    expect(await c.start({ ...input, requestId: 'another-start' }, prepare)).toMatchObject({ ok: false, error: { code: 'evaluation_busy' } });
    expect(await c.start({ ...input, previewId: 'another-preview' }, prepare)).toMatchObject({ ok: false, error: { code: 'evaluation_request_conflict' } });
    const current = await c.control({ requestId: 'start-1' }); if (!current.ok || !current.data.batchId) throw Error('Original start not queryable');
    expect(current.data.state).toBe('preparing');
    expect(await c.cancel({ batchId: current.data.batchId })).toMatchObject({ ok: true, data: { state: 'cancelling' } });
    release();
    expect(await first).toMatchObject({ ok: true, data: { batchId: current.data.batchId, state: 'finished', outcome: 'cancelled', executionIds: [] } });
    expect(await duplicate).toMatchObject({ ok: true, data: { batchId: current.data.batchId } });
    expect(preparations).toBe(1); expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
    expect(events.map(event => event.control.state)).toEqual(['preparing', 'cancelling', 'finished']);
    expect(JSON.stringify(events)).not.toContain('synthetic-main-worker-private-key');
  } finally { release?.(); expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
});

test('a confirmed idle Worker exit invalidates its previews without reading keys or replaying a start', async () => {
  const c = client(); let preparations = 0;
  try {
    const preview = await c.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview unavailable');
    const child = Reflect.get(c, 'child') as ChildProcessWithoutNullStreams;
    const exited = new Promise<void>(done => child.once('exit', () => done())); child.kill(); await exited;
    expect(await c.start({ previewId: preview.data.previewId, requestId: 'start-after-exit' }, async () => {
      preparations++; return ok({ settings, credentials: { agent: 'synthetic-main-worker-private-key', judge: null } });
    })).toMatchObject({ ok: false, error: { code: 'evaluation_preview_unknown' } });
    expect(preparations).toBe(0); expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
  } finally { expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
});

test('closing cannot wait forever for a Main credential preparation and its late result cannot start a Trial', async () => {
  const c = client(); let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(done => { release = done; }), preparing = new Promise<void>(done => { entered = done; });
  let started: ReturnType<Client['start']> | undefined, closing: ReturnType<Client['close']> | undefined;
  let timers: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>> | undefined;
  try {
    const preview = await c.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview unavailable');
    started = c.start({ previewId: preview.data.previewId, requestId: 'blocked-start' }, async () => {
      entered(); await blocked; return ok({ settings, credentials: { agent: 'synthetic-main-worker-private-key', judge: null } });
    });
    await preparing;
    const schedule = globalThis.setTimeout;
    const accelerated = new Proxy(schedule, { apply(target, receiver, args) {
      return Reflect.apply(target, receiver, [args[0], args[1] === 15_000 ? 25 : args[1], ...args.slice(2)]);
    } });
    timers = spyOn(globalThis, 'setTimeout').mockImplementation(accelerated);
    closing = c.close();
    const result = await Promise.race([closing, new Promise<null>(done => schedule(() => done(null), 250))]);
    expect(result).toMatchObject({ ok: true, data: { closed: false, stopped: true } });
    expect(await c.control({ requestId: 'blocked-start' })).toMatchObject({ ok: true, data: { state: 'cancelling', executionIds: [] } });
    release();
    expect(await started).toMatchObject({ ok: true, data: { state: 'finished', outcome: 'cancelled', executionIds: [] } });
    expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
  } finally {
    timers?.mockRestore(); release?.(); await started; await closing;
    expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
  }
});

test('current control rebinds an idle replacement Worker while original request queries keep their saved identity', async () => {
  const c = client(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(done => { release = done; }), preparing = new Promise<void>(done => { entered = done; });
  let next: ReturnType<Client['start']> | undefined;
  try {
    const preview = await c.preview(selection, settings); if (!preview.ok) throw Error('Synthetic preview unavailable');
    await c.start({ previewId: preview.data.previewId, requestId: 'original-failed-start' }, async () =>
      fail(appError('synthetic_prepare_failed', 'input', 'Synthetic key preparation failed.')));
    const original = await c.control({ requestId: 'original-failed-start' }); if (!original.ok) throw Error('Original control missing');
    expect(original.data).toMatchObject({ state: 'finished', outcome: 'failed', executionIds: [] });
    const child = Reflect.get(c, 'child') as ChildProcessWithoutNullStreams;
    const exited = new Promise<void>(done => child.once('exit', () => done())); child.kill(); await exited;
    const replacement = await c.preview(selection, settings); if (!replacement.ok) throw Error('Replacement preview unavailable');
    const current = await c.control(); if (!current.ok) throw Error('Current control unavailable');
    expect(current.data.sessionId).not.toBe(original.data.sessionId);
    expect(current.data).toMatchObject({ state: 'idle', requestId: null, batchId: null });
    expect(c.state).toEqual(current.data);
    expect(await c.control({ requestId: 'original-failed-start' })).toEqual(original);
    next = c.start({ previewId: replacement.data.previewId, requestId: 'replacement-start' }, async () => {
      entered(); await held; return ok({ settings, credentials: { agent: 'synthetic-private-key', judge: null } });
    });
    await preparing;
    expect(await c.control({ requestId: 'original-failed-start' })).toEqual(original);
    expect(c.state).toMatchObject({ sessionId: current.data.sessionId, requestId: 'replacement-start', state: 'preparing' });
    const batchId = c.state?.batchId; if (!batchId) throw Error('Replacement batch unavailable');
    await c.cancel({ batchId }); release();
    expect(await next).toMatchObject({ ok: true, data: { outcome: 'cancelled', executionIds: [] } });
    expect(existsSync(join(fixtureRepo, 'agent-eval/runs'))).toBe(false);
  } finally { release(); await next; expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
});

test('the fixed Worker reads and compares saved reports without Dataset configuration or an active batch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-client-read-')), c = new Client(repository, root), facts = JSON.stringify(comparisonFacts());
  const files: string[] = [];
  for (const executionId of ['read-left', 'read-right']) {
    const directory = join(root, 'agent-eval/runs/business', executionId); mkdirSync(directory, { recursive: true });
    const report = reportFixture(); report.executionId = executionId; report.trials[0]!.execution!.identity.executionId = executionId;
    const file = join(directory, 'report.json'); saveReport(file, report); files.push(file); writeFileSync(join(directory, 'snapshot.json'), facts);
  }
  const before = files.map(file => readFileSync(file, 'utf8'));
  try {
    const list = await c.listExecutions({ limit: 1 });
    expect(list).toMatchObject({ ok: true, data: { items: [{ executionId: 'read-left' }], page: { nextOffset: 1 } } });
    const result = await c.result({ executionId: 'read-left', trialId: 'trial-1', view: 'scores' });
    expect(result).toMatchObject({ ok: true, data: { executionId: 'read-left', scores: [{ metricId: 'task-result', value: 1 }] } });
    const compared = await c.compare({ left: 'read-left', right: 'read-right' });
    expect(compared).toMatchObject({ ok: true, data: { rows: [{ caseId: 'sample', before: 'PASS', after: 'PASS' }] } });
    expect(c.state).toBeNull(); expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
    expect(readdirSync(join(root, 'agent-eval/runs/business'))).toEqual(['read-left', 'read-right']);
  } finally { expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
}, 45_000);

test('a closed Main controller cannot create a new Worker through a read-only control query', async () => {
  const c = client();
  try {
    expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
    expect(await c.control()).toMatchObject({ ok: false, error: { code: 'evaluation_worker_unavailable' } });
    expect(c.state).toBeNull();
  } finally { expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
}, 45_000);

test('Main and the real fixed Worker expose registered Cases and original feedback without preparing models or running a Trial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-client-cases-')), c = new Client(repository, root);
  cpSync(fixtureDirectory, join(root, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  try {
    expect(Reflect.get(c, 'catalog')).toBeFunction();
    const listed = await c.catalog({ view: 'list', limit: 2 });
    expect(listed).toMatchObject({ ok: true, data: { view: 'list', page: { total: 3, nextOffset: 2 } } });
    const selected = await c.catalog({ view: 'case', datasetId: 'facility-test', caseId: 'test-fields', limit: 300 });
    if (!selected.ok || selected.data.view !== 'case') throw Error('Synthetic Case unavailable');
    expect(selected.data.gaps.some(gap => gap.reason === 'missing')).toBe(true);
    const target = { kind: 'case-quality' as const, datasetId: 'facility-test', caseId: 'test-fields', caseViewId: selected.data.caseViewId };
    const input = { target, operationId: 'synthetic-real-worker-feedback', reviewer: 'synthetic-reviewer', verdict: 'bad', note: 'Synthetic missing material.' };
    const saved = await c.addFeedback(input);
    expect(saved).toMatchObject({ ok: true, data: { operationId: input.operationId, record: { caseId: target.caseId, reviewer: input.reviewer } } });
    const queried = await c.feedback({ target: { kind: target.kind, datasetId: target.datasetId, caseId: target.caseId }, operationId: input.operationId });
    expect(queried).toMatchObject({ ok: true, data: { operation: { id: input.operationId, validity: 'current' }, formalAcceptance: 'pending' } });
    cpSync(join(fixtureRepo, 'data'), join(root, 'data'), { recursive: true });
    expect(await c.addFeedback({ ...input, operationId: 'synthetic-new-stale-view' })).toMatchObject({ ok: false });
    expect(await c.addFeedback(input)).toMatchObject({ ok: true, data: { operationId: input.operationId } });
    expect(c.state).toBeNull(); expect(readdirSync(join(root, 'agent-eval/runs'))).toEqual(['case-reviews']);
  } finally { expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
}, 45_000);

test('Main prepares a platform connection only for an explicit upload and the real Worker preserves target-bound receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-client-export-')), directory = join(root, 'agent-eval/runs/business/unit');
  mkdirSync(directory, { recursive: true }); const file = join(directory, 'report.json'); saveReport(file, reportFixture());
  const original = readFileSync(file, 'utf8'), c = new Client(repository, root);
  let projects = 0, sends = 0, preparations = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/projects')) {
      projects++; return Response.json({ data: [{ id: 'synthetic-main-project', name: 'Synthetic', organization: { id: 'org', name: 'Synthetic' }, metadata: {} }] });
    }
    if (!new URL(request.url).pathname.endsWith('/ingestion')) return new Response(null, { status: 404 });
    sends++; const body = await request.json() as { batch: Array<{ id: string }> };
    return Response.json({ successes: body.batch.map(event => ({ id: event.id, status: 201 })), errors: [] });
  } });
  const connection = { baseUrl: `http://127.0.0.1:${server.port}`, publicKey: 'synthetic-main-platform-public', secretKey: 'synthetic-main-platform-secret' };
  try {
    expect(Reflect.get(c, 'export')).toBeFunction();
    await c.result({ executionId: 'unit', view: 'summary' });
    expect(preparations).toBe(0); expect(projects).toBe(0); expect(sends).toBe(0);
    expect(await c.export({ executionId: 'unit', operationId: 'synthetic-platform-missing' }, () => {
      preparations++; return fail(appError('configuration_missing', 'input', 'Synthetic platform is not configured.'));
    })).toMatchObject({ ok: false });
    expect(projects).toBe(0); expect(sends).toBe(0);
    const input = { executionId: 'unit', operationId: 'synthetic-main-upload' };
    const prepare = () => { preparations++; return ok(connection); };
    const sent = await c.export(input, prepare);
    expect(sent).toMatchObject({ ok: true, data: { ...input, export: { status: 'complete', target: { projectId: 'synthetic-main-project' } } } });
    expect(await c.export(input, prepare)).toEqual(sent);
    expect(await c.export({ ...input, executionId: 'different-report' }, prepare)).toMatchObject({ ok: false });
    expect(preparations).toBe(2); expect(projects).toBe(1); expect(sends).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(original); expect(JSON.stringify(sent)).not.toContain(connection.secretKey);
    expect(c.state).toBeNull();
  } finally { expect(await c.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); await server.stop(true); }
}, 45_000);
