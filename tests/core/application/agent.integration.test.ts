import { mkdtempSync } from '../../support/resources.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { appError, INVOICE_CHAT_SYSTEM_PROMPT, ok } from '@flowmate/contracts';
import type {
  AgentExecutionInput,
  P5ChatAgentConfigFacts,
  AgentNativeOutcome,
  AgentPort,
  PreparedAgent,
  PromptTraceBuffer,
  ProviderConfig,
  ProviderPort,
  SafeConfigSnapshot,
} from '@flowmate/contracts';
import type { SessionRepository } from '../../../packages/core/src/storage/repositories.ts';
import { makeApplication, RuntimeService, SessionService } from '../../../packages/core/src/index.ts';
import { openTestDatabase } from '../../support/database.ts';
import { createAgentHistoryFixture } from './agent-history-fixture.ts';

const config: ProviderConfig = {
  version: 1,
  name: 'fixture',
  revision: 2,
  modelRef: { provider: 'fixture-provider', model: 'fixture-model' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};

function dbPaths(root: string) {
  return { root, databaseFile: join(root, 'data', 'application.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options: { failSessionInsert?: boolean; failTraceQuery?: boolean; failSessionRelease?: boolean; legacyHistory?: boolean } = {}) {
  const opened = openTestDatabase(dbPaths(mkdtempSync(join(tmpdir(), 'flowmate-app-agent-'))));
  if (!opened.ok) throw new Error(opened.error.message);
  let created = 0;
  let preparations = 0;
  const released: string[] = [];
  const clearedTraceSessions: number[] = [];
  let failSessionRelease = options.failSessionRelease ?? false;
  const records = new Map<string, { busy: boolean }>();
  const history = createAgentHistoryFixture(tmpdir(), () => '2026-09-24T00:00:00.000Z');
  const agent: AgentPort = {
    createSession() {
      const nativeSessionId = `native-${++created}`;
      records.set(nativeSessionId, { busy: false });
      history.create(nativeSessionId);
      return ok({ nativeSessionId });
    },
    ...(!options.legacyHistory ? { exportSession: history.exportSession, watchSession: history.watchSession,
      restoreSessionLeaf: history.restoreSessionLeaf } : {}),
    inspect(nativeSessionId) {
      const record = records.get(nativeSessionId);
      return { availability: !record ? 'missing' : record.busy ? 'busy' : 'ready' };
    },
    async prepare(nativeSessionId, receivedConfig, limits, signal): Promise<ReturnType<typeof ok<PreparedAgent>> | { ok: false; error: ReturnType<typeof appError> }> {
      preparations += 1;
      if (signal.aborted) return { ok: false, error: appError('agent_cancelled', 'runtime', 'cancelled', false) };
      const record = records.get(nativeSessionId);
      if (!record) return { ok: false, error: appError('session_history_unavailable', 'session', 'missing', false) };
      const agentFacts: P5ChatAgentConfigFacts = {
        policyVersion: 'p5-session-inputs-v1', nativeSessionId, systemPrompt: INVOICE_CHAT_SYSTEM_PROMPT, thinkingLevel: 'off',
        resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 524_288, maxOutputBytes: 262_144,
        maxAssistantContentBytes: 524_288, maxModelCalls: 12, sessionRetry: false,
      };
      const snapshot: SafeConfigSnapshot & { agent: P5ChatAgentConfigFacts; historyPolicyVersion: 'p9-native-history-v1' } = { historyPolicyVersion: 'p9-native-history-v1',
        version: 1, name: receivedConfig.name, revision: receivedConfig.revision, requestedModel: receivedConfig.modelRef,
        resolvedModel: receivedConfig.modelRef, api: receivedConfig.connection?.api ?? null,
        endpoint: receivedConfig.connection?.baseUrl ?? null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
        parameters: receivedConfig.parameters, limits, native: { authSource: 'pi-runtime-api-key', modelsSelection: null },
        agent: agentFacts,
      };
      const prepared: PreparedAgent = {
        snapshot,
        async execute(input: AgentExecutionInput, _runSignal) {
          record.busy = true;
          history.saveUser(nativeSessionId, input);
          const outcome: AgentNativeOutcome = {
            text: input.text === 'first invoice summary' ? '发票 INV-1，金额 100 元，缺少日期。' : '根据上文，缺少开票日期。',
            partial: false, stopReason: 'stop', responseId: `response-${input.runId}`, responseModel: receivedConfig.modelRef.model,
            error: null, usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: '2026-09-24T00:00:00.000Z' },
            tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
            stopped: true, cleanupErrors: [], agent: { nativeSessionId, turnCount: 1, modelCallCount: 1 },
          };
          history.saveResult(nativeSessionId, input, outcome);
          record.busy = false;
          return outcome;
        },
      };
      return ok(prepared);
    },
    async releaseSession(nativeSessionId) {
      if (failSessionRelease) return { stopped: false, closed: false, errors: [appError('fixture_release_failed', 'session', 'fixture', true)] };
      released.push(nativeSessionId); records.delete(nativeSessionId); return { stopped: true, closed: true, errors: [] };
    },
    async close() { records.clear(); return { stopped: true, closed: true, errors: [] }; },
  };
  const provider: ProviderPort = {
    async prepare() { return { ok: false, error: appError('unused', 'provider', 'unused', false) }; },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  };
  const runtime = new RuntimeService({ memory: opened.data.memory, runs: opened.data.runs, sessions: opened.data.sessions, sessionInputs: opened.data.sessionInputs, agent, provider,
    log: { write: () => undefined, close: async () => undefined }, now: () => '2026-09-24T00:00:00.000Z', monotonicNow: () => performance.now() });
  const sessionRepository: SessionRepository = options.failSessionInsert ? {
    ...opened.data.sessions,
    create: () => ({ ok: false, error: appError('storage_write_failed', 'storage', 'fixture session insert failure', true) }),
    get: (sessionId) => opened.data.sessions.get(sessionId),
    list: (request) => opened.data.sessions.list(request),
    rename: (input) => opened.data.sessions.rename(input),
    isModelUseBlocked: (sessionId) => opened.data.sessions.isModelUseBlocked(sessionId),
    revokeDocumentUse: (input) => opened.data.sessions.revokeDocumentUse(input),
    prepareDelete: (sessionId, at) => opened.data.sessions.prepareDelete(sessionId, at),
    delete: (sessionId, at) => opened.data.sessions.delete(sessionId, at),
  } : opened.data.sessions;
  const sessionService = new SessionService(sessionRepository, agent, () => runtime.state(), () => '2026-09-24T00:00:00.000Z', opened.data.runs, opened.data.memory,
    opened.data.sessionInputs, (request, submission, control) => runtime.start(request, control, submission));
  const promptTrace: PromptTraceBuffer = {
    begin() {}, append() {}, end() {}, clearSession(sessionId) { clearedTraceSessions.push(sessionId); },
    query() { if (options.failTraceQuery) throw new Error('diagnostic source failed'); return { availability: 'not-started', calls: [], droppedCalls: 0 }; },
  };
  const app = makeApplication(runtime, opened.data.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessionService, promptTrace);
  return { app, db: opened.data, runtime, promptTrace, counts: () => ({ created, preparations }), released, clearedTraceSessions,
    setReleaseFailure(value: boolean) { failSessionRelease = value; } };
}

describe('P2 Application Agent entry', () => {
  it('rejects invalid message queries and reports legacy native history without preparing a model', async () => {
    const { app, counts } = harness({ legacyHistory: true });
    const created = await app.createSession({});
    if (!created.ok) throw new Error(created.error.message);
    expect(typeof app.listSessionMessages).toBe('function');
    expect(await app.listSessionMessages({ sessionId: 0 })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await app.listSessionMessages({ sessionId: created.data.sessionId })).toMatchObject({ ok: true, data: { items: [], entryCount: 0, leafId: null, session: { historyState: 'legacy-read-only' } } });
    expect(counts()).toEqual({ created: 1, preparations: 0 });
  });
  it('creates persistent Session identity without preparing a model and runs same-Session follow-up as a new Run', async () => {
    const { app, db, counts } = harness();
    const created = await app.createSession({});
    expect(created).toMatchObject({ ok: true, data: { sessionId: 1, nativeSessionId: 'native-1', availability: 'ready' } });
    expect(counts()).toEqual({ created: 1, preparations: 0 });
    expect(db.runs.listBySession({ sessionId: 1, limit: 50 })).toMatchObject({ ok: true, data: { items: [] } });

    const sessionId = created.ok ? created.data.sessionId : 0;
    const finishFirst = deferred<void>();
    const first = await app.startRun({ sessionId, text: 'first invoice summary', config }, { onEvent(event) {
      if (event.type === 'run_finished') finishFirst.resolve();
    } });
    expect(first).toMatchObject({ ok: true, data: { runId: 1, sessionId } });
    await finishFirst.promise;
    expect(await app.queryRun(1)).toMatchObject({ ok: true, data: { kind: 'agent', status: 'completed', sessionId, output: { text: '发票 INV-1，金额 100 元，缺少日期。' } } });

    const finishSecond = deferred<void>();
    const second = await app.startRun({ sessionId, text: '根据上文还缺什么？', config }, { onEvent(event) {
      if (event.type === 'run_finished') finishSecond.resolve();
    } });
    expect(second).toMatchObject({ ok: true, data: { runId: 2, sessionId } });
    await finishSecond.promise;
    expect(await app.listSessionRuns({ sessionId, limit: 20 })).toMatchObject({ ok: true, data: { items: [
      { runId: 2, sessionId, status: 'completed' }, { runId: 1, sessionId, status: 'completed' },
    ] } });
    expect(await app.listSessions()).toMatchObject({ ok: true, data: { items: [{ sessionId, availability: 'ready' }] } });
    expect(counts()).toEqual({ created: 1, preparations: 2 });
  });

  it('rejects malformed public inputs before a Run reaches Runtime', async () => {
    const { app, db, counts } = harness();
    const created = await app.createSession();
    if (!created.ok) throw new Error('fixture session failed');
    expect(await app.startRun({ sessionId: created.data.sessionId, text: '   ', config })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await app.querySession(-1)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(db.runs.listBySession({ sessionId: created.data.sessionId, limit: 50 })).toMatchObject({ ok: true, data: { items: [] } });
    expect(counts()).toEqual({ created: 1, preparations: 0 });
  });

  it('releases an unregistered native Session when the metadata insert fails', async () => {
    const { app, counts, released } = harness({ failSessionInsert: true });

    expect(await app.createSession()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(await app.listSessions()).toMatchObject({ ok: true, data: { items: [] } });
    expect(counts()).toEqual({ created: 1, preparations: 0 });
    expect(released).toEqual(['native-1']);
  });

  it('renames without changing native identity or creating a Run', async () => {
    const { app, counts } = harness();
    const created = await app.createSession({ title: 'Invoice' });
    if (!created.ok) throw new Error('fixture session failed');
    const renamed = await app.renameSession({ sessionId: created.data.sessionId, title: '  Review invoice  ' });
    expect(renamed).toMatchObject({ ok: true, data: { sessionId: created.data.sessionId, nativeSessionId: 'native-1', title: 'Review invoice' } });
    expect(counts()).toEqual({ created: 1, preparations: 0 });
  });

  it('deletes only the target Session and leaves it archived for retry when native release fails', async () => {
    const { app, clearedTraceSessions, released, setReleaseFailure } = harness({ failSessionRelease: true });
    const first = await app.createSession({ title: 'First' });
    const second = await app.createSession({ title: 'Second' });
    if (!first.ok || !second.ok) throw new Error('fixture sessions failed');

    const deleting = app.deleteSession(second.data.sessionId);
    expect(await app.deleteSession(second.data.sessionId)).toMatchObject({ ok: false, error: { code: 'session_busy' } });
    const third = await app.createSession({ title: 'Unrelated' });
    expect(third).toMatchObject({ ok: true, data: { sessionId: 3, nativeSessionId: 'native-3' } });
    expect(await deleting).toMatchObject({ ok: false, error: { code: 'session_delete_incomplete' } });
    expect(await app.listSessions({ limit: 10 })).toMatchObject({ ok: true, data: { items: [
      { sessionId: 3, status: 'active' },
      { sessionId: second.data.sessionId, status: 'archived' },
      { sessionId: first.data.sessionId, status: 'active' },
    ] } });
    expect(clearedTraceSessions).toEqual([]);

    setReleaseFailure(false);
    expect(await app.deleteSession(second.data.sessionId)).toEqual({ ok: true, data: { deletedSessionId: second.data.sessionId, disposition: 'permanent' } });
    expect(await app.listSessions({ limit: 10 })).toMatchObject({ ok: true, data: { items: [
      { sessionId: 3, status: 'active' }, { sessionId: first.data.sessionId, status: 'active' },
    ] } });
    expect(clearedTraceSessions).toEqual([second.data.sessionId]);
    expect(released).toEqual(['native-2']);
  });

  it('reports an unavailable Trace source without changing the saved Run', async () => {
    const { app, db } = harness({ failTraceQuery: true });
    const session = await app.createSession();
    if (!session.ok) throw new Error('fixture session failed');
    const finished = deferred<void>();
    const accepted = await app.startRun({ sessionId: session.data.sessionId, text: 'source failure is diagnostic only', config }, { onEvent(event) {
      if (event.type === 'run_finished') finished.resolve();
    } });
    if (!accepted.ok) throw new Error('fixture run failed to start');
    await finished.promise;

    expect(await app.queryPromptTrace(accepted.data.runId)).toMatchObject({ ok: true, data: { availability: 'source-unavailable', calls: [] } });
    expect(await app.queryRun(accepted.data.runId)).toMatchObject({ ok: true, data: { kind: 'agent', status: 'completed' } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'completed' } });
  });

  it('uses the boot Run boundary only for missing old Agent diagnostics', async () => {
    const { app, db, runtime, promptTrace } = harness();
    const session = await app.createSession();
    if (!session.ok) throw new Error(session.error.message);
    const finished = deferred<void>();
    const accepted = await app.startRun({ sessionId: session.data.sessionId, text: 'trace boundary', config }, { onEvent(event) {
      if (event.type === 'run_finished') finished.resolve();
    } });
    if (!accepted.ok) throw new Error(accepted.error.message);
    await finished.promise;
    const runId = accepted.data.runId;
    const restarted = makeApplication(runtime, db.runs, async () => ({ stopped: true, closed: true, errors: [] }),
      undefined, promptTrace, undefined, undefined, undefined, runId);
    expect(await app.queryPromptTrace(runId)).toMatchObject({ ok: true, data: { availability: 'not-started' } });
    expect(await restarted.queryPromptTrace(runId)).toMatchObject({ ok: true, data: { availability: 'process-exited', droppedCalls: null } });

    db.db.query("UPDATE runs SET output_json=json_set(output_json,'$.agent.modelCallCount',0) WHERE id=?").run(runId);
    expect(await restarted.queryPromptTrace(runId)).toMatchObject({ ok: true, data: { availability: 'not-started', droppedCalls: 0 } });
    for (const availability of ['available', 'evicted'] as const) {
      promptTrace.query = () => ({ availability, calls: [], droppedCalls: 2 });
      expect(await restarted.queryPromptTrace(runId)).toMatchObject({ ok: true, data: { availability, droppedCalls: 2 } });
    }
    await app.callProvider({ goal: 'Trace classification', text: 'provider failure fixture', config, timeoutMs: 60_000, stopGraceMs: 2_000 });
    expect(await restarted.queryPromptTrace(runId + 1)).toMatchObject({ ok: true, data: { availability: 'not-collected', droppedCalls: null } });
  });
});
