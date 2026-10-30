import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok, RUNTIME_CONFIG, CompactionObservationSchema, NativeSessionHistorySchema } from '@flowmate/contracts';
import type { AgentPort, CompactionObservation, NativeCompactionControl, NativeCompactionOutcome, ProviderConfig,
  Result, RuntimeAgentConfigFacts, SafeConfigSnapshot, SessionCompactionRequest } from '@flowmate/contracts';
import type { PreparedAgent } from '@flowmate/contracts';
import { makeApplication } from '../../../packages/core/src/application.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { openTestDatabase, withNativeHistoryFaults } from '../../support/database.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { createAgentHistoryFixture } from './agent-history-fixture.ts';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { ContextService } from '../../../packages/core/src/context/service.ts';
import { createHttpProvider } from '../../support/resources.ts';
import { createPromptTraceBuffer } from '@flowmate/logging';

const at = '2026-10-05T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const capacity = { tokens: 10, source: 'message-estimate' as const, contextWindow: 64000, thresholdTokens: 47616, fitsEstimate: true };
function fixture(holdPreparation = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p10-admission-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs') };
  const store = need(openTestDatabase(paths));
  const history = createAgentHistoryFixture(root, () => at);
  const nativeId = randomUUID(); history.create(nativeId);
  const session = need(store.sessions.create({ nativeSessionId: nativeId, title: 'Compaction admission', at,
    nativeHistory: need(history.exportSession(nativeId)) }));
  const config: ProviderConfig = { version: 1, name: 'Compaction fixture', revision: 1,
    modelRef: { provider: 'fixture', model: 'fixture' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  const facts: RuntimeAgentConfigFacts = { policyVersion: 'runtime-v1', taskPolicyVersion: 'p2-invoice-chat-v1',
    nativeSessionId: nativeId, systemPrompt: 'fixture', thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
    maxContextBytes: 524288, maxAssistantContentBytes: 524288, maxOutputBytes: 262144,
    maxModelCalls: 2, maxToolCalls: 0, toolTimeoutMs: 10000, sessionRetry: false };
  const snapshot: SafeConfigSnapshot & { agent: RuntimeAgentConfigFacts; historyPolicyVersion: 'p9-native-history-v1' } = { version: 2,
    historyPolicyVersion: 'p9-native-history-v1', name: config.name, revision: 1,
    requestedModel: config.modelRef, resolvedModel: config.modelRef, api: 'openai-completions', endpoint: null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: config.parameters,
    native: { authSource: 'unknown', modelsSelection: null }, limits: { timeoutMs: 60000, stopGraceMs: 1000 },
    compactionPolicy: RUNTIME_CONFIG.compaction, agent: facts };
  const preparation = deferred<void>(), completion = deferred<void>();
  if (!holdPreparation) preparation.resolve();
  let prepares = 0, compacts = 0, restores = 0, inspections = 0;
  let control: NativeCompactionControl | undefined;
  let observation: CompactionObservation | null = null;
  let metadata = false;
  let preparationCommit: unknown;
  const agent: AgentPort = {
    createSession: () => fail(appError('fixture', 'runtime', 'No new Session.')),
    exportSession: history.exportSession,
    restoreSession: history.restoreSession,
    restoreSessionLeaf: (...args) => { restores++; return history.restoreSessionLeaf(...args); },
    watchSession: history.watchSession,
    inspect: () => ({ availability: 'ready' }),
    inspectSessionCompaction: () => { inspections++; return ok({ capacity, lastSaved: null, operation: observation }); },
    prepare: async (_id, _config, _limits, signal, options) => {
      prepares++; expect(store.db.inTransaction).toBe(false);
      expect(options?.compactionPolicy).toEqual(RUNTIME_CONFIG.compaction);
      await preparation.promise;
      if (signal.aborted) return fail(appError('compaction_cancelled', 'runtime', 'Cancelled.'));
      if (metadata) {
        const loaded = need(store.sessions.loadHistoryForContext(session.sessionId));
        const h = need(history.exportSession(nativeId));
        h.entries = [...h.entries, { type: 'model_change', id: 'model-fixture', parentId: h.leafId, timestamp: at, provider: 'fixture', modelId: 'fixture' }];
        h.leafId = 'model-fixture';
        preparationCommit = need(store.memory.commit({ sessionId: session.sessionId, expected: loaded.commit!,
          header: h.header, appendEntries: h.entries, leafId: h.leafId, unusable: false, contexts: [] }));
      }
      return ok({ snapshot, execute: async () => { throw new Error('Manual compaction cannot execute an Agent Run.'); } });
    },
    compactSession: async (_id, value): Promise<NativeCompactionOutcome> => {
      compacts++; control = value; expect(value.maxModelCalls).toBe(2); need(await value.verifyUse());
      observation = { sessionId: session.sessionId, nativeSessionId: nativeId, operationId: value.operationId, runId: null,
        reason: 'manual', observationSequence: 1, phase: 'compacting', generated: false, nativeOutcome: 'pending',
        entryId: null, saved: null, error: null, stopRequested: false, stopped: false, continuation: 'next-run',
        mayContinue: false, capacity, usage: { version: 1, source: 'not-requested', reason: 'fixture',
          sdkValues: null, attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } };
      value.observe(observation);
      await completion.promise;
      observation = { ...observation, observationSequence: 2, phase: 'ended', stopped: true,
        nativeOutcome: value.signal.aborted ? 'cancelled' : 'failed', stopRequested: value.signal.aborted,
        error: appError(value.signal.aborted ? 'compaction_cancelled' : 'compaction_not_needed', 'runtime', 'Fixture no work.'),
        mayContinue: !value.signal.aborted };
      value.observe(observation);
      return { observation, stopped: true, cleanupErrors: [] };
    },
    releaseSession: async () => ({ stopped: true, closed: true, errors: [] }),
    close: async () => ({ stopped: true, closed: true, errors: [] }),
  };
  let sessions!: SessionService;
  const runtime = new RuntimeService({ database: store,  agent, isSessionManaging: id => sessions.isManaging(id),
    provider: { async prepare() { throw new Error('Manual compaction cannot call Provider port.'); },
      async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
  sessions = new SessionService(agent, () => runtime.state(), () => at, store,
     undefined, undefined, (id, intent, repository) => runtime.verifySessionMutation(id, intent, repository));
  const app = makeApplication(runtime, store.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessions);
  deferCleanup(async () => { preparation.resolve(); completion.resolve(); await runtime.close(); });
  const expected = need(store.sessions.loadHistoryForContext(session.sessionId)).commit!;
  const request: SessionCompactionRequest = { sessionId: session.sessionId, operationId: randomUUID(), expected, config };
  async function call(name: string, input: unknown): Promise<Result<any>> {
    const method: unknown = Reflect.get(app, name);
    expect(typeof method, `${name} must be public`).toBe('function');
    if (typeof method !== 'function') throw new Error(`Missing ${name}`);
    return method(input);
  }
  const rows = () => Object.fromEntries(['runs', 'session_inputs', 'jobs', 'session_native_history', 'session_native_entries']
    .map(table => [table, store.db.query(`SELECT * FROM ${table}`).all()]));
  return { store, session, request, app, runtime, sessions, agent, call, rows, control: () => control,
    counts: () => ({ prepares, compacts, restores, inspections }), metadata: () => { metadata = true; },
    preparationCommit: () => preparationCommit, unblockPreparation: () => preparation.resolve(),
    finish: () => completion.resolve(), observation: () => observation };
}

describe('P10 manual admission and readonly queries (controlled port, not SDK proof)', () => {
  it('does not claim manual compaction for a disconnected foreground client', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort('shutdown');
    expect(await f.app.compactSession(f.request, { signal: controller.signal }))
      .toMatchObject({ ok: false, error: { code: 'runtime_shutdown' } });
    expect(f.counts()).toMatchObject({ prepares: 0, compacts: 0 });
    expect(f.runtime.state().active).toBeNull();
  });

  it('propagates foreground disconnection into the original manual compaction preparation', async () => {
    const f = fixture(true), controller = new AbortController();
    need(await f.app.compactSession(f.request, { signal: controller.signal }));
    await waitFor(async () => f.counts().prepares === 1);
    controller.abort('shutdown'); f.unblockPreparation();
    await waitFor(async () => f.runtime.state().active === null);
    expect(f.counts()).toMatchObject({ prepares: 1, compacts: 0 });
    expect(f.rows().runs).toEqual([]);
  });

  it('queries compaction only after a held owner commits its Session eligibility change', async () => {
    const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const held = f.store.transaction(async scope => {
      scope.db.query("UPDATE sessions SET status='archived' WHERE id=?").run(f.session.sessionId);
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    let settled = false;
    const query = f.app.querySessionCompaction({ sessionId: f.session.sessionId }).then(result => { settled = true; return result; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { release.resolve(); await held; }
    expect(await query).toMatchObject({ ok: true, data: { manualAllowed: false, blockCode: 'session_archived' } });
  });

  it('executes manual compaction from live owner repositories after legacy root aliases become unavailable', async () => {
    const f = fixture();
    f.store.sessions.readHistorySnapshot = () => fail(appError('storage_read_failed', 'storage', 'Root alias must not serve compaction.'));
    need(await f.app.compactSession(f.request));
    await waitFor(async () => f.control() !== undefined || f.runtime.state().active === null);
    expect(f.counts()).toMatchObject({ prepares: 1, compacts: 1 });
    expect(await f.control()!.verifyUse()).toEqual(ok(undefined));
    f.finish(); await waitFor(async () => f.runtime.state().active === null);
  });

  it('manual-claims-slot-before-prepare-await', async () => {
    const f = fixture(true);
    expect(need(await f.call('compactSession', f.request))).toEqual({ sessionId: f.session.sessionId, operationId: f.request.operationId });
    expect(f.runtime.state().active).toEqual({ kind: 'compaction', runId: null, sessionId: f.session.sessionId, operationId: f.request.operationId });
    expect(await f.call('compactSession', { ...f.request, operationId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(await f.runtime.callProvider({ goal: 'fixture', text: 'blocked', config: f.request.config, timeoutMs: 1000, stopGraceMs: 100 }))
      .toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(await f.runtime.start({ sessionId: f.session.sessionId, text: 'blocked', config: f.request.config }))
      .toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(need(await f.sessions.get(f.session.sessionId))).toMatchObject({ availability: 'busy', activeRunId: null });
    expect(await f.store.read(scope => f.runtime.verifySessionMutation(f.session.sessionId, undefined, scope.sessions)))
      .toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(await f.sessions.setStatus({ sessionId: f.session.sessionId, expectedStatus: 'active', status: 'archived' })).toMatchObject({ ok: false, error: { code: 'session_busy' } });
    const before = f.rows();
    expect(await f.sessions.branch({ sessionId: f.session.sessionId, expectedLeafId: f.request.expected.leafId,
      expectedEntryCount: f.request.expected.entryCount, expectedCommitRevision: f.request.expected.commitRevision, targetEntryId: 'blocked-target' }))
      .toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(await f.sessions.forkSession({ sourceSessionId: f.session.sessionId, expected: f.request.expected,
      targetEntryId: 'blocked-target', title: 'Blocked fork', clientOperationId: randomUUID() }))
      .toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(await f.sessions.deleteSession(f.session.sessionId)).toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(f.rows()).toEqual(before);
    expect(f.counts()).toMatchObject({ prepares: 1, compacts: 0 });
  });

  it.each(['commitRevision', 'entryCount', 'leafId'] as const)('manual-expected-before-metadata-write: %s', async field => {
    const f = fixture(); const before = f.rows();
    const expected = { ...f.request.expected, [field]: field === 'leafId' ? 'wrong' : f.request.expected[field]! + 1 };
    expect(await f.call('compactSession', { ...f.request, expected })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.counts()).toMatchObject({ prepares: 0, compacts: 0, restores: 0 });
    expect(f.rows()).toEqual(before);
  });

  it('prepare metadata becomes the new baseline without a Run/Input/Job', async () => {
    const f = fixture(); f.metadata(); const before = f.rows();
    need(await f.call('compactSession', f.request));
    await waitFor(async () => f.control() !== undefined);
    expect(f.preparationCommit()).toEqual({ commitRevision: f.request.expected.commitRevision + 1, entryCount: 1, leafId: 'model-fixture' });
    expect(await f.control()!.verifyUse()).toEqual(ok(undefined));
    for (const table of ['runs', 'session_inputs', 'jobs']) expect(f.rows()[table]).toEqual(before[table]);
    expect(f.store.db.query('SELECT run_id FROM session_native_entries').all()).toEqual([{ run_id: null }]);
    f.finish(); await waitFor(async () => f.runtime.state().active === null);
    expect(need(await f.call('querySessionCompaction', { sessionId: f.session.sessionId })).commit).toEqual(f.preparationCommit());
  });

  it('reuses only an alive identical request, rejects changed identity and cannot reopen completed operation', async () => {
    const f = fixture(true);
    const first = await f.call('compactSession', f.request);
    expect(await f.call('compactSession', structuredClone(f.request))).toEqual(first);
    expect(await f.call('compactSession', { ...f.request, config: { ...f.request.config, revision: 2 } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    f.unblockPreparation(); await waitFor(async () => f.control() !== undefined);
    f.finish(); await waitFor(async () => f.runtime.state().active === null);
    expect(await f.call('compactSession', f.request)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    expect(f.counts()).toMatchObject({ prepares: 1, compacts: 1 });
  });

  it('query-is-pure-and-restored-operation-is-unknown', async () => {
    const f = fixture(); const before = f.rows();
    for (let index = 0; index < 3; index++) {
      expect(need(await f.call('querySessionCompaction', { sessionId: f.session.sessionId })))
        .toMatchObject({ operation: null, operationAvailability: 'none', manualAllowed: true, commit: f.request.expected });
      expect(need(await f.call('querySessionCompaction', { sessionId: f.session.sessionId, operationId: f.request.operationId })))
        .toMatchObject({ operation: null, operationAvailability: 'unknown' });
    }
    expect(f.counts()).toMatchObject({ prepares: 0, compacts: 0, restores: 0 }); expect(f.rows()).toEqual(before);
  });
  it('manual query blocks an unusable native instance even when the saved prefix remains readable', async () => {
    const f = fixture(); f.agent.inspect = () => ({ availability: 'unusable' });
    const before = f.rows();
    expect(need(await f.app.querySessionCompaction({ sessionId: f.session.sessionId })))
      .toMatchObject({ manualAllowed: false, blockCode: 'agent_session_unusable' });
    expect(f.rows()).toEqual(before);
    expect(f.counts().prepares).toBe(0);
  });

  it('cancel latches before finish, does not imply stopped, and blocks manual completion qualification', async () => {
    const f = fixture(); need(await f.call('compactSession', f.request)); await waitFor(async () => f.control() !== undefined);
    const query = { sessionId: f.session.sessionId, operationId: f.request.operationId };
    expect(need(await f.call('cancelSessionCompaction', query)).accepted).toBe(true);
    expect(need(await f.call('cancelSessionCompaction', query)).accepted).toBe(false);
    expect(need(await f.call('querySessionCompaction', query)).operation).toMatchObject({ phase: 'stopping', stopRequested: true, stopped: false, mayContinue: false });
    expect(f.runtime.state().active?.kind).toBe('compaction');
    expect(await f.call('cancelSessionCompaction', { ...query, operationId: randomUUID() }))
      .toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    f.finish(); await waitFor(async () => f.runtime.state().active === null);
    expect(need(await f.call('querySessionCompaction', query)).operation).toMatchObject({ stopped: true, mayContinue: false, nativeOutcome: 'cancelled' });
  });
  it('duplicate normalized observations and notifications after completion cannot change the operation facts', async () => {
    const f = fixture(); need(await f.app.compactSession(f.request));
    await waitFor(async () => f.control() !== undefined);
    const query = { sessionId: f.session.sessionId, operationId: f.request.operationId };
    const before = need(await f.app.querySessionCompaction(query));
    f.control()!.observe(structuredClone(f.observation()!));
    f.control()!.observe(structuredClone(f.observation()!));
    expect(need(await f.app.querySessionCompaction(query))).toEqual(before);
    f.finish(); await waitFor(async () => f.runtime.state().active === null);
    const ended = need(await f.app.querySessionCompaction(query));
    f.control()!.observe({ ...f.observation()!, observationSequence: 999, phase: 'compacting', stopped: false });
    expect(need(await f.app.querySessionCompaction(query))).toEqual(ended);
    expect(f.counts().compacts).toBe(1);
  });
  it('manual stop grace holds occupancy and marks Runtime blocked until actual late completion', async () => {
    const f = fixture(); need(await f.app.compactSession(f.request));
    await waitFor(async () => f.control() !== undefined);
    need(await f.app.cancelSessionCompaction({ sessionId: f.session.sessionId, operationId: f.request.operationId }));
    await new Promise(resolve => setTimeout(resolve, RUNTIME_CONFIG.request.stopGraceMs + 50));
    expect(f.runtime.state()).toMatchObject({ blocked: true, active: { kind: 'compaction' } });
    const query = need(await f.app.querySessionCompaction({ sessionId: f.session.sessionId, operationId: f.request.operationId }));
    expect(query.operation).toMatchObject({ stopRequested: true, stopped: false, mayContinue: false, error: { code: 'stop_unconfirmed' } });
    f.finish(); await waitFor(async () => f.runtime.state().active === null);
    expect(f.runtime.state().blocked).toBe(true);
  });
  it('manual close cannot report stopped or closed while its original compaction Promise remains pending', async () => {
    const f = fixture(); need(await f.app.compactSession(f.request));
    await waitFor(async () => f.control() !== undefined);
    const closing = f.runtime.close();
    expect(f.control()!.signal.aborted).toBe(true);
    const report = await closing;
    expect(report).toMatchObject({ stopped: false, closed: false });
    expect(f.runtime.state()).toMatchObject({ blocked: true, active: { kind: 'compaction' } });
    f.finish(); await waitFor(async () => f.runtime.state().active === null);
    expect(f.runtime.state().blocked).toBe(true);
  });

  it.each(['archived', 'deletePending', 'unusable', 'corrupt'] as const)('rejects %s before prepare', async kind => {
    const f = fixture();
    if (kind === 'archived') need(f.store.sessions.setStatus({ sessionId: f.session.sessionId, expectedStatus: 'active', status: 'archived', at }));
    if (kind === 'deletePending') need(f.store.sessions.prepareDelete(f.session.sessionId, at));
    if (kind === 'unusable') need(f.store.sessions.markHistoryUnusable(f.session.sessionId));
    if (kind === 'corrupt') f.store.db.query("UPDATE session_native_history SET header_json='{}' WHERE session_id=?").run(f.session.sessionId);
    expect((await f.call('compactSession', f.request)).ok).toBe(false);
    expect(f.counts()).toMatchObject({ prepares: 0, compacts: 0 });
  });

  it('validates raw requests at the Application boundary', async () => {
    const f = fixture();
    expect(await f.call('compactSession', { ...f.request, modelId: 'untrusted' })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await f.call('querySessionCompaction', { sessionId: 0 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await f.call('cancelSessionCompaction', { sessionId: f.session.sessionId, operationId: 'invalid' }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(f.counts()).toMatchObject({ prepares: 0, compacts: 0 });
  });
});

describe('P10 public Application → native SDK → controlled HTTP → SQLite', () => {
  async function realFixture(mode: 'manual' | 'threshold' | 'split' | 'post-threshold' | 'overflow-stop' | 'overflow-error' | 'overflow-length' | 'overflow-twice',
    respond?: (request: Request, count: number) => Promise<Response | null>, failure?: 'pre-start' | 'auth') {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-p10-public-'));
    const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
      artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs') };
    const store = withNativeHistoryFaults(need(openTestDatabase(paths)));
    const payloads: unknown[] = [];
    const server = await createHttpProvider(async request => {
      payloads.push(await request.json());
      if (respond) { const response = await respond(request, payloads.length); if (response) return response; }
      const pre = mode === 'manual' || mode === 'threshold' || mode === 'split';
      const summaryCall = pre ? 1 : 2;
      if ((mode === 'overflow-error' || mode === 'overflow-twice') && (payloads.length === 1 || mode === 'overflow-twice' && payloads.length === 3))
        return Response.json({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error' } }, { status: 400 });
      const text = payloads.length === summaryCall || mode === 'split' && payloads.length === 2 ? 'P10 native checkpoint' : 'Explicit next answer';
      const chunk = (delta: unknown, reason: string | null) => 'data: ' + JSON.stringify({ id: 'public-p10', model: 'offline',
        choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n';
      const reason = mode === 'overflow-length' && payloads.length === 1 ? 'length' : 'stop';
      const input = !pre && payloads.length === 1 ? mode === 'overflow-stop' ? 65000 : mode === 'post-threshold' ? 50000 : 10 : 10;
      return new Response(chunk({ role: 'assistant', content: text }, null) + chunk({}, reason)
        + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: 5, total_tokens: input + 5 } })
        + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    });
    deferCleanup(() => server.stop(true));
    const manager = SessionManager.inMemory(root);
    manager.appendModelChange('p10-public', 'offline'); manager.appendThinkingLevelChange('off');
    for (let index = 0; index < (mode === 'split' ? 2 : 4); index++) {
      manager.appendMessage({ role: 'user', content: 'Legacy invoice ' + 'x'.repeat(mode === 'split' ? 90000 : 45000), timestamp: index * 2 });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: mode === 'split' && index === 1 ? 'z'.repeat(100000) : 'Legacy answer' }], api: 'openai-completions',
        provider: 'p10-public', model: 'offline', stopReason: 'stop', timestamp: index * 2 + 1,
        usage: { input: mode === 'threshold' && index === 3 || mode === 'split' && index === 1 ? 50000 : 1, output: 1,
          totalTokens: mode === 'threshold' && index === 3 || mode === 'split' && index === 1 ? 50001 : 2, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    const row = need(store.sessions.create({ nativeSessionId: manager.getSessionId(), title: 'Public compaction', at,
      nativeHistory: { storageVersion: 1, header: manager.getHeader()!, entries: manager.getEntries().map(entry => ({ ...entry })),
        leafId: manager.getLeafId(), unusable: false } }));
    const promptTrace = createPromptTraceBuffer();
    const nativeEvents: string[] = [];
    const agent = new PiAgentAdapter({ cwd: root, agentDir: root, credentials: new InMemoryCredentialStore(),
      runtimeApiKey: 'synthetic-public-p10', promptTrace, sessionSetup(session) {
        session.subscribe(event => { if (event.type === 'compaction_start' || event.type === 'compaction_end') nativeEvents.push(event.type); });
        if (failure === 'pre-start') Reflect.set(session, '_runAutoCompaction', async function(_reason: unknown, _willRetry: unknown) {
          throw new Error('controlled pre-start native failure');
        });
        // Pi 1.4 emits compaction_start before resolving summary authentication.
        if (failure === 'auth') Reflect.set(session, '_getSummarizationRequestAuth', async () => { throw new Error('controlled summary auth failure'); });
      } });
    const nativeCompact = agent.compactSession.bind(agent);
    agent.compactSession = async (...args) => {
      const value = await nativeCompact(...args);
      const parsed = CompactionObservationSchema.safeParse(value.observation);
      expect(parsed.success).toBe(true);
      return value;
    };
    const context = new ContextService({ store, materials: { inspectParsed() { throw new Error('Pure chat cannot inspect material.'); } } });
    const runtime = new RuntimeService({ database: store,  contextService: context, agent,
      provider: { async prepare() { throw new Error('No direct Provider.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    const sessions = new SessionService(agent, () => runtime.state(), () => at, store);
    const app = makeApplication(runtime, store.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessions);
    deferCleanup(async () => { await runtime.close(); });
    const config: ProviderConfig = { version: 1, name: 'Public fixture', revision: 1, modelRef: { provider: 'p10-public', model: 'offline' },
      native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    return { root, store, row, agent, runtime, app, config, payloads, promptTrace, sessions, nativeEvents };
  }
  for (const failure of ['pre-start', 'auth'] as const) it(`native automatic ${failure} failure preserves its actual lifecycle and sends no HTTP`, async () => {
    const f = await realFixture('threshold', undefined, failure);
    const accepted = need(await f.app.startRun({ sessionId: f.row.sessionId, text: 'New explicit input', config: f.config,
      timeoutMs: 5000, stopGraceMs: 100 }));
    await waitFor(async () => f.runtime.state().active === null);
    expect(need(await f.app.queryRun(accepted.runId)).status).toBe('failed');
    expect(f.nativeEvents).toEqual(failure === 'pre-start' ? [] : ['compaction_start', 'compaction_end']);
    expect(f.payloads).toHaveLength(0);
    const state = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId, runId: accepted.runId }));
    expect(state.operation).toMatchObject({ generated: false, saved: null, stopped: true, mayContinue: false,
      nativeOutcome: 'failed', error: { code: failure === 'pre-start' ? 'compaction_unavailable' : 'compaction_failed' },
      tokens: { totalTokens: null, cost: null } });
    if (failure === 'pre-start') expect(state.operation!.error!.message).toContain('unknown');
    expect(state.operation!.error!.message).not.toContain('controlled');
    expect(NativeSessionHistorySchema.parse(need(f.store.memory.load(f.row.sessionId))!.history).entries.filter(e => e.type === 'compaction')).toHaveLength(0);
  });
  it('a successful threshold summary exhausting the original budget refuses continuation without poisoning verified history', async () => {
    const f = await realFixture('threshold');
    const accepted = need(await f.app.startRun({ sessionId: f.row.sessionId, text: 'Explicit input', config: f.config,
      budget: { maxModelCalls: 1 }, timeoutMs: 5000, stopGraceMs: 100 }));
    await waitFor(async () => f.runtime.state().active === null);
    const run = need(await f.app.queryRun(accepted.runId));
    expect(run).toMatchObject({ status: 'failed', error: { code: 'agent_model_call_budget' } });
    expect(f.payloads).toHaveLength(1);
    const view = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId, runId: accepted.runId }));
    expect(view.operation).toMatchObject({ generated: true, nativeOutcome: 'succeeded', stopped: true, mayContinue: false,
      error: { code: 'agent_model_call_budget' } });
    expect(view.operation!.saved).not.toBeNull();
    expect(f.agent.inspect(f.row.nativeSessionId).availability).toBe('ready');
    expect(NativeSessionHistorySchema.parse(need(f.store.memory.load(f.row.sessionId))!.history).entries.filter(e => e.type === 'compaction')).toHaveLength(1);
  });
  it('post-agent summary using the final budget call finishes the answered Run without authorizing another call', async () => {
    const f = await realFixture('post-threshold');
    const accepted = need(await f.app.startRun({ sessionId: f.row.sessionId, text: 'Explicit input', config: f.config,
      budget: { maxModelCalls: 2 }, timeoutMs: 5000, stopGraceMs: 100 }));
    await waitFor(async () => f.runtime.state().active === null);
    expect(need(await f.app.queryRun(accepted.runId))).toMatchObject({ status: 'completed', error: null });
    expect(f.payloads).toHaveLength(2);
    const view = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId, runId: accepted.runId }));
    expect(view.operation).toMatchObject({ generated: true, nativeOutcome: 'succeeded', stopped: true, mayContinue: false, error: null });
    expect(view.operation!.saved).not.toBeNull();
    expect(f.agent.inspect(f.row.nativeSessionId).availability).toBe('ready');
  });
  it.each(['native-sql', 'journal-before-http', 'journal-after-generation', 'journal-ended', 'capacity'] as const)(
    'automatic %s failure blocks the next model request without repeating compaction', async kind => {
    const f = await realFixture('threshold', kind === 'capacity' ? async (_request, count) => {
      if (count !== 1) return null;
      const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({
        choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
      return new Response(chunk({ role: 'assistant', content: 'z'.repeat(240000) }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } : undefined);
    const before = NativeSessionHistorySchema.parse(need(f.store.memory.load(f.row.sessionId))!.history);
    if (kind === 'native-sql') f.store.db.exec("CREATE TRIGGER p10_auto_sql BEFORE INSERT ON session_native_entries WHEN json_extract(NEW.entry_json,'$.type')='compaction' BEGIN SELECT RAISE(ABORT,'controlled auto save failure'); END");
    if (kind.startsWith('journal')) f.store.db.exec(`CREATE TRIGGER p10_auto_evidence BEFORE UPDATE OF context_observations_json ON runs
      WHEN json_array_length(json_extract(NEW.context_observations_json,'$.compactions')) > 0
      ${kind === 'journal-after-generation' ? "AND json_extract(NEW.context_observations_json,'$.compactions[0].observation.generated')=1" : ''}
      ${kind === 'journal-ended' ? "AND json_extract(NEW.context_observations_json,'$.compactions[0].observation.phase')='ended'" : ''}
      BEGIN SELECT RAISE(ABORT,'controlled required evidence failure'); END`);
    const next = need(await f.app.startRun({ sessionId: f.row.sessionId, text: 'Explicit test input', config: f.config,
      timeoutMs: 5000, stopGraceMs: 100 }));
    await waitFor(async () => f.runtime.state().active === null);
    const run = need(await f.app.queryRun(next.runId));
    expect(run.status).toBe('failed');
    expect(f.payloads).toHaveLength(kind === 'journal-before-http' ? 0 : 1);
    const history = NativeSessionHistorySchema.parse(need(f.store.memory.load(f.row.sessionId))!.history);
    expect(history.entries.filter(e => e.type === 'compaction')).toHaveLength(kind === 'capacity' || kind === 'journal-ended' ? 1 : 0);
    if (kind !== 'capacity') expect(history.entries.slice(0, before.entries.length)).toEqual([...before.entries]);
    const view = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId }));
    expect(view.operation?.mayContinue).toBe(false);
    if (kind === 'native-sql') expect(view.operation).toMatchObject({ generated: true, saved: null, nativeOutcome: 'succeeded',
      mayContinue: false, error: { code: 'storage_write_failed' } });
    if (kind === 'journal-ended') expect(view.operation).toMatchObject({ generated: true, nativeOutcome: 'succeeded',
      saved: { leafId: expect.any(String) }, error: { code: 'storage_write_failed' } });
    if (kind === 'capacity') {
      expect(view.operation).toMatchObject({ generated: true, nativeOutcome: 'succeeded', capacity: { fitsEstimate: false } });
      expect(view.operation?.saved).not.toBeNull();
      // A pure capacity refusal leaves a verified history usable; it does not clear other failures.
      expect(f.agent.inspect(f.row.nativeSessionId).availability).toBe('ready');
    } else {
      expect(f.agent.inspect(f.row.nativeSessionId).availability).toBe('unusable');
      const refused = await f.app.startRun({ sessionId: f.row.sessionId, text: 'No failed tail replay', config: f.config });
      expect(refused.ok).toBe(false);
      expect(f.payloads).toHaveLength(kind === 'journal-before-http' ? 0 : 1);
    }
  });
  it.each(['stop', 'timeout', 'revoke'] as const)('automatic %s wins over a late summary and preserves the saved prefix', async kind => {
    const entered = deferred<void>(), release = deferred<void>();
    const f = await realFixture('threshold', async request => {
      entered.resolve();
      request.signal.addEventListener('abort', () => release.resolve(), { once: true });
      await release.promise;
      return null;
    });
    const accepted = need(await f.app.startRun({ sessionId: f.row.sessionId, text: 'Original fixed input', config: f.config,
      timeoutMs: kind === 'timeout' ? 1000 : 5000, stopGraceMs: 100 }));
    await entered.promise;
    if (kind === 'stop') need(await f.app.cancelRun(accepted.runId));
    if (kind === 'revoke') f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
      .run(JSON.stringify({ documentIds: [123], at, reason: 'document_use_revoked' }), f.row.sessionId);
    if (kind !== 'timeout') release.resolve();
    await waitFor(async () => f.runtime.state().active === null);
    const run = need(await f.app.queryRun(accepted.runId));
    expect(run.status).toBe(kind === 'stop' ? 'cancelled' : 'failed');
    expect(f.payloads).toHaveLength(1);
    const history = NativeSessionHistorySchema.parse(need(f.store.memory.load(f.row.sessionId))!.history);
    expect(history.entries.filter(entry => entry.type === 'compaction')).toHaveLength(0);
    // Pre-prompt threshold runs before the accepted Input is consumed by Pi.
    expect(history.entries.filter(entry => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(4);
    const state = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId, runId: accepted.runId }));
    expect(state.operation).toMatchObject({ stopped: true, saved: null, mayContinue: false });
    expect(state.manualAllowed).toBe(false);
  });
  it('Stop after the native SQL commit retains the real entry and cannot authorize continuation', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const f = await realFixture('threshold', async () => { entered.resolve(); await release.promise; return null; });
    const accepted = need(await f.app.startRun({ sessionId: f.row.sessionId, text: 'Original input', config: f.config,
      timeoutMs: 5000, stopGraceMs: 100 }));
    await entered.promise;
    const transaction = f.store.transaction;
    let stopped: Promise<Result<unknown>> | undefined;
    f.store.transaction = async operation => {
      const result = await transaction(operation);
      const saved = need(f.store.memory.load(f.row.sessionId));
      if (!stopped && saved?.history.entries.at(-1)?.type === 'compaction')
        stopped = f.app.cancelRun(accepted.runId);
      return result;
    };
    release.resolve();
    await waitFor(async () => f.runtime.state().active === null);
    expect(stopped).toBeDefined(); expect((await stopped)!.ok).toBe(true);
    const view = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId, runId: accepted.runId }));
    expect(view.operation).toMatchObject({ generated: true, saved: { leafId: view.lastSaved!.entryId },
      stopRequested: true, stopped: true, mayContinue: false });
    expect(f.payloads).toHaveLength(1);
    expect(need(await f.app.queryRun(accepted.runId)).status).toBe('cancelled');
  });
  it('a failed manual summary permits only an explicit new Run from a verified unchanged prefix', async () => {
    const f = await realFixture('manual', async (_request, count) => count === 1
      ? Response.json({ error: { message: 'Controlled summary unavailable' } }, { status: 503 }) : null);
    const baseline = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId }));
    const operationId = randomUUID();
    need(await f.app.compactSession({ sessionId: f.row.sessionId, expected: baseline.commit, config: f.config, operationId }));
    await waitFor(async () => f.runtime.state().active === null);
    const failed = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId, operationId }));
    expect(failed).toMatchObject({ commit: baseline.commit, operation: { generated: false, saved: null, stopped: true,
      nativeOutcome: 'failed', mayContinue: true } });
    expect(f.payloads).toHaveLength(1);
    const next = need(await f.app.startRun({ sessionId: f.row.sessionId, text: 'Explicit new question', config: f.config,
      timeoutMs: 5000, stopGraceMs: 100 }));
    await waitFor(async () => f.runtime.state().active === null);
    expect(need(await f.app.queryRun(next.runId)).status).toBe('completed');
    expect(f.payloads).toHaveLength(2);
  });
  it('the native prepared execute port cannot enter an idle Agent while its manual compaction is pending', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const f = await realFixture('manual', async () => { entered.resolve(); await release.promise; return null; });
    const prepare = f.agent.prepare.bind(f.agent); let prepared: PreparedAgent | undefined;
    f.agent.prepare = async (...args) => { const result = await prepare(...args); if (result.ok) prepared = result.data; return result; };
    const before = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId }));
    need(await f.app.compactSession({ sessionId: f.row.sessionId, expected: before.commit, config: f.config, operationId: randomUUID() }));
    await entered.promise;
    try {
      const outcome = await prepared!.execute({ goal: 'No concurrent model operation', text: 'No concurrent input', runId: 999,
        sessionId: f.row.sessionId, messageTimestamp: 1, verifyModelUse: () => ok(undefined) }, new AbortController().signal, () => {});
      expect(outcome).toMatchObject({ error: { code: 'agent_session_busy' }, agent: { modelCallCount: 0 } });
      expect(f.payloads).toHaveLength(1);
    } finally { release.resolve(); await waitFor(async () => f.runtime.state().active === null); }
  });
  it('a fork of an actually compacted Session retains its summary source and ancestor revocation', async () => {
    const f = await realFixture('manual');
    const baseline = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId }));
    need(await f.app.compactSession({ sessionId: f.row.sessionId, expected: baseline.commit, config: f.config, operationId: randomUUID() }));
    await waitFor(async () => f.runtime.state().active === null);
    const saved = need(await f.app.querySessionCompaction({ sessionId: f.row.sessionId }));
    const fork = need(await f.sessions.forkSession({ sourceSessionId: f.row.sessionId, expected: saved.commit,
      targetEntryId: saved.lastSaved!.entryId, title: 'Compacted fork', clientOperationId: randomUUID() }));
    const child = need(await f.app.querySessionCompaction({ sessionId: fork.session.sessionId }));
    expect(child.lastSaved).toMatchObject({ entryId: saved.lastSaved!.entryId, originSessionId: f.row.sessionId });
    f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
      .run(JSON.stringify({ documentIds: [123], at, reason: 'document_use_revoked' }), f.row.sessionId);
    expect(await f.app.startRun({ sessionId: fork.session.sessionId, text: 'Must not bypass source access', config: f.config }))
      .toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
    expect(f.payloads).toHaveLength(1);
  });
  it.each(['manual', 'threshold', 'split', 'post-threshold', 'overflow-stop', 'overflow-error', 'overflow-length', 'overflow-twice'] as const)(
    '%s saves a real native checkpoint and retains actual request identities', async mode => {
    const { root, store, row, agent, runtime, app, config, payloads, promptTrace } = await realFixture(mode);
    const query = need(await app.querySessionCompaction({ sessionId: row.sessionId }));
    expect(query).toMatchObject({ manualAllowed: true, capacity: { contextWindow: null } });
    const operationId = randomUUID();
    if (mode === 'manual') {
      need(await app.compactSession({ sessionId: row.sessionId, operationId, expected: query.commit, config }));
      await waitFor(async () => runtime.state().active === null);
      const saved = need(await app.querySessionCompaction({ sessionId: row.sessionId, operationId }));
      expect(saved.operation).toMatchObject({ generated: true, nativeOutcome: 'succeeded', stopped: true, mayContinue: true, saved: saved.commit });
      expect(store.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
      expect(store.db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({ n: 0 });
      expect(payloads).toHaveLength(1);
    }
    let finished!: () => void;
    const terminal = new Promise<void>(resolve => { finished = resolve; });
    const next = need(await app.startRun({ sessionId: row.sessionId, text: 'Explicit new invoice question', config, timeoutMs: 5000, stopGraceMs: 100 },
      { onEvent(event) { if (event.type === 'run_finished') finished(); } }));
    await terminal;
    const run = need(await app.queryRun(next.runId));
    const recovered = mode === 'overflow-error' || mode === 'overflow-length' || mode === 'overflow-twice';
    expect(run).toMatchObject({ status: mode === 'overflow-twice' ? 'failed' : 'completed',
      ...(mode === 'overflow-twice' ? {} : { output: { text: 'Explicit next answer' } }) });
    expect(payloads).toHaveLength(recovered || mode === 'split' ? 3 : 2);
    if (mode === 'manual' || mode === 'threshold' || mode === 'split' || recovered) expect(JSON.stringify(payloads.at(-1))).toContain('P10 native checkpoint');
    const raw = store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(next.runId) as { context_observations_json: string };
    const evidence = JSON.parse(raw.context_observations_json);
    const checkpoint = need(await app.querySessionCompaction({ sessionId: row.sessionId })).lastSaved!;
    if (mode === 'manual' || mode === 'threshold' || mode === 'split' || recovered) expect(evidence.requests.at(-1).binding.includedNativeContexts)
      .toEqual([expect.objectContaining({ nativeEntryId: checkpoint.entryId,
        entryType: 'compaction', messageRole: 'compactionSummary', originSessionId: row.sessionId })]);
    if (mode !== 'manual') {
      expect(evidence.compactions).toHaveLength(1);
      const beforeAnswer = mode === 'threshold' || mode === 'split';
      const autoReason = mode.startsWith('overflow') ? 'overflow' : 'threshold';
      expect(evidence.compactions[0]).toMatchObject({ runId: next.runId, reason: autoReason,
        observation: { generated: true, nativeOutcome: 'succeeded', stopped: true, entryId: checkpoint.entryId, saved: { leafId: checkpoint.entryId } },
        calls: mode === 'split' ? [
          { modelCallIndex: 1, purpose: 'history', attempts: [{ attempt: 1, responseStatus: 200 }] },
          { modelCallIndex: 2, purpose: 'turn-prefix', attempts: [{ attempt: 1, responseStatus: 200 }] },
        ] : [{ modelCallIndex: beforeAnswer ? 1 : 2, purpose: 'history', attempts: [{ attempt: 1, responseStatus: 200 }] }] });
      expect(run).toMatchObject({ output: { agent: { modelCallCount: recovered || mode === 'split' ? 3 : 2 } }, config: { compactionPolicy: RUNTIME_CONFIG.compaction } });
      if (mode === 'split') {
        expect(run).toMatchObject({ tokens: { inputTokens: 30, outputTokens: 15, totalTokens: 45, cost: null } });
        expect(promptTrace.query(next.runId).calls).toEqual(expect.arrayContaining([
          expect.objectContaining({ callSequence: 2, purpose: 'summary-turn-prefix', answerRequestSequence: null, state: 'ended' })]));
      }
      expect(evidence.requests.map((value: {binding:{requestSequence:number;callSequence:number}}) => value.binding))
        .toEqual(Array.from({length:recovered ? 2 : 1}, (_, index) => expect.objectContaining({ requestSequence: index + 1, callSequence: index + 1 })));
      expect(promptTrace.query(next.runId).calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ callSequence: beforeAnswer ? 1 : 2, purpose: 'summary-history', answerRequestSequence: null,
          operationId: evidence.compactions[0].operationId, state: 'ended' }),
        expect.objectContaining({ callSequence: beforeAnswer ? mode === 'split' ? 3 : 2 : 1, purpose: 'answer', answerRequestSequence: 1 }),
      ]));
      const history = NativeSessionHistorySchema.parse(need(store.memory.load(row.sessionId))!.history);
      expect(history.entries.filter(entry => entry.type === 'compaction')).toHaveLength(1);
      if (mode === 'overflow-error' || mode === 'overflow-twice') expect(history.entries.filter(entry =>
        entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason === 'error')).toHaveLength(mode === 'overflow-twice' ? 2 : 1);
      expect(store.db.query('SELECT COUNT(*) AS n FROM session_inputs').get()).toEqual({ n: 1 });
      const coldAgent = new PiAgentAdapter({ cwd: root, agentDir: root });
      const coldRuntime = new RuntimeService({ database: store,  agent: coldAgent,
        provider: { async prepare() { throw new Error('Readonly query.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
        log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
      const recorded = need(await coldRuntime.querySessionCompaction({ sessionId: row.sessionId, runId: next.runId,
        operationId: evidence.compactions[0].operationId }));
      expect(recorded).toMatchObject({ operationAvailability: 'recorded', operation: { operationId: evidence.compactions[0].operationId,
        entryId: checkpoint.entryId, mayContinue: false } });
      expect(payloads).toHaveLength(recovered || mode === 'split' ? 3 : 2);
      await coldAgent.close();
    }
  });
});
