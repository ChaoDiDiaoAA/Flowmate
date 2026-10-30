import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, normalizeAgentRunRequest, normalizeProviderRequest, normalizeSessionInputRequest, SessionCompactionRequestSchema } from '@flowmate/contracts';
import type { AgentRunEvent, ProviderConfig, Result } from '@flowmate/contracts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { openTestDatabase } from '../../support/database.ts';
import { createFixtureDependencies } from '../../support/pi-provider.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-owner-admission-'));
  const store = need(openTestDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs') }));
  const database: Pick<typeof store, 'read' | 'transaction'> = {
    read: operation => store.read(operation), transaction: operation => store.transaction(operation),
  };
  deferCleanup(() => store.close());
  const requests: unknown[] = [];
  const native = await createFixtureDependencies('none', event => { if (event.type === 'fixture_fetch') requests.push(event); });
  const agent = new PiAgentAdapter({ cwd: root, agentDir: join(root, 'agent'), ...native, runtimeApiKey: 'controlled-runtime-owner' });
  deferCleanup(() => agent.close());
  let sessions!: SessionService, providerCalls = 0;
  const runtime = new RuntimeService({ database, agent,
    isSessionManaging: id => sessions.isManaging(id), provider: {
      async prepare() { providerCalls++; throw Error('Provider should be denied by the owned Agent slot'); },
      async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: () => '2026-10-28T00:00:00.000Z', monotonicNow: () => performance.now() });
  deferCleanup(() => runtime.close());
  sessions = new SessionService(agent, () => runtime.state(), () => '2026-10-28T00:00:00.000Z', database,
    undefined, undefined, (id, intent, repository) => runtime.verifySessionMutation(id, intent, repository));
  const session = need(await sessions.create({ title: 'Runtime admission' }));
  const config: ProviderConfig = { version: 1, name: 'Runtime owner', revision: 1,
    modelRef: { provider: 'runtime-owner-fixture', model: 'deepseek-flash' }, native: { authPath: join(root, 'absent.json'), modelsPath: null },
    connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const request = need(normalizeAgentRunRequest({ sessionId: session.sessionId, text: 'One approved question', config }));
  const events: AgentRunEvent[] = [], finished = Promise.withResolvers<Extract<AgentRunEvent, { type: 'run_finished' }>>();
  const control = { onEvent(event: AgentRunEvent) { events.push(event); if (event.type === 'run_finished') finished.resolve(event); } };
  return { store, database, runtime, agent, session, request, config, events, finished, control, requests, providerCalls: () => providerCalls };
}

test('Runtime and Session input queries complete a real Run and close using only the database owner', async () => {
  const f = await fixture();
  const sessions = new SessionService(f.agent, () => f.runtime.state(), () => '2026-10-28T00:00:00.000Z', f.database);
  expect(await sessions.listInputs({ sessionId: f.session.sessionId, limit: 10 }))
    .toMatchObject({ ok: true, data: { items: [] } });
  const submission = need(normalizeSessionInputRequest({ ...f.request, mode: 'prompt', clientSequence: 1 }));
  const accepted = need(await f.runtime.start(f.request, f.control, submission));
  expect((await f.finished.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(await sessions.queryInput({ sessionId: f.session.sessionId, clientSequence: 1 }))
    .toMatchObject({ ok: true, data: { input: { inputId: accepted.inputId, runId: accepted.runId } } });
  expect(f.requests).toHaveLength(1);
  expect(await f.runtime.close()).toMatchObject({ stopped: true, closed: true });
});

test('Agent admission publishes and executes only after its actual owner COMMIT', async () => {
  const f = await fixture(), transaction = f.store.transaction;
  const entered = Promise.withResolvers<{ runs: number; inputs: number }>(), release = Promise.withResolvers<void>();
  f.store.transaction = operation => {
    f.store.transaction = transaction;
    return transaction(async scope => {
      const value = await operation(scope);
      entered.resolve({ runs: scope.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM runs').get()!.count,
        inputs: scope.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM session_inputs').get()!.count });
      await release.promise; return value;
    });
  };
  const starting = f.runtime.start(f.request, f.control);
  try {
    expect(await entered.promise).toEqual({ runs: 1, inputs: 1 });
    expect(f.runtime.state().active).toBeNull(); expect(f.events).toEqual([]); expect(f.requests).toHaveLength(0);
    release.resolve(); expect(await starting).toMatchObject({ ok: true });
    expect((await f.finished.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.requests).toHaveLength(1);
    expect(f.events.filter(event => event.type === 'run_progress' && event.phase === 'created')).toHaveLength(1);
  } finally { release.resolve(); await starting; }
});

test('a failed metadata COMMIT publishes no Run and starts no model', async () => {
  const f = await fixture();
  f.store.db.exec("CREATE TABLE owner_fault_parent(id INTEGER PRIMARY KEY); CREATE TABLE owner_fault_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES owner_fault_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER owner_admission_fault AFTER INSERT ON runs BEGIN INSERT INTO owner_fault_child VALUES(1,404); END;");
  expect(await f.runtime.start(f.request, f.control)).toMatchObject({ ok: false });
  expect(f.runtime.state().active).toBeNull(); expect(f.events).toEqual([]); expect(f.requests).toHaveLength(0);
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 0 });
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM session_inputs').get())).toEqual({ count: 0 });
});

test('Agent, Provider and manual compaction arbitrate their shared slot on the owner line', async () => {
  const f = await fixture(), expected = need(await f.store.read(scope => scope.memory.load(f.session.sessionId)))!.commit;
  const providerRequest = need(normalizeProviderRequest({ goal: 'Other provider', text: 'Wait for the slot', config: f.config }));
  const compactRequest = SessionCompactionRequestSchema.parse({ sessionId: f.session.sessionId,
    operationId: '00000000-0000-4000-8000-000000000004', expected, config: f.config });
  const transaction = f.store.transaction, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.store.transaction = operation => {
    f.store.transaction = transaction;
    return transaction(async scope => { entered.resolve(); await release.promise; return operation(scope); });
  };
  const starting = f.runtime.start(f.request, f.control);
  await entered.promise;
  let providerSettled = false, compactSettled = false;
  const provider = f.runtime.callProvider(providerRequest).then(result => { providerSettled = true; return result; });
  const compact = f.runtime.compactSession(compactRequest).then(result => { compactSettled = true; return result; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(providerSettled).toBe(false); expect(compactSettled).toBe(false); expect(f.requests).toHaveLength(0);
    release.resolve(); expect(await starting).toMatchObject({ ok: true });
    expect(await provider).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(await compact).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect((await f.finished.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.providerCalls()).toBe(0); expect(f.requests).toHaveLength(1);
  } finally { release.resolve(); await starting; await provider; await compact; }
});

test('an admitted Agent survives an owner response lost after COMMIT without another execution', async () => {
  const f = await fixture(), transaction = f.store.transaction;
  f.store.transaction = async operation => {
    f.store.transaction = transaction;
    await transaction(operation); throw Error('Controlled owner response loss after admission COMMIT');
  };
  const submission = need(normalizeSessionInputRequest({ ...f.request, mode: 'prompt', clientSequence: 1 }));
  const accepted = need(await f.runtime.start(f.request, f.control, submission));
  expect((await f.finished.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(await f.runtime.start(f.request, {}, submission)).toEqual({ ok: true, data: accepted });
  expect(f.events.filter(event => event.type === 'run_progress' && event.phase === 'created')).toHaveLength(1);
  expect(f.requests).toHaveLength(1);
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM runs').get())).toEqual({ count: 1 });
});

test('Agent execution and terminal writes use the current owner repositories', async () => {
  const f = await fixture();
  f.store.runs.start = () => fail(appError('storage_write_failed', 'storage', 'Expired root Run repository.'));
  f.store.runs.finish = () => fail(appError('storage_write_failed', 'storage', 'Expired root Run repository.'));
  const accepted = need(await f.runtime.start(f.request, f.control));
  expect((await f.finished.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(await f.store.read(scope => scope.runs.get(accepted.runId)))
    .toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.requests).toHaveLength(1);
});

test('Agent start remains created until the owner ahead of execution has committed', async () => {
  const f = await fixture(), prepare = f.agent.prepare.bind(f.agent);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held: Promise<void> | undefined;
  f.agent.prepare = async (...parameters) => {
    const result = await prepare(...parameters);
    held = f.store.transaction(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    return result;
  };
  const accepted = need(await f.runtime.start(f.request, f.control));
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.store.db.query('SELECT status FROM runs WHERE id=?').get(accepted.runId)).toEqual({ status: 'created' });
    expect(f.events.some(event => event.type === 'run_progress' && event.phase === 'running')).toBe(false);
    expect(f.requests).toHaveLength(0);
  } finally { release.resolve(); await held; }
  expect((await f.finished.promise).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.requests).toHaveLength(1);
});
