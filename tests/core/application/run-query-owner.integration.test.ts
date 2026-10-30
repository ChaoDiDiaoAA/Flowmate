import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, type Result } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { makeApplication } from '../../../packages/core/src/application.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { ContextService } from '../../../packages/core/src/context/service.ts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-run-query-owner-'));
  const store = need(openTestDatabase({ root, databaseFile: join(root, 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs') }));
  const at = '2026-10-28T00:00:00.000Z';
  const saved = await store.transaction(scope => {
    const session = need(scope.sessions.create({ nativeSessionId: 'query-owner-parent', title: 'Query parent', at }));
    const config = { version: 1 as const, name: 'Queries', revision: 1, requestedModel: { provider: 'fixture', model: 'unused' },
      resolvedModel: null, api: null, endpoint: null, sdk: { codingAgent: '1.4.0', ai: '1.4.0' },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 }, limits: { timeoutMs: 1000, stopGraceMs: 100 },
      native: { authSource: 'unknown' as const, modelsSelection: null }, agent: {
        policyVersion: 'p2-invoice-chat-v1' as const, nativeSessionId: session.nativeSessionId, systemPrompt: 'Fixture',
        thinkingLevel: 'off', resourcePolicy: 'none' as const, historyPolicy: 'memory-only' as const,
        maxContextBytes: 524288 as const, maxOutputBytes: 262144 as const, maxAssistantContentBytes: 524288 as const,
        maxModelCalls: 1 as const, sessionRetry: false as const } };
    const runId = need(scope.runs.createAgent({ sessionId: session.sessionId, goal: 'Before commit',
      scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] },
      input: { version: 1, goal: 'Before commit', text: 'No model invocation', messageTimestamp: 1 }, config, createdAt: at,
      cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false },
      usage: { version: 1, source: 'unknown', reason: 'not-requested', sdkValues: null, attempts: null,
        attemptsComplete: false, costSource: null, updatedAt: at } }));
    return { runId, sessionId: session.sessionId };
  });
  let modelCalls = 0;
  const runtime = new RuntimeService({ database: store, provider: {
    async prepare() { modelCalls++; throw Error('Read queries must not start a Provider.'); },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  }, log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
  const runs = {
    get: (id: number) => store.read(scope => scope.runs.get(id)),
    listBySession: (input: Parameters<typeof store.runs.listBySession>[0]) => store.read(scope => scope.runs.listBySession(input)),
    listSubagents: (input: Parameters<typeof store.runs.listSubagents>[0]) => store.read(scope => scope.runs.listSubagents(input)),
    querySubagent: (input: Parameters<typeof store.runs.querySubagent>[0]) => store.read(scope => scope.runs.querySubagent(input)),
  };
  const context = new ContextService({ store, materials: { inspectParsed() { throw Error('Readonly queries have no material admission.'); } } });
  const app = makeApplication(runtime, runs, async () => { await store.close(); return { stopped: true, closed: true, errors: [] }; },
    undefined, undefined, undefined, undefined, { documents: store.documents, jobs: store.jobs, candidates: store.candidates,
      events: store.businessEvents, contextService: context,
      contextRepository: { readResourceEvidence: input => store.read(scope => scope.context.readResourceEvidence(input)) },
      importInvoiceMaterial: async () => fail(appError('input_unavailable', 'input', 'No imports in query tests.')),
      importPreparedInvoiceMaterial: async () => fail(appError('input_unavailable', 'input', 'No imports in query tests.')),
      readDocumentPage: () => fail(appError('input_unavailable', 'input', 'No documents in query tests.')),
      listDocumentPages: () => fail(appError('input_unavailable', 'input', 'No documents in query tests.')),
      readDocumentOriginal: () => fail(appError('input_unavailable', 'input', 'No documents in query tests.')),
    });
  deferCleanup(() => app.close());
  store.runs.get = () => { throw Error('Expired root Run query.'); };
  return { store, app, ...saved, modelCalls: () => modelCalls };
}

test('Run queries wait for the real owner COMMIT and validate child identity after asynchronous parent reads', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const writing = f.store.transaction(async scope => {
    scope.db.query('UPDATE runs SET duration_ms=? WHERE id=?').run(42, f.runId);
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  let settled = 0;
  const reading = Promise.all([
    f.app.queryRun(f.runId), f.app.listSessionRuns({ sessionId: f.sessionId }),
    f.app.listSubagents({ parentRunId: f.runId, parentSessionId: f.sessionId }),
    f.app.querySubagent({ parentRunId: f.runId, parentSessionId: f.sessionId, childRunId: f.runId }),
  ].map(pending => pending.then(value => { settled++; return value; })));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(0);
    release.resolve(); await writing;
    const [run, sessionRuns, children, child] = await reading;
    expect(run).toMatchObject({ ok: true, data: { durationMs: 42 } });
    expect(sessionRuns).toMatchObject({ ok: true, data: { items: [{ runId: f.runId, durationMs: 42 }] } });
    expect(children).toMatchObject({ ok: true, data: { items: [], nextBeforeRunId: null } });
    expect(child).toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
    expect(await f.app.listSubagents({ parentRunId: f.runId, parentSessionId: f.sessionId + 1 }))
      .toMatchObject({ ok: false, error: { code: 'subagent_identity_conflict' } });
  } finally { release.resolve(); await writing; await reading; }
});

test('the formal Run query assembly returns a Result when its database owner has closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-run-query-closed-'));
  const app = need(await createApplication({ paths: { root, databaseFile: join(root, 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs') } }));
  deferCleanup(() => app.close());
  need(await app.close());
  expect(await app.queryRun(1)).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.listSessionRuns({ sessionId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.listSubagents({ parentRunId: 1, parentSessionId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.querySubagent({ parentRunId: 1, parentSessionId: 1, childRunId: 2 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.listContextSnapshots({ sessionId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.listContextRequests({ sessionId: 1, runId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.queryContextSnapshot({ sessionId: 1, runId: 1, snapshotId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.listActivity({ jobId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.listRunToolCalls({ runId: 1, sessionId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.queryRunToolCall({ runId: 1, sessionId: 1, toolCallId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await app.queryRunToolEvidence({ runId: 1, sessionId: 1, toolCallId: 1 })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
});

test('Context and resource evidence queries wait for the owner and ignore expired root repositories', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const expired = () => fail(appError('storage_read_failed', 'storage', 'Expired root Context repository.'));
  f.store.context.listContextSnapshots = expired; f.store.context.queryContextSnapshot = expired;
  f.store.context.listContextRequests = expired; f.store.context.readResourceEvidence = expired;
  const writing = f.store.transaction(async scope => { entered.resolve(); await release.promise;
    scope.db.query('UPDATE runs SET duration_ms=? WHERE id=?').run(77, f.runId); });
  await entered.promise;
  const owner = { sessionId: f.sessionId, runId: f.runId };
  let settled = 0;
  const reading = Promise.all([f.app.listContextSnapshots(owner), f.app.listContextRequests(owner),
    f.app.queryContextSnapshot({ ...owner, snapshotId: 999 }), f.app.queryRunResources(owner)]
    .map(pending => pending.then(value => { settled++; return value; })));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(0);
    release.resolve(); await writing;
    const [snapshots, requests, detail, resources] = await reading;
    expect(snapshots).toMatchObject({ ok: true, data: { ...owner, items: [], nextBeforeId: null } });
    expect(requests).toMatchObject({ ok: true, data: { items: [], collection: 'not-collected' } });
    expect(detail).toMatchObject({ ok: false, error: { code: 'context_snapshot_not_found' } });
    expect(resources).toMatchObject({ ok: true, data: { ...owner, frozen: null, evidence: null, gap: 'legacy-not-collected' } });
  } finally { release.resolve(); await writing; await reading; }
});

for (const query of ['snapshots', 'snapshot', 'requests'] as const)
test(`Context ${query} retains the original target and paging request while its owner is held`, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const owner = { sessionId: f.sessionId, runId: f.runId };
  const snapshots = { ...owner, beforeId: 100, limit: 1 };
  const snapshot = { ...owner, snapshotId: 999 };
  const requests = { ...owner, beforeRequestSequence: 100, limit: 1 };
  let settled = false;
  const pending = (query === 'snapshots' ? f.app.listContextSnapshots(snapshots)
    : query === 'snapshot' ? f.app.queryContextSnapshot(snapshot) : f.app.listContextRequests(requests))
    .then(result => { settled = true; return result; });
  snapshots.sessionId++; snapshots.runId++; snapshots.beforeId = 0; snapshots.limit = 0;
  snapshot.sessionId++; snapshot.runId++; snapshot.snapshotId = 0;
  requests.sessionId++; requests.runId++; requests.beforeRequestSequence = 0; requests.limit = 0;
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(f.modelCalls()).toBe(0);
    release.resolve(); await holding;
    const result = await pending;
    if (query === 'snapshot') expect(result).toMatchObject({ ok: false, error: { code: 'context_snapshot_not_found' } });
    else expect(result).toMatchObject({ ok: true, data: { ...owner, items: [],
      ...(query === 'snapshots' ? { nextBeforeId: null } : { collection: 'not-collected' }) } });
    expect(f.modelCalls()).toBe(0);
  } finally { release.resolve(); await holding; await pending; }
});
