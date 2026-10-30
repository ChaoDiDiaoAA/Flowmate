import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { NativeOutcome, ProviderObservation, ProviderRequest, Result } from '@flowmate/contracts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { PiProviderAdapter } from '../../../packages/runtime-pi/src/provider.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openTestDatabase } from '../../support/database.ts';
import { createFixtureDependencies } from '../../support/pi-provider.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(monotonicNow = () => performance.now()) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-owner-'));
  const store = need(openTestDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') }));
  const http: unknown[] = [];
  const dependencies = await createFixtureDependencies('none', value => { if (value.type === 'fixture_fetch') http.push(value); });
  const provider = new PiProviderAdapter({ ...dependencies, runtimeApiKey: 'controlled-runtime-owner-key' });
  const agent = new PiAgentAdapter({ cwd: root, agentDir: join(root, 'agent'), ...dependencies, runtimeApiKey: 'controlled-runtime-owner-key' });
  let sessions!: SessionService;
  const runtime = new RuntimeService({ database: store,  provider, agent,
    isSessionManaging: id => sessions.isManaging(id),
    log: { write() {}, async close() {} }, now: () => '2026-10-28T00:00:00.000Z', monotonicNow });
  sessions = new SessionService(agent, () => runtime.state(), () => '2026-10-28T00:00:00.000Z', store,
    undefined, undefined, (id, intent, repository) => runtime.verifySessionMutation(id, intent, repository));
  deferCleanup(() => runtime.close());
  const request: ProviderRequest = { goal: 'Original goal', text: 'Original text', timeoutMs: 10000, stopGraceMs: 1000,
    config: { version: 1, name: 'Runtime owner fixture', revision: 1,
      modelRef: { provider: 'controlled-runtime-owner', model: 'deepseek-flash' },
      native: { authPath: join(root, 'absent-auth.json'), modelsPath: null },
      connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } } };
  return { store, runtime, sessions, agent, provider, request, http };
}

async function hold(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const completion = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  return { release: release.resolve, completion };
}

test('Provider admission waits for its owner and snapshots the request before queueing', async () => {
  const f = await fixture(), blocker = await hold(f), observations: ProviderObservation[] = [];
  let settled = false;
  const pending = f.runtime.callProvider(f.request, { onObservation: event => { observations.push(event); } })
    .then(result => { settled = true; return result; });
  f.request.goal = 'Changed goal'; f.request.text = 'Changed text'; f.request.config.name = 'Changed config';
  try {
    await tick();
    expect(settled).toBe(false); expect(observations).toHaveLength(0); expect(f.http).toHaveLength(0);
    expect(f.runtime.state().active).toBeNull();
    blocker.release(); await blocker.completion;
    const outcome = need(await pending);
    expect(outcome).toMatchObject({ status: 'completed', text: 'fixture response' });
    const saved = need(await f.store.read(scope => scope.runs.get(outcome.runId)));
    expect(saved).toMatchObject({ input: { goal: 'Original goal', text: 'Original text' }, config: { name: 'Runtime owner fixture' } });
    expect(observations.filter(event => event.type === 'run_created')).toHaveLength(1);
    expect(f.http).toHaveLength(1);
  } finally { blocker.release(); await blocker.completion; await pending; await f.runtime.close(); }
});

test('a queued Provider retains the original abort signal without dispatching model work', async () => {
  const f = await fixture(), blocker = await hold(f), controller = new AbortController();
  const control = { signal: controller.signal };
  const pending = f.runtime.callProvider(f.request, control);
  control.signal = new AbortController().signal;
  controller.abort();
  try {
    await tick(); expect(f.runtime.state().active).toBeNull(); expect(f.http).toHaveLength(0);
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
    expect(f.http).toHaveLength(0);
  } finally { blocker.release(); await blocker.completion; await pending; await f.runtime.close(); }
});

test.each(['continue', 'close'] as const)('Provider activation waits for the actual owner COMMIT: %s', async action => {
  const f = await fixture(), transaction = f.store.transaction, observations: ProviderObservation[] = [];
  const entered = Promise.withResolvers<unknown>(), release = Promise.withResolvers<void>();
  f.store.transaction = operation => {
    f.store.transaction = transaction;
    return transaction(async scope => {
      const value = await operation(scope);
      entered.resolve(scope.db.query('SELECT COUNT(*) AS count FROM runs').get());
      await release.promise; return value;
    });
  };
  const pending = f.runtime.callProvider(f.request, { onObservation: event => { observations.push(event); } });
  let closing: ReturnType<typeof f.runtime.close> | undefined;
  try {
    expect(await entered.promise).toEqual({ count: 1 });
    expect(f.runtime.state().active).toBeNull(); expect(observations).toHaveLength(0); expect(f.http).toHaveLength(0);
    if (action === 'close') closing = f.runtime.close();
    release.resolve();
    expect(await pending).toMatchObject({ ok: true, data: action === 'close'
      ? { status: 'failed', stopped: true, error: { code: 'runtime_shutdown' } } : { status: 'completed', text: 'fixture response' } });
    if (closing) expect(await closing).toMatchObject({ stopped: true, closed: true });
    expect(observations.filter(event => event.type === 'run_created')).toHaveLength(1);
    expect(f.http).toHaveLength(action === 'close' ? 0 : 1);
  } finally { release.resolve(); await pending; await closing; await f.runtime.close(); }
});

test('a failed Provider metadata COMMIT leaves no Run, active slot, observation or model call', async () => {
  const f = await fixture(), observations: ProviderObservation[] = [];
  await f.store.transaction(scope => scope.db.exec('CREATE TABLE provider_owner_parent(id INTEGER PRIMARY KEY); '
    + 'CREATE TABLE provider_owner_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES provider_owner_parent(id) DEFERRABLE INITIALLY DEFERRED); '
    + 'CREATE TRIGGER provider_owner_commit_fault AFTER INSERT ON runs BEGIN INSERT INTO provider_owner_child VALUES(1,404); END;'));
  expect(await f.runtime.callProvider(f.request, { onObservation: event => { observations.push(event); } }))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(f.runtime.state().active).toBeNull(); expect(observations).toHaveLength(0); expect(f.http).toHaveLength(0);
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
});

test('a Provider admitted before a lost owner response retains its one committed lifecycle', async () => {
  const f = await fixture(), transaction = f.store.transaction, observations: ProviderObservation[] = [];
  f.store.transaction = async operation => {
    f.store.transaction = transaction;
    await transaction(operation); throw Error('Controlled Provider admission response loss');
  };
  expect(await f.runtime.callProvider(f.request, { onObservation: event => { observations.push(event); } }))
    .toMatchObject({ ok: true, data: { status: 'completed', text: 'fixture response' } });
  expect(observations.filter(event => event.type === 'run_created')).toHaveLength(1); expect(f.http).toHaveLength(1);
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 1 });
});

test('manual compaction queues duplicate lookup and retains the accepted request snapshot', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Queued manual compaction' }));
  const expected = need(await f.store.read(scope => scope.sessions.loadHistoryForContext(session.sessionId))).commit!;
  const request = { sessionId: session.sessionId, operationId: randomUUID(), expected: { ...expected }, config: structuredClone(f.request.config) };
  const original = structuredClone(request), preparation = Promise.withResolvers<void>();
  const prepare = f.agent.prepare.bind(f.agent);
  let prepares = 0, settled = 0, observedConfig: unknown;
  f.agent.prepare = async (...args) => { prepares++; observedConfig = args[1]; expect(f.store.db.inTransaction).toBe(false); await preparation.promise; return prepare(...args); };
  const blocker = await hold(f);
  const first = f.runtime.compactSession(request).then(result => { settled++; return result; });
  const second = f.runtime.compactSession(structuredClone(original)).then(result => { settled++; return result; });
  request.operationId = randomUUID(); request.config.name = 'Changed queued compaction'; request.expected.commitRevision++;
  try {
    await tick(); expect(settled).toBe(0); expect(prepares).toBe(0); expect(f.runtime.state().active).toBeNull();
    blocker.release(); await blocker.completion;
    const accepted = { ok: true as const, data: { sessionId: session.sessionId, operationId: original.operationId } };
    expect(await first).toEqual(accepted); expect(await second).toEqual(accepted);
    await tick(); expect(prepares).toBe(1); expect(observedConfig).toMatchObject({ name: 'Runtime owner fixture' });
    expect(f.runtime.state().active).toMatchObject({ kind: 'compaction', operationId: original.operationId });
    expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
    expect(f.http).toHaveLength(0);
  } finally { blocker.release(); preparation.resolve(); await blocker.completion; await first; await second; await f.runtime.close(); }
});

test('manual compaction rechecks the latest session eligibility after its owner becomes available', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Archive before manual admission' }));
  const expected = need(await f.store.read(scope => scope.sessions.loadHistoryForContext(session.sessionId))).commit!;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const blocker = f.store.transaction(async scope => {
    entered.resolve(); await release.promise;
    scope.db.query("UPDATE sessions SET status = 'archived' WHERE id = ?").run(session.sessionId);
  });
  await entered.promise;
  let settled = false;
  const pending = f.runtime.compactSession({ sessionId: session.sessionId, operationId: randomUUID(), expected, config: f.request.config })
    .then(result => { settled = true; return result; });
  try {
    await tick(); expect(settled).toBe(false); expect(f.runtime.state().active).toBeNull();
    release.resolve(); await blocker;
    expect(await pending).toMatchObject({ ok: false, error: { code: 'session_archived' } });
    expect(f.http).toHaveLength(0); expect(f.runtime.state().active).toBeNull();
  } finally { release.resolve(); await blocker; await pending; await f.runtime.close(); }
});

test('close waits for queued Provider admission and prevents a Run from appearing after close returns', async () => {
  const f = await fixture(), blocker = await hold(f), observations: ProviderObservation[] = [];
  const pending = f.runtime.callProvider(f.request, { onObservation: event => { observations.push(event); } });
  let closed = false;
  const closing = f.runtime.close().then(report => { closed = true; return report; });
  try {
    await tick(); expect(closed).toBe(false); expect(f.http).toHaveLength(0);
    blocker.release(); await blocker.completion;
    expect(await closing).toMatchObject({ stopped: true, closed: true });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(observations).toHaveLength(0); expect(f.http).toHaveLength(0);
    expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  } finally { blocker.release(); await blocker.completion; await pending; await closing; }
});

function nativeOutcome(): NativeOutcome {
  return { text: 'Controlled response', partial: false, stopReason: 'stop', responseId: null, responseModel: null,
    error: null, stopped: true, cleanupErrors: [],
    usage: { version: 1, source: 'sdk', reason: null, attempts: 1, attemptsComplete: true, costSource: null,
      updatedAt: '2026-10-28T00:00:01.000Z', sdkValues: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0,
        totalTokens: 5, costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null, costTotal: null } },
    tokens: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: null, usageComplete: false } };
}

async function controlledProvider(monotonicNow?: () => number) {
  const f = await fixture(monotonicNow), entered = Promise.withResolvers<void>(), native = Promise.withResolvers<NativeOutcome>(),
    stopped = Promise.withResolvers<void>();
  const prepared = need(await f.provider.prepare(f.request.config, f.request, new AbortController().signal));
  f.provider.prepare = async () => ({ ok: true, data: { snapshot: prepared.snapshot, execute(_input, signal) {
    expect(f.store.db.inTransaction).toBe(false); signal.addEventListener('abort', () => stopped.resolve(), { once: true });
    entered.resolve(); return native.promise;
  } } });
  return { ...f, entered, native, stopped };
}

test.each(['cancel', 'deadline', 'close'] as const)('Provider dispatch rechecks %s after its queued start gains the owner', async action => {
  let elapsed = 0;
  const f = await fixture(() => elapsed), preparing = Promise.withResolvers<void>(), preparation = Promise.withResolvers<void>();
  const prepare = f.provider.prepare.bind(f.provider), controller = new AbortController();
  f.provider.prepare = async (...args) => { const value = await prepare(...args); preparing.resolve(); await preparation.promise; return value; };
  let settled = false, closing: ReturnType<typeof f.runtime.close> | undefined;
  const pending = f.runtime.callProvider(f.request, { signal: controller.signal }).then(value => { settled = true; return value; });
  await preparing.promise;
  const blocker = await hold(f);
  try {
    preparation.resolve(); await tick();
    expect(settled).toBe(false); expect(f.http).toHaveLength(0);
    if (action === 'cancel') controller.abort();
    else if (action === 'deadline') elapsed = 10_001;
    else closing = f.runtime.close();
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ ok: true, data: { status: action === 'cancel' ? 'cancelled' : 'failed', stopped: true,
      error: { code: action === 'cancel' ? 'provider_cancelled' : action === 'deadline' ? 'provider_timeout' : 'runtime_shutdown' } } });
    expect(f.http).toHaveLength(0);
  } finally { preparation.resolve(); blocker.release(); await blocker.completion; await pending; await closing; await f.runtime.close(); }
});

test.each(['cancel', 'deadline', 'close'] as const)('Provider terminal commit rechecks %s when the owner is released', async action => {
  let elapsed = 0;
  const f = await controlledProvider(() => elapsed), controller = new AbortController(), observations: ProviderObservation[] = [];
  let settled = false, closing: ReturnType<typeof f.runtime.close> | undefined;
  const pending = f.runtime.callProvider(f.request, { signal: controller.signal, onObservation: event => observations.push(event) })
    .then(value => { settled = true; return value; });
  await f.entered.promise;
  const blocker = await hold(f);
  try {
    f.native.resolve(nativeOutcome()); await tick();
    expect(settled).toBe(false); expect(observations.filter(event => event.type === 'stopped')).toHaveLength(0);
    if (action === 'cancel') controller.abort();
    else if (action === 'deadline') elapsed = 10_001;
    else closing = f.runtime.close();
    blocker.release(); await blocker.completion;
    const outcome = need(await pending), code = action === 'cancel' ? 'provider_cancelled' : action === 'deadline' ? 'provider_timeout' : 'runtime_shutdown';
    expect(outcome).toMatchObject({ status: action === 'cancel' ? 'cancelled' : 'failed', stopped: true, error: { code } });
    expect(need(await f.store.read(scope => scope.runs.get(outcome.runId)))).toMatchObject({ status: outcome.status,
      error: { code }, tokens: { totalTokens: 5 }, cleanup: { stopReason: action === 'cancel' ? 'user' : action === 'deadline' ? 'timeout' : 'shutdown' } });
  } finally { f.native.resolve(nativeOutcome()); blocker.release(); await blocker.completion; await pending; await closing; await f.runtime.close(); }
});

test('close waits for a late Provider usage commit queued after its initial owner barrier', async () => {
  const f = await controlledProvider(), controller = new AbortController();
  f.request.stopGraceMs = 100;
  const pending = f.runtime.callProvider(f.request, { signal: controller.signal });
  await f.entered.promise; controller.abort();
  const outcome = need(await pending);
  expect(outcome).toMatchObject({ status: 'failed', stopped: false });
  const providerClosing = Promise.withResolvers<void>(), providerClosed = Promise.withResolvers<void>();
  f.provider.close = async () => { providerClosing.resolve(); await providerClosed.promise; return { stopped: true, closed: true, errors: [] }; };
  let closed = false;
  const closing = f.runtime.close().then(value => { closed = true; return value; });
  await providerClosing.promise;
  const blocker = await hold(f);
  try {
    f.native.resolve(nativeOutcome()); await tick(); providerClosed.resolve(); await tick();
    expect(closed).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await closing).toMatchObject({ stopped: true, closed: true });
    expect(need(await f.store.read(scope => scope.runs.get(outcome.runId)))).toMatchObject({ status: 'failed',
      error: { code: 'provider_cancelled' }, tokens: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      cleanup: { stopped: false, lateObservationRequired: true } });
  } finally { f.native.resolve(nativeOutcome()); providerClosed.resolve(); blocker.release(); await blocker.completion; await closing; }
});

test('Provider usage that arrives while the terminal write is queued is saved after that terminal commits', async () => {
  const f = await controlledProvider(), controller = new AbortController();
  f.request.stopGraceMs = 100;
  let settled = false;
  const pending = f.runtime.callProvider(f.request, { signal: controller.signal }).then(value => { settled = true; return value; });
  await f.entered.promise;
  const blocker = await hold(f);
  try {
    controller.abort(); await new Promise(resolve => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    f.native.resolve(nativeOutcome()); await tick();
    blocker.release(); await blocker.completion;
    const outcome = need(await pending);
    expect(outcome).toMatchObject({ status: 'failed', stopped: false });
    expect(await f.runtime.close()).toMatchObject({ stopped: true, closed: true });
    expect(need(await f.store.read(scope => scope.runs.get(outcome.runId)))).toMatchObject({ tokens: { totalTokens: 5 },
      cleanup: { stopped: false, lateObservationRequired: true } });
  } finally { f.native.resolve(nativeOutcome()); blocker.release(); await blocker.completion; await pending; await f.runtime.close(); }
});

test('public Provider cancellation aborts immediately and waits for the owner cancellation commit', async () => {
  const f = await controlledProvider();
  const pending = f.runtime.callProvider(f.request);
  await f.entered.promise;
  const runId = f.runtime.state().active!.runId!, blocker = await hold(f);
  let cancelled = false;
  const cancellation = Promise.resolve(f.runtime.cancel(runId)).then(value => { cancelled = true; return value; });
  try {
    await f.stopped.promise; await tick();
    expect(cancelled).toBe(false); expect(f.runtime.state().blocked).toBe(false);
    f.native.resolve(nativeOutcome()); blocker.release(); await blocker.completion;
    expect(await cancellation).toEqual({ ok: true, data: { runId, accepted: true } });
    expect(await pending).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
    expect(need(await f.store.read(scope => scope.runs.get(runId))).cancelRequestedAt).toBe('2026-10-28T00:00:00.000Z');
  } finally { f.native.resolve(nativeOutcome()); blocker.release(); await blocker.completion; await cancellation; await pending; await f.runtime.close(); }
});

test('public Provider cancellation queues terminal and missing Run lookups behind the owner', async () => {
  const f = await controlledProvider(), pending = f.runtime.callProvider(f.request);
  await f.entered.promise; f.native.resolve(nativeOutcome());
  const outcome = need(await pending), blocker = await hold(f);
  let settled = 0;
  const existing = Promise.resolve(f.runtime.cancel(outcome.runId)).then(value => { settled++; return value; });
  const missing = Promise.resolve(f.runtime.cancel(999)).then(value => { settled++; return value; });
  try {
    await tick(); expect(settled).toBe(0);
    blocker.release(); await blocker.completion;
    expect(await existing).toEqual({ ok: true, data: { runId: outcome.runId, accepted: false } });
    expect(await missing).toMatchObject({ ok: false, error: { code: 'run_not_found' } });
  } finally { blocker.release(); await blocker.completion; await existing; await missing; await f.runtime.close(); }
});

test('close leaves the database open when Provider native work has not finalized within the close grace', async () => {
  const f = await controlledProvider(), controller = new AbortController();
  f.request.stopGraceMs = 100;
  const pending = f.runtime.callProvider(f.request, { signal: controller.signal });
  await f.entered.promise; controller.abort();
  const outcome = need(await pending);
  try {
    expect(await f.runtime.close()).toMatchObject({ stopped: true, closed: false,
      errors: [{ code: 'runtime_finalization_pending' }] });
    expect(need(await f.store.read(scope => scope.runs.get(outcome.runId)))).toMatchObject({ tokens: { totalTokens: null } });
    f.native.resolve(nativeOutcome());
    expect(await f.runtime.close()).toMatchObject({ stopped: true, closed: true });
    expect(need(await f.store.read(scope => scope.runs.get(outcome.runId)))).toMatchObject({ tokens: { totalTokens: 5 } });
  } finally { f.native.resolve(nativeOutcome()); await f.runtime.close(); }
});

test('close waits until a late Provider usage write actually commits', async () => {
  const f = await controlledProvider(), controller = new AbortController();
  f.request.stopGraceMs = 100;
  const pending = f.runtime.callProvider(f.request, { signal: controller.signal });
  await f.entered.promise; controller.abort();
  const outcome = need(await pending), transaction = f.store.transaction;
  const usageWriting = Promise.withResolvers<void>(), releaseCommit = Promise.withResolvers<void>(),
    providerClosing = Promise.withResolvers<void>(), providerClosed = Promise.withResolvers<void>();
  f.store.transaction = operation => transaction(async scope => {
    let lateUsage = false;
    const supplement = scope.runs.supplementUsage;
    scope.runs.supplementUsage = (...args) => { lateUsage = true; return supplement(...args); };
    const value = await operation(scope);
    if (lateUsage) { usageWriting.resolve(); await releaseCommit.promise; }
    return value;
  });
  f.provider.close = async () => { providerClosing.resolve(); await providerClosed.promise; return { stopped: true, closed: true, errors: [] }; };
  let closed = false;
  const closing = f.runtime.close().then(value => { closed = true; return value; });
  try {
    await providerClosing.promise; f.native.resolve(nativeOutcome()); await usageWriting.promise;
    providerClosed.resolve(); await tick();
    expect(f.store.db.inTransaction).toBe(true); expect(closed).toBe(false);
    releaseCommit.resolve();
    expect(await closing).toMatchObject({ stopped: true, closed: true });
    expect(need(await f.store.read(scope => scope.runs.get(outcome.runId)))).toMatchObject({ status: 'failed',
      error: { code: 'provider_cancelled' }, tokens: { totalTokens: 5 }, cleanup: { stopped: false } });
  } finally { f.native.resolve(nativeOutcome()); releaseCommit.resolve(); providerClosed.resolve(); await closing; }
});
