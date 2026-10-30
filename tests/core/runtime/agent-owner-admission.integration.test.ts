import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, normalizeSessionInputRequest, normalizeProviderRequest } from '@flowmate/contracts';
import type { AgentPort, AgentRunEvent, ProviderConfig } from '@flowmate/contracts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import type { RuntimeDependencies } from '../../../packages/core/src/runtime/service.ts';
import { createAgentHistoryFixture } from '../application/agent-history-fixture.ts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-28T00:00:00.000Z';
const config: ProviderConfig = { version: 1, name: 'owner-fixture', revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' }, native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 } };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-agent-owner-'));
  const opened = openTestDatabase({ root, databaseFile: join(root, 'data', 'test.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  if (!opened.ok) throw Error(opened.error.code);
  const database = opened.data, history = createAgentHistoryFixture(root, () => at);
  const created = database.sessions.create({ nativeSessionId: 'owner-native', title: 'Owner admission', at,
    nativeHistory: history.create('owner-native') });
  if (!created.ok) throw Error(created.error.code);
  let prepares = 0;
  const agent: AgentPort = { createSession: () => { throw Error('unused'); }, exportSession: history.exportSession,
    restoreSessionLeaf: history.restoreSessionLeaf, watchSession: history.watchSession, inspect: () => ({ availability: 'ready' }),
    prepare: async () => { prepares++; return fail(appError('fixture_prepare_failed', 'runtime', 'Controlled failure.')); },
    releaseSession: async () => ({ stopped: true, closed: true, errors: [] }),
    close: async () => ({ stopped: true, closed: true, errors: [] }) };
  const dependencies: RuntimeDependencies = { database,  agent,
    provider: { prepare: async () => { throw Error('unused'); }, close: async () => ({ stopped: true, closed: true, errors: [] }) },
    log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() };
  const runtime = new RuntimeService(dependencies);
  deferCleanup(() => runtime.close());
  return { database, dependencies, runtime, sessionId: created.data.sessionId, prepares: () => prepares };
}

test('a disconnected foreground client cannot admit an Agent after waiting for the original owner', async () => {
  const f = fixture(), controller = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const admission = f.runtime.start({ sessionId: f.sessionId, text: 'Do not run after disconnect.', config }, { signal: controller.signal });
  controller.abort('shutdown'); release.resolve(); await held;
  expect(await admission).toMatchObject({ ok: false, error: { code: 'runtime_shutdown' } });
  expect(f.prepares()).toBe(0);
  expect(await f.database.read(store => store.db.query('SELECT id FROM runs').all())).toEqual([]);
});

test('an already disconnected Provider client cannot create a Run or an execution observation', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort('shutdown');
  const request = normalizeProviderRequest({ goal: 'Do not execute.', text: 'Disconnected original request.', config });
  if (!request.ok) throw Error(request.error.code);
  let observations = 0;
  expect(await f.runtime.callProvider(request.data, { signal: controller.signal, onObservation: () => { observations++; } }))
    .toMatchObject({ ok: false, error: { code: 'runtime_shutdown' } });
  expect(observations).toBe(0);
  expect(await f.database.read(store => store.db.query('SELECT id FROM runs').all())).toEqual([]);
});

test('Agent admission waits for the owner before reading Settings or a Session archived by the held transaction', async () => {
  const { database, dependencies, runtime, sessionId, prepares } = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = database.transaction(async store => {
    store.db.query("UPDATE sessions SET status='archived' WHERE id=?").run(sessionId);
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  let settingsReads = 0;
  dependencies.runtimeDefaults = () => { settingsReads++; return fail(appError('fixture_settings_failed', 'input', 'Settings must wait.')); };
  let settled = false;
  const admission = runtime.start({ sessionId, text: 'Wait for owner', config }).then(result => { settled = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(settingsReads).toBe(0);
  } finally { release.resolve(); await held; }
  expect(await admission).toMatchObject({ ok: false, error: { code: 'session_archived' } });
  expect(prepares()).toBe(0);
  expect(await database.read(store => store.db.query('SELECT id FROM runs').all())).toEqual([]);
});

test('Agent admission freezes the request and desktop identity before waiting for the owner', async () => {
  const { database, runtime, sessionId } = fixture();
  const request = { sessionId, text: 'Original request', config: structuredClone(config), budget: { maxModelCalls: 2 } };
  const normalized = normalizeSessionInputRequest({ ...request, mode: 'prompt', clientSequence: 1 });
  if (!normalized.ok) throw Error(normalized.error.code);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const finished = Promise.withResolvers<AgentRunEvent>();
  const control = { desktopRequestIdentity: 'desktop-original', onEvent: (event: AgentRunEvent) => {
    if (event.type === 'run_finished') finished.resolve(event);
  } };
  const admission = runtime.start(request, control, normalized.data);
  request.text = 'Changed while waiting'; request.budget.maxModelCalls = 4; control.desktopRequestIdentity = 'desktop-changed';
  release.resolve(); await held;
  const accepted = await admission;
  expect(accepted).toMatchObject({ ok: true });
  if (!accepted.ok) return;
  const input = await database.read(store => store.sessionInputs.get(accepted.data.inputId!));
  expect(input).toMatchObject({ ok: true, data: { content: { text: 'Original request', desktopRequestIdentity: 'desktop-original',
    originalBudgetOverrides: { budget: { maxModelCalls: 2 } } } } });
  await finished.promise;
});

test('Agent admission rechecks dedicated Research identity after native restoration before creating a Chat Run', async () => {
  const { database, dependencies, runtime, sessionId, prepares } = fixture();
  let installed = false, injected = false;
  const watch = dependencies.agent!.watchSession!;
  dependencies.agent!.watchSession = (...parameters) => { const result = watch(...parameters); installed = true; return result; };
  dependencies.database = { transaction: operation => database.transaction(operation),
    read: async operation => {
      const result = await database.read(operation);
      if (installed && !injected) {
        injected = true;
        expect(await database.transaction(store => store.research.create({ sessionId, title: 'New dedicated Research',
          sourcePolicy: { web: false, domains: [], documentIds: [], artifactIds: [] }, at }))).toMatchObject({ ok: true });
      }
      return result;
    } };
  expect(await runtime.start({ sessionId, text: 'Plain Chat request', config }))
    .toMatchObject({ ok: false, error: { code: 'research_intent_required' } });
  expect(prepares()).toBe(0);
  expect(await database.read(store => store.db.query('SELECT id FROM runs').all())).toEqual([]);
});
