import { mkdtempSync } from '../../support/resources.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { appError, ok } from '@flowmate/contracts';
import type {
  AgentConfigFacts,
  AgentExecutionInput,
  AgentNativeOutcome,
  AgentPort,
  AgentRunEvent,
  PreparedAgent,
  ProviderConfig,
  ProviderRequest,
  Result,
  SafeConfigSnapshot,
} from '@flowmate/contracts';
import type { RunRepository } from '../../../packages/core/src/storage/repositories.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { openTestDatabase } from '../../support/database.ts';
import type { ProviderPort } from '@flowmate/contracts';

const config: ProviderConfig = {
  version: 1,
  name: 'fixture',
  revision: 1,
  modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  native: { authPath: 'C:\\Users\\test\\.pi\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 },
};
const snapshot: SafeConfigSnapshot & { agent: AgentConfigFacts } = {
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
    policyVersion: 'p2-invoice-chat-v1', nativeSessionId: 'native-1', systemPrompt: 'fixture prompt',
    thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 524_288,
    maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 1, sessionRetry: false,
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
  opened.data.sessions.create({ nativeSessionId: 'native-1', title: 'Invoice chat', at: '2026-09-24T00:00:00.000Z' });
  const deps = {
    runs: opened.data.runs,
    sessions: opened.data.sessions,
    provider: {
      async prepare() { throw new Error('provider must not be called'); },
      async close() { return { stopped: true, closed: true, errors: [] as const }; },
    } satisfies ProviderPort,
    log: { write: () => undefined, close: async () => undefined },
    now: () => '2026-09-24T00:00:00.000Z',
    monotonicNow: () => performance.now(),
  };
  return { db: opened.data, deps };
}

function makeAgent(options: {
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
    prepare: (_nativeSessionId, _config, _limits, signal) => prepare(signal),
    releaseSession: async () => ({ stopped: true, closed: true, errors: [] }),
    close: options.close ?? (async () => ({ stopped: true, closed: true, errors: [] })),
  };
}

describe('RuntimeService Agent lifecycle', () => {
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
    const service = new RuntimeService({ ...deps, runs, agent: makeAgent({ prepare: async () => {
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
    const service = new RuntimeService({ ...deps, agent: makeAgent() });
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
    db.sessions.create({ nativeSessionId: 'native-other-session', title: 'Other Session', at: '2026-09-24T00:00:00.000Z' });
    const service = new RuntimeService({ ...deps, agent: makeAgent({ execute: () => { entered.resolve(); return work.promise; } }) });
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({ execute: () => { entered.resolve(); return work.promise; } }) });
    const accepted = await service.start({ ...request, stopGraceMs: 10 }, finished);
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
    await Promise.resolve();
    await Promise.resolve();
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
    const service = new RuntimeService({ ...deps, runs: failedRuns, agent: makeAgent() });
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
    const short = { ...request, stopGraceMs: 10 };
    const service = new RuntimeService({ ...deps, agent: makeAgent({ execute: async () => { entered.resolve(); return new Promise<AgentNativeOutcome>(() => undefined); } }) });
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
    const service = new RuntimeService({ ...deps, runs, agent: makeAgent({ execute: async () => { prompted = true; return nativeOutcome; } }) });
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({ inspection: {
      availability: 'missing',
    } }) });
    expect(await service.start(request)).toMatchObject({ ok: false, error: { code: 'session_history_unavailable' } });
    expect(db.runs.listBySession({ sessionId: 1, limit: 50 })).toMatchObject({ ok: true, data: { items: [] } });
  });

  it('finalizes a settled preparation error without starting the native prompt', async () => {
    const { db, deps } = fixture();
    const finished = finishSignal();
    let prompted = false;
    const service = new RuntimeService({ ...deps, agent: makeAgent({
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({
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
    const service = new RuntimeService({ ...deps, runs, agent: makeAgent({ execute: () => { entered.resolve(); return work.promise; } }) });
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({ execute: async () => ({
      ...nativeOutcome, agent: { ...nativeOutcome.agent, modelCallCount: 2 },
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({ execute: async () => ({
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({ execute: async () => ({
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
    const service = new RuntimeService({ ...deps, agent: makeAgent({
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
      agent: makeAgent({ close: async () => { order.push('agent'); return { stopped: true, closed: true, errors: [] }; } }),
      provider: { ...deps.provider, close: async () => { order.push('provider'); return { stopped: true, closed: true, errors: [] }; } },
    });
    expect(await service.close()).toMatchObject({ stopped: true, closed: true });
    expect(order).toEqual(['agent', 'provider']);
  });
});
