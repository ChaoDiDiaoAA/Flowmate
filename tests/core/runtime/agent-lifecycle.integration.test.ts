import { mkdtempSync, waitFor } from '../../support/resources.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { appError, fail, ok, ToolExecutionFailure } from '@flowmate/contracts';
import type {
  AgentInputDispatch,
  P5ChatAgentConfigFacts,
  AgentExecutionInput,
  AgentNativeOutcome,
  AgentPort,
  AgentRunEvent,
  PreparedAgent,
  ProviderConfig,
  ProviderRequest,
  Result,
  SafeConfigSnapshot,
  SessionInputAccepted,
} from '@flowmate/contracts';
import { z } from 'zod';
import { makeApplication } from '../../../packages/core/src/application.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createToolRecorder } from '../../../packages/core/src/tools/recorder.ts';
import type { RunRepository } from '../../../packages/core/src/storage/repositories.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { openTestDatabase } from '../../support/database.ts';
import type { ProviderPort } from '@flowmate/contracts';
import { createAgentHistoryFixture } from '../application/agent-history-fixture.ts';
import { createTestWorkspaceVerifier } from '../../support/workspace.ts';

const config: ProviderConfig = {
  version: 1,
  name: 'fixture',
  revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};
const snapshot: SafeConfigSnapshot & { agent: P5ChatAgentConfigFacts } = {
  version: 1,
  name: config.name,
  revision: config.revision,
  requestedModel: config.modelRef,
  resolvedModel: config.modelRef,
  api: 'openai-completions',
  endpoint: null,
  sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: config.parameters,
  limits: { timeoutMs: 1000, stopGraceMs: 100 },
  native: { authSource: 'pi-native', modelsSelection: null },
  agent: {
    policyVersion: 'p5-session-inputs-v1', nativeSessionId: 'native-1', systemPrompt: 'fixture prompt',
    thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 524_288,
    maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12, sessionRetry: false,
  },
};
const nativeOutcome: AgentNativeOutcome = {
  text: '发票号为 INV-204，金额 580 元，缺少开票日期。', partial: false, stopReason: 'stop',
  responseId: 'fixture-response', responseModel: 'deepseek-v4-flash', error: null,
  usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: '2026-09-24T00:00:00.000Z' },
  tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
  stopped: true, cleanupErrors: [],
  agent: { nativeSessionId: 'native-1', turnCount: 1, modelCallCount: 1 },
};
const request = { sessionId: 1, text: '发票 INV-204，金额 580 元。', config, timeoutMs: 1000, stopGraceMs: 100 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function finishSignal() {
  const done = deferred<AgentRunEvent>();
  return { done, onEvent: (event: AgentRunEvent) => { if (event.type === 'run_finished') done.resolve(event); } };
}

function tempPaths(root: string) {
  return {
    root,
    databaseFile: join(root, 'data', 'test.sqlite'),
    logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-agent-lifecycle-'));
  const opened = openTestDatabase(tempPaths(root));
  if (!opened.ok) throw new Error(opened.error.message);
  const fixtureHistory = createAgentHistoryFixture(root, () => '2026-09-24T00:00:00.000Z');
  const nativeHistory = fixtureHistory.create('native-1');
  const session = opened.data.sessions.create({ nativeSessionId: 'native-1', title: 'Invoice chat', at: '2026-09-24T00:00:00.000Z', nativeHistory });
  if (!session.ok) throw new Error(session.error.code);
  fixtureHistory.watchSession('native-1', (history, context) => opened.data.sessions.saveHistory(session.data.sessionId, history, context));
  const deps = {
    fixtureHistory,
    runs: opened.data.runs,
    sessions: opened.data.sessions,
    sessionInputs: opened.data.sessionInputs,
    provider: {
      async prepare() { throw new Error('provider must not be called'); },
      async close() { return { stopped: true, closed: true, errors: [] as const }; },
    } satisfies ProviderPort,
    log: { write: () => undefined, close: async () => undefined },
    now: () => '2026-09-24T00:00:00.000Z',
    monotonicNow: () => performance.now(),
  };
  return { db: opened.data, deps, root };
}

function makeAgent(history: ReturnType<typeof createAgentHistoryFixture>, options: {
  execute?: (input: AgentExecutionInput, signal: AbortSignal) => Promise<AgentNativeOutcome>;
  prepare?: (signal: AbortSignal) => Promise<Result<PreparedAgent>>;
  inspection?: ReturnType<AgentPort['inspect']>;
  close?: () => Promise<{ stopped: boolean; closed: boolean; errors: readonly [] }>;
} = {}): AgentPort {
  const prepare = options.prepare ?? (async () => ok({
    snapshot,
    execute: async (input, signal) => options.execute?.(input, signal) ?? nativeOutcome,
  }));
  return {
    createSession: () => ok({ nativeSessionId: 'native-2' }),
    inspect: (nativeSessionId) => options.inspection ?? ({
      availability: nativeSessionId === 'native-1' ? 'ready' : 'missing',
    }),
    prepare: async (nativeSessionId, _config, _limits, signal) => {
      const prepared = await prepare(signal);
      if (!prepared.ok) return prepared;
      return ok({ ...prepared.data, execute: async (input, runSignal, observe) => {
        history.saveUser(nativeSessionId, input);
        const outcome = await prepared.data.execute(input, runSignal, observe);
        history.saveResult(nativeSessionId, input, outcome, !runSignal.aborted);
        return outcome;
      } });
    },
    releaseSession: async () => ({ stopped: true, closed: true, errors: [] }),
    close: options.close ?? (async () => ({ stopped: true, closed: true, errors: [] })),
  };
}

describe('RuntimeService Agent lifecycle', () => {
  it('rejects a new Workspace Run with missing verification before storing or preparing it', async () => {
    const { db, deps } = fixture();
    let preparations = 0;
    const agent = makeAgent(deps.fixtureHistory, { prepare: async () => { preparations++; return ok({ snapshot, execute: async () => nativeOutcome }); } });
    const runtime = new RuntimeService({ ...deps, agent });
    expect(await runtime.start({ ...request, workspace: { revision: 0, sessionId: 1, documentRef: null, jobId: null, candidateRef: null } }))
      .toMatchObject({ ok: false, error: { code: 'workspace_unavailable' } });
    expect(preparations).toBe(0);
    expect(db.db.query('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(db.db.query('SELECT count(*) AS count FROM session_inputs').get()).toEqual({ count: 0 });
    await runtime.close(); db.close();
  });

  it.each([false, true])('keeps pure Chat input use available and requires verification for consistent empty Workspace (verifier=%s)', async hasVerifier => {
    for (const scopeVersion of [1, 2] as const) {
      const { db, deps, root } = fixture();
      let checked: Result<void> | undefined;
      const agent = makeAgent(deps.fixtureHistory, { execute: async input => {
        if (scopeVersion === 2) {
          const run = db.runs.get(input.runId), saved = db.sessionInputs.get(input.inputId!);
          if (!run.ok || !saved.ok || !saved.data) throw new Error('Saved admission is required.');
          const workspaceContext = { formatVersion: 1, revision: 0, sessionId: 1, documentRef: null,
            jobId: null, candidateRef: null, activeView: 'candidate', selection: null };
          const workspaceInput = { documentRef: null, job: null, candidate: null };
          db.db.query('UPDATE runs SET scope_json=?,input_json=?,config_json=? WHERE id=?').run(JSON.stringify({ version: 2,
            allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] }),
          JSON.stringify({ ...run.data.input, version: 2, workspaceInput }), JSON.stringify({ ...run.data.config, workspaceContext }), input.runId);
          db.db.query('UPDATE session_inputs SET content_json=? WHERE id=?').run(JSON.stringify({ ...saved.data.content,
            workspaceContext, workspaceInput }), input.inputId!);
        }
        checked = input.verifyInputUse!(input.inputId!);
        return { ...nativeOutcome, error: checked.ok ? null : checked.error, stopReason: checked.ok ? 'stop' : 'error' };
      } });
      const runtime = new RuntimeService({ ...deps, agent,
        ...(hasVerifier ? { workspaceVerifier: createTestWorkspaceVerifier(db, root) } : {}) });
      const finished = finishSignal();
      expect((await runtime.start(request, finished)).ok).toBe(true);
      await finished.done.promise;
      expect(checked).toMatchObject(scopeVersion === 1 || hasVerifier ? { ok: true }
        : { ok: false, error: { code: 'workspace_unavailable' } });
      await runtime.close(); db.close();
    }
  });

  it.each([false, true])('rejects contradictory authoritative Scope and saved input before native delivery (verifier=%s)', async hasVerifier => {
    for (const contradiction of ['chat-with-context', 'workspace-without-context'] as const) {
      const { db, deps, root } = fixture();
      let delivered = 0;
      let checked: Result<void> | undefined;
      const agent = { ...makeAgent(deps.fixtureHistory), prepare: async () => ok({ snapshot,
        execute: async (input: AgentExecutionInput) => {
          const saved = db.sessionInputs.get(input.inputId!);
          if (!saved.ok || !saved.data) throw new Error('Expected a saved input.');
          if (contradiction === 'chat-with-context') {
            db.db.query('UPDATE session_inputs SET content_json=? WHERE id=?').run(JSON.stringify({ ...saved.data.content,
              workspaceContext: { formatVersion: 1, revision: 0, sessionId: 1, documentRef: null, jobId: null,
                candidateRef: null, activeView: 'candidate', selection: null },
              workspaceInput: { documentRef: null, job: null, candidate: null } }), input.inputId!);
          } else {
            db.db.query('UPDATE runs SET scope_json=? WHERE id=?').run(JSON.stringify({ version: 2,
              allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] }), input.runId);
          }
          checked = input.verifyInputUse!(input.inputId!);
          if (checked.ok) delivered++;
          return { ...nativeOutcome, error: checked.ok ? null : checked.error, stopReason: checked.ok ? 'stop' : 'error' };
        } }) } satisfies AgentPort;
      const runtime = new RuntimeService({ ...deps, agent,
        ...(hasVerifier ? { workspaceVerifier: createTestWorkspaceVerifier(db, root) } : {}) });
      const finished = finishSignal();
      expect((await runtime.start(request, finished)).ok).toBe(true);
      await finished.done.promise;
      expect(checked).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
      expect(delivered).toBe(0);
      await runtime.close(); db.close();
    }
  });
  it('keeps admitted Run limits when prepared Agent facts report different limits', async () => {
    const { db, deps } = fixture();
    let remainingMs = 0;
    const agent = makeAgent(deps.fixtureHistory, { prepare: async () => ok({
      snapshot: { ...snapshot, limits: { timeoutMs: 100, stopGraceMs: 100 } },
      execute: async input => { remainingMs = input.remainingRunMs?.() ?? 0; return nativeOutcome; },
    }) });
    const runtime = new RuntimeService({ ...deps, agent });
    const finished = finishSignal();
    const accepted = await runtime.start({ ...request, timeoutMs: 90_000, stopGraceMs: 200 }, { onEvent: finished.onEvent });
    if (!accepted.ok) throw new Error(accepted.error.code);
    await finished.done.promise;
    expect(remainingMs).toBeGreaterThan(80_000);
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { config: {
      limits: { timeoutMs: 90_000, stopGraceMs: 200 } } } });
    await runtime.close(); db.close();
  });
  it('freezes Settings then explicit budget and looks up the original input before reading changed defaults', async () => {
    const { db, deps } = fixture();
    let settingsReads = 0;
    let defaults = { timeoutMs: 90_000, stopGraceMs: 200,
      budget: { maxModelCalls: 32, maxToolCalls: 40, toolTimeoutMs: 20_000 } };
    let executed: AgentExecutionInput | undefined;
    const baseAgent = makeAgent(deps.fixtureHistory, { execute: async input => { executed = input; return nativeOutcome; } });
    const agent: AgentPort = { ...baseAgent, prepare: async (...args) => {
      const result = await baseAgent.prepare(...args);
      if (!result.ok) return result;
      const budget = args[4]!.runtimeBudget!;
      return ok({ ...result.data, snapshot: { ...result.data.snapshot, version: 2, limits: args[2], runtimeBudget: budget,
        agent: { ...snapshot.agent, policyVersion: 'runtime-v1', taskPolicyVersion: 'p5-session-inputs-v1', ...budget } } });
    } };
    const runtime = new RuntimeService({ ...deps, agent, runtimeDefaults: () => { settingsReads++; return ok(defaults); } });
    const sessions = new SessionService(db.sessions, agent, () => runtime.state(), deps.now, db.runs, db.sessionInputs,
      (runRequest, input, control) => runtime.start(runRequest, control, input), input => runtime.appendInput(input));
    const app = makeApplication(runtime, db.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessions);
    const input = { sessionId: 1, mode: 'prompt' as const, clientSequence: 1, text: 'Budgeted invoice', config,
      budget: { maxModelCalls: 64 } };
    const finished = finishSignal();
    const first = await app.submitInput(input, { onEvent: finished.onEvent });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.code);
    await finished.done.promise;
    const run = await app.queryRun(first.data.runId);
    expect(run).toMatchObject({ ok: true, data: { config: { version: 2,
      limits: { timeoutMs: 90_000, stopGraceMs: 200 },
      runtimeBudget: { maxModelCalls: 64, maxToolCalls: 0, toolTimeoutMs: 20_000 } }, output: { version: 2 } } });
    expect(executed?.runtimeBudget).toEqual({ maxModelCalls: 64, maxToolCalls: 0, toolTimeoutMs: 20_000 });
    expect(executed?.remainingRunMs?.()).toBeGreaterThan(0);
    expect(settingsReads).toBe(1);
    defaults = { timeoutMs: 100, stopGraceMs: 100, budget: { maxModelCalls: 1, maxToolCalls: 100, toolTimeoutMs: 100 } };
    expect(await app.submitInput(input)).toEqual(first);
    expect(settingsReads).toBe(1);
    expect(await app.submitInput({ ...input, budget: { maxModelCalls: 32 } })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(settingsReads).toBe(1);
    const queried = db.sessionInputs.get(first.data.inputId);
    expect(queried).toMatchObject({ ok: true, data: { content: { version: 2, requestIdentityVersion: 1,
      originalBudgetOverrides: { budget: { maxModelCalls: 64 } } } } });
    const nextFinished = finishSignal();
    const next = await app.submitInput({ sessionId: 1, clientSequence: 2, mode: 'prompt', text: 'Next invoice', config },
      { onEvent: nextFinished.onEvent });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(next.error.code);
    await nextFinished.done.promise;
    expect(settingsReads).toBe(2);
    expect(await app.queryRun(next.data.runId)).toMatchObject({ ok: true, data: { config: {
      limits: { timeoutMs: 100, stopGraceMs: 100 }, runtimeBudget: { maxModelCalls: 1, maxToolCalls: 0, toolTimeoutMs: 100 } } } });
    expect(await app.queryRun(first.data.runId)).toEqual(run);
    await app.close(); db.close();
  });
  it('never prepares or executes an Agent when the initial Agent Run insert fails', async () => {
    const { db, deps } = fixture();
    const runs = new Proxy(db.runs as RunRepository, {
      get(target, key, receiver) {
        if (key === 'createAgent') return () => ({ ok: false, error: appError('storage_write_failed', 'storage', 'fixture insert failure', true) });
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let prepared = false;
    let events = 0;
    const service = new RuntimeService({ ...deps, runs, agent: makeAgent(deps.fixtureHistory, { prepare: async () => {
      prepared = true;
      return ok({ snapshot, execute: async () => nativeOutcome });
    } }) });

    expect(await service.start(request, { onEvent: () => { events += 1; } })).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(prepared).toBe(false);
    expect(events).toBe(0);
    expect(db.runs.get(1)).toMatchObject({ ok: false, error: { code: 'run_not_found' } });
    expect(service.state()).toMatchObject({ active: null, blocked: false });
  });

  it('reserves the shared execution slot before the created callback and commits the Agent Run', async () => {
    const { db, deps } = fixture();
    const requestProvider: ProviderRequest = { goal: 'provider', text: 'text', config, timeoutMs: 100, stopGraceMs: 100 };
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, ) });
    const finished = finishSignal();
    let reentrant: Awaited<ReturnType<RuntimeService['callProvider']>> | undefined;
    const accepted = await service.start(request, { onEvent: (event) => {
      finished.onEvent(event);
      if (event.type === 'run_progress' && event.phase === 'created') {
        void service.callProvider(requestProvider).then((result) => { reentrant = result; });
      }
    } });
    expect(accepted).toMatchObject({ ok: true, data: { runId: 1, sessionId: 1 } });
    for (let attempt = 0; attempt < 20 && !reentrant; attempt += 1) await Promise.resolve();
    expect(reentrant).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    await finished.done.promise;
    const runId = accepted.ok ? accepted.data.runId : 0;
    const row = db.runs.get(runId);
    expect(row).toMatchObject({ ok: true, data: { kind: 'agent', sessionId: 1, status: 'completed', output: { text: nativeOutcome.text } } });
    expect(service.state()).toMatchObject({ active: null, blocked: false });
    expect(service.cancel(runId)).toMatchObject({ ok: true, data: { accepted: false } });
    expect(service.cancel(999)).toMatchObject({ ok: false, error: { code: 'run_not_found' } });
    const secondFinished = finishSignal();
    const second = await service.start({ ...request, text: '上面这张发票还缺少什么？' }, secondFinished);
    expect(second).toMatchObject({ ok: true, data: { runId: 2, sessionId: 1 } });
    await secondFinished.done.promise;
    expect(db.runs.listBySession({ sessionId: 1, limit: 50 })).toMatchObject({ ok: true, data: { items: [
      { runId: 2, kind: 'agent', sessionId: 1, status: 'completed' },
      { runId: 1, kind: 'agent', sessionId: 1, status: 'completed' },
    ] } });
  });

  it('lets the first cancellation win, waits for actual stop, and stores cancellation', async () => {
    const work = deferred<AgentNativeOutcome>();
    const entered = deferred<void>();
    const finished = finishSignal();
    const { db, deps } = fixture();
    db.sessions.create({ nativeSessionId: 'native-other-session', title: 'Other Session', at: '2026-09-24T00:00:00.000Z',
      nativeHistory: deps.fixtureHistory.create('native-other-session') });
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, { execute: () => { entered.resolve(); return work.promise; } }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await entered.promise;
    expect(await service.start({ ...request, sessionId: 2 })).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    const cancelled = service.cancel(accepted.data.runId);
    expect(cancelled).toMatchObject({ ok: true, data: { accepted: true } });
    expect(service.cancel(accepted.data.runId)).toMatchObject({ ok: true, data: { accepted: false } });
    work.resolve(nativeOutcome);
    await finished.done.promise;
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'cancelled', stoppedAt: '2026-09-24T00:00:00.000Z', output: { text: nativeOutcome.text }, error: { code: 'agent_cancelled' } } });
  });

  it('supplements only compatible usage after an unconfirmed stop and keeps the terminal output fixed', async () => {
    const work = deferred<AgentNativeOutcome>();
    const entered = deferred<void>();
    const finished = finishSignal();
    const { db, deps } = fixture();
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, { execute: () => { entered.resolve(); return work.promise; } }) });
    const accepted = await service.start({ ...request, stopGraceMs: 100 }, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await entered.promise;
    expect(service.cancel(accepted.data.runId)).toMatchObject({ ok: true, data: { accepted: true } });
    await finished.done.promise;
    const before = db.runs.get(accepted.data.runId);
    expect(before).toMatchObject({ ok: true, data: { status: 'failed', output: null, stoppedAt: null } });
    work.resolve({
      ...nativeOutcome,
      usage: {
        ...nativeOutcome.usage,
        source: 'sdk', reason: null,
        sdkValues: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0 },
        attempts: 1,
      },
      tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: '0', usageComplete: true },
    });
    await waitFor(async () => { const row = db.runs.get(accepted.data.runId); return row.ok && row.data.tokens.totalTokens === 3; }, 1000);
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: {
      status: 'failed', output: null, stoppedAt: null,
      usage: { source: 'sdk', sdkValues: { totalTokens: 3 } }, tokens: { totalTokens: 3 },
    } });
    expect(service.state()).toMatchObject({ blocked: true });
  });

  it('poisons the runtime when a stopped Agent outcome cannot be persisted', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    const failedRuns = new Proxy(db.runs as RunRepository, {
      get(target, key, receiver) {
        if (key === 'finish') return () => ({ ok: false, error: appError('storage_write_failed', 'storage', 'fixture write failure', true) });
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new RuntimeService({ ...deps, runs: failedRuns, agent: makeAgent(deps.fixtureHistory, ) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const terminalEvent = await finished.done.promise;
    expect(terminalEvent).toMatchObject({ type: 'run_finished', result: { ok: false, runId: accepted.data.runId,
      error: { code: 'storage_write_failed', runId: accepted.data.runId } } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'running', endedAt: null } });
    expect(service.state()).toMatchObject({ active: null, blocked: true, error: { code: 'runtime_unusable' } });
    expect(await service.start(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
  });

  it('records stop as unconfirmed after the single grace window and never reuses the runtime', async () => {
    const entered = deferred<void>();
    const finished = finishSignal();
    const { db, deps } = fixture();
    const short = { ...request, stopGraceMs: 100 };
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, { execute: async () => { entered.resolve(); return new Promise<AgentNativeOutcome>(() => undefined); } }) });
    const accepted = await service.start(short, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await entered.promise;
    service.cancel(accepted.data.runId);
    await finished.done.promise;
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: {
      status: 'failed', stoppedAt: null, cleanup: { stopped: false, errors: [{ code: 'stop_unconfirmed' }] },
    } });
    expect(service.state()).toMatchObject({ blocked: true });
    expect(await service.start(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
  });

  it('does not run the prompt when saving the running snapshot fails', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    const runs = new Proxy(db.runs as RunRepository, {
      get(target, key, receiver) {
        if (key === 'start') return () => ({ ok: false, error: appError('storage_write_failed', 'storage', 'fixture write failure', true) });
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let prompted = false;
    const service = new RuntimeService({ ...deps, runs, agent: makeAgent(deps.fixtureHistory, { execute: async () => { prompted = true; return nativeOutcome; } }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    const end = await finished.done.promise;
    expect(prompted).toBe(false);
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: false, error: { code: 'storage_write_failed', runId: 1 } } });
    if (!accepted.ok) return;
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed', startedAt: null, error: { code: 'storage_write_failed' } } });
    expect(service.state()).toMatchObject({ blocked: true });
  });

  it('allows the selected model to change for an existing native Session', async () => {
    const { db, deps } = fixture();
    const changedConfig = { ...config, modelRef: { provider: 'other', model: 'model' } };
    const changedSnapshot = { ...snapshot, requestedModel: changedConfig.modelRef };
    const finished = finishSignal();
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, {
      prepare: async () => ok({ snapshot: changedSnapshot, execute: async () => nativeOutcome }),
      inspection: {
        availability: 'ready',
      },
    }) });
    const accepted = await service.start({ ...request, config: changedConfig }, finished);
    expect(accepted.ok).toBe(true);
    expect((await finished.done.promise).type).toBe('run_finished');
    expect(db.runs.listBySession({ sessionId: 1, limit: 50 })).toMatchObject({ ok: true, data: { items: [{ config: { requestedModel: changedConfig.modelRef } }] } });
  });

  it('rejects unavailable in-memory history without creating a Run', async () => {
    const { db, deps } = fixture();
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, { inspection: {
      availability: 'missing',
    } }) });
    expect(await service.start(request)).toMatchObject({ ok: false, error: { code: 'session_history_unavailable' } });
    expect(db.runs.listBySession({ sessionId: 1, limit: 50 })).toMatchObject({ ok: true, data: { items: [] } });
  });

  it('finalizes a settled preparation error without starting the native prompt', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    let prompted = false;
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, {
      prepare: async () => ({ ok: false, error: appError('agent_auth_missing', 'runtime', 'No credential', false) }),
      execute: async () => { prompted = true; return nativeOutcome; },
    }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const end = await finished.done.promise;
    expect(prompted).toBe(false);
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'failed', stopped: true, error: { code: 'agent_auth_missing' } } } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed', startedAt: null } });
    expect(service.state()).toMatchObject({ blocked: false, active: null });
  });

  it('blocks reuse when Agent preparation reports that stopping is unconfirmed', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, {
      prepare: async () => ({ ok: false, error: appError('stop_unconfirmed', 'runtime', 'fixture cleanup uncertainty', true) }),
    }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(await finished.done.promise).toMatchObject({ type: 'run_finished', result: { ok: true, data: {
      status: 'failed', stopped: false, error: { code: 'stop_unconfirmed' },
    } } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: {
      status: 'failed', stoppedAt: null, cleanup: { stopped: false, errors: [{ code: 'stop_unconfirmed' }] },
    } });
    expect(service.state()).toMatchObject({ blocked: true });
  });

  it('preserves cancel intent in the terminal transaction when the initial cancel write fails', async () => {
    const work = deferred<AgentNativeOutcome>();
    const entered = deferred<void>();
    const finished = finishSignal();
    const { db, deps } = fixture();
    const runs = new Proxy(db.runs as RunRepository, {
      get(target, key, receiver) {
        if (key === 'recordCancel') return () => ({ ok: false, error: appError('storage_write_failed', 'storage', 'fixture cancel write failure', true) });
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new RuntimeService({ ...deps, runs, agent: makeAgent(deps.fixtureHistory, { execute: () => { entered.resolve(); return work.promise; } }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await entered.promise;
    const cancellation = service.cancel(accepted.data.runId);
    work.resolve(nativeOutcome);
    const end = await finished.done.promise;
    expect(cancellation).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: false, error: { code: 'storage_write_failed' } } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: {
      status: 'cancelled', cancelRequestedAt: '2026-09-24T00:00:00.000Z', stoppedAt: '2026-09-24T00:00:00.000Z',
    } });
    expect(service.state()).toMatchObject({ blocked: true });
  });

  it('fails the Run when the native Agent returns a non-mechanical completion', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, { execute: async () => ({
      ...nativeOutcome, agent: { ...nativeOutcome.agent, modelCallCount: 13 },
    }) }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const end = await finished.done.promise;
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: true, data: {
      status: 'failed', stopped: true, error: { code: 'agent_mechanical_check_failed' },
    } } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'agent_mechanical_check_failed' } } });
  });

  it('stores a settled model error as failed while keeping the runtime available', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    const modelError = appError('provider_model_error', 'provider', 'fixture model error', true);
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, { execute: async () => ({
      ...nativeOutcome, text: '', stopReason: 'error', error: modelError,
    }) }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const end = await finished.done.promise;
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: true, data: {
      status: 'failed', stopped: true, error: { code: 'provider_model_error', runId: accepted.data.runId },
    } } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: {
      status: 'failed', stoppedAt: '2026-09-24T00:00:00.000Z', error: { code: 'provider_model_error' },
    } });
    expect(service.state()).toMatchObject({ blocked: false });
  });

  it('fails and blocks on native cleanup errors even when the prompt itself stopped', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    const cleanupError = appError('agent_cleanup_failed', 'runtime', 'fixture cleanup failure', true);
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, { execute: async () => ({
      ...nativeOutcome, cleanupErrors: [cleanupError],
    }) }) });
    const accepted = await service.start(request, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const end = await finished.done.promise;
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: true, data: {
      status: 'failed', stopped: true, error: { code: 'agent_cleanup_failed' },
    } } });
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: {
      status: 'failed', stoppedAt: '2026-09-24T00:00:00.000Z', cleanup: { errors: [{ code: 'agent_cleanup_failed' }] },
    } });
    expect(service.state()).toMatchObject({ blocked: true });
  });

  it('counts the Agent deadline during prepare and bounds stop waiting by one grace window', async () => {
    const preparing = deferred<Result<PreparedAgent>>();
    const entered = deferred<void>();
    const finished = finishSignal();
    const { db, deps } = fixture();
    let prompted = false;
    const service = new RuntimeService({ ...deps, agent: makeAgent(deps.fixtureHistory, {
      prepare: () => { entered.resolve(); return preparing.promise; },
      execute: async () => { prompted = true; return nativeOutcome; },
    }) });
    const accepted = await service.start({ ...request, timeoutMs: 100, stopGraceMs: 100 }, finished);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await entered.promise;
    const end = await finished.done.promise;
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'failed', stopped: false, error: { code: 'agent_timeout' } } } });
    expect(prompted).toBe(false);
    expect(db.runs.get(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'failed', startedAt: null, stoppedAt: null, cleanup: { errors: [{ code: 'stop_unconfirmed' }] } } });
    expect(service.state()).toMatchObject({ blocked: true, active: null });
    preparing.resolve(ok({ snapshot, execute: async () => nativeOutcome }));
  });

  it('closes Agent sessions before the Provider runtime', async () => {
    const { deps } = fixture();
    const order: string[] = [];
    const service = new RuntimeService({
      ...deps,
      agent: makeAgent(deps.fixtureHistory, { close: async () => { order.push('agent'); return { stopped: true, closed: true, errors: [] }; } }),
      provider: { ...deps.provider, close: async () => { order.push('provider'); return { stopped: true, closed: true, errors: [] }; } },
    });
    expect(await service.close()).toMatchObject({ stopped: true, closed: true });
    expect(order).toEqual(['agent', 'provider']);
  });
});

describe('P5 public input stopping and admission barriers', () => {
  it('blocks the Session when the final input audit fails after its saved result completed', async () => {
    const { db, deps } = fixture();
    let executions = 0;
    let auditReads = 0;
    const agent = makeAgent(deps.fixtureHistory, { execute: async () => { executions++; return nativeOutcome; } });
    const runtime = new RuntimeService({ ...deps, agent, sessionInputs: { ...db.sessionInputs, forRun(runId) {
      if (++auditReads === 2) return fail(appError('storage_read_failed', 'storage', 'Final input audit unavailable.', true));
      return db.sessionInputs.forRun(runId);
    } } });
    const sessions = new SessionService(db.sessions, agent, () => runtime.state(), deps.now, db.runs, db.sessionInputs,
      (runRequest, submission, control) => runtime.start(runRequest, control, submission), input => runtime.appendInput(input),
      id => runtime.verifySessionMutation(id));
    const app = makeApplication(runtime, db.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessions);
    const finished = finishSignal();
    const submitted = await app.submitInput({ ...request, clientSequence: 1, mode: 'prompt' }, finished);
    if (!submitted.ok) throw new Error(submitted.error.code);
    expect(await finished.done.promise).toMatchObject({ type: 'run_finished', result: { ok: true, data: {
      status: 'failed', stopped: true, error: { code: 'storage_read_failed' },
    } } });
    expect(auditReads).toBe(2);
    expect(await app.querySessionInput({ sessionId: 1, inputId: submitted.data.inputId })).toMatchObject({ ok: true, data: { input: {
      inputId: submitted.data.inputId, runId: submitted.data.runId, status: 'consumed', processingStatus: 'completed',
      nativeEntryId: `user-${submitted.data.inputId}`, resultEntryId: `assistant-${submitted.data.inputId}`, error: null,
    } } });
    expect(db.sessions.get(1)).toMatchObject({ ok: true, data: { nativeUnusable: true } });
    expect(await app.querySession(1)).toMatchObject({ ok: true, data: { availability: 'unusable' } });
    expect(await app.submitInput({ ...request, clientSequence: 2, mode: 'prompt' }))
      .toMatchObject({ ok: false, error: { code: 'agent_session_unusable' } });
    expect(executions).toBe(1);
    expect(db.db.query('SELECT id FROM runs WHERE session_id=?').all(1)).toEqual([{ id: submitted.data.runId }]);
    await app.close();
  });

  it.each(['failed-result', 'ledger-read-failure'] as const)('blocks unknown delivery when its audit encounters %s', async scenario => {
    const { db, deps } = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    let streaming = false;
    const agent: AgentPort = {
      ...makeAgent(deps.fixtureHistory),
      inspect: () => ({ availability: streaming ? 'busy' : 'ready' }),
      enqueueInput: async () => ok(undefined),
      async prepare(nativeId) {
        return ok({ snapshot, async execute(input, _signal, observe) {
          streaming = true;
          observe({ type: 'agent_event', at: deps.now(), monotonicMs: performance.now(), data: { eventName: 'agent_start' } });
          deps.fixtureHistory.saveUser(nativeId, input);
          entered.resolve(); await release.promise;
          deps.fixtureHistory.saveResult(nativeId, { ...input, completeInputResult: () => ok(undefined) }, nativeOutcome);
          if (scenario === 'failed-result') {
            const failed = db.sessionInputs.failResult(input.runId, [input.inputId!], `assistant-${input.inputId}`,
              appError('agent_goal_not_met', 'runtime', 'The first input did not meet its goal.', false, input.runId), deps.now());
            if (!failed.ok) throw new Error(failed.error.code);
          }
          streaming = false;
          return nativeOutcome;
        } });
      },
    };
    let rejectRead = scenario === 'ledger-read-failure';
    const runtime = new RuntimeService({ ...deps, agent, sessionInputs: { ...db.sessionInputs, forRun(runId) {
      if (rejectRead) { rejectRead = false; return fail(appError('storage_read_failed', 'storage', 'Transient input audit failure.', true)); }
      return db.sessionInputs.forRun(runId);
    } } });
    const sessions = new SessionService(db.sessions, agent, () => runtime.state(), deps.now, db.runs, db.sessionInputs,
      (runRequest, submission, control) => runtime.start(runRequest, control, submission), input => runtime.appendInput(input),
      id => runtime.verifySessionMutation(id));
    const app = makeApplication(runtime, db.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessions);
    const finished = finishSignal();
    const initial = await app.submitInput({ ...request, clientSequence: 1, mode: 'prompt', timeoutMs: 5000 }, finished);
    if (!initial.ok) throw new Error(initial.error.code);
    await entered.promise;
    const queued = await app.submitInput({ sessionId: 1, clientSequence: 2, mode: 'followUp', runId: initial.data.runId, text: 'Unconfirmed input' });
    if (!queued.ok) throw new Error(queued.error.code);
    release.resolve();
    expect(await finished.done.promise).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'failed', stopped: true } } });
    expect(await app.querySessionInput({ sessionId: 1, inputId: queued.data.inputId })).toMatchObject({ ok: true, data: { input: {
      status: 'delivery_unknown', processingStatus: 'failed', nativeEntryId: null } } });
    expect(db.sessions.get(1)).toMatchObject({ ok: true, data: { nativeUnusable: true } });
    expect(await app.querySession(1)).toMatchObject({ ok: true, data: { availability: 'unusable' } });
    expect(await app.submitInput({ ...request, clientSequence: 3, mode: 'prompt' }))
      .toMatchObject({ ok: false, error: { code: 'agent_session_unusable' } });
    await app.close();
  });

  it.each([true, false])('keeps each input fact across Stop and requires the real tool barrier: tool stopped=%s', async toolStopped => {
    const { db, deps } = fixture();
    const entered = deferred<void>();
    const finishFirst = deferred<void>();
    const toolEntered = deferred<void>();
    const releaseTool = deferred<void>();
    const settled = deferred<AgentNativeOutcome>();
    const queued: AgentInputDispatch[] = [];
    let streaming = false;
    let executionInput!: AgentExecutionInput;
    let executeCount = 0;
    const tools = createToolExecutor({ definitions: [{ name: 'powershell', version: '0.85.1', description: 'Controlled stop evidence.',
      effect: 'LOCAL_WRITE', executionMode: 'sequential', inputSchema: z.object({}).strict(), outputSchema: z.object({}).strict(),
      async execute() {
        toolEntered.resolve();
        await releaseTool.promise;
        if (!toolStopped) throw new ToolExecutionFailure(appError('stop_not_confirmed', 'runtime', 'The native process did not prove termination.'), {});
        return {};
      } }], recorder: createToolRecorder(db.toolCalls, deps.now), now: deps.now });
    const agent: AgentPort = {
      ...makeAgent(deps.fixtureHistory),
      inspect: () => ({ availability: streaming ? 'busy' : 'ready' }),
      enqueueInput: async (_nativeId, input) => { queued.push(input); return ok(undefined); },
      async prepare(nativeId) {
        return ok({ snapshot: { ...snapshot, agent: { ...snapshot.agent, policyVersion: 'p3-invoice-tools-v1',
          maxContextBytes: 8_388_608, maxModelCalls: 16, maxToolCalls: 24, toolTimeoutMs: 10_000 } },
        async execute(input, signal, observe) {
          executeCount += 1; streaming = true; executionInput = input;
          observe({ type: 'agent_event', at: deps.now(), monotonicMs: performance.now(), data: { eventName: 'agent_start' } });
          deps.fixtureHistory.saveUser(nativeId, input);
          entered.resolve();
          await finishFirst.promise;
          const { onInputAdmissionClosed: _firstAgentEnd, ...firstTurn } = input;
          deps.fixtureHistory.saveResult(nativeId, firstTurn, nativeOutcome);
          const consumed = queued[0]!;
          deps.fixtureHistory.saveUser(nativeId, { ...input, inputId: consumed.inputId, text: consumed.text, promptText: consumed.promptText });
          if (!input.toolBinding) throw new Error('The public material Run must bind the real tool executor.');
          await input.toolBinding.execute('powershell', {}, { nativeToolCallId: 'p5-stop-process', signal });
          const outcome = await settled.promise;
          streaming = false; input.onInputAdmissionClosed?.();
          return outcome;
        } });
      },
    };
    const nativeHeader = db.db.query<{ cwd: string }, []>("SELECT json_extract(header_json,'$.cwd') AS cwd FROM session_native_history WHERE session_id=1").get();
    if (!nativeHeader) throw new Error('The native Session header must exist.');
    const verify = createTestWorkspaceVerifier(db, nativeHeader.cwd);
    const runtime = new RuntimeService({ ...deps, agent, tools, workspaceVerifier: verify, nativeTools: {
      runtimeDir: nativeHeader.cwd,
      availability: [{ name: 'powershell', available: true, reason: null }] } });
    const sessions = new SessionService(db.sessions, agent, () => runtime.state(), deps.now, db.runs, db.sessionInputs,
      (runRequest, submission, control) => runtime.start(runRequest, control, submission), input => runtime.appendInput(input),
      id => runtime.verifySessionMutation(id));
    const app = makeApplication(runtime, db.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessions);
    const current = db.workspace.update({ expectedRevision: 0, change: { kind: 'session', sessionId: 1 }, at: deps.now() }, verify);
    if (!current.ok) throw new Error(current.error.code);
    const workspace = { revision: current.data.revision, sessionId: 1, documentRef: null, jobId: null, candidateRef: null };
    const finished = finishSignal();
    const initial = await app.submitInput({ ...request, clientSequence: 1, mode: 'prompt', workspace, timeoutMs: 5000, stopGraceMs: 1000 }, finished);
    if (!initial.ok) throw new Error(initial.error.code);
    await entered.promise;
    expect(executionInput.workspaceContext).toEqual({ ...workspace, formatVersion: 1, activeView: current.data.activeView, selection: null });
    const receipts: SessionInputAccepted[] = [];
    for (const clientSequence of [2, 3, 4]) {
      const receipt = await app.submitInput({ sessionId: 1, clientSequence, mode: 'followUp', runId: initial.data.runId,
        text: `Additional input ${clientSequence}`, workspace });
      if (!receipt.ok) throw new Error(receipt.error.code);
      receipts.push(receipt.data);
    }
    finishFirst.resolve();
    await toolEntered.promise;
    const firstResultId = `assistant-${initial.data.inputId}`;
    expect(await app.querySessionInput({ sessionId: 1, inputId: initial.data.inputId })).toMatchObject({ ok: true, data: { input: {
      status: 'consumed', processingStatus: 'completed', resultEntryId: firstResultId } } });
    expect(await app.querySessionInput({ sessionId: 1, inputId: receipts[0]!.inputId })).toMatchObject({ ok: true, data: { input: {
      status: 'consumed', processingStatus: 'pending', resultEntryId: null } } });
    expect(await app.cancelRun(initial.data.runId)).toMatchObject({ ok: true, data: { accepted: true } });
    expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { active: { runId: initial.data.runId } } });
    expect(await app.submitInput({ sessionId: 1, clientSequence: 5, mode: 'steer', runId: initial.data.runId, text: 'After Stop', workspace }))
      .toMatchObject({ ok: false, error: { code: 'input_admission_closed' } });
    expect(executionInput.completeInputResult?.([initial.data.inputId], firstResultId))
      .toMatchObject({ ok: false, error: { code: 'input_admission_closed' } });
    expect(db.db.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({ count: 4 });
    expect(queued).toHaveLength(3);
    releaseTool.resolve();
    settled.resolve({ ...nativeOutcome, agent: { ...nativeOutcome.agent, turnCount: 2, modelCallCount: 2,
      confirmedUnconsumedInputIds: [receipts[1]!.inputId] } });
    const end = await finished.done.promise;
    expect(end).toMatchObject({ type: 'run_finished', result: { ok: true, data: {
      status: toolStopped ? 'cancelled' : 'failed', stopped: toolStopped } } });
    const inputs = await app.listSessionInputs({ sessionId: 1, runId: initial.data.runId });
    if (!inputs.ok) throw new Error(inputs.error.code);
    expect(inputs.data.items.find(input => input.inputId === initial.data.inputId)).toMatchObject({ status: 'consumed',
      processingStatus: 'completed', resultEntryId: firstResultId, error: null });
    expect(inputs.data.items.find(input => input.inputId === receipts[0]!.inputId)).toMatchObject({ status: 'consumed',
      processingStatus: toolStopped ? 'cancelled' : 'failed', resultEntryId: null });
    expect(inputs.data.items.find(input => input.inputId === receipts[1]!.inputId)).toMatchObject({
      status: toolStopped ? 'cancelled' : 'delivery_unknown', processingStatus: toolStopped ? 'cancelled' : 'failed', nativeEntryId: null });
    expect(inputs.data.items.find(input => input.inputId === receipts[2]!.inputId)).toMatchObject({ status: 'delivery_unknown',
      processingStatus: toolStopped ? 'cancelled' : 'failed', nativeEntryId: null });
    expect(await app.querySession(1)).toMatchObject({ ok: true, data: { availability: 'unusable' } });
    expect(db.sessions.get(1)).toMatchObject({ ok: true, data: { nativeUnusable: true } });
    expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { active: null, blocked: !toolStopped } });
    expect(db.toolCalls.list({ runId: initial.data.runId, limit: 10 })).toMatchObject({ ok: true, data: { items: [{
      cleanup: { stopped: toolStopped }, stoppedAt: toolStopped ? deps.now() : null } ] } });
    expect(executeCount).toBe(1);
    await app.close();
  });

  it('closes public admission at the first agent_end while still streaming and never carries its residual input to another Run', async () => {
    const { db, deps } = fixture();
    const entered = deferred<void>();
    const beginClosing = deferred<void>();
    const closedAdmission = deferred<void>();
    const releaseSettled = deferred<void>();
    const queued: AgentInputDispatch[] = [];
    let streaming = false;
    let executeCount = 0;
    const agent: AgentPort = {
      ...makeAgent(deps.fixtureHistory),
      inspect: () => ({ availability: streaming ? 'busy' : 'ready' }),
      enqueueInput: async (_nativeId, input) => { queued.push(input); return ok(undefined); },
      async prepare(nativeId) {
        return ok({ snapshot, async execute(input, _signal, observe) {
          executeCount += 1; streaming = true;
          observe({ type: 'agent_event', at: deps.now(), monotonicMs: performance.now(), data: { eventName: 'agent_start' } });
          deps.fixtureHistory.saveUser(nativeId, input);
          if (executeCount === 1) {
            entered.resolve(); await beginClosing.promise;
            deps.fixtureHistory.saveResult(nativeId, input, nativeOutcome);
            observe({ type: 'agent_event', at: deps.now(), monotonicMs: performance.now(), data: { eventName: 'agent_end' } });
            closedAdmission.resolve(); await releaseSettled.promise;
            streaming = false;
            return { ...nativeOutcome, agent: { ...nativeOutcome.agent, confirmedUnconsumedInputIds: queued.map(item => item.inputId) } };
          }
          deps.fixtureHistory.saveResult(nativeId, input, nativeOutcome);
          streaming = false; return nativeOutcome;
        } });
      },
    };
    const runtime = new RuntimeService({ ...deps, agent });
    const sessions = new SessionService(db.sessions, agent, () => runtime.state(), deps.now, db.runs, db.sessionInputs,
      (runRequest, submission, control) => runtime.start(runRequest, control, submission), input => runtime.appendInput(input),
      id => runtime.verifySessionMutation(id));
    const app = makeApplication(runtime, db.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessions);
    const finished = finishSignal();
    const initial = await app.submitInput({ ...request, clientSequence: 1, mode: 'prompt', timeoutMs: 5000 }, finished);
    if (!initial.ok) throw new Error(initial.error.code);
    await entered.promise;
    const beforeEnd = await app.submitInput({ sessionId: 1, clientSequence: 2, mode: 'followUp', runId: initial.data.runId, text: 'Before agent_end' });
    if (!beforeEnd.ok) throw new Error(beforeEnd.error.code);
    beginClosing.resolve(); await closedAdmission.promise;
    expect(agent.inspect('native-1')).toMatchObject({ availability: 'busy' });
    expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { active: { runId: initial.data.runId } } });
    expect(await app.submitInput({ sessionId: 1, clientSequence: 3, mode: 'steer', runId: initial.data.runId, text: 'After first agent_end' }))
      .toMatchObject({ ok: false, error: { code: 'input_admission_closed' } });
    expect(db.db.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({ count: 2 });
    expect(queued.map(input => input.inputId)).toEqual([beforeEnd.data.inputId]);
    releaseSettled.resolve();
    expect(await finished.done.promise).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'completed', stopped: true } } });
    expect(await app.querySessionInput({ sessionId: 1, inputId: beforeEnd.data.inputId })).toMatchObject({ ok: true, data: { input: {
      runId: initial.data.runId, status: 'cancelled', processingStatus: 'cancelled', nativeEntryId: null, resultEntryId: null } } });
    const nextFinished = finishSignal();
    const next = await app.submitInput({ ...request, clientSequence: 3, mode: 'prompt', text: 'Explicit next Run' }, nextFinished);
    if (!next.ok) throw new Error(next.error.code);
    expect(next.data.runId).not.toBe(initial.data.runId);
    expect(await nextFinished.done.promise).toMatchObject({ type: 'run_finished', result: { ok: true, data: { status: 'completed' } } });
    expect(await app.listSessionInputs({ sessionId: 1, runId: next.data.runId })).toMatchObject({ ok: true, data: { items: [{
      inputId: next.data.inputId, mode: 'prompt', processingStatus: 'completed' }] } });
    expect(db.db.query("SELECT COUNT(*) AS count FROM session_native_entries WHERE json_extract(entry_json,'$.message.role')='user'").get())
      .toEqual({ count: 2 });
    expect(queued).toHaveLength(1); expect(executeCount).toBe(2);
    await app.close();
  });
});
