import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase, withNativeHistoryFaults } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { createFixtureDependencies } from '../../support/pi-provider.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import type { AgentRunEvent, ProviderConfig, Result } from '@flowmate/contracts';
import { ExtensionInstanceViewSchema, normalizeListSessionsRequest, normalizeSessionMessagesRequest, ok } from '@flowmate/contracts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-core-native-owner-'));
  const store = need(openTestDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') }));
  deferCleanup(() => store.close());
  const requests: unknown[] = [];
  const dependencies = await createFixtureDependencies('none', value => { if (value.type === 'fixture_fetch') requests.push(value); });
  const agent = new PiAgentAdapter({ cwd: root, agentDir: join(root, 'agent'), ...dependencies, runtimeApiKey: 'controlled-core-native-key' });
  deferCleanup(() => agent.close());
  let sessions!: SessionService;
  const runtime = new RuntimeService({ database: store,  agent,
    isSessionManaging: id => sessions.isManaging(id),
    provider: { async prepare() { throw Error('No direct Provider work'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: () => '2026-10-28T00:00:00.000Z', monotonicNow: () => performance.now() });
  deferCleanup(() => runtime.close());
  sessions = new SessionService(agent, () => runtime.state(),
    () => '2026-10-28T00:00:00.000Z', store,  undefined, undefined,
    (id, intent, repository) => runtime.verifySessionMutation(id, intent, repository));
  const config: ProviderConfig = { version: 1, name: 'Core native owner', revision: 1,
    modelRef: { provider: 'controlled-core-native', model: 'deepseek-flash' },
    native: { authPath: join(root, 'absent-auth.json'), modelsPath: null },
    connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  return { store, agent, runtime, sessions, config, requests };
}

test('the Core-installed native history writer waits for its database owner before confirming SDK preparation', async () => {
  const { store, agent, sessions, config } = await fixture();
  const session = need(await sessions.create({ title: 'Core native owner' }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const preparing = agent.prepare(session.nativeSessionId, config, { timeoutMs: 60000, stopGraceMs: 1000 }, new AbortController().signal)
    .then(result => { settled = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(agent.inspect(session.nativeSessionId).availability).toBe('busy');
    release.resolve(); await holding;
    expect(await preparing).toMatchObject({ ok: true });
    const saved = need(await store.read(scope => scope.sessions.loadHistoryForContext(session.sessionId)));
    expect(saved.history?.entries.map(entry => entry.type)).toEqual(['model_change', 'thinking_level_change']);
    expect(saved.commit?.entryCount).toBe(2);
  } finally { release.resolve(); await holding; await preparing; await agent.close(); await store.close(); }
});

test('two Core admissions waiting for one database cannot create two root Runs across different sessions', async () => {
  const f = await fixture();
  const a = need(await f.sessions.create({ title: 'First admission' })), b = need(await f.sessions.create({ title: 'Second admission' }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const terminal = Promise.withResolvers<Extract<AgentRunEvent, { type: 'run_finished' }>>();
  const control = { onEvent(event: AgentRunEvent) { if (event.type === 'run_finished') terminal.resolve(event); } };
  let settled = 0;
  const start = (sessionId: number) => f.runtime.start({ sessionId, text: 'Read this saved question', config: f.config }, control)
    .then(result => { settled++; return result; });
  const first = start(a.sessionId), second = start(b.sessionId);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(0); expect(f.requests).toHaveLength(0);
    release.resolve(); await holding;
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const denied = results.find(result => !result.ok); if (!denied || denied.ok) throw Error('Second admission was not refused');
    expect(['runtime_busy', 'session_busy', 'agent_session_busy']).toContain(denied.error.code);
    expect((await terminal.promise).result).toMatchObject({ ok: true, data: { status: 'completed', text: 'fixture response' } });
    expect(f.requests).toHaveLength(1);
    expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 1 });
  } finally { release.resolve(); await holding; await first; await second; await f.runtime.close(); await f.store.close(); }
});

test('closing Core while native restoration waits cannot admit a Run after the owner queue resumes', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Close during restore' }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const starting = f.runtime.start({ sessionId: session.sessionId, text: 'Must not run after close', config: f.config });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const closing = f.runtime.close();
    release.resolve(); await holding;
    expect(await closing).toMatchObject({ closed: true, stopped: true });
    expect(await starting).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(0);
    expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  } finally { release.resolve(); await holding; await starting; await f.store.close(); }
});

test('native history fault forwarding cannot turn an escaped SQL executor into a root-level write', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Expired fault scope' }));
  const baseline = need(f.store.memory.load(session.sessionId))!, database = withNativeHistoryFaults(f.store);
  const commit = await database.read(scope => scope.memory.commit);
  expect(() => commit({ sessionId: session.sessionId, expected: baseline.commit, header: baseline.history.header,
    appendEntries: [], leafId: baseline.history.leafId, unusable: false, contexts: [] })).toThrow();
  expect(need(f.store.memory.load(session.sessionId))!.commit).toEqual(baseline.commit);
});

test('Core queries the exact committed native result when the owner commit response is lost', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Lost owner response' }));
  const transaction = f.store.transaction; let writes = 0;
  f.store.transaction = async operation => {
    const result = await transaction(operation);
    if (++writes === 1) throw Error('Controlled owner response loss after COMMIT');
    return result;
  };
  expect(await f.agent.prepare(session.nativeSessionId, f.config, { timeoutMs: 60000, stopGraceMs: 1000 }, new AbortController().signal))
    .toMatchObject({ ok: true });
  const saved = need(await f.store.read(scope => scope.sessions.loadHistoryForContext(session.sessionId)));
  expect(saved.history?.entries.map(entry => entry.type)).toEqual(['model_change', 'thinking_level_change']);
  expect(saved.commit).toMatchObject({ commitRevision: 3, entryCount: 2 });
  expect(writes).toBe(2); expect(f.requests).toHaveLength(0);
});

test('all public Session reads wait for the owner and cannot expose an uncommitted title', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Committed title' }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async scope => {
    need(scope.sessions.rename({ sessionId: session.sessionId, title: 'New committed title', at: '2026-10-28T00:00:01.000Z' }));
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  let settled = 0;
  const get = Promise.resolve(f.sessions.get(session.sessionId)).then(result => { settled++; return result; });
  const reads = [
    () => f.sessions.list(need(normalizeListSessionsRequest({ limit: 10 }))),
    () => f.sessions.listMessages(need(normalizeSessionMessagesRequest({ sessionId: session.sessionId, limit: 10 }))),
    () => f.sessions.listHistory({ sessionId: session.sessionId }),
    () => f.sessions.querySessionHistoryEntry({ sessionId: session.sessionId, entryId: 'missing', expectedCommitRevision: 1 }),
    () => f.sessions.queryInput({ sessionId: session.sessionId, clientSequence: 1 }),
    () => f.sessions.listInputs({ sessionId: session.sessionId, limit: 10 }),
    () => f.sessions.queryExtensions({ sessionId: session.sessionId }),
  ].map(async read => { const result = await read(); settled++; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(0); expect(f.requests).toHaveLength(0);
    release.resolve(); await holding;
    expect(await get).toMatchObject({ ok: true, data: { title: 'New committed title' } });
    await Promise.all(reads); expect(settled).toBe(8); expect(f.requests).toHaveLength(0);
  } finally { release.resolve(); await holding; await get; await Promise.all(reads); }
});

test('public Session projection retains the committed title when the pending owner write rolls back', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Original title' }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async scope => {
    need(scope.sessions.rename({ sessionId: session.sessionId, title: 'Rolled back title', at: '2026-10-28T00:00:01.000Z' }));
    entered.resolve(); await release.promise; throw Error('Controlled rollback');
  }).catch(error => { if (!(error instanceof Error) || error.message !== 'Controlled rollback') throw error; });
  await entered.promise;
  let settled = false;
  const reading = Promise.resolve(f.sessions.get(session.sessionId)).then(result => { settled = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    release.resolve(); await holding;
    expect(await reading).toMatchObject({ ok: true, data: { title: 'Original title' } });
    expect(f.requests).toHaveLength(0);
  } finally { release.resolve(); await holding; await reading; }
});

test('public Session creation waits for the owner and survives another transaction rollback', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), inspect = Promise.withResolvers<void>();
  const inspected = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async scope => {
    entered.resolve(); await inspect.promise;
    inspected.resolve(scope.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM sessions').get()!.count);
    await release.promise; throw Error('Controlled creation rollback');
  }).catch(error => { if (!(error instanceof Error) || error.message !== 'Controlled creation rollback') throw error; });
  await entered.promise;
  const creating = f.sessions.create({ title: 'Independent creation' });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); inspect.resolve();
    expect(await inspected.promise).toBe(0);
    release.resolve(); await holding;
    const session = need(await creating);
    expect(await f.sessions.get(session.sessionId)).toMatchObject({ ok: true, data: { title: 'Independent creation' } });
    expect(f.requests).toHaveLength(0);
  } finally { inspect.resolve(); release.resolve(); await holding; await creating; }
});

test.each(['rename', 'status', 'delete', 'command', 'dispose', 'fork'] as const)
  ('public Session %s waits for a pending deletion rollback and uses the restored facts', async operation => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Keep this Session' }));
  if (operation === 'fork') {
    const saved = need(await f.store.read(scope => scope.memory.load(session.sessionId)))!;
    need(await f.store.transaction(scope => scope.memory.commit({ sessionId: session.sessionId, expected: saved.commit,
      header: saved.history.header, appendEntries: [{ type: 'message', id: 'fork-seed', parentId: null,
        timestamp: '2026-10-28T00:00:01.000Z', message: { role: 'user', content: 'Approved source', timestamp: 1 } }],
      leafId: 'fork-seed', unusable: false, contexts: [] })));
  }
  const expected = need(await f.store.read(scope => scope.memory.load(session.sessionId)))!.commit;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async scope => {
    need(scope.sessions.prepareDelete(session.sessionId, '2026-10-28T00:00:02.000Z'));
    expect(need(scope.sessions.delete(session.sessionId, '2026-10-28T00:00:02.000Z'))).toBe('permanent');
    entered.resolve(); await release.promise; throw Error('Controlled management rollback');
  }).catch(error => { if (!(error instanceof Error) || error.message !== 'Controlled management rollback') throw error; });
  await entered.promise;
  let settled = false;
  const executing = (async (): Promise<Result<unknown>> => {
    const sessionId = session.sessionId, expectedInstanceId = '00000000-0000-4000-8000-000000000001';
    switch (operation) {
      case 'rename': return f.sessions.rename({ sessionId, title: 'Renamed after rollback' });
      case 'status': return f.sessions.setStatus({ sessionId, expectedStatus: 'active', status: 'archived' });
      case 'delete': return f.sessions.deleteSession(sessionId);
      case 'command': return f.sessions.executeExtensionCommand({ sessionId, expectedInstanceId, name: 'invoice-assist', arguments: '' });
      case 'dispose': return f.sessions.disposeSessionExtensions({ sessionId, expectedInstanceId });
      case 'fork': return f.sessions.forkSession({ sourceSessionId: sessionId, expected, targetEntryId: 'fork-seed',
        title: 'Fork after rollback', clientOperationId: '00000000-0000-4000-8000-000000000002' });
    }
  })().then(result => { settled = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    release.resolve(); await holding;
    const result = await executing;
    if (operation === 'rename') expect(result).toMatchObject({ ok: true, data: { sessionId: session.sessionId, title: 'Renamed after rollback' } });
    else if (operation === 'status') expect(result).toMatchObject({ ok: true, data: { sessionId: session.sessionId, status: 'archived' } });
    else if (operation === 'delete') expect(result).toMatchObject({ ok: true, data: { deletedSessionId: session.sessionId, disposition: 'permanent' } });
    else if (operation === 'fork') expect(result).toMatchObject({ ok: true, data: { sourceSessionId: session.sessionId,
      session: { title: 'Fork after rollback' }, selectedEntryId: 'fork-seed' } });
    else expect(result).toMatchObject({ ok: false, error: { code: 'extension_not_loaded' } });
    expect(f.requests).toHaveLength(0);
  } finally { release.resolve(); await holding; await executing; }
});

test('a queued Session command rechecks Runtime closure before invoking the native command', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Closing command' }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let calls = 0;
  const execute = f.agent.executeExtensionCommand.bind(f.agent);
  f.agent.executeExtensionCommand = (...args) => { calls++; return execute(...args); };
  const command = f.sessions.executeExtensionCommand({ sessionId: session.sessionId,
    expectedInstanceId: '00000000-0000-4000-8000-000000000001', name: 'invoice-assist', arguments: '' });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const closing = f.runtime.close();
    release.resolve(); await holding;
    expect(await closing).toMatchObject({ stopped: true, closed: true });
    expect(await command).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
    expect(calls).toBe(0); expect(f.sessions.isManaging(session.sessionId)).toBe(false);
    expect(f.requests).toHaveLength(0);
  } finally { release.resolve(); await holding; await command; }
});

test('Session deletion commits its preparation before native cleanup can reenter the database owner', async () => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'Cleanup uses the owner' }));
  const release = f.agent.releaseSession.bind(f.agent);
  let observed: unknown;
  f.agent.releaseSession = async nativeSessionId => {
    observed = await f.store.read(scope => scope.sessions.get(session.sessionId));
    return release(nativeSessionId);
  };
  expect(await f.sessions.deleteSession(session.sessionId)).toMatchObject({ ok: true, data: { disposition: 'permanent' } });
  expect(observed).toMatchObject({ ok: true, data: { status: 'archived', deletePending: true } });
  expect(f.sessions.isManaging(session.sessionId)).toBe(false); expect(f.requests).toHaveLength(0);
});

test.each(['retry', 'late-confirmation', 'in-flight-confirmation'] as const)
  ('controlled native cleanup reserves one admission and releases confirmed completion: %s', async scenario => {
  const f = await fixture(), session = need(await f.sessions.create({ title: 'One cleanup admission' }));
  const instanceId = '00000000-0000-4000-8000-000000000003', at = '2026-10-28T00:00:00.000Z';
  let instance = ExtensionInstanceViewSchema.parse({ instanceId, ref: { id: 'invoice-assist', version: 'v1' },
    nativeSessionId: session.nativeSessionId, state: 'load_failed', admission: 'closed', startedAt: at,
    activatedAt: null, disposedAt: null, lastError: null, registeredTools: [], registeredCommands: [], hookEvents: [],
    cleanup: { shutdownRequired: false, shutdownAcknowledged: false, sdkSessionCreated: false, sdkDisposed: false, ownedCallbacksSettled: false },
    diagnostics: [] });
  f.agent.inspectExtensions = () => ok({ nativeSessionId: session.nativeSessionId, instances: [instance] });
  const release = Promise.withResolvers<void>(), confirmed = Promise.withResolvers<void>(), delivered = Promise.withResolvers<void>();
  let calls = 0;
  f.agent.disposeExtensions = async (nativeSessionId, expectedInstanceId) => {
    expect(nativeSessionId).toBe(session.nativeSessionId); expect(expectedInstanceId).toBe(instanceId);
    if (++calls > 1) {
      await release.promise;
      instance = ExtensionInstanceViewSchema.parse({ ...instance, state: 'disposed', disposedAt: at,
        cleanup: { ...instance.cleanup, ownedCallbacksSettled: true } });
      confirmed.resolve();
      if (scenario === 'in-flight-confirmation') await delivered.promise;
    }
    return ok({ nativeSessionId, instanceId, state: instance.state,
      report: { stopped: instance.state === 'disposed', closed: instance.state === 'disposed', errors: [] } });
  };
  const request = { sessionId: session.sessionId, expectedInstanceId: instanceId };
  expect(await f.sessions.disposeSessionExtensions(request)).toMatchObject({ ok: true, data: { report: { closed: false } } });
  expect(f.sessions.isManaging(session.sessionId)).toBe(true);
  if (scenario === 'late-confirmation') {
    instance = ExtensionInstanceViewSchema.parse({ ...instance, state: 'disposed', disposedAt: at,
      cleanup: { ...instance.cleanup, ownedCallbacksSettled: true } });
    expect(await f.sessions.disposeSessionExtensions(request)).toMatchObject({ ok: true, data: { report: { stopped: true, closed: true } } });
    expect(f.sessions.isManaging(session.sessionId)).toBe(false);
    expect(await f.sessions.rename({ sessionId: session.sessionId, title: 'Available after confirmed cleanup' }))
      .toMatchObject({ ok: true, data: { title: 'Available after confirmed cleanup' } });
    expect(calls).toBe(1); expect(f.requests).toHaveLength(0); return;
  }
  const first = f.sessions.disposeSessionExtensions(request), duplicate = f.sessions.disposeSessionExtensions(request);
  try {
    expect(await duplicate).toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(calls).toBe(2);
    if (scenario === 'in-flight-confirmation') {
      release.resolve(); await confirmed.promise;
      expect(await f.sessions.disposeSessionExtensions(request)).toMatchObject({ ok: true, data: { report: { closed: true } } });
      expect(f.sessions.isManaging(session.sessionId)).toBe(true);
      expect(await f.sessions.rename({ sessionId: session.sessionId, title: 'Too early' })).toMatchObject({ ok: false });
      delivered.resolve();
    }
    release.resolve(); expect(await first).toMatchObject({ ok: true, data: { state: 'disposed', report: { closed: true } } });
    expect(f.sessions.isManaging(session.sessionId)).toBe(false); expect(f.requests).toHaveLength(0);
    expect(await f.sessions.rename({ sessionId: session.sessionId, title: 'Available after cleanup' }))
      .toMatchObject({ ok: true, data: { title: 'Available after cleanup' } });
  } finally { release.resolve(); delivered.resolve(); await first; await duplicate; }
});
