import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager, type AgentSession, type AgentSessionEvent, type CompactionResult } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok, RUNTIME_CONFIG } from '@flowmate/contracts';

describe('P10 readonly adapter compaction inspection', () => {
  it('cold inspection does not prepare/restore or write and preserves unknown model capacity', async () => {
    const f = await fixture();
    const bundle = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    const cold = new PiAgentAdapter({ cwd: bundle.history!.header.cwd });
    const before = f.store.db.query('SELECT * FROM session_native_history').all();
    const view = cold.inspectSessionCompaction({ history: bundle.history!, seed: bundle.seed, commit: bundle.commit! });
    expect(view).toMatchObject({ ok: true, data: { operation: null, lastSaved: null,
      capacity: { source: 'message-estimate', contextWindow: null, thresholdTokens: null, fitsEstimate: null } } });
    expect(f.store.db.query('SELECT * FROM session_native_history').all()).toEqual(before);
    expect(cold.inspect(f.row.nativeSessionId)).toEqual({ availability: 'missing' });
    await cold.close();
  });
  it('invalid windows cannot qualify and derived summary estimate does not reuse old usage', async () => {
    const f = await fixture(); await f.session.compact();
    const bundle = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    const view = need(f.adapter.inspectSessionCompaction({ history: bundle.history!, seed: bundle.seed, commit: bundle.commit! }));
    expect(view.lastSaved).toMatchObject({ entryId: f.appended[0], originSessionId: f.row.sessionId });
    expect(view.capacity).toMatchObject({ source: 'sdk-post-compaction-estimate', contextWindow: 64000, fitsEstimate: true });
    expect(view.capacity.tokens).toBeGreaterThan(15);
    f.session.model!.contextWindow = 0;
    const invalid = need(f.adapter.inspectSessionCompaction({ history: bundle.history!, seed: bundle.seed, commit: bundle.commit! }));
    expect(invalid.capacity).toMatchObject({ contextWindow: null, thresholdTokens: null, fitsEstimate: null });
  });
  it('fixed SDK skips other-model overflow, aborted callbacks and stale pre-compaction usage', async () => {
    const f = await fixture(); f.session.setAutoCompactionEnabled(true);
    const check = Reflect.get(f.session, '_checkCompaction');
    if (typeof check !== 'function') throw new Error('Missing fixed SDK check');
    const observed: AssistantMessage = { ...reply('Old overflow', Date.now(), 'error'), model: 'previous-model',
      errorMessage: 'maximum context length exceeded', usage: { ...usage, input: 65000, totalTokens: 65005 } };
    expect(await check.call(f.session, observed)).toBe(false);
    expect(await check.call(f.session, { ...observed, model: 'offline', stopReason: 'aborted' })).toBe(false);
    expect(f.calls).toHaveLength(0); expect(f.appended).toHaveLength(0);
    await f.session.compact();
    const before = need(f.store.memory.load(f.row.sessionId))!.commit;
    expect(f.session.getContextUsage()).toMatchObject({ tokens: null, percent: null });
    expect(await check.call(f.session, { ...observed, model: 'offline', timestamp: 2 })).toBe(false);
    for (const stopReason of ['stop', 'error'] as const)
      expect(await check.call(f.session, { ...reply('Post-boundary zero usage', Date.now() + 1, stopReason),
        usage: { ...usage, input: 0, output: 0, totalTokens: 0 } })).toBe(false);
    expect(f.calls).toHaveLength(1); expect(f.appended).toHaveLength(1);
    expect(need(f.store.memory.load(f.row.sessionId))!.commit).toEqual(before);
    // Fixed SDK excludes other-model overflow, but direct nonzero usage still participates in threshold.
    const other = await fixture(); other.session.setAutoCompactionEnabled(true);
    await check.call(other.session, { ...observed, stopReason: 'stop' });
    expect(other.calls).toHaveLength(1); expect(other.appended).toHaveLength(1);
    expect(other.events).toContainEqual({ type: 'compaction_start', reason: 'threshold' });
  });
});
import type { NativeSessionHistory, Result, CompactionObservation } from '@flowmate/contracts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { ensureNativeSession } from '../../packages/core/src/sessions/service.ts';
import { openTestDatabase } from '../support/database.ts';
import { deferCleanup, mkdtempSync, createHttpProvider } from '../support/resources.ts';
import { installNativeCompactionBridge, type NativeSummaryScope } from '../../packages/runtime-pi/src/memory/compaction.ts';

const at = '2026-10-05T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (text: string, timestamp = 2, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'p10-native',
  model: 'offline', timestamp, stopReason, usage,
});
async function fixture(kind: 'long' | 'empty' | 'split' = 'long', product = false, transport: 'native' | 'http' = 'native') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p10-native-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs') };
  const store = need(openTestDatabase(paths));
  const payloads: unknown[] = [];
  const server = transport === 'http' ? await createHttpProvider(async request => {
    payloads.push(await request.json());
    const chunk = (delta: unknown, reason: string | null) => 'data: ' + JSON.stringify({ id: 'controlled-summary',
      model: 'offline', choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'same native summary' }, null)
      + chunk({}, 'stop') + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'summary-request' } });
  }) : null;
  if (server) deferCleanup(() => server.stop(true));
  const manager = SessionManager.inMemory(root);
  manager.appendModelChange('p10-native', 'offline'); manager.appendThinkingLevelChange('off');
  if (kind === 'long') for (let turn = 0; turn < 4; turn++) {
    manager.appendMessage({ role: 'user', content: `Invoice turn ${turn} ` + 'x'.repeat(45000), timestamp: turn * 2 + 1 });
    manager.appendMessage(reply(`Original answer ${turn}`, turn * 2 + 2));
  }
  if (kind === 'split') {
    manager.appendMessage({ role: 'user', content: 'earlier invoice ' + 'x'.repeat(90000), timestamp: 1 });
    manager.appendMessage(reply('earlier answer'));
    manager.appendMessage({ role: 'user', content: 'one large invoice turn ' + 'y'.repeat(90000), timestamp: 3 });
    manager.appendMessage(reply('retained end ' + 'z'.repeat(100000), 4));
  }
  const history: NativeSessionHistory = { storageVersion: 1, header: manager.getHeader()!,
    entries: manager.getEntries().map(entry => ({ ...entry })), leafId: manager.getLeafId(), unusable: false };
  const row = need(store.sessions.create({ nativeSessionId: history.header.id, title: 'Native compaction', at, nativeHistory: history }));
  let session!: AgentSession;
  const adapter = new PiAgentAdapter({ cwd: root, agentDir: root, credentials: new InMemoryCredentialStore(),
    runtimeApiKey: 'synthetic-native-compaction', sessionSetup: value => { session = value; } });
  need(ensureNativeSession(store.sessions, adapter, row, store.memory));
  const config = { version: 1 as const, name: 'Native fixture', revision: 1,
    modelRef: { provider: 'p10-native', model: 'offline' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { baseUrl: server ? `http://127.0.0.1:${server.port}/v1` : 'http://127.0.0.1:1/v1', api: 'openai-completions' as const, contextWindow: 64000, maxTokens: 16384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  need(await adapter.prepare(row.nativeSessionId, config, { timeoutMs: 5000, stopGraceMs: 100 }, new AbortController().signal,
    product ? { compactionPolicy: RUNTIME_CONFIG.compaction, runtimeBudget: { maxModelCalls: 2, maxToolCalls: 0, toolTimeoutMs: 10000 } } : undefined));
  const calls: Parameters<AgentSession['agent']['streamFunction']>[1][] = [];
  let response: AssistantMessage = reply('same native summary');
  // This fixture replaces transport, not the SDK compact/preparation/append path.
  if (transport === 'native') session.agent.streamFunction = (_model, context) => {
    calls.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (response.stopReason === 'error' || response.stopReason === 'aborted')
        stream.push({ type: 'error', reason: response.stopReason, error: structuredClone(response) });
      else if (response.stopReason !== 'pending') stream.push({ type: 'done', reason: response.stopReason, message: structuredClone(response) });
      else throw new Error('Controlled summary cannot be pending.');
    });
    return stream;
  };
  const scopes: NativeSummaryScope[] = [], generated: CompactionResult[] = [], appended: string[] = [], events: AgentSessionEvent[] = [];
  let denyGenerated = false;
  const hook = {
    async withSummary<T>(scope: NativeSummaryScope, run: () => Promise<T>): Promise<T> { scopes.push(scope); return run(); },
    onGenerated(value: CompactionResult) {
      generated.push(structuredClone(value));
      if (denyGenerated) throw appError('session_scope_revoked', 'session', 'Revoked before saving.');
    },
    onAppend(id: string) {
      appended.push(id);
      const saved = need(store.sessions.loadHistoryForContext(row.sessionId));
      expect(saved.commit!.leafId).toBe(id);
      expect(saved.history!.entries.at(-1)?.id).toBe(id);
    },
    afterAuto: () => ok(undefined),
    onEvent(value: AgentSessionEvent) { events.push(value); },
  };
  const bridge = product ? { dispose() {} } : need(installNativeCompactionBridge(session, hook));
  deferCleanup(async () => { bridge.dispose(); await adapter.close(); });
  return { store, row, adapter, session, bridge, hook, scopes, generated, appended, events, calls, payloads,
    denyGenerated: () => { denyGenerated = true; }, response: (value: AssistantMessage) => { response = value; } };
}

describe('P10 fixed native compaction bridge and real SQLite commit', () => {
  it.each(['no-work', 'expired', 'small-window', 'unknown-window'] as const)('public manual %s sends no summary HTTP and does not invent a save', async kind => {
    const f = await fixture(kind === 'no-work' ? 'empty' : 'long', true, 'http');
    if (kind === 'small-window' || kind === 'unknown-window') f.session.model!.contextWindow = kind === 'small-window' ? RUNTIME_CONFIG.compaction.reserveTokens : 0;
    const before = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    const result = await f.adapter.compactSession(f.row.nativeSessionId, { sessionId: f.row.sessionId, operationId: crypto.randomUUID(),
      signal: new AbortController().signal, maxModelCalls: 2, remainingMs: () => kind === 'expired' ? 0 : 5000,
      verifyUse: () => ok(undefined), observe: () => {} });
    expect(result.observation).toMatchObject({ generated: false, saved: null, stopped: true, nativeOutcome: 'failed',
      error: { code: kind === 'expired' ? 'compaction_timeout' : kind === 'no-work' ? 'compaction_not_needed' : 'compaction_capacity_exceeded' } });
    expect(f.payloads).toHaveLength(0);
    expect(need(f.store.sessions.loadHistoryForContext(f.row.sessionId)).commit).toEqual(before.commit);
  });
  it.each(['cas-conflict', 'lost-receipt'] as const)('uses the existing exact native transaction contract: %s', async kind => {
    const f = await fixture('long', true, 'http');
    const originalCommit = f.store.memory.commit.bind(f.store.memory);
    let writes = 0;
    f.store.memory.commit = input => {
      writes++;
      if (kind === 'cas-conflict') f.store.db.query('UPDATE session_native_history SET commit_revision=commit_revision+1 WHERE session_id=?').run(f.row.sessionId);
      const saved = originalCommit(input);
      return saved.ok && kind === 'lost-receipt' ? fail(appError('storage_write_failed', 'storage', 'Controlled lost receipt.', true)) : saved;
    };
    const outcome = await f.adapter.compactSession(f.row.nativeSessionId, { sessionId: f.row.sessionId,
      operationId: crypto.randomUUID(), signal: new AbortController().signal, maxModelCalls: 2,
      remainingMs: () => 5000, verifyUse: () => ok(undefined), observe: () => {} });
    expect(writes).toBe(1); expect(f.payloads).toHaveLength(1);
    expect(outcome.observation.generated).toBe(true);
    expect(outcome.observation.saved !== null).toBe(kind === 'lost-receipt');
    expect(outcome.observation.mayContinue).toBe(kind === 'lost-receipt');
    expect(outcome.observation.nativeOutcome).toBe(kind === 'lost-receipt' ? 'succeeded' : 'failed');
    expect(f.store.db.query("SELECT COUNT(*) AS n FROM session_native_entries WHERE json_extract(entry_json,'$.type')='compaction'").get())
      .toEqual({ n: kind === 'lost-receipt' ? 1 : 0 });
  });
  it('refuses a revision-exhausted checkpoint before its first summary HTTP', async () => {
    const f = await fixture('long', true, 'http');
    f.store.db.query('UPDATE session_native_history SET commit_revision=? WHERE session_id=?').run(Number.MAX_SAFE_INTEGER, f.row.sessionId);
    need(ensureNativeSession(f.store.sessions, f.adapter, need(f.store.sessions.get(f.row.sessionId)), f.store.memory));
    const outcome = await f.adapter.compactSession(f.row.nativeSessionId, { sessionId: f.row.sessionId,
      operationId: crypto.randomUUID(), signal: new AbortController().signal, maxModelCalls: 2,
      remainingMs: () => 5000, verifyUse: () => ok(undefined), observe: () => {} });
    expect(outcome.observation).toMatchObject({ generated: false, saved: null, mayContinue: false, error: { code: 'storage_write_failed' } });
    expect(f.payloads).toHaveLength(0);
  });
  it.each(['long', 'split'] as const)('public native summary transport keeps summary out of Input and answer: %s', async kind => {
    const f = await fixture(kind, true, 'http');
    const beforeInputs = f.store.db.query('SELECT * FROM session_inputs').all();
    const beforeRuns = f.store.db.query('SELECT * FROM runs').all();
    const outcome = await f.adapter.compactSession(f.row.nativeSessionId, { sessionId: f.row.sessionId,
      operationId: crypto.randomUUID(), signal: new AbortController().signal, maxModelCalls: 2,
      remainingMs: () => 5000, verifyUse: () => ok(undefined), observe: () => {} });
    expect(outcome.observation).toMatchObject({ generated: true, nativeOutcome: 'succeeded', stopped: true, mayContinue: true });
    expect(f.payloads).toHaveLength(kind === 'split' ? 2 : 1);
    expect(outcome.observation.usage.attempts).toBe(kind === 'split' ? 2 : 1);
    expect(outcome.observation.tokens.totalTokens).toBe(kind === 'split' ? 30 : 15);
    expect(outcome.observation.tokens.cost).toBeNull();
    expect(f.store.db.query('SELECT * FROM session_inputs').all()).toEqual(beforeInputs);
    expect(f.store.db.query('SELECT * FROM runs').all()).toEqual(beforeRuns);
    expect(f.store.db.query('SELECT * FROM context_snapshots').all()).toEqual([]);
    expect(f.store.db.query('SELECT * FROM tool_calls').all()).toEqual([]);
  });
  it('split-budget-reserved-before-first-send', async () => {
    const f = await fixture('split', true, 'http');
    const outcome = await f.adapter.compactSession(f.row.nativeSessionId, { sessionId: f.row.sessionId,
      operationId: crypto.randomUUID(), signal: new AbortController().signal, maxModelCalls: 1,
      remainingMs: () => 5000, verifyUse: () => ok(undefined), observe: () => {} });
    expect(outcome.observation).toMatchObject({ generated: false, saved: null, nativeOutcome: 'failed', error: { code: 'agent_model_call_budget' } });
    expect(f.payloads).toHaveLength(0);
  });
  it.each(['saved', 'sql-failed'] as const)('manual port keeps generation, native completion and saving separate: %s', async kind => {
    const f = await fixture('long', true);
    const before = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    if (kind === 'sql-failed') f.store.db.exec("CREATE TRIGGER reject_port_compaction BEFORE INSERT ON session_native_entries WHEN json_extract(NEW.entry_json,'$.type')='compaction' BEGIN SELECT RAISE(ABORT,'port SQL rejection'); END");
    const observations: CompactionObservation[] = [];
    const outcome = await f.adapter.compactSession(f.row.nativeSessionId, { sessionId: f.row.sessionId,
      operationId: crypto.randomUUID(), signal: new AbortController().signal, maxModelCalls: 2,
      remainingMs: () => 5000, verifyUse: () => ok(undefined), observe: value => { observations.push(value); } });
    expect(outcome.stopped).toBe(true);
    expect(outcome.observation).toMatchObject({ generated: true, stopped: true, phase: 'ended',
      nativeOutcome: kind === 'saved' ? 'succeeded' : 'failed', mayContinue: kind === 'saved' });
    const bundle = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    if (kind === 'saved') {
      expect(outcome.observation.saved).toEqual(bundle.commit);
      expect(bundle.history!.entries.at(-1)?.id ?? null).toBe(outcome.observation.entryId);
      expect(outcome.observation.capacity.source).toBe('sdk-post-compaction-estimate');
      expect(observations.some(value => value.generated && value.saved === null)).toBe(true);
    } else {
      expect(outcome.observation.saved).toBeNull();
      expect(outcome.observation.error?.code).toBe('storage_write_failed');
      expect(bundle.history!.entries).toEqual(before.history!.entries);
      expect(bundle.commit!.leafId).toBe(before.commit!.leafId);
    }
  });
  it('native-manual-no-work-and-result-identity', async () => {
    const f = await fixture();
    const before = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    const result = await f.session.compact();
    expect(f.scopes).toHaveLength(1); expect(f.scopes[0]!.reason).toBe('manual');
    expect(f.generated).toHaveLength(1); expect(result).not.toHaveProperty('id');
    expect(f.appended).toHaveLength(1);
    const after = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    const entry = after.history!.entries.at(-1)!;
    expect(entry).toMatchObject({ type: 'compaction', id: f.appended[0], parentId: before.commit!.leafId,
      firstKeptEntryId: result.firstKeptEntryId, summary: result.summary, fromHook: false });
    expect(after.commit).toEqual({ commitRevision: before.commit!.commitRevision + 1,
      entryCount: before.commit!.entryCount + 1, leafId: entry.id });
    expect(f.store.db.query('SELECT run_id FROM session_native_entries WHERE entry_id=?').get(entry.id)).toEqual({ run_id: null });
    expect(f.events.filter(value => value.type === 'compaction_start' || value.type === 'compaction_end').map(value => value.type))
      .toEqual(['compaction_start', 'compaction_end']);
    expect(f.session.messages[0]?.role).toBe('compactionSummary');
    expect(f.session.getContextUsage()?.tokens).toBeNull();
    await expect(f.session.compact()).rejects.toThrow('Already compacted');
    expect(f.appended).toHaveLength(1); expect(f.calls).toHaveLength(1);
    expect(need(f.store.sessions.loadHistoryForContext(f.row.sessionId)).commit).toEqual(after.commit);
  });

  it('same summary text still produces distinct actual native IDs and includes previousSummary', async () => {
    const f = await fixture(); await f.session.compact();
    for (let turn = 0; turn < 4; turn++) {
      f.session.sessionManager.appendMessage({ role: 'user', content: 'new invoice ' + 'y'.repeat(45000), timestamp: 20 + turn * 2 });
      f.session.sessionManager.appendMessage(reply('new answer', 21 + turn * 2));
    }
    await f.session.compact();
    expect(f.appended).toHaveLength(2); expect(f.appended[1]).not.toBe(f.appended[0]);
    expect(f.scopes[1]!.preparation.previousSummary).toBe('same native summary');
    expect(JSON.stringify(f.calls.at(-1))).toContain('<previous-summary>');
    expect(f.session.messages[0]?.role).toBe('compactionSummary');
    expect(f.store.db.query("SELECT COUNT(*) AS n FROM session_native_entries WHERE json_extract(entry_json,'$.type')='compaction'").get()).toEqual({ n: 2 });
  });

  it('native-split-turn has history then prefix from actual preparation', async () => {
    const f = await fixture('split'); await f.session.compact();
    expect(f.scopes[0]!.preparation.isSplitTurn).toBe(true);
    expect(f.scopes[0]!.preparation.messagesToSummarize.length).toBeGreaterThan(0);
    expect(f.scopes[0]!.preparation.turnPrefixMessages.length).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(f.calls[0])).toContain('earlier invoice');
    expect(JSON.stringify(f.calls[1])).toContain('one large invoice turn');
    expect(f.generated[0]!.usage?.totalTokens).toBe(30);
  });

  it('empty native history performs no summary request and no append', async () => {
    const f = await fixture('empty'); const before = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    await expect(f.session.compact()).rejects.toThrow('Nothing to compact');
    expect(f.calls).toHaveLength(0); expect(f.generated).toHaveLength(0); expect(f.appended).toHaveLength(0);
    expect(need(f.store.sessions.loadHistoryForContext(f.row.sessionId)).commit).toEqual(before.commit);
  });

  it('generated-before-sql-failure retains the last committed prefix', async () => {
    const f = await fixture(); const before = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    f.store.db.exec("CREATE TRIGGER fail_compaction BEFORE INSERT ON session_native_entries WHEN json_extract(NEW.entry_json,'$.type')='compaction' BEGIN SELECT RAISE(ABORT,'controlled SQL rejection'); END");
    await expect(f.session.compact()).rejects.toThrow();
    expect(f.generated).toHaveLength(1); expect(f.appended).toHaveLength(0);
    const after = need(f.store.sessions.loadHistoryForContext(f.row.sessionId));
    expect(after.history!.entries).toEqual(before.history!.entries); expect(after.commit!.leafId).toBe(before.commit!.leafId);
    expect(f.adapter.inspect(f.row.nativeSessionId).availability).toBe('unusable');
    expect(f.events.filter(value => value.type === 'compaction_end').at(-1)).toMatchObject({ result: undefined, aborted: false });
    expect(f.calls).toHaveLength(1);
  });

  it('necessary generated callback rejects before native append', async () => {
    const f = await fixture(); const before = need(f.store.sessions.loadHistoryForContext(f.row.sessionId)); f.denyGenerated();
    await expect(f.session.compact()).rejects.toThrow();
    expect(f.generated).toHaveLength(1); expect(f.appended).toHaveLength(0);
    expect(need(f.store.sessions.loadHistoryForContext(f.row.sessionId)).commit).toEqual(before.commit);
  });

  it.each(['length', 'toolUse'] as const)('rejects unsafe native summary %s instead of persisting a checkpoint', async reason => {
    const f = await fixture();
    const response = reply('unsafe', 9, reason);
    if (reason === 'toolUse') response.content = [{ type: 'toolCall', id: 'unwanted', name: 'probe', arguments: {} }];
    f.response(response);
    await expect(f.session.compact()).rejects.toThrow();
    expect(f.generated).toHaveLength(0); expect(f.appended).toHaveLength(0); expect(f.calls).toHaveLength(1);
  });

  it('refuses duplicate installation and restores exact methods on dispose', async () => {
    const f = await fixture();
    expect(installNativeCompactionBridge(f.session, f.hook)).toMatchObject({ ok: false, error: { code: 'compaction_unavailable' } });
    f.bridge.dispose(); f.bridge.dispose();
    const again = need(installNativeCompactionBridge(f.session, f.hook)); again.dispose();
  });
  it.each(['_runDefaultCompaction', '_runAutoCompaction'] as const)('refuses missing or wrong-arity fixed SDK seam %s before executing', async name => {
    const f = await fixture(); f.bridge.dispose();
    const original = Reflect.get(f.session, name), append = f.session.sessionManager.appendCompaction;
    const before = need(f.store.memory.load(f.row.sessionId))!.commit;
    let calls = 0;
    try {
      for (const incompatible of [undefined, () => { calls++; }]) {
        Reflect.set(f.session, name, incompatible);
        expect(installNativeCompactionBridge(f.session, f.hook)).toMatchObject({ ok: false, error: { code: 'compaction_unavailable' } });
        expect(Reflect.get(f.session, name)).toBe(incompatible);
        expect(f.session.sessionManager.appendCompaction).toBe(append);
      }
      expect(calls).toBe(0); expect(f.calls).toHaveLength(0); expect(f.events).toHaveLength(0);
      expect(need(f.store.memory.load(f.row.sessionId))!.commit).toEqual(before);
    } finally { Reflect.set(f.session, name, original); }
  });
});
