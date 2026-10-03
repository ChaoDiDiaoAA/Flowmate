import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok } from '@flowmate/contracts';
import type { AgentExecutionInput, AgentInputDispatch, AgentNativeOutcome, AgentPort, ProviderConfig, Result, RuntimeAgentConfigFacts, SafeConfigSnapshot } from '@flowmate/contracts';
import { ContextService } from '../../../packages/core/src/context/service.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { SessionService, ensureNativeSession } from '../../../packages/core/src/sessions/service.ts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { createAgentHistoryFixture } from './agent-history-fixture.ts';

const at = '2026-10-03T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
function fixture(legacy = false, preparedMarker: 'p8-context-v1' | undefined = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p8-admission-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs') };
  const store = need(openTestDatabase(paths));
  const history = createAgentHistoryFixture(root, () => at);
  history.create('native-context');
  const session = need(store.sessions.create({ nativeSessionId: 'native-context', title: 'Context', at,
    nativeHistory: need(history.exportSession('native-context')) }));
  need(history.watchSession(session.nativeSessionId, (saved, context) => store.sessions.saveHistory(session.sessionId, saved, context)));
  const config: ProviderConfig = { version: 1, name: 'Context fixture', revision: 1,
    modelRef: { provider: 'fixture', model: 'fixture' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  const agentFacts: RuntimeAgentConfigFacts = { policyVersion: 'runtime-v1', taskPolicyVersion: 'p5-session-inputs-v1',
    nativeSessionId: session.nativeSessionId, systemPrompt: 'fixture', thinkingLevel: 'off', resourcePolicy: 'none',
    historyPolicy: 'memory-only', maxContextBytes: 524288, maxAssistantContentBytes: 524288, maxOutputBytes: 262144,
    maxModelCalls: 12, maxToolCalls: 0, toolTimeoutMs: 10000, sessionRetry: false };
  const prepared: SafeConfigSnapshot & { agent: RuntimeAgentConfigFacts } = { version: 2, name: config.name, revision: config.revision,
    requestedModel: config.modelRef, resolvedModel: config.modelRef, api: 'openai-completions', endpoint: null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: config.parameters,
    native: { authSource: 'unknown', modelsSelection: null }, limits: { timeoutMs: 5000, stopGraceMs: 100 },
    runtimeBudget: { maxModelCalls: 12, maxToolCalls: 0, toolTimeoutMs: 10000 },
    contextPolicyVersion: preparedMarker, agent: agentFacts };
  let preparing = 0, builds = 0, busy = false;
  let execution!: AgentExecutionInput;
  let entered!: () => void;
  const executing = new Promise<void>(resolve => { entered = resolve; });
  const enqueued: AgentInputDispatch[] = [];
  const agent: AgentPort = { createSession: () => fail(appError('fixture', 'runtime', 'No new native Session.')),
    exportSession: history.exportSession, watchSession: history.watchSession, restoreSession: history.restoreSession,
    restoreSessionLeaf: history.restoreSessionLeaf, inspect: () => ({ availability: busy ? 'busy' : 'ready' }),
    enqueueInput: async (_nativeId, input) => { expect(store.db.inTransaction).toBe(false); enqueued.push(input); return ok(undefined); },
    prepare: async () => { preparing++; return ok({ snapshot: prepared, execute: async (input, signal, observe) => {
      expect(store.db.inTransaction).toBe(false); execution = input; busy = true;
      history.saveUser(session.nativeSessionId, input);
      observe({ type: 'agent_event', at, monotonicMs: performance.now(), data: { eventName: 'agent_start' } }); entered();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      busy = false;
      const outcome: AgentNativeOutcome = { text: '', partial: false, stopReason: 'aborted', responseId: null, responseModel: null,
        error: null, usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: 1, attemptsComplete: true,
          costSource: null, updatedAt: at }, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        stopped: true, cleanupErrors: [], agent: { nativeSessionId: session.nativeSessionId, turnCount: 1, modelCallCount: 1 } };
      return outcome;
    } }); }, releaseSession: async () => ({ stopped: true, closed: true, errors: [] }), close: async () => ({ stopped: true, closed: true, errors: [] }) };
  const service = new ContextService({ store, materials: { inspectParsed() { throw new Error('Chat cannot inspect material.'); } } });
  const runtime = new RuntimeService({ runs: store.runs, sessions: store.sessions, sessionInputs: store.sessionInputs, agent,
    ...(legacy ? {} : { contextService: { build: request => { builds++; expect(store.db.inTransaction).toBe(true); return service.build(request); } } }),
    provider: { async prepare() { throw new Error('No direct provider.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
  const sessions = new SessionService(store.sessions, agent, () => runtime.state(), () => at, store.runs, store.sessionInputs,
    (request, submission, control) => runtime.start(request, control, submission), request => runtime.appendInput(request));
  deferCleanup(async () => { await runtime.close(); });
  const request = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt' as const, text: 'same text', config,
    timeoutMs: 5000, stopGraceMs: 100 };
  const rows = () => ({ runs: store.db.query('SELECT * FROM runs').all(), inputs: store.db.query('SELECT * FROM session_inputs').all(),
    snapshots: store.db.query('SELECT * FROM context_snapshots').all(), events: store.db.query('SELECT * FROM runtime_events').all() });
  return { store, session, history, runtime, sessions, request, prepared, executing, rows, enqueued, execution: () => execution,
    counts: () => ({ builds, preparing, enqueued: enqueued.length }) };
}

const failures = {
  snapshot: "CREATE TRIGGER fail_admit BEFORE INSERT ON context_snapshots BEGIN SELECT RAISE(ABORT,'snapshot rejected'); END",
  pointer: "CREATE TRIGGER fail_admit BEFORE UPDATE OF current_context_snapshot_id ON runs BEGIN SELECT RAISE(ABORT,'pointer rejected'); END",
  input: "CREATE TRIGGER fail_admit BEFORE INSERT ON session_inputs BEGIN SELECT RAISE(ABORT,'input rejected'); END",
  event: "CREATE TRIGGER fail_admit BEFORE INSERT ON runtime_events WHEN NEW.type='input_state_changed' BEGIN SELECT RAISE(ABORT,'input event rejected'); END",
};
describe('T04 real Ledger Context admission', () => {
  it('commits new P8 context before execute and preserves the saved marker over prepared undefined', async () => {
    const f = fixture();
    const accepted = need(await f.sessions.submitInput(f.request)); await f.executing;
    const saved = need(f.store.sessionInputs.get(accepted.inputId))!;
    expect(saved.contextSnapshotId).toBeNumber();
    const run = need(f.store.runs.get(accepted.runId));
    expect(run.config.contextPolicyVersion).toBe('p8-context-v1');
    expect(run.currentContextSnapshotId).toBe(saved.contextSnapshotId);
    expect(f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(accepted.runId))
      .toEqual({ context_observations_json: '{"version":1,"requests":[]}' });
    expect(f.execution()).toMatchObject({ inputId: saved.inputId, contextSnapshotId: saved.contextSnapshotId, promptText: 'same text' });
    expect(saved.content).not.toHaveProperty('contextSnapshotId');
  });
  it('keeps an explicit legacy Runtime unmarked even when prepare supplies a P8 marker', async () => {
    const f = fixture(true, 'p8-context-v1');
    let ended!: () => void;
    const terminal = new Promise<void>(resolve => { ended = resolve; });
    const accepted = need(await f.sessions.submitInput(f.request, { onEvent(event) { if (event.type === 'run_finished') ended(); } }));
    await Promise.race([f.executing, terminal]);
    const raw = f.store.db.query('SELECT config_json FROM runs WHERE id=?').get(accepted.runId) as { config_json: string };
    expect(JSON.parse(raw.config_json)).not.toHaveProperty('contextPolicyVersion');
    await f.executing;
    expect(need(f.store.sessionInputs.get(accepted.inputId))?.contextSnapshotId).toBeNull();
    expect(need(f.store.runs.get(accepted.runId)).config).not.toHaveProperty('contextPolicyVersion');
    expect(f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(accepted.runId))
      .toEqual({ context_observations_json: null });
    expect(f.counts().builds).toBe(0);
  });
  it('keeps direct Provider config behavior independent of Agent context admission', async () => {
    const f = fixture(); const { agent: _agent, contextPolicyVersion: _marker, ...snapshot } = f.prepared;
    const providerSnapshot = snapshot;
    const runtime = new RuntimeService({ runs: f.store.runs, contextService: { build() { throw new Error('Provider cannot build Agent context.'); } },
      provider: { async prepare() { return ok({ snapshot: providerSnapshot, async execute() { return { text: 'Provider reply', partial: false,
        stopReason: 'stop', responseId: null, responseModel: null, error: null, stopped: true, cleanupErrors: [],
        usage: { version: 1 as const, source: 'unknown' as const, reason: 'fixture', sdkValues: null, attempts: 1,
          attemptsComplete: true, costSource: null, updatedAt: at },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } }; } }); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => at, monotonicNow: () => performance.now() });
    deferCleanup(async () => { await runtime.close(); });
    const outcome = need(await runtime.callProvider({ goal: 'Provider', text: 'Direct input', config: f.request.config, timeoutMs: 5000, stopGraceMs: 100 }));
    expect(outcome.status).toBe('completed');
    expect(need(f.store.runs.get(outcome.runId)).config).toEqual(providerSnapshot);
    expect(f.store.db.query('SELECT context_observations_json,current_context_snapshot_id FROM runs WHERE id=?').get(outcome.runId))
      .toEqual({ context_observations_json: null, current_context_snapshot_id: null });
    expect(f.counts().builds).toBe(0);
  });
  it('identifies the staged Tool recorder failure as the actual 015 null-context guard', async () => {
    const f = fixture(); const accepted = need(await f.sessions.submitInput(f.request)); await f.executing;
    expect(f.store.toolCalls.request({ runId: accepted.runId, sessionId: f.session.sessionId, nativeToolCallId: 'staged-tool',
      toolName: 'read', toolVersion: '0.85.1', effect: 'READ', rawArguments: {}, requestedAt: at }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    const before = f.rows();
    // Same omitted columns as the production request INSERT; inspect the underlying SQLite guard error.
    expect(() => f.store.db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,
      delivery_json,cleanup_json,requested_at) VALUES (?,?,?,?,?,?,?, ?,?,?)`).run(accepted.runId, f.session.sessionId,
      'staged-tool-raw', 'read', '0.85.1', 'READ', JSON.stringify({ version: 1, raw: {}, final: null }),
      JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null,
        requestDispatchedAt: null, error: null }), JSON.stringify({ version: 1, stopReason: null, stopped: false, errors: [] }), at))
      .toThrow('context_identity_invalid');
    expect(f.store.db.query('SELECT count(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
    expect(f.rows()).toEqual(before);
  });
  it.each(Object.entries(failures))('rolls initial admission back when %s fails after Run creation', async (_kind, sql) => {
    const f = fixture(), before = f.rows(); f.store.db.exec(sql);
    expect(await f.sessions.submitInput(f.request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(f.rows()).toEqual(before); expect(f.counts()).toEqual({ builds: 1, preparing: 0, enqueued: 0 });
  });
  it.each(Object.entries(failures))('preserves old admission when append %s fails', async (_kind, sql) => {
    const f = fixture(); const initial = need(await f.sessions.submitInput(f.request)); await f.executing;
    const before = f.rows(); f.store.db.exec(sql);
    expect(await f.sessions.submitInput({ sessionId: f.session.sessionId, clientSequence: 2, mode: 'followUp', runId: initial.runId, text: 'same text' }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(f.rows()).toEqual(before); expect(f.counts()).toEqual({ builds: 2, preparing: 1, enqueued: 0 });
  });
  it('returns original identities on retry and gives equal new inputs separate snapshots', async () => {
    const f = fixture(); const initial = need(await f.sessions.submitInput(f.request)); await f.executing;
    const raw = f.rows();
    expect(await f.sessions.submitInput(f.request)).toEqual(ok(initial)); expect(f.rows()).toEqual(raw);
    const followRequest = { sessionId: f.session.sessionId, clientSequence: 2, mode: 'followUp' as const, runId: initial.runId, text: 'same text' };
    const follow = need(await f.sessions.submitInput(followRequest));
    const steer = need(await f.sessions.submitInput({ ...followRequest, clientSequence: 3, mode: 'steer' }));
    const first = need(f.store.sessionInputs.get(initial.inputId))!, second = need(f.store.sessionInputs.get(follow.inputId))!, third = need(f.store.sessionInputs.get(steer.inputId))!;
    if (second.content.version !== 2 || third.content.version !== 2) throw new Error('Expected V2 input.');
    expect(new Set([first.contextSnapshotId, second.contextSnapshotId, third.contextSnapshotId]).size).toBe(3);
    expect(f.enqueued).toMatchObject([{ inputId: second.inputId, contextSnapshotId: second.contextSnapshotId, promptText: second.content.promptText },
      { inputId: third.inputId, contextSnapshotId: third.contextSnapshotId, promptText: third.content.promptText }]);
    const after = f.rows(); expect(await f.sessions.submitInput(followRequest)).toEqual(ok(follow)); expect(f.rows()).toEqual(after);
    expect(f.counts()).toEqual({ builds: 3, preparing: 1, enqueued: 2 });
    expect(f.execution().verifyInputUse?.(first.inputId)).toEqual(ok(undefined));
  });
  it('rejects a saved prompt that no longer matches its original immutable snapshot', async () => {
    const f = fixture(); const initial = need(await f.sessions.submitInput(f.request)); await f.executing;
    f.store.db.query("UPDATE session_inputs SET content_json=json_set(content_json,'$.promptText','corrupt') WHERE id=?").run(initial.inputId);
    const before = f.rows();
    expect(f.execution().verifyInputUse?.(initial.inputId)).toMatchObject({ ok: false, error: { code: 'storage_corrupt', retryable: false } });
    expect(f.rows()).toEqual(before);
  });
});

describe('T04 readonly persisted context seeds', () => {
  it.each([1, 2] as const)('retains an actual consumed legacy version %s Input with a NULL snapshot', async version => {
    const f = fixture(true); const accepted = need(await f.sessions.submitInput(f.request)); await f.executing;
    const input = need(f.store.sessionInputs.get(accepted.inputId))!;
    if (input.nativeEntryId === null) throw new Error('Expected consumed legacy entry.');
    if (version === 1) f.store.db.query('UPDATE session_inputs SET content_json=? WHERE id=?')
      .run(JSON.stringify({ version: 1, text: input.content.text,
        workspaceContext: { formatVersion: 1, revision: 0, sessionId: f.session.sessionId, documentRef: null,
          jobId: null, candidateRef: null, activeView: 'original', selection: null }, allowedDocumentIds: [], allowedArtifactIds: [] }), input.inputId);
    const before = f.rows();
    expect(need(f.store.sessions.loadHistoryForContext(f.session.sessionId)).bindings).toEqual([
      { nativeEntryId: input.nativeEntryId, originRunId: accepted.runId, inputId: input.inputId, snapshotId: null }]);
    expect(f.rows()).toEqual(before);
  });
  it('does not reconnect a busy native Session', async () => {
    const f = fixture(); need(await f.sessions.submitInput(f.request)); await f.executing;
    const before = structuredClone(f.history.restorations);
    // The Runtime already owns the busy SDK Session; management must leave that active bridge intact.
    const port: AgentPort = { createSession: () => fail(appError('unused', 'runtime', 'Unused.')), inspect: () => ({ availability: 'busy' }),
      prepare: async () => { throw new Error('No prepare.'); }, restoreSession: () => { throw new Error('No restore.'); },
      restoreSessionLeaf: () => { throw new Error('No leaf restore.'); }, watchSession: () => { throw new Error('No watch.'); },
      releaseSession: async () => ({ stopped: true, closed: true, errors: [] }), close: async () => ({ stopped: true, closed: true, errors: [] }) };
    expect(ensureNativeSession(f.store.sessions, port, need(f.store.sessions.get(f.session.sessionId)))).toEqual({ ok: true, data: undefined });
    expect(f.history.restorations).toEqual(before);
  });
  it('joins the consumed original Input and excludes later queued inputs without consulting the current pointer', async () => {
    const f = fixture(); const initial = need(await f.sessions.submitInput(f.request)); await f.executing;
    const first = need(f.store.sessionInputs.get(initial.inputId))!;
    if (first.nativeEntryId === null) throw new Error('Expected consumed native entry.');
    need(await f.sessions.submitInput({ sessionId: f.session.sessionId, clientSequence: 2, mode: 'steer', runId: initial.runId, text: 'same text' }));
    const before = f.rows();
    expect(typeof f.store.sessions.loadHistoryForContext).toBe('function');
    const bundle = need(f.store.sessions.loadHistoryForContext(f.session.sessionId));
    expect(bundle.history).toEqual(need(f.store.sessions.loadHistory(f.session.sessionId)));
    expect(bundle.bindings).toEqual([{ originRunId: initial.runId, inputId: initial.inputId,
      nativeEntryId: first.nativeEntryId, snapshotId: first.contextSnapshotId }]);
    expect(f.rows()).toEqual(before);
  });
  it('preserves actual pre-ledger user origin including the original nullable 008 Run', () => {
    const f = fixture();
    const { contextPolicyVersion: _marker, ...config } = f.prepared;
    const runId = need(f.store.runs.createAgent({ sessionId: f.session.sessionId, scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] }, config,
      goal: 'Legacy', input: { version: 1, text: 'same text', goal: 'Legacy', messageTimestamp: 1 },
      usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: at },
      cleanup: { version: 1, stopped: true, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: at }));
    const previous = need(f.store.sessions.loadHistory(f.session.sessionId))!;
    const first = { type: 'message', id: 'pre-ledger-null', parentId: null, timestamp: at,
      message: { role: 'user', content: 'same text', timestamp: 1 } };
    need(f.store.sessions.saveHistory(f.session.sessionId, { ...previous, entries: [first], leafId: first.id }));
    const second = { ...first, id: 'pre-ledger-run', parentId: first.id };
    need(f.store.sessions.saveHistory(f.session.sessionId, { ...previous, entries: [first, second], leafId: second.id }, { entryId: second.id, runId }));
    const before = f.rows();
    expect(typeof f.store.sessions.loadHistoryForContext).toBe('function');
    expect(need(f.store.sessions.loadHistoryForContext(f.session.sessionId)).bindings).toEqual([
      { nativeEntryId: first.id, originRunId: null, inputId: null, snapshotId: null },
      { nativeEntryId: second.id, originRunId: runId, inputId: null, snapshotId: null },
    ]);
    expect(f.rows()).toEqual(before);
  });
  it.each(['entry-run', 'p8-no-input', 'message', 'missing-snapshot'] as const)('rejects %s provenance without writing or guessing', async cause => {
    const f = fixture(); const initial = need(await f.sessions.submitInput(f.request)); await f.executing;
    if (cause === 'entry-run') f.store.db.query('UPDATE session_native_entries SET run_id=NULL WHERE session_id=?').run(f.session.sessionId);
    if (cause === 'p8-no-input') f.store.db.query('DELETE FROM session_inputs WHERE id=?').run(initial.inputId);
    if (cause === 'message') f.store.db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content',json('7')) WHERE session_id=?").run(f.session.sessionId);
    if (cause === 'missing-snapshot') {
      // Persisted corruption cannot become a legacy fallback.
      const { contextPolicyVersion: _marker, ...legacy } = need(f.store.runs.get(initial.runId)).config;
      f.store.db.query('UPDATE runs SET config_json=?,context_observations_json=NULL WHERE id=?').run(JSON.stringify(legacy), initial.runId);
    }
    const before = f.rows(); expect(typeof f.store.sessions.loadHistoryForContext).toBe('function');
    expect(f.store.sessions.loadHistoryForContext(f.session.sessionId)).toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
    expect(f.rows()).toEqual(before);
  });
  it('distinguishes a missing Session from a real SQLite query failure', () => {
    const f = fixture(); expect(typeof f.store.sessions.loadHistoryForContext).toBe('function');
    expect(f.store.sessions.loadHistoryForContext(f.session.sessionId + 100)).toMatchObject({ ok: false, error: { code: 'session_not_found' } });
    f.store.db.exec('DROP TABLE session_native_entries');
    expect(f.store.sessions.loadHistoryForContext(f.session.sessionId)).toMatchObject({ ok: false, error: { code: 'storage_read_failed', retryable: true } });
  });
});
