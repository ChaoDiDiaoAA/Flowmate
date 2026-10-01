import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { appError, fail, FillInvoiceFormInputSchema, FillInvoiceFormOutputSchema, normalizeSessionInputRequest, ok } from '@flowmate/contracts';
import type { InvoiceFormTarget, P3AgentConfigFacts, PreparedAgent, Result, SafeConfigSnapshot, SessionInputRequest, WorkspaceContext } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createToolRecorder } from '../../../packages/core/src/tools/recorder.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';

const at = '2026-10-01T00:00:00.000Z';
const workspace: WorkspaceContext = { formatVersion: 1, revision: 3, sessionId: 1,
  documentRef: { id: 1, version: 'v1' }, jobId: 1, candidateRef: { id: 1, sequence: 1 },
  activeView: 'candidate', selection: null };
const request: SessionInputRequest = { sessionId: 1, clientSequence: 1, mode: 'prompt', goalMode: 'fill-form',
  text: 'Fill the selected invoice form.', workspace: { revision: 3, sessionId: 1,
    documentRef: { id: 1, version: 'v1' }, jobId: 1, candidateRef: { id: 1, sequence: 1 } },
  formTarget: { formInstanceId: 'form-1', expectedRevision: 0 }, config: { version: 1, name: 'fixture', revision: 1,
    modelRef: { provider: 'fixture', model: 'fixture' }, native: { authPath: 'D:/isolated/auth.json', modelsPath: null },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } }, timeoutMs: 1000, stopGraceMs: 100 };
const usage = { version: 1 as const, source: 'unknown' as const, reason: 'fixture', sdkValues: null,
  attempts: null, attemptsComplete: false, costSource: null, updatedAt: at };
const cleanup = { version: 1 as const, stopped: true, stopReason: null, errors: [], lateObservationRequired: false };
const safeConfig: SafeConfigSnapshot & { agent: P3AgentConfigFacts; goalMode: 'fill-form'; workspaceContext: WorkspaceContext;
  formTarget: InvoiceFormTarget } = { version: 1, name: 'fixture', revision: 1, requestedModel: request.config.modelRef,
  resolvedModel: null, api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: request.config.parameters, limits: { timeoutMs: 1000, stopGraceMs: 100 },
  native: { authSource: 'pi-native', modelsSelection: null },
  agent: { policyVersion: 'p3-invoice-tools-v1' as const, nativeSessionId: 'native-fill-input', systemPrompt: 'fixture prompt',
    thinkingLevel: 'off' as const, resourcePolicy: 'none' as const, historyPolicy: 'memory-only' as const, maxContextBytes: 8_388_608,
    maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12, maxToolCalls: 24,
    toolTimeoutMs: 10_000, sessionRetry: false as const }, goalMode: 'fill-form', workspaceContext: workspace,
  formTarget: request.formTarget };
function need<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-input-ledger-'));
  const paths = { root, databaseFile: join(root, 'data', 'test.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const store = need(openDatabase(paths));
  deferCleanup(() => store.close());
  need(store.sessions.create({ nativeSessionId: 'native-fill-input', title: 'Fill input', at,
    nativeHistory: { storageVersion: 1, header: { type: 'session', id: 'native-fill-input', version: 3,
      timestamp: at, cwd: root }, entries: [], leafId: null, unusable: false } }));
  const ledger = Reflect.get(store, 'sessionInputs') as import('../../../packages/core/src/sessions/input-ledger.ts').SessionInputLedger;
  expect(ledger).toBeDefined();
  let creates = 0;
  const createRun = () => {
    creates++;
    const inserted = store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,
      cleanup_json,usage_json,created_at) VALUES ('agent',1,?,'created','Fill form',?,?,?, ?,?)`)
      .run(JSON.stringify({ version: 2, allowedTools: ['fill_invoice_form'], allowedDocumentIds: [1],
        allowedArtifactIds: [2], allowedResourcePaths: [] }), JSON.stringify({ version: 1, goal: 'Fill form',
        text: request.text, messageTimestamp: 1 }), JSON.stringify(safeConfig), JSON.stringify(cleanup), JSON.stringify(usage), at);
    return ok({ runId: Number(inserted.lastInsertRowid), jobId: 1,
      scope: { version: 2 as const, allowedTools: ['fill_invoice_form'], allowedDocumentIds: [1],
        allowedArtifactIds: [2], allowedResourcePaths: [] }, workspaceContext: workspace,
      workspaceInput: { documentRef: workspace.documentRef, job: { id: 1, goal: 'Fill form' }, candidate: null },
      formTarget: request.formTarget });
  };
  const tools = createToolExecutor({ definitions: [{ name: 'fill_invoice_form', version: '1', description: 'Fixture form tool',
    effect: 'LOCAL_WRITE', executionMode: 'sequential', inputSchema: FillInvoiceFormInputSchema,
    outputSchema: FillInvoiceFormOutputSchema, async execute() { throw new Error('Unexpected tool execution.'); } }],
    recorder: createToolRecorder(store.toolCalls, () => at), now: () => at });
  return { store, ledger, paths, createRun, tools, creates: () => creates };
}

describe('idle Fill prompt input ledger', () => {
  it('persists the original Run and frozen input, and duplicate admission never creates another Run', () => {
    const { store, ledger, createRun, creates } = fixture();
    const first = need(ledger.admit(request, createRun, at));
    const repeated = need(ledger.admit(request, createRun, at));
    expect(first.created).toBe(true);
    expect(repeated).toMatchObject({ created: false, input: { inputId: first.input.inputId, runId: first.input.runId,
      status: 'queued', processingStatus: 'pending', nativeEntryId: null, content: { workspaceContext: workspace } } });
    expect(creates()).toBe(1);
    expect(store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 }))).toMatchObject({ nextClientSequence: 2,
      input: { inputId: first.input.inputId, runId: first.input.runId } });
  });

  it('rejects same clientSequence with another text, target, or expected Workspace without overwriting', () => {
    const { ledger, createRun, creates } = fixture();
    const first = need(ledger.admit(request, createRun, at));
    for (const changed of [{ ...request, text: 'Different input.' },
      { ...request, formTarget: { ...request.formTarget, formInstanceId: 'form-other' } },
      { ...request, workspace: { ...request.workspace, revision: 4 } }]) {
      expect(ledger.lookup(changed)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    }
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toEqual(first.input);
    expect(creates()).toBe(1);
  });

  it('rolls back Run creation when storing the accepted input fails', () => {
    const { store, ledger, createRun } = fixture();
    store.db.exec("CREATE TRIGGER reject_input BEFORE INSERT ON session_inputs BEGIN SELECT RAISE(ABORT,'fixture input failure'); END;");
    expect(ledger.admit(request, createRun, at)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toBeNull();
  });

  it('does not save a receipt or Run when the trusted admission rejects the current Workspace', () => {
    const { store, ledger } = fixture();
    expect(ledger.admit(request, () => fail(appError('state_conflict', 'input', 'Workspace changed.')), at))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({ count: 0 });
    expect(store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  });

  it('requires the actual saved user entry and keeps consumed when processing is cancelled', async () => {
    const { store, ledger, createRun } = fixture();
    const { markInputConsumed, finishSessionInputs } = await import('../../../packages/core/src/sessions/input-ledger.ts');
    const first = need(ledger.admit(request, createRun, at));
    expect(() => markInputConsumed(store.db, first.input.runId!, 'missing-entry', at)).toThrow();
    const entry = { type: 'message', id: 'real-user', parentId: null, timestamp: at,
      message: { role: 'user', content: request.text, timestamp: 1 } };
    store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES (1,0,?,?,?)')
      .run(entry.id, JSON.stringify(entry), first.input.runId);
    store.db.transaction(() => markInputConsumed(store.db, first.input.runId!, entry.id, at)).immediate();
    finishSessionInputs(store.db, first.input.runId!, 'cancelled', appError('agent_cancelled', 'runtime', 'cancelled'), at);
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'consumed',
      processingStatus: 'cancelled', nativeEntryId: 'real-user' });
  });

  it('rejects assistant entries and another Run identity as evidence of input consumption', async () => {
    const { store, ledger, createRun } = fixture();
    const { markInputConsumed } = await import('../../../packages/core/src/sessions/input-ledger.ts');
    const first = need(ledger.admit(request, createRun, at));
    store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES (1,0,?,?,?)')
      .run('assistant', JSON.stringify({ type: 'message', id: 'assistant', message: { role: 'assistant' } }), first.input.runId);
    expect(() => markInputConsumed(store.db, first.input.runId!, 'assistant', at)).toThrow();
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input?.status).toBe('queued');
  });

  it('keeps a completed processing fact when a later cancellation arrives', async () => {
    const { store, ledger, createRun } = fixture();
    const { markInputConsumed, finishSessionInputs } = await import('../../../packages/core/src/sessions/input-ledger.ts');
    const first = need(ledger.admit(request, createRun, at));
    const entry = { type: 'message', id: 'user-complete', message: { role: 'user', content: request.text } };
    store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES (1,0,?,?,?)')
      .run(entry.id, JSON.stringify(entry), first.input.runId);
    markInputConsumed(store.db, first.input.runId!, entry.id, at);
    finishSessionInputs(store.db, first.input.runId!, 'completed', null, at);
    finishSessionInputs(store.db, first.input.runId!, 'cancelled', appError('agent_cancelled', 'runtime', 'late cancel'), at);
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'consumed', processingStatus: 'completed', error: null });
  });

  it('records unknown delivery after a dispatch gap and never retries it on duplicate admission', async () => {
    const { store, ledger, createRun, creates } = fixture();
    const { finishSessionInputs } = await import('../../../packages/core/src/sessions/input-ledger.ts');
    const first = need(ledger.admit(request, createRun, at));
    need(ledger.dispatch(first.input.runId!, at));
    finishSessionInputs(store.db, first.input.runId!, 'failed', appError('host_interrupted', 'runtime', 'interrupted'), at);
    expect(need(ledger.admit(request, createRun, at))).toMatchObject({ created: false, input: {
      status: 'delivery_unknown', processingStatus: 'failed', nativeEntryId: null } });
    expect(creates()).toBe(1);
  });

  it('saves the actual user entry and consumed fact atomically, including a failed input write', () => {
    const { store, ledger, createRun } = fixture();
    const first = need(ledger.admit(request, createRun, at));
    const previous = need(store.sessions.loadHistory(1))!;
    const entry = { type: 'message', id: 'saved-user', parentId: null, timestamp: at,
      message: { role: 'user', content: request.text, timestamp: 1 } };
    const history = { ...previous, entries: [entry], leafId: entry.id };
    store.db.exec("CREATE TRIGGER reject_consumption BEFORE UPDATE OF status ON session_inputs BEGIN SELECT RAISE(ABORT,'fixture consumption failure'); END;");
    expect(store.sessions.saveHistory(1, history, { entryId: entry.id, runId: first.input.runId! }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(need(store.sessions.loadHistory(1))).toMatchObject({ entries: [], leafId: null });
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'queued', nativeEntryId: null });
    store.db.exec('DROP TRIGGER reject_consumption');
    need(store.sessions.saveHistory(1, history, { entryId: entry.id, runId: first.input.runId! }));
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'consumed', nativeEntryId: entry.id });
    need(store.sessions.saveHistory(1, history, { entryId: entry.id, runId: first.input.runId! }));
    expect(need(store.sessions.loadHistory(1))?.entries).toHaveLength(1);
  });

  it('rejects Run completion without actual consumption and rolls back its terminal fact', () => {
    const { store, ledger, createRun } = fixture();
    const first = need(ledger.admit(request, createRun, at));
    need(store.runs.start(first.input.runId!, { ...safeConfig, api: 'openai-completions', resolvedModel: request.config.modelRef }, at));
    const finished = store.runs.finish(first.input.runId!, { status: 'completed', output: null, error: null,
      usage, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup, endedAt: at, stoppedAt: at, durationMs: 0 });
    expect(finished).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(need(store.runs.get(first.input.runId!)).status).toBe('running');
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'queued', processingStatus: 'pending' });
  });

  it('repairs interrupted input on restart and queries its original identity without re-dispatch', () => {
    const { store, ledger, createRun, creates, paths } = fixture();
    const first = need(ledger.admit(request, createRun, at));
    need(ledger.dispatch(first.input.runId!, at));
    store.close();
    const restarted = need(openDatabase(paths));
    deferCleanup(() => restarted.close());
    expect(need(restarted.sessionInputs.query({ sessionId: 1, clientSequence: 1 })).input)
      .toMatchObject({ inputId: first.input.inputId, runId: first.input.runId, status: 'delivery_unknown',
        processingStatus: 'failed', nativeEntryId: null, dispatchedAt: at, error: { code: 'runtime_interrupted' } });
    expect(need(restarted.runs.get(first.input.runId!))).toMatchObject({ status: 'failed', cleanup: { stopped: false } });
    expect(need(restarted.sessionInputs.admit(request, () => { throw new Error('Restart must not re-admit input.'); }, at)))
      .toMatchObject({ created: false, input: { inputId: first.input.inputId, runId: first.input.runId } });
    expect(restarted.sessionInputs.dispatch(first.input.runId!, at)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(restarted.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
    expect(creates()).toBe(1);
  });

  it('returns the original input and Run before poisoned Runtime or stale Workspace admission', async () => {
    const { store, ledger, createRun, paths } = fixture();
    const first = need(ledger.admit(request, createRun, at));
    const runtime = new RuntimeService({ runs: store.runs, sessions: store.sessions, sessionInputs: ledger,
      recoveryError: appError('stop_not_confirmed', 'runtime', 'Unrelated old Runtime is blocked.'),
      agent: new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir }),
      provider: { async prepare() { throw new Error('No provider call is authorized by this test.'); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    const normalized = need(normalizeSessionInputRequest(request));
    const response = await runtime.start({ sessionId: 1, text: request.text, config: request.config,
      workspace: request.workspace, goalMode: 'fill-form', timeoutMs: 1000, stopGraceMs: 100 }, {}, normalized);
    expect(response).toEqual({ ok: true, data: { runId: first.input.runId!, sessionId: 1, inputId: first.input.inputId } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
  });

  it('rejects ordinary startRun fill requests even when called without public normalization', async () => {
    const { store, ledger, paths } = fixture();
    const runtime = new RuntimeService({ runs: store.runs, sessions: store.sessions, sessionInputs: ledger,
      agent: new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir }),
      provider: { async prepare() { throw new Error('No provider call is authorized by this test.'); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    expect(await runtime.start({ sessionId: 1, text: request.text, config: request.config, workspace: request.workspace,
      goalMode: 'fill-form', timeoutMs: 1000, stopGraceMs: 100 }))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  });

  it('keeps the admitted form target when a prepared SDK snapshot contains another target', async () => {
    const { store, ledger, paths, createRun, tools } = fixture();
    const agent = new PiAgentAdapter({ cwd: paths.root, agentDir: paths.runtimeDir });
    const snapshot = { ...safeConfig, api: 'openai-completions', resolvedModel: request.config.modelRef,
      formTarget: { formInstanceId: 'prepared-other-form', expectedRevision: 99 } };
    let preparedOptions: unknown;
    agent.prepare = async (_nativeId, _config, _limits, _signal, options) => { preparedOptions = options; return ok({ snapshot,
      async execute() { throw new Error('This preparation-boundary test must not execute a model.'); },
    } satisfies PreparedAgent); };
    let startedTarget: unknown;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const runtime = new RuntimeService({ runs: { ...store.runs, createWorkspaceAgent: createRun,
      start(_runId, startedConfig) {
        startedTarget = (startedConfig as Record<string, unknown>).formTarget;
        return fail(appError('state_conflict', 'storage', 'Fixture stops at the preparation boundary.'));
      } }, sessions: store.sessions, sessionInputs: ledger, agent, tools,
      nativeTools: { runtimeDir: paths.runtimeDir, availability: [] },
      provider: { async prepare() { throw new Error('No provider call is authorized by this test.'); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    deferCleanup(() => runtime.close());
    need(await runtime.start({ sessionId: 1, text: request.text, config: request.config, workspace: request.workspace,
      goalMode: 'fill-form', timeoutMs: 1000, stopGraceMs: 100 }, {
      onEvent(event) { if (event.type === 'run_finished') finish(); },
    }, need(normalizeSessionInputRequest(request))));
    await finished;
    expect(preparedOptions).toEqual({ activeToolNames: ['fill_invoice_form'], goalMode: 'fill-form' });
    expect(startedTarget).toEqual(request.formTarget);
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input)
      .toMatchObject({ status: 'failed', processingStatus: 'failed', dispatchedAt: null });
  });

  it('requires actual applied and delivered tool facts rather than a final model claim', async () => {
    const { store, ledger, paths, createRun, tools } = fixture();
    const agent = new PiAgentAdapter({ cwd: paths.root, agentDir: paths.runtimeDir });
    agent.prepare = async () => ok({ snapshot: safeConfig, async execute(input) {
      const previous = need(store.sessions.loadHistory(input.sessionId))!;
      const entry = { type: 'message', id: 'true-input', parentId: null, timestamp: at,
        message: { role: 'user', content: input.text, timestamp: input.messageTimestamp } };
      need(store.sessions.saveHistory(input.sessionId, { ...previous, entries: [entry], leafId: entry.id },
        { entryId: entry.id, runId: input.runId }));
      return { text: 'The form was filled.', partial: false, stopReason: 'stop' as const,
        responseId: null, responseModel: null, error: null, usage,
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        stopped: true, cleanupErrors: [], agent: { nativeSessionId: 'native-fill-input', turnCount: 1, modelCallCount: 1 } };
    } } satisfies PreparedAgent);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const runtime = new RuntimeService({ runs: { ...store.runs, createWorkspaceAgent: createRun },
      sessions: store.sessions, sessionInputs: ledger, agent, tools,
      provider: { async prepare() { throw new Error('No provider call is authorized by this lifecycle test.'); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    deferCleanup(() => runtime.close());
    const accepted = need(await runtime.start({ sessionId: 1, text: request.text, config: request.config,
      workspace: request.workspace, goalMode: 'fill-form', timeoutMs: 1000, stopGraceMs: 100 }, {
      onEvent(event) { if (event.type === 'run_finished') finish(); },
    }, need(normalizeSessionInputRequest(request))));
    await finished;
    expect(need(store.runs.get(accepted.runId))).toMatchObject({ status: 'failed', error: { code: 'agent_goal_not_met' } });
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input)
      .toMatchObject({ status: 'consumed', processingStatus: 'failed' });
  });

  it('rejects a new Fill input before creating a Run when no trusted form tool is assembled', async () => {
    const { store, ledger, paths, createRun, creates } = fixture();
    const agent = new PiAgentAdapter({ cwd: paths.root, agentDir: paths.runtimeDir });
    const runtime = new RuntimeService({ runs: { ...store.runs, createWorkspaceAgent: createRun },
      sessions: store.sessions, sessionInputs: ledger, agent,
      provider: { async prepare() { throw new Error('Unexpected model request.'); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    deferCleanup(() => runtime.close());
    expect(await runtime.start({ sessionId: 1, text: request.text, config: request.config,
      workspace: request.workspace, goalMode: 'fill-form', timeoutMs: 1000, stopGraceMs: 100 }, {},
      need(normalizeSessionInputRequest(request))))
      .toMatchObject({ ok: false, error: { code: 'tool_runtime_unavailable' } });
    expect(creates()).toBe(0);
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toBeNull();
  });

  it('allows only idle prompt Fill inputs through SessionService and rejects extra wire fields', async () => {
    const { store, ledger, paths } = fixture();
    const agent = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir });
    const service = new SessionService(store.sessions, agent, () => ({ active: null, ready: true, closing: false, blocked: false, error: null }),
      () => at, store.runs, ledger, async () => fail(appError('runtime_busy', 'runtime', 'Busy.')));
    expect(await service.submitInput({ ...request, mode: 'steer' } as unknown as SessionInputRequest))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await service.submitInput({ ...request, inputId: 100 } as SessionInputRequest))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    for (const clientSequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await service.submitInput({ ...request, clientSequence }))
        .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    }
    expect(need(service.queryInput({ sessionId: 1 }))).toEqual({ input: null, nextClientSequence: 1 });
    expect(await service.submitInput(request)).toMatchObject({ ok: false, error: { code: 'runtime_busy' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({ count: 0 });
  });
});
