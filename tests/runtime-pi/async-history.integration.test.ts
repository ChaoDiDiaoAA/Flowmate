import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase as openDatabase } from '../support/database.ts';
import { PiMemoryAdapter } from '../../packages/runtime-pi/src/memory/persistence.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { createFixtureDependencies } from '../support/pi-provider.ts';
import { ok, NativeAgentMessageSchema } from '@flowmate/contracts';
import type { NativeHistoryWrite, NativeSessionHistory, ProviderConfig, Result } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';

function required<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const stamp = '2026-10-28T00:00:00.000Z';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-async-native-history-'));
  const store = required(openDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') }));
  deferCleanup(() => store.close());
  const history: NativeSessionHistory = { storageVersion: 1, header: { type: 'session', version: 3,
    id: 'async-native-history', timestamp: stamp, cwd: root }, entries: [], leafId: null, unusable: false };
  const session = required(store.sessions.create({ nativeSessionId: history.header.id, title: 'Async history', at: stamp, nativeHistory: history }));
  const baseline = required(store.sessions.loadHistoryForContext(session.sessionId));
  if (!baseline.history || !baseline.commit) throw Error('Missing initial history');
  return { root, store, sessionId: session.sessionId, history: baseline.history, commit: baseline.commit, seed: baseline.seed };
}

function configuration(root: string): ProviderConfig {
  return { version: 1, name: 'Async history', revision: 1, modelRef: { provider: 'controlled-history', model: 'deepseek-flash' },
    native: { authPath: join(root, 'absent-auth.json'), modelsPath: null },
    connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
}

async function executionFixture(onWrite: (write: NativeHistoryWrite) => void = () => {}) {
  const f = fixture(), requests: unknown[] = [];
  const dependencies = await createFixtureDependencies('none', value => { if (value.type === 'fixture_fetch') requests.push(value); });
  const adapter = new PiAgentAdapter({ cwd: f.root, agentDir: join(f.root, 'agent'), ...dependencies, runtimeApiKey: 'controlled-history-key' });
  deferCleanup(() => adapter.close());
  required(adapter.restoreSession(f.history.header.id, f.history, f.seed, f.commit));
  required(adapter.watchSession(f.history.header.id, f.commit, f.seed, write => {
    onWrite(write);
    return f.store.transaction(scope => scope.memory.commit({ sessionId: f.sessionId, expected: write.expected,
      header: write.history.header, appendEntries: write.history.entries, leafId: write.history.leafId,
      unusable: write.history.unusable, contexts: write.contexts }));
  }));
  const prepared = required(await adapter.prepare(f.history.header.id, configuration(f.root),
    { timeoutMs: 60000, stopGraceMs: 1000 }, new AbortController().signal));
  const input = { goal: 'Read the saved invoice question', text: 'Explain the selected invoice.', messageTimestamp: Date.parse(stamp) };
  const runId = required(await f.store.transaction(scope => scope.runs.createAgent({ sessionId: f.sessionId,
    scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] }, config: prepared.snapshot,
    goal: input.goal, input: { version: 1, ...input }, createdAt: stamp,
    usage: { version: 1, source: 'unknown', reason: 'controlled', sdkValues: null, attempts: null,
      attemptsComplete: false, costSource: null, updatedAt: stamp },
    cleanup: { version: 1, stopped: true, stopReason: null, errors: [], lateObservationRequired: false } })));
  required(await f.store.transaction(scope => scope.runs.start(runId, prepared.snapshot, stamp)));
  return { ...f, adapter, prepared, input: { ...input, runId, sessionId: f.sessionId, verifyModelUse: () => ok(undefined) }, requests };
}

test('Pi does not send a model request or finish while its user history is waiting for SQLite', async () => {
  const writing = Promise.withResolvers<void>(); let executing = false;
  const f = await executionFixture(() => { if (executing) writing.resolve(); });
  executing = true;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const observations: unknown[] = []; let settled = false;
  const execution = f.prepared.execute(f.input, new AbortController().signal, event => observations.push(event))
    .then(result => { settled = true; return result; });
  try {
    await Promise.race([writing.promise, execution.then(outcome => { throw Error(`Execution settled before submitting user history: ${JSON.stringify(outcome.error)}`); })]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(f.requests).toHaveLength(0);
    expect(observations).not.toContainEqual(expect.objectContaining({ type: 'display_message', message: expect.objectContaining({ persistence: 'saved' }) }));
    release.resolve(); await holding;
    expect(await execution).toMatchObject({ error: null, text: 'fixture response', stopped: true });
    expect(f.requests).toHaveLength(1);
    const stored = required(await f.store.read(scope => scope.sessions.loadHistoryForContext(f.sessionId)));
    expect(stored.history?.entries.filter(entry => entry.type === 'message').map(entry => NativeAgentMessageSchema.parse(entry.message).role)).toEqual(['system', 'user', 'assistant']);
    expect(stored.seed.origins.filter(origin => origin.originRunId === f.input.runId)).toHaveLength(2);
  } finally { release.resolve(); await holding; await execution; await f.adapter.close(); await f.store.close(); }
});

test('Pi blocks the real SDK model request when asynchronous SQLite history is rejected', async () => {
  const f = await executionFixture();
  await f.store.transaction(scope => scope.db.exec("CREATE TRIGGER reject_sdk_history BEFORE INSERT ON session_native_entries BEGIN SELECT RAISE(ABORT,'controlled SDK history refusal'); END"));
  try {
    const outcome = await f.prepared.execute(f.input, new AbortController().signal, () => {});
    expect(outcome).toMatchObject({ error: { code: 'storage_write_failed' }, stopped: true });
    expect(f.requests).toHaveLength(0);
    expect(f.adapter.inspect(f.history.header.id).availability).toBe('unusable');
    const stored = required(await f.store.read(scope => scope.sessions.loadHistory(f.sessionId)));
    expect(stored?.entries.filter(entry => entry.type === 'message')).toHaveLength(0);
  } finally { await f.adapter.close(); await f.store.close(); }
});

test.each([false, true])('Pi holds final delivery and ownership until assistant history commits (cancel=%s)', async cancel => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let holding: Promise<void> | undefined, executing = false;
  const f = await executionFixture(write => {
    const last = write.history.entries.at(-1);
    if (executing && !holding && last?.type === 'message' && NativeAgentMessageSchema.parse(last.message).role === 'assistant') {
      holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
    }
  });
  executing = true;
  const controller = new AbortController(), observations: unknown[] = []; let settled = false;
  const execution = f.prepared.execute(f.input, controller.signal, event => observations.push(event))
    .then(result => { settled = true; return result; });
  try {
    await Promise.race([entered.promise, execution.then(outcome => { throw Error(`Execution settled before assistant save: ${JSON.stringify(outcome.error)}`); })]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(observations).not.toContainEqual(expect.objectContaining({ type: 'display_message',
      message: expect.objectContaining({ role: 'assistant', persistence: 'saved' }) }));
    expect(await f.adapter.releaseSession(f.history.header.id)).toMatchObject({ closed: false, stopped: false });
    if (cancel) controller.abort();
    release.resolve(); await holding;
    expect(await execution).toMatchObject({ error: cancel ? { code: 'agent_cancelled' } : null, stopped: true });
    const stored = required(await f.store.read(scope => scope.sessions.loadHistory(f.sessionId)));
    expect(stored?.unusable).toBe(cancel);
    expect(stored?.entries.filter(entry => entry.type === 'message' && NativeAgentMessageSchema.parse(entry.message).role === 'assistant')).toHaveLength(1);
  } finally { release.resolve(); await holding; await execution; await f.adapter.close(); await f.store.close(); }
});

test('Pi preparation waits for queued SQLite metadata before confirming a usable session', async () => {
  const f = fixture(), dependencies = await createFixtureDependencies('none');
  const adapter = new PiAgentAdapter({ cwd: f.root, agentDir: join(f.root, 'agent'), ...dependencies,
    runtimeApiKey: 'controlled-history-key' });
  deferCleanup(() => adapter.close());
  required(adapter.restoreSession(f.history.header.id, f.history, f.seed, f.commit));
  const writing = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  required(adapter.watchSession(f.history.header.id, f.commit, f.seed, write => {
    writing.resolve();
    return f.store.transaction(scope => scope.memory.commit({ sessionId: f.sessionId, expected: write.expected,
      header: write.history.header, appendEntries: write.history.entries, leafId: write.history.leafId,
      unusable: write.history.unusable, contexts: write.contexts }));
  }));
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const preparing = adapter.prepare(f.history.header.id, { version: 1, name: 'Async history', revision: 1,
    modelRef: { provider: 'controlled-history', model: 'deepseek-flash' },
    native: { authPath: join(f.root, 'absent-auth.json'), modelsPath: null },
    connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } },
  { timeoutMs: 60000, stopGraceMs: 1000 }, new AbortController().signal).then(result => { settled = true; return result; });
  try {
    await writing.promise; await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(adapter.inspect(f.history.header.id).availability).toBe('busy');
    release.resolve(); await holding;
    expect(await preparing).toMatchObject({ ok: true });
    expect(adapter.inspect(f.history.header.id).availability).toBe('ready');
    const saved = required(await f.store.read(scope => scope.sessions.loadHistoryForContext(f.sessionId)));
    expect(saved.history?.entries.map(entry => entry.type)).toEqual(['model_change', 'thinking_level_change']);
  } finally { release.resolve(); await holding; await preparing; await adapter.close(); await f.store.close(); }
});

test('Pi history acknowledgement waits for real queued SQLite commit and freezes its input before the wait', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const memory = new PiMemoryAdapter(f.history, f.commit, f.seed, write => f.store.transaction(scope => scope.memory.commit({
    sessionId: f.sessionId, expected: write.expected, header: write.history.header, appendEntries: write.history.entries,
    leafId: write.history.leafId, unusable: write.history.unusable, contexts: write.contexts,
  })));
  const entry = { type: 'model_change' as const, id: 'async-entry-1', parentId: null, timestamp: stamp,
    provider: 'controlled-provider', modelId: 'controlled-model' };
  const next = { ...f.history, entries: [entry], leafId: entry.id };
  const holding = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    let acknowledged = false;
    const saving = Promise.resolve(memory.save(next, [])).then(value => { acknowledged = true; return value; });
    entry.provider = 'changed-after-submit';
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(acknowledged).toBe(false);
    expect(memory.commit).toEqual(f.commit); expect(memory.lastSavedHistory).toEqual(f.history);
    release.resolve(); await holding;
    expect(await saving).toEqual({ ok: true, data: { commitRevision: f.commit.commitRevision + 1, entryCount: 1, leafId: entry.id } });
    expect(memory.lastSavedHistory.entries[0]).toMatchObject({ provider: 'controlled-provider' });
    expect(await f.store.read(scope => scope.sessions.loadHistory(f.sessionId))).toMatchObject({ ok: true,
      data: { entries: [{ id: entry.id, provider: 'controlled-provider' }] } });
  } finally { release.resolve(); await holding; await f.store.close(); }
});

test('Pi asynchronous history failure preserves the confirmed prefix and never retries a rejected append', async () => {
  const f = fixture(); let writes = 0;
  await f.store.transaction(scope => scope.db.exec("CREATE TRIGGER reject_async_history BEFORE INSERT ON session_native_entries BEGIN SELECT RAISE(ABORT,'controlled history refusal'); END"));
  const memory = new PiMemoryAdapter(f.history, f.commit, f.seed, write => {
    writes++;
    return f.store.transaction(scope => scope.memory.commit({ sessionId: f.sessionId, expected: write.expected,
      header: write.history.header, appendEntries: write.history.entries, leafId: write.history.leafId,
      unusable: write.history.unusable, contexts: write.contexts }));
  });
  const entry = { type: 'model_change' as const, id: 'async-entry-failed', parentId: null, timestamp: stamp,
    provider: 'controlled-provider', modelId: 'controlled-model' };
  try {
    expect(await memory.save({ ...f.history, entries: [entry], leafId: entry.id }, [])).toMatchObject({ ok: false });
    expect(memory.commit).toEqual(f.commit); expect(memory.lastSavedHistory).toEqual(f.history);
    expect(await memory.save({ ...f.history, entries: [entry], leafId: entry.id }, [])).toMatchObject({ ok: false });
    expect(writes).toBe(1);
    expect(await f.store.read(scope => scope.sessions.loadHistory(f.sessionId))).toEqual({ ok: true, data: f.history });
  } finally { await f.store.close(); }
});
