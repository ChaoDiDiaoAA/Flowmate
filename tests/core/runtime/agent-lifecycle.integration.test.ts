import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appError, fail, ok } from '../../../packages/contracts/src/index.ts';
import type { AgentConfigSnapshot, AgentNativeOutcome, AgentPort, PreparedAgent, SafeConfigSnapshot } from '../../../packages/contracts/src/ports.ts';
import type { RuntimeState, ProviderConfig } from '../../../packages/contracts/src/runtime.ts';
import type { AgentExecutionInput } from '../../../packages/contracts/src/ports.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';

const config: ProviderConfig = {
  version: 1, name: 'fixture', revision: 1,
  modelRef: { provider: 'fixture', model: 'model-a' },
  native: { authPath: 'C:\\flowmate-test\\auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 100 },
};
const snapshot: SafeConfigSnapshot = {
  version: 1, name: config.name, revision: 1, requestedModel: config.modelRef, resolvedModel: config.modelRef,
  api: 'openai-completions', endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: config.parameters, limits: { timeoutMs: 10_000, stopGraceMs: 100 },
  native: { authSource: 'pi-native', modelsSelection: null },
};

class ImmediateAgent implements AgentPort {
  public prepared = 0;
  public issued: string[] = [];
  public prepareFailure?: ReturnType<typeof appError>;
  public prepareWait?: Promise<void>;
  public onPrepare?: () => void;
  private readonly sessions = new Set<string>();

  public createSession() {
    const nativeSessionId = `native-${this.sessions.size + 1}`;
    this.sessions.add(nativeSessionId);
    return ok({ nativeSessionId });
  }
  public inspect(nativeSessionId: string) {
    return { availability: this.sessions.has(nativeSessionId) ? 'ready' as const : 'missing' as const };
  }
  public async prepare(nativeSessionId: string): Promise<{ ok: true; data: PreparedAgent } | { ok: false; error: ReturnType<typeof appError> }> {
    this.prepared += 1;
    this.onPrepare?.();
    if (this.prepareWait) await this.prepareWait;
    if (this.prepareFailure) return fail(this.prepareFailure);
    const agentSnapshot: AgentConfigSnapshot = {
      ...snapshot,
      agent: {
        policyVersion: 'p2-invoice-chat-v1', nativeSessionId, systemPrompt: 'fixture', thinkingLevel: 'off',
        resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 512_000,
        maxOutputBytes: 256_000, maxAssistantContentBytes: 512_000, maxModelCalls: 1, sessionRetry: false,
      },
    };
    return { ok: true, data: { snapshot: agentSnapshot, execute: async (input: AgentExecutionInput) => {
      this.issued.push(input.text);
      return this.outcome(nativeSessionId);
    } } };
  }
  public async releaseSession() { return { stopped: true, closed: true, errors: [] }; }
  public async close() { return { stopped: true, closed: true, errors: [] }; }

  private outcome(nativeSessionId: string): AgentNativeOutcome {
    return {
      text: 'done', partial: false, stopReason: 'stop', responseId: null, responseModel: 'model-a', error: null,
      usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null, updatedAt: new Date().toISOString() },
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      stopped: true, cleanupErrors: [], agent: { nativeSessionId, turnCount: 1, modelCallCount: 1 },
    };
  }
}

describe('RuntimeService Agent lifecycle', () => {
  it('holds the global run slot before publishing created and does not prepare a reentrant second run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-agent-lifecycle-'));
    const opened = openDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const agent = new ImmediateAgent();
    const service = new RuntimeService({
      runs: opened.data.runs,
      sessions: opened.data.sessions,
      agent,
      provider: { prepare: async () => { throw new Error('Provider is unused'); }, close: async () => ({ stopped: true, closed: true, errors: [] }) },
      log: { write: () => undefined, close: async () => undefined },
      now: () => new Date().toISOString(),
      monotonicNow: () => performance.now(),
    });
    const first = await service.createSession({ title: 'A' });
    const second = await service.createSession({ title: 'B' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    let reentrant: Promise<unknown> | undefined;
    let attempted = false;
    const stateDuringCreated: { value: RuntimeState | null } = { value: null };
    let createdRunId: number | null = null;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const accepted = await service.startRun({ sessionId: first.data.sessionId, text: 'A message', config }, {
      onEvent(event) {
        if (event.type === 'run_progress' && event.phase === 'created' && !attempted) {
          attempted = true;
          createdRunId = event.runId;
          void service.queryRuntimeState().then((state) => { stateDuringCreated.value = state.ok ? state.data : null; });
          reentrant = service.startRun({ sessionId: second.data.sessionId, text: 'B message', config });
        }
        if (event.type === 'run_finished') resolveFinished();
      },
    });
    expect(accepted.ok).toBe(true);
    const rejected = await reentrant as { ok: boolean; error?: { code: string } };
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('runtime_busy');
    expect(createdRunId).not.toBeNull();
    expect(stateDuringCreated.value?.active?.runId).toBe(createdRunId!);
    await finished;
    expect(agent.prepared).toBe(1);
    expect(agent.issued).toEqual(['A message']);

    const active = await service.queryRuntimeState();
    expect(active.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    opened.data.close();
  });

  it('does not record a confirmed stop or release the runtime after cleanup is uncertain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-agent-cleanup-'));
    const opened = openDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const agent = new ImmediateAgent();
    agent.prepareFailure = appError('stop_unconfirmed', 'runtime', 'synthetic cleanup uncertainty', true);
    const service = new RuntimeService({
      runs: opened.data.runs, sessions: opened.data.sessions, agent,
      provider: { prepare: async () => { throw new Error('Provider is unused'); }, close: async () => ({ stopped: true, closed: true, errors: [] }) },
      log: { write: () => undefined, close: async () => undefined }, now: () => new Date().toISOString(), monotonicNow: () => performance.now(),
    });
    const session = await service.createSession({ title: 'Uncertain' });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const accepted = await service.startRun({ sessionId: session.data.sessionId, text: 'test', config }, { onEvent(event) {
      if (event.type === 'run_finished') resolveFinished();
    } });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await finished;
    const saved = opened.data.runs.get(accepted.data.runId);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.data.status).toBe('failed');
      expect(saved.data.stoppedAt).toBeNull();
      expect(saved.data.cleanup.stopped).toBe(false);
    }
    const state = await service.queryRuntimeState();
    expect(state.ok && state.data.blocked).toBe(true);
    opened.data.close();
  });

  it('does not prompt when Stop arrives during model preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-agent-prepare-stop-'));
    const opened = openDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const agent = new ImmediateAgent();
    let finishPreparation!: () => void;
    agent.prepareWait = new Promise<void>((resolve) => { finishPreparation = resolve; });
    let signalPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => { signalPrepareStarted = resolve; });
    agent.onPrepare = signalPrepareStarted;
    const service = new RuntimeService({
      runs: opened.data.runs, sessions: opened.data.sessions, agent,
      provider: { prepare: async () => { throw new Error('Provider is unused'); }, close: async () => ({ stopped: true, closed: true, errors: [] }) },
      log: { write: () => undefined, close: async () => undefined }, now: () => new Date().toISOString(), monotonicNow: () => performance.now(),
    });
    const session = await service.createSession({ title: 'Preparation stop' });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    const accepted = await service.startRun({ sessionId: session.data.sessionId, text: 'cancel before prompt', config, timeoutMs: 10_000, stopGraceMs: 1_000 }, {
      onEvent(event) { if (event.type === 'run_finished') resolveFinished(); },
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await prepareStarted;
    const cancellation = await service.cancelRun(accepted.data.runId);
    expect(cancellation.ok && cancellation.data.accepted).toBe(true);
    finishPreparation();
    await finished;
    const saved = opened.data.runs.get(accepted.data.runId);
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.data.status).toBe('cancelled');
      expect(saved.data.stoppedAt).not.toBeNull();
    }
    expect(agent.issued).toEqual([]);
    opened.data.close();
  });
});
