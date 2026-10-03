import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { appError, ok, INVOICE_TOOLS_SYSTEM_PROMPT } from '@flowmate/contracts';
import type { AgentPort, ProductPaths, ProviderPort, ProviderRequest, SafeConfigSnapshot, NativeSessionHistory } from '@flowmate/contracts';
import { openDatabase } from '@flowmate/core';
import { createApplication } from '../../../apps/composition.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const stamp = '2026-10-01T12:00:00.000Z';
const input = { version: 1 as const, goal: 'Synthetic recovery', text: '', messageTimestamp: 1 };
const usage = { version: 1 as const, source: 'unknown' as const, reason: 'offline', sdkValues: null,
  attempts: null, attemptsComplete: false, costSource: null, updatedAt: stamp };
const cleanup = { version: 1 as const, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
const tokens = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
const config: SafeConfigSnapshot = { version: 1, name: 'Recovery fixture', revision: 1,
  requestedModel: { provider: 'synthetic', model: 'synthetic' }, resolvedModel: null, api: null, endpoint: null,
  sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 },
  limits: { timeoutMs: 1_000, stopGraceMs: 100 }, native: { authSource: 'unknown', modelsSelection: null } };
const request: ProviderRequest = { goal: input.goal, text: '', timeoutMs: 1_000, stopGraceMs: 100,
  config: { version: 1, name: config.name, revision: 1, modelRef: config.requestedModel,
    parameters: config.parameters, native: { authPath: join(tmpdir(), 'synthetic-recovery-auth.json'), modelsPath: null } } };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cold-start-'));
  const paths: ProductPaths = { root, databaseFile: join(root, 'data', 'trial.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const opened = openDatabase(paths);
  if (!opened.ok) throw new Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  return { paths, store: opened.data };
}

function providerRun(store: ReturnType<typeof fixture>['store']) {
  const created = store.runs.create({ goal: input.goal, input, config, usage, cleanup, createdAt: stamp });
  if (!created.ok) throw new Error(created.error.code);
  expect(store.runs.start(created.data, config, stamp).ok).toBe(true);
  return created.data;
}

function agentRun(store: ReturnType<typeof fixture>['store'], toolName = 'powershell', unusable = false) {
  const nativeSessionId = 'synthetic-recovery-session';
  const nativeHistory: NativeSessionHistory = { storageVersion: 1, header: { type: 'session', version: 3,
    id: nativeSessionId, timestamp: stamp, cwd: tmpdir() }, entries: [], leafId: null, unusable };
  const session = store.sessions.create({ nativeSessionId, title: 'Recovery fixture', at: stamp, nativeHistory });
  if (!session.ok) throw new Error(session.error.code);
  const agentConfig = { ...config, goalMode: 'answer' as const, agent: { policyVersion: 'p3-invoice-tools-v1' as const,
    nativeSessionId, systemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT, thinkingLevel: 'off' as const, resourcePolicy: 'none' as const,
    historyPolicy: 'memory-only' as const, maxContextBytes: 8_388_608 as const, maxOutputBytes: 262_144 as const,
    maxAssistantContentBytes: 524_288 as const, maxModelCalls: 12 as const, maxToolCalls: 24 as const,
    toolTimeoutMs: 10_000 as const, sessionRetry: false as const } };
  // The seed is created before history is deliberately marked unusable below.
  if (unusable) store.db.query('UPDATE session_native_history SET unusable=0 WHERE session_id=?').run(session.data.sessionId);
  const created = store.runs.createAgent({ goal: input.goal, input, config: agentConfig, usage, cleanup, createdAt: stamp,
    sessionId: session.data.sessionId, scope: { version: 2, allowedTools: [toolName], allowedDocumentIds: [],
      allowedArtifactIds: [], allowedResourcePaths: [] } });
  if (!created.ok) throw new Error(created.error.code);
  expect(store.runs.start(created.data, agentConfig, stamp).ok).toBe(true);
  if (unusable) store.db.query('UPDATE session_native_history SET unusable=1 WHERE session_id=?').run(session.data.sessionId);
  return { runId: created.data, sessionId: session.data.sessionId, agentConfig };
}

function finish(store: ReturnType<typeof fixture>['store'], runId: number, options: { stopped?: boolean; diagnostic?: boolean } = {}) {
  const stopped = options.stopped ?? true;
  const existing = store.runs.get(runId);
  if (!existing.ok) throw new Error(existing.error.code);
  return store.runs.finish(runId, { status: stopped ? 'completed' : 'failed',
    output: { version: 1, text: 'Saved output', partial: false, stopReason: 'stop', responseId: null, responseModel: null,
      ...(existing.data.kind === 'agent' ? { agent: { nativeSessionId: 'synthetic-recovery-session', turnCount: 1, modelCallCount: 1 } } : {}) },
    error: stopped ? null : appError('provider_timeout', 'provider', 'The original request timed out.', true, runId),
    usage, tokens, cleanup: { ...cleanup, stopped, lateObservationRequired: !stopped,
      errors: options.diagnostic ? [appError('logger_close_failed', 'runtime', 'Diagnostic logging failed.', true)] : [] },
    endedAt: stamp, stoppedAt: stopped ? stamp : null, durationMs: 1 });
}

async function application(paths: ProductPaths) {
  let providerCalls = 0;
  let agentCalls = 0;
  let sessionCounter = 0;
  const createdSessions = new Set<string>();
  const provider: ProviderPort = { prepare: async () => { providerCalls += 1; return { ok: false,
    error: appError('provider_auth_failed', 'provider', 'Synthetic authentication failure.') }; },
    close: async () => ({ stopped: true, closed: true, errors: [] }) };
  const agent: AgentPort = { createSession: () => { const nativeSessionId = `synthetic-new-${++sessionCounter}`;
    createdSessions.add(nativeSessionId); return ok({ nativeSessionId }); },
    inspect: id => ({ availability: createdSessions.has(id) ? 'ready' : 'missing' }),
    prepare: async () => { agentCalls += 1; return { ok: false, error: appError('offline', 'runtime', 'Synthetic preparation.') }; },
    releaseSession: async () => ({ stopped: true, closed: true, errors: [] }),
    close: async () => ({ stopped: true, closed: true, errors: [] }) };
  const opened = await createApplication({ paths, provider, agent, logger: { write() {}, close: async () => undefined } });
  if (!opened.ok) throw new Error(opened.error.code);
  deferCleanup(() => opened.data.close());
  return { app: opened.data, providerCalls: () => providerCalls, agentCalls: () => agentCalls };
}

it('cold-start blocks an unconfirmed terminal Provider while preserving read-only facts without inventing stop evidence', async () => {
  const { store, paths } = fixture();
  const runId = providerRun(store);
  expect(finish(store, runId, { stopped: false }).ok).toBe(true);
  const before = store.runs.get(runId);
  store.close();
  const { app, providerCalls } = await application(paths);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { active: null, blocked: true,
    error: { code: 'runtime_recovery_blocked', runId } } });
  expect(await app.queryRun(runId)).toEqual(before);
  expect(await app.callProvider(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
  expect(providerCalls()).toBe(0);
  await app.close();
  const again = await application(paths);
  expect(await again.app.queryRun(runId)).toEqual(before);
  expect(await again.app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true } });
});

it('cold-start does not clear process-exit uncertainty merely because it acquired a database controller lease', async () => {
  const { store, paths } = fixture();
  const runId = providerRun(store);
  store.close();
  const { app, providerCalls } = await application(paths);
  expect(await app.queryRun(runId)).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'runtime_interrupted' },
    stoppedAt: null, cleanup: { stopped: false, lateObservationRequired: true } } });
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true } });
  expect(await app.callProvider(request)).toMatchObject({ ok: false });
  expect(providerCalls()).toBe(0);
});

it.each(['powershell', 'bash'])('cold-start retains actual stop uncertainty for an interrupted %s even when its Run is already completed', async (toolName) => {
  const { store, paths } = fixture();
  const { runId, sessionId } = agentRun(store, toolName);
  const call = store.toolCalls.request({ context: null, runId, sessionId, nativeToolCallId: 'original-native-call', toolName,
    toolVersion: '0.85.1', effect: 'LOCAL_WRITE', rawArguments: { command: 'synthetic command, never executed' }, requestedAt: stamp });
  if (!call.ok) throw new Error(call.error.code);
  expect(store.toolCalls.fixArguments({ toolCallId: call.data.toolCallId, finalArguments: {} }).ok).toBe(true);
  expect(store.toolCalls.start({ toolCallId: call.data.toolCallId, startedAt: stamp }).ok).toBe(true);
  expect(finish(store, runId).ok).toBe(true);
  const before = store.runs.get(runId);
  store.close();
  const { app, providerCalls, agentCalls } = await application(paths);
  expect(await app.queryRun(runId)).toEqual(before);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true,
    error: { code: 'runtime_recovery_blocked', runId, toolCallId: 'original-native-call' } } });
  expect(await app.callProvider(request)).toMatchObject({ ok: false });
  expect(providerCalls()).toBe(0); expect(agentCalls()).toBe(0);
  await app.close();
  const reopened = openDatabase(paths);
  if (!reopened.ok) throw new Error(reopened.error.code);
  deferCleanup(() => reopened.data.close());
  expect(reopened.data.toolCalls.getById(call.data.toolCallId)).toMatchObject({ ok: true, data: {
    status: 'failed', startedAt: stamp, stoppedAt: null, result: { error: { code: 'runtime_interrupted' } }, cleanup: { stopped: false } } });
  reopened.data.close();
});

it('cold-start closes a provably unstarted requested tool without claiming a historical stopped timestamp', async () => {
  const { store, paths } = fixture();
  const { runId, sessionId } = agentRun(store);
  const call = store.toolCalls.request({ context: null, runId, sessionId, nativeToolCallId: 'never-started', toolName: 'powershell',
    toolVersion: '0.85.1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: stamp });
  if (!call.ok) throw new Error(call.error.code);
  expect(finish(store, runId).ok).toBe(true);
  store.close();
  const { app } = await application(paths);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: false } });
  await app.close();
  const reopened = openDatabase(paths);
  if (!reopened.ok) throw new Error(reopened.error.code);
  deferCleanup(() => reopened.data.close());
  expect(reopened.data.toolCalls.getById(call.data.toolCallId)).toMatchObject({ ok: true, data: {
    status: 'failed', startedAt: null, stoppedAt: null, cleanup: { stopped: true } } });
  reopened.data.close();
});

it('cold-start keeps history unusable local to its Session and does not treat diagnostic errors or delivery failure as global stop uncertainty', async () => {
  const { store, paths } = fixture();
  const { runId, sessionId } = agentRun(store, 'powershell', true);
  const call = store.toolCalls.request({ context: null, runId, sessionId, nativeToolCallId: 'finished-shell', toolName: 'powershell',
    toolVersion: '0.85.1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: stamp });
  if (!call.ok) throw new Error(call.error.code);
  expect(store.toolCalls.fixArguments({ toolCallId: call.data.toolCallId, finalArguments: {} }).ok).toBe(true);
  expect(store.toolCalls.start({ toolCallId: call.data.toolCallId, startedAt: stamp }).ok).toBe(true);
  expect(store.toolCalls.finish({ toolCallId: call.data.toolCallId, result: { version: 1, committedCandidateId: null,
    status: 'succeeded', data: { content: [{ type: 'text', text: 'Saved synthetic result' }] } },
    cleanup: { version: 1, stopped: true, stopReason: 'tool-settled', errors: [] }, endedAt: stamp, stoppedAt: stamp }).ok).toBe(true);
  expect(store.toolCalls.recordDelivery({ toolCallId: call.data.toolCallId, delivery: { version: 1, state: 'failed',
    messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null,
    error: appError('tool_result_delivery_failed', 'runtime', 'Synthetic delivery failure.', true) } }).ok).toBe(true);
  expect(finish(store, runId, { diagnostic: true }).ok).toBe(true);
  const before = store.runs.get(runId);
  store.close();
  const { app, providerCalls, agentCalls } = await application(paths);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: false } });
  expect(await app.queryRun(runId)).toEqual(before);
  expect(await app.startRun({ sessionId, text: 'Do not revive this history.', config: request.config }))
    .toMatchObject({ ok: false, error: { code: 'agent_session_unusable' } });
  expect(agentCalls()).toBe(0);
  expect(await app.callProvider(request)).toMatchObject({ ok: true, data: { status: 'failed', stopped: true } });
  expect(providerCalls()).toBe(1);
});

it('cold-start preserves readable records while blocking an unreadable required Run stop fact', async () => {
  const { store, paths } = fixture();
  const runId = providerRun(store);
  expect(finish(store, runId).ok).toBe(true);
  store.db.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify({ ...cleanup, version: 999 }), runId);
  store.close();
  const { app, providerCalls } = await application(paths);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true,
    error: { code: 'runtime_recovery_blocked', runId } } });
  expect(await app.queryRun(runId)).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  expect(await app.callProvider(request)).toMatchObject({ ok: false });
  expect(providerCalls()).toBe(0);
});

it.each([
  { stopped: false, lateObservationRequired: false },
  { stopped: true, lateObservationRequired: true },
])('cold-start independently blocks stop and late-observation gaps: %j', async (gap) => {
  const { store, paths } = fixture();
  const runId = providerRun(store);
  expect(finish(store, runId).ok).toBe(true);
  store.db.query('UPDATE runs SET cleanup_json=? WHERE id=?').run(JSON.stringify({ ...cleanup, ...gap }), runId);
  const before = store.runs.get(runId);
  expect(before.ok).toBe(true);
  store.close();
  const { app, providerCalls } = await application(paths);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true,
    error: { code: 'runtime_recovery_blocked', runId } } });
  expect(await app.queryRun(runId)).toEqual(before);
  expect(await app.callProvider(request)).toMatchObject({ ok: false });
  expect(providerCalls()).toBe(0);
});

function finishedToolWithMissingResult(store: ReturnType<typeof fixture>['store']) {
  const { runId, sessionId } = agentRun(store);
  const call = store.toolCalls.request({ context: null, runId, sessionId, nativeToolCallId: 'finished-with-save-gap', toolName: 'powershell',
    toolVersion: '0.85.1', effect: 'LOCAL_WRITE', rawArguments: {}, requestedAt: stamp });
  if (!call.ok) throw new Error(call.error.code);
  expect(store.toolCalls.fixArguments({ toolCallId: call.data.toolCallId, finalArguments: {} }).ok).toBe(true);
  expect(store.toolCalls.start({ toolCallId: call.data.toolCallId, startedAt: stamp }).ok).toBe(true);
  expect(store.toolCalls.finish({ toolCallId: call.data.toolCallId, result: { version: 1, committedCandidateId: null,
    status: 'succeeded', data: { content: [{ type: 'text', text: 'Synthetic committed side effect' }] } },
    cleanup: { version: 1, stopped: true, stopReason: 'tool-settled', errors: [] }, endedAt: stamp, stoppedAt: stamp }).ok).toBe(true);
  expect(finish(store, runId).ok).toBe(true);
  // Existing terminal and stopped facts remain, but the mandatory SDK result
  // cannot be read. The tool is never actually invoked in this seed.
  store.db.query('UPDATE tool_calls SET result_json=? WHERE id=?').run(JSON.stringify({ version: 999 }), call.data.toolCallId);
  return { runId, sessionId, toolCallId: call.data.toolCallId };
}

it('cold-start blocks only the original Session when a stopped completed tool lacks a readable necessary result', async () => {
  const { store, paths } = fixture();
  const { runId, sessionId, toolCallId } = finishedToolWithMissingResult(store);
  const before = store.runs.get(runId);
  expect(before.ok).toBe(true);
  store.close();
  const { app, providerCalls, agentCalls } = await application(paths);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: false } });
  expect(await app.queryRun(runId)).toEqual(before);
  expect(await app.startRun({ sessionId, text: 'Do not reconstruct this tool result.', config: request.config }))
    .toMatchObject({ ok: false, error: { code: 'agent_session_unusable' } });
  expect(agentCalls()).toBe(0);
  expect(await app.callProvider(request)).toMatchObject({ ok: true, data: { status: 'failed', stopped: true } });
  expect(providerCalls()).toBe(1);
  const fresh = await app.createSession({ title: 'Explicit new conversation after local history failure' });
  expect(fresh.ok).toBe(true);
  if (!fresh.ok) throw new Error(fresh.error.code);
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const accepted = await app.startRun({ sessionId: fresh.data.sessionId, text: 'Synthetic new request.', config: request.config }, {
    onEvent(event) { if (event.type === 'run_finished') resolveFinished(); },
  });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.error.code);
  await finished;
  expect(agentCalls()).toBe(1);
  expect(await app.queryRun(accepted.data.runId)).toMatchObject({ ok: true, data: {
    sessionId: fresh.data.sessionId, status: 'failed', error: { code: 'offline' }, cleanup: { stopped: true } } });
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: false } });
  expect(await app.queryRun(runId)).toEqual(before);
  await app.close();
  const reopened = openDatabase(paths);
  if (!reopened.ok) throw new Error(reopened.error.code);
  deferCleanup(() => reopened.data.close());
  expect(reopened.data.sessions.loadHistory(sessionId)).toMatchObject({ ok: true, data: { unusable: true } });
  expect(reopened.data.db.query('SELECT status,stopped_at,result_json FROM tool_calls WHERE id=?').get(toolCallId))
    .toEqual({ status: 'succeeded', stopped_at: stamp, result_json: '{"version":999}' });
});

it('cold-start rolls back all recovery if a necessary Session history block cannot be saved', () => {
  const { store, paths } = fixture();
  const { sessionId, toolCallId } = finishedToolWithMissingResult(store);
  const runId = providerRun(store);
  store.db.exec(`CREATE TRIGGER reject_history_block BEFORE UPDATE ON session_native_history
    BEGIN SELECT RAISE(ABORT,'synthetic necessary save failure'); END;`);
  store.close();
  expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
  const saved = new Database(paths.databaseFile);
  deferCleanup(() => saved.close());
  expect(saved.query('SELECT status,stopped_at,ended_at FROM runs WHERE id=?').get(runId))
    .toEqual({ status: 'running', stopped_at: null, ended_at: null });
  expect(saved.query('SELECT unusable FROM session_native_history WHERE session_id=?').get(sessionId)).toEqual({ unusable: 0 });
  expect(saved.query('SELECT status,stopped_at,result_json FROM tool_calls WHERE id=?').get(toolCallId))
    .toEqual({ status: 'succeeded', stopped_at: stamp, result_json: '{"version":999}' });
});
