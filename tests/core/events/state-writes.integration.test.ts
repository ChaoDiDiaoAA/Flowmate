import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Result, UsageRecord, TokenColumns, NativeSessionHistory, SessionInputRequest, P3AgentConfigFacts, ToolRuntimeObservation } from '@flowmate/contracts';
import { appError, fail, ok } from '@flowmate/contracts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { createRuntimeEventStore } from '../../../packages/core/src/events/store.ts';
import { createRunRepository, createSessionRepository, createToolCallRepository } from '../../../packages/core/src/storage/repositories.ts';
import { createSessionInputLedger } from '../../../packages/core/src/sessions/input-ledger.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const stamp = '2026-10-03T00:00:00.000Z';
const later = '2026-10-03T00:00:01.000Z';
const usage = { version: 1 as const, source: 'unknown' as const, reason: 'not-requested', sdkValues: null,
  attempts: null, attemptsComplete: false, costSource: null, updatedAt: stamp };
const tokens: TokenColumns = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
const cleanup = { version: 1 as const, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
const config = { version: 1 as const, name: 'event-fixture', revision: 1,
  requestedModel: { provider: 'fixture', model: 'fixture-model' }, resolvedModel: { provider: 'fixture', model: 'fixture-model' },
  api: 'openai-completions', endpoint: 'https://fixture.invalid/v1', sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
  parameters: { maxRetries: 0, maxRetryDelayMs: 2000 }, limits: { timeoutMs: 60_000, stopGraceMs: 5000 },
  native: { authSource: 'pi-runtime-api-key' as const, modelsSelection: null } };
const input = { version: 1 as const, goal: 'Observe a real fixture', text: 'Fixture input', messageTimestamp: 1 };
const observation: ToolRuntimeObservation = { version: 1, groupKey: 'fixture-read', strategyVersion: 'runtime-v1', sampleSource: 'test',
  beforeOutcome: 'allowed', failureStage: null, diagnosticCode: null, afterStructure: 'valid', afterDomain: 'not_applicable',
  executionDurationMs: 12, timingComplete: true, effectiveTimeoutMs: 1000, timeoutSource: 'configured',
  runDeadlineTruncated: false, commit: 'none_confirmed', commitError: null };
function required<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p6-state-writes-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const opened = required(openDatabase(paths));
  deferCleanup(() => opened.close());
  const events = createRuntimeEventStore(opened.db);
  const runs = createRunRepository(opened.db, events);
  const sessions = createSessionRepository(opened.db, events);
  const toolCalls = createToolCallRepository(opened.db, events);
  const ledger = createSessionInputLedger(opened.db, events);
  const published: unknown[] = [];
  events.onCommitted(refs => { expect(opened.db.inTransaction).toBe(false); published.push(refs); });
  const query = (runId: number, sessionId: number | null = null) => required(events.query({ runId, sessionId,
    cursor: { runId, lastPersistedSequence: 0 } }));
  const create = () => runs.create({ goal: input.goal, input, config, cleanup, usage, createdAt: stamp });
  const terminal = { status: 'failed' as const, output: null, error: appError('fixture_failed', 'provider', 'Fixture stopped.'),
    usage, tokens, cleanup: { ...cleanup, stopped: true, stopReason: 'fixture-stop' }, endedAt: later, stoppedAt: later, durationMs: 1 };
  return { ...opened, paths, events, runs, sessions, toolCalls, ledger, published, query, create, terminal };
}

function agentFixture(workspace = false, legacy = false) {
  const f = fixture();
  if (legacy) {
    f.runs = createRunRepository(f.db);
    f.sessions = createSessionRepository(f.db);
    f.toolCalls = createToolCallRepository(f.db);
    f.ledger = createSessionInputLedger(f.db);
  }
  const history: NativeSessionHistory = { storageVersion: 1, header: { type: 'session', version: 3,
    id: 'native-p6-events', timestamp: stamp, cwd: f.paths.runtimeDir }, entries: [], leafId: null, unusable: false };
  const session = required(f.sessions.create({ nativeSessionId: history.header.id, title: 'Events', at: stamp,
    nativeHistory: history, expectedRevision: 0 }));
  const agent: P3AgentConfigFacts = { policyVersion: 'p3-invoice-tools-v1', nativeSessionId: history.header.id,
    systemPrompt: 'Fixture', thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
    maxContextBytes: 8_388_608, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12,
    maxToolCalls: 24, toolTimeoutMs: 10_000, sessionRetry: false };
  const agentConfig = { ...config, agent };
  const request: SessionInputRequest = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: input.text,
    config: { version: 1, name: 'fixture', revision: 1, modelRef: { provider: 'fixture', model: 'fixture-model' },
      native: { authPath: 'D:/isolated/auth.json', modelsPath: null }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } } };
  const admit = (sequence = 1) => f.ledger.admit({ ...request, clientSequence: sequence }, () => {
    if (workspace) {
      const admission = f.runs.createWorkspaceAgent({ goal: input.goal, text: input.text, messageTimestamp: 1,
        config: agentConfig, usage, cleanup, createdAt: stamp, sessionId: session.sessionId, goalMode: 'answer',
        expected: { revision: 1, documentRef: null, jobId: null, candidateRef: null, sessionId: session.sessionId } });
      if (!admission.ok) return admission;
      return ok({ runId: admission.data.runId, content: { version: 2 as const, text: input.text,
        workspaceContext: admission.data.workspaceContext, workspaceInput: admission.data.workspaceInput,
        allowedDocumentIds: [], allowedArtifactIds: [], promptText: input.text } });
    }
    const created = f.runs.createAgent({ goal: input.goal, input, config: agentConfig, usage, cleanup, createdAt: stamp,
      sessionId: session.sessionId, scope: { version: 2, allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] } });
    return created.ok ? ok({ runId: created.data, content: { version: 2 as const, text: input.text, workspaceContext: null,
      workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [], promptText: input.text } }) : created;
  }, stamp);
  return { ...f, history, sessionId: session.sessionId, agentConfig, request, admit };
}
function bindResult(f: ReturnType<typeof agentFixture>) {
  const admitted = required(f.admit()).input;
  const runId = admitted.runId!;
  required(f.runs.start(runId, f.agentConfig, stamp));
  const user = { type: 'message', id: 'batch-user', parentId: null, timestamp: stamp,
    message: { role: 'user', content: input.text, timestamp: 1 } };
  const result = { type: 'message', id: 'batch-result', parentId: user.id, timestamp: later,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Saved batch.' }], stopReason: 'stop', timestamp: 2 } };
  required(f.sessions.saveHistory(f.sessionId, { ...f.history, entries: [user], leafId: user.id },
    { entryId: user.id, runId, inputId: admitted.inputId }));
  required(f.sessions.saveHistory(f.sessionId, { ...f.history, entries: [user, result], leafId: result.id },
    { entryId: result.id, runId, resultInputIds: [admitted.inputId] }));
  return { runId, inputId: admitted.inputId, resultEntryId: result.id };
}

describe('P6 real state write entry points', () => {
  it('commits provider creation, start, first cancellation and terminal with their original facts', () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER reject_created BEFORE INSERT ON runtime_events WHEN NEW.type='run_created' BEGIN SELECT RAISE(ABORT,'fixture event failure'); END;");
    expect(f.create()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(f.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_created');
    const runId = required(f.create());
    expect(f.query(runId).items.map(event => [event.type, event.payload])).toEqual([
      ['run_created', { version: 1, status: 'created', origin: 'live', stopped: false, errorCode: null }],
    ]);
    required(f.runs.start(runId, config, stamp));
    expect(f.runs.recordCancel(runId, stamp)).toEqual({ ok: true, data: true });
    expect(f.runs.recordCancel(runId, later)).toEqual({ ok: true, data: true });
    expect(required(f.runs.get(runId)).cancelRequestedAt).toBe(stamp);
    expect(f.query(runId).items.map(event => event.type)).toEqual(['run_created', 'run_started', 'run_cancel_requested']);
    expect(f.runs.finish(runId, f.terminal)).toEqual({ ok: true, data: true });
    const finished = f.query(runId);
    expect(f.runs.finish(runId, f.terminal)).toEqual({ ok: true, data: true });
    expect(f.runs.recordCancel(runId, later)).toEqual({ ok: true, data: false });
    expect(f.query(runId)).toEqual(finished);
    expect(finished.items.map(event => event.type)).toEqual(['run_created', 'run_started', 'run_cancel_requested', 'run_failed']);
    expect(finished.items[2]?.occurredAt).toBe(stamp);
    expect(f.published.length).toBe(4);
  });

  it('records the original cancel intent when terminal persistence first saves it after an initial write failure', () => {
    const f = fixture();
    const runId = required(f.create());
    required(f.runs.start(runId, config, stamp));
    f.db.exec("CREATE TRIGGER reject_active_cancel BEFORE UPDATE OF cancel_requested_at ON runs WHEN NEW.status='running' AND NEW.cancel_requested_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture cancel failure'); END;");
    expect(f.runs.recordCancel(runId, stamp)).toMatchObject({ ok: false });
    expect(required(f.runs.get(runId)).cancelRequestedAt).toBeNull();
    const terminal = { ...f.terminal, status: 'cancelled' as const, cancelRequestedAt: stamp };
    required(f.runs.finish(runId, terminal));
    const page = f.query(runId);
    expect(page.items.map(event => event.type)).toEqual(['run_created', 'run_started', 'run_cancel_requested', 'run_cancelled']);
    expect(page.items[2]?.occurredAt).toBe(stamp);
    expect(f.runs.finish(runId, terminal)).toEqual({ ok: true, data: true });
    expect(f.query(runId)).toEqual(page);
  });

  it.each([false, true])('shares the outer input admission transaction with workspace=%s Run creation', workspace => {
    const f = agentFixture(workspace);
    f.db.exec("CREATE TRIGGER reject_input_event BEFORE INSERT ON runtime_events WHEN NEW.type='input_state_changed' BEGIN SELECT RAISE(ABORT,'fixture input event failure'); END;");
    expect(f.ledger.allocateSequence(f.sessionId, sequence => f.admit(sequence)))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(f.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(f.db.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({ count: 0 });
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_input_event');
    f.db.exec("CREATE TRIGGER reject_input_row BEFORE INSERT ON session_inputs BEGIN SELECT RAISE(ABORT,'fixture input row failure'); END;");
    expect(f.ledger.allocateSequence(f.sessionId, sequence => f.admit(sequence))).toMatchObject({ ok: false });
    expect(f.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
    expect(f.db.query('SELECT COUNT(*) AS count FROM runtime_events').get()).toEqual({ count: 0 });
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_input_row');
    const admitted = required(f.ledger.allocateSequence(f.sessionId, sequence => f.admit(sequence)));
    expect(admitted.created).toBe(true);
    const page = f.query(admitted.input.runId!, f.sessionId);
    expect(page.items.map(event => event.type)).toEqual(['run_created', 'input_state_changed']);
    expect(page.items[1]?.payload).toMatchObject({ inputId: admitted.input.inputId, origin: 'live',
      status: 'queued', processingStatus: 'pending', nativeEntryId: null, resultEntryId: null });
    expect(f.published).toEqual([[{ runId: admitted.input.runId, sequence: 1 }, { runId: admitted.input.runId, sequence: 2 }]]);
    expect(required(f.admit()).created).toBe(false);
    expect(f.query(admitted.input.runId!, f.sessionId)).toEqual(page);
  });

  it.each(['admit', 'allocateSequence'] as const)('rolls back inner Run and event writes when the %s callback returns a failed Result', boundary => {
    const f = agentFixture();
    const beforeSessions = f.db.query('SELECT * FROM sessions ORDER BY id').all();
    const rejected = fail(appError('state_conflict', 'input', 'Fixture rejects after creating the Run.'));
    let attemptedRunId = 0;
    const inspectInnerWrites = (runId: number, eventCount: number, inputCount: number) => {
      attemptedRunId = runId;
      expect(f.db.inTransaction).toBe(true);
      expect(f.db.query('SELECT id,status,session_id FROM runs WHERE id=?').get(runId))
        .toEqual({ id: runId, status: 'created', session_id: f.sessionId });
      expect(f.db.query('SELECT COUNT(*) AS count FROM runtime_events WHERE run_id=?').get(runId))
        .toEqual({ count: eventCount });
      expect(f.db.query('SELECT COUNT(*) AS count FROM session_inputs WHERE run_id=?').get(runId))
        .toEqual({ count: inputCount });
      expect(f.published).toEqual([]);
    };
    const result = boundary === 'admit' ? f.ledger.admit(f.request, () => {
      const runId = required(f.runs.createAgent({ goal: input.goal, input, config: f.agentConfig, usage, cleanup,
        createdAt: stamp, sessionId: f.sessionId,
        scope: { version: 2, allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] } }));
      inspectInnerWrites(runId, 1, 0);
      return rejected;
    }, stamp) : f.ledger.allocateSequence(f.sessionId, sequence => {
      const admitted = required(f.admit(sequence));
      inspectInnerWrites(admitted.input.runId!, 2, 1);
      return rejected;
    });

    expect(result).toEqual(rejected);
    expect(attemptedRunId).toBeGreaterThan(0);
    expect(f.db.inTransaction).toBe(false);
    expect(f.db.query('SELECT * FROM runs').all()).toEqual([]);
    expect(f.db.query('SELECT * FROM runtime_events').all()).toEqual([]);
    expect(f.db.query('SELECT * FROM session_inputs').all()).toEqual([]);
    expect(f.db.query('SELECT * FROM sessions ORDER BY id').all()).toEqual(beforeSessions);
    expect(required(f.ledger.query({ sessionId: f.sessionId, clientSequence: 1 })))
      .toMatchObject({ input: null, nextClientSequence: 1 });
    expect(f.published).toEqual([]);

    const retried = required(f.ledger.allocateSequence(f.sessionId, sequence => f.admit(sequence)));
    expect(retried.input.clientSequence).toBe(1);
    expect(f.query(retried.input.runId!, f.sessionId).items.map(event => [event.sequence, event.type]))
      .toEqual([[1, 'run_created'], [2, 'input_state_changed']]);
    expect(f.published).toEqual([[{ runId: retried.input.runId, sequence: 1 }, { runId: retried.input.runId, sequence: 2 }]]);
  });

  it('saves the actual native user and first result entries atomically with input associations', () => {
    const f = agentFixture();
    const admitted = required(f.admit()).input;
    const runId = admitted.runId!;
    const user = { type: 'message', id: 'p6-user', parentId: null, timestamp: stamp,
      message: { role: 'user', content: input.text, timestamp: 1 } };
    const userHistory = { ...f.history, entries: [user], leafId: user.id };
    const userContext = { entryId: user.id, runId, inputId: admitted.inputId };
    const queued = f.query(runId, f.sessionId);
    f.published.length = 0;
    f.db.exec("CREATE TRIGGER reject_consumption BEFORE INSERT ON runtime_events WHEN NEW.type='input_state_changed' AND json_extract(NEW.payload_json,'$.status')='consumed' BEGIN SELECT RAISE(ABORT,'fixture consumption failure'); END;");
    expect(f.sessions.saveHistory(f.sessionId, userHistory, userContext))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(required(f.sessions.loadHistory(f.sessionId))).toEqual(f.history);
    expect(required(f.ledger.query({ sessionId: f.sessionId, inputId: admitted.inputId })).input?.status).toBe('queued');
    expect(f.query(runId, f.sessionId)).toEqual(queued);
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_consumption');
    required(f.sessions.saveHistory(f.sessionId, userHistory, userContext));
    const consumed = f.query(runId, f.sessionId);
    expect(consumed.items.at(-1)?.payload).toMatchObject({ status: 'consumed', processingStatus: 'pending',
      nativeEntryId: user.id, resultEntryId: null });
    const result = { type: 'message', id: 'p6-result', parentId: user.id, timestamp: later,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Saved answer.' }], stopReason: 'stop', timestamp: 2 } };
    const resultHistory = { ...userHistory, entries: [user, result], leafId: result.id };
    const resultContext = { entryId: result.id, runId, resultInputIds: [admitted.inputId] };
    f.db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON runtime_events WHEN NEW.type='input_state_changed' AND json_extract(NEW.payload_json,'$.resultEntryId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture result failure'); END;");
    expect(f.sessions.saveHistory(f.sessionId, resultHistory, resultContext)).toMatchObject({ ok: false });
    expect(required(f.sessions.loadHistory(f.sessionId))).toEqual(userHistory);
    expect(required(f.ledger.query({ sessionId: f.sessionId, inputId: admitted.inputId })).input?.resultEntryId).toBeNull();
    expect(f.query(runId, f.sessionId)).toEqual(consumed);
    f.db.exec('DROP TRIGGER reject_result');
    required(f.sessions.saveHistory(f.sessionId, resultHistory, resultContext));
    const associated = f.query(runId, f.sessionId);
    expect(associated.items.at(-1)?.payload).toMatchObject({ status: 'consumed', processingStatus: 'pending',
      nativeEntryId: user.id, resultEntryId: result.id });
    required(f.sessions.saveHistory(f.sessionId, resultHistory, resultContext));
    expect(f.query(runId, f.sessionId)).toEqual(associated);
    expect(f.published.length).toBe(2);
  });

  it.each(['ledger-complete', 'ledger-fail', 'run-complete', 'run-cancel'] as const)
    ('rolls back batch processing and its enclosing state when %s events fail', mode => {
    const f = agentFixture();
    const batch = bindResult(f);
    const error = appError('agent_goal_not_met', 'runtime', 'Fixture result does not meet the goal.');
    const save = () => mode === 'ledger-complete' ? f.ledger.completeResult(batch.runId, [batch.inputId], batch.resultEntryId, later)
      : mode === 'ledger-fail' ? f.ledger.failResult(batch.runId, [batch.inputId], batch.resultEntryId, error, later)
        : f.runs.finish(batch.runId, { ...f.terminal, status: mode === 'run-complete' ? 'completed' : 'cancelled',
          error: mode === 'run-complete' ? null : error,
          output: mode === 'run-complete' ? { version: 2, text: 'Saved batch.', partial: false, stopReason: 'stop',
            responseId: null, responseModel: 'fixture-model', agent: { nativeSessionId: f.history.header.id, turnCount: 1, modelCallCount: 1 } } : null,
          ...(mode === 'run-cancel' ? { cancelRequestedAt: stamp } : {}),
          inputResults: mode === 'run-complete' ? [{ inputIds: [batch.inputId], resultEntryId: batch.resultEntryId }] : [] });
    const before = f.query(batch.runId, f.sessionId);
    f.published.length = 0;
    f.db.exec("CREATE TRIGGER reject_processing BEFORE INSERT ON runtime_events WHEN NEW.type='input_state_changed' AND json_extract(NEW.payload_json,'$.processingStatus')!='pending' BEGIN SELECT RAISE(ABORT,'fixture processing failure'); END;");
    expect(save()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(required(f.runs.get(batch.runId)).status).toBe('running');
    expect(required(f.ledger.query({ sessionId: f.sessionId, inputId: batch.inputId })).input)
      .toMatchObject({ processingStatus: 'pending', resultEntryId: batch.resultEntryId });
    expect(f.query(batch.runId, f.sessionId)).toEqual(before);
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_processing');
    expect(save().ok).toBe(true);
    const after = f.query(batch.runId, f.sessionId);
    const status = mode === 'ledger-complete' || mode === 'run-complete' ? 'completed' : mode === 'ledger-fail' ? 'failed' : 'cancelled';
    expect(after.items.at(-1)?.payload).toMatchObject({ inputId: batch.inputId, status: 'consumed', processingStatus: status,
      resultEntryId: batch.resultEntryId });
    expect(after.items.slice(before.items.length).map(event => event.type)).toEqual(mode.startsWith('ledger-')
      ? ['input_state_changed'] : mode === 'run-complete' ? ['run_completed', 'input_state_changed']
        : ['run_cancel_requested', 'run_cancelled', 'input_state_changed']);
    expect(f.published.length).toBe(1);
    save();
    expect(f.query(batch.runId, f.sessionId)).toEqual(after);
  });

  it.each(['finish', 'reject'] as const)('commits Tool requested/count and %s/012 facts with events', mode => {
    const f = agentFixture();
    const admitted = required(f.admit()).input;
    const runId = admitted.runId!;
    required(f.runs.start(runId, f.agentConfig, stamp));
    const request = { runId, sessionId: f.sessionId, nativeToolCallId: 'p6-real-tool', toolName: 'read_fixture',
      toolVersion: '1', effect: 'READ' as const, rawArguments: {}, requestedAt: stamp };
    f.db.exec("CREATE TRIGGER reject_tool_request BEFORE INSERT ON runtime_events WHEN NEW.type='tool_requested' BEGIN SELECT RAISE(ABORT,'fixture request failure'); END;");
    const before = f.query(runId, f.sessionId);
    f.published.length = 0;
    expect(f.toolCalls.request(request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(required(f.runs.get(runId)).toolCallCount).toBe(0);
    expect(f.toolCalls.list({ runId, limit: 10 })).toMatchObject({ ok: true, data: { items: [] } });
    expect(f.query(runId, f.sessionId)).toEqual(before);
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_tool_request');
    const call = required(f.toolCalls.request(request));
    expect(f.toolCalls.request(request)).toEqual({ ok: true, data: call });
    expect(required(f.runs.get(runId)).toolCallCount).toBe(1);
    if (mode === 'finish') {
      required(f.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: {} }));
      f.db.exec("CREATE TRIGGER reject_tool_start BEFORE INSERT ON runtime_events WHEN NEW.type='tool_started' BEGIN SELECT RAISE(ABORT,'fixture start failure'); END;");
      expect(f.toolCalls.start({ toolCallId: call.toolCallId, startedAt: stamp })).toMatchObject({ ok: false });
      expect(required(f.toolCalls.getById(call.toolCallId)).status).toBe('requested');
      f.db.exec('DROP TRIGGER reject_tool_start');
      required(f.toolCalls.start({ toolCallId: call.toolCallId, startedAt: stamp }));
      required(f.toolCalls.start({ toolCallId: call.toolCallId, startedAt: later }));
    }
    const facts = { toolCallId: call.toolCallId, endedAt: later,
      cleanup: { version: 1 as const, stopped: true, stopReason: mode === 'finish' ? 'fixture-stop' : 'not-executed', errors: [] },
      runtimeObservation: mode === 'finish' ? observation : { ...observation, beforeOutcome: 'rejected' as const,
        afterStructure: 'not_applicable' as const, executionDurationMs: null, timingComplete: false } };
    const settle = () => mode === 'finish' ? f.toolCalls.finish({ ...facts, stoppedAt: later,
      result: { version: 1, status: 'succeeded', data: {}, committedCandidateId: null } }) : f.toolCalls.reject({ ...facts,
      result: { version: 1, status: 'failed', error: appError('tool_invalid_input', 'tool', 'Fixture rejection.'), committedCandidateId: null } });
    const pending = f.query(runId, f.sessionId);
    f.db.exec("CREATE TRIGGER reject_tool_terminal BEFORE INSERT ON runtime_events WHEN NEW.type IN ('tool_succeeded','tool_failed') BEGIN SELECT RAISE(ABORT,'fixture terminal failure'); END;");
    expect(settle()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(required(f.toolCalls.getById(call.toolCallId))).toMatchObject({ status: mode === 'finish' ? 'running' : 'requested',
      result: null, runtimeObservation: null, endedAt: null });
    expect(f.query(runId, f.sessionId)).toEqual(pending);
    f.db.exec('DROP TRIGGER reject_tool_terminal');
    const terminal = required(settle());
    expect(terminal.runtimeObservation).toEqual(facts.runtimeObservation);
    const finished = f.query(runId, f.sessionId);
    expect(finished.items.slice(before.items.length).map(event => event.type)).toEqual(mode === 'finish'
      ? ['tool_requested', 'tool_started', 'tool_succeeded'] : ['tool_requested', 'tool_failed']);
    expect(settle()).toEqual({ ok: true, data: terminal });
    expect(f.query(runId, f.sessionId)).toEqual(finished);
  });

  it('persists one correctly owned tool_cancelled event when rejecting a Tool before execution', () => {
    const f = agentFixture();
    const admitted = required(f.admit()).input;
    const runId = admitted.runId!;
    required(f.runs.start(runId, f.agentConfig, stamp));
    const call = required(f.toolCalls.request({ runId, sessionId: f.sessionId, nativeToolCallId: 'p6-cancelled-tool',
      toolName: 'read_fixture', toolVersion: '1', effect: 'READ', rawArguments: {}, requestedAt: stamp }));
    const before = f.query(runId, f.sessionId);
    const facts = { toolCallId: call.toolCallId, endedAt: later,
      result: { version: 1 as const, status: 'cancelled' as const,
        error: appError('run_cancelled', 'runtime', 'Fixture stopped before tool execution.'), committedCandidateId: null },
      cleanup: { version: 1 as const, stopped: true, stopReason: 'not-executed', errors: [] },
      runtimeObservation: { ...observation, beforeOutcome: 'rejected' as const,
        afterStructure: 'not_applicable' as const, executionDurationMs: null, timingComplete: false } };
    f.published.length = 0;
    const terminal = f.events.withTransaction(() => {
      const cancelled = required(f.toolCalls.reject(facts));
      expect(f.db.inTransaction).toBe(true);
      expect(f.db.query("SELECT sequence FROM runtime_events WHERE run_id=? AND type='tool_cancelled'").all(runId))
        .toEqual([{ sequence: before.highWatermark + 1 }]);
      expect(f.published).toEqual([]);
      return cancelled;
    });
    expect(terminal).toMatchObject({ runId, sessionId: f.sessionId, toolCallId: call.toolCallId,
      status: 'cancelled', startedAt: null, endedAt: later, stoppedAt: null, result: facts.result,
      cleanup: facts.cleanup, runtimeObservation: facts.runtimeObservation });
    const after = f.query(runId, f.sessionId);
    expect(after.items.map(event => [event.sequence, event.type])).toEqual([
      [1, 'run_created'], [2, 'input_state_changed'], [3, 'run_started'], [4, 'tool_requested'], [5, 'tool_cancelled'],
    ]);
    const event = after.items.at(-1)!;
    expect(event).toMatchObject({ runId, sessionId: f.sessionId, toolCallId: call.toolCallId,
      sequence: before.highWatermark + 1, type: 'tool_cancelled', occurredAt: later,
      payload: { version: 1, toolName: 'read_fixture', status: 'cancelled', origin: 'live', stopped: true,
        committedCandidateId: null, errorCode: 'run_cancelled' } });
    expect(f.db.query('SELECT id AS eventId,run_id AS runId,session_id AS sessionId,tool_call_id AS toolCallId,sequence,type FROM runtime_events WHERE id=?')
      .get(event.eventId)).toEqual({ eventId: event.eventId, runId, sessionId: f.sessionId,
        toolCallId: call.toolCallId, sequence: event.sequence, type: 'tool_cancelled' });
    const beforeReplay = f.db.query('SELECT * FROM tool_calls WHERE id=?').get(call.toolCallId);
    expect(f.published).toEqual([[{ runId, sequence: event.sequence }]]);
    expect(f.toolCalls.reject(facts)).toEqual({ ok: true, data: terminal });
    expect(f.db.query('SELECT * FROM tool_calls WHERE id=?').get(call.toolCallId)).toEqual(beforeReplay);
    expect(f.query(runId, f.sessionId)).toEqual(after);
    expect(f.published).toEqual([[{ runId, sequence: event.sequence }]]);
  });

  it('appends late usage only for compatible semantic changes, ignoring every usage timestamp', () => {
    const f = fixture();
    const runId = required(f.create());
    required(f.runs.start(runId, config, stamp));
    const first: UsageRecord = { ...usage, version: 2, calls: [{ callSequence: 1, usage, tokens }] };
    const terminal = { ...f.terminal, usage: first };
    required(f.runs.finish(runId, terminal));
    const fixed = required(f.runs.get(runId));
    const before = f.query(runId);
    const timestampsOnly: UsageRecord = { ...first, updatedAt: later,
      calls: [{ ...first.calls[0]!, usage: { ...usage, updatedAt: later } }] };
    expect(f.runs.supplementUsage(runId, timestampsOnly, tokens)).toEqual({ ok: true, data: true });
    expect(f.query(runId)).toEqual(before);
    expect(required(f.runs.get(runId)).usage).toEqual(first);
    const measured = { ...usage, source: 'sdk' as const, reason: null, attempts: 1, attemptsComplete: true, updatedAt: later,
      sdkValues: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
        costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null, costTotal: null } };
    const measuredTokens = { ...tokens, inputTokens: 5, outputTokens: 3, totalTokens: 8, usageComplete: true };
    const incoming: UsageRecord = { ...measured, version: 2, calls: [{ callSequence: 1, usage: measured, tokens: measuredTokens }] };
    f.db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON runtime_events WHEN NEW.type='run_usage_updated' BEGIN SELECT RAISE(ABORT,'fixture usage failure'); END;");
    expect(f.runs.supplementUsage(runId, incoming, measuredTokens)).toMatchObject({ ok: false });
    expect(required(f.runs.get(runId))).toEqual(fixed);
    f.db.exec('DROP TRIGGER reject_usage');
    expect(f.runs.supplementUsage(runId, incoming, measuredTokens)).toEqual({ ok: true, data: true });
    const after = f.query(runId);
    expect(after.items.slice(before.items.length)).toMatchObject([{ type: 'run_usage_updated',
      payload: { tokens: measuredTokens, source: 'sdk', attempts: 1, attemptsComplete: true } }]);
    expect(f.runs.supplementUsage(runId, { ...incoming, updatedAt: '2026-10-03T00:00:02.000Z',
      calls: [{ ...incoming.calls[0]!, usage: { ...measured, updatedAt: '2026-10-03T00:00:02.000Z' } }] }, measuredTokens))
      .toEqual({ ok: true, data: true });
    expect(f.runs.supplementUsage(runId, { ...incoming, sdkValues: { ...measured.sdkValues, input: 99 } }, measuredTokens))
      .toEqual({ ok: true, data: false });
    expect(f.runs.supplementUsage(runId, { ...incoming, calls: [
      { ...incoming.calls[0]!, usage: { ...measured, sdkValues: { ...measured.sdkValues, input: 99 } } },
      { callSequence: 2, usage, tokens },
    ] }, measuredTokens)).toEqual({ ok: true, data: false });
    expect(f.query(runId)).toEqual(after);
    expect(f.runs.finish(runId, terminal)).toEqual({ ok: true, data: true });
    const final = required(f.runs.get(runId));
    expect([final.status, final.endedAt, final.stoppedAt, final.cleanup, final.output, final.error])
      .toEqual([fixed.status, fixed.endedAt, fixed.stoppedAt, fixed.cleanup, fixed.output, fixed.error]);
  });

  it.each([
    ['run', true, true], ['model-call', true, true],
    ['run', false, true], ['model-call', false, true],
    ['run', true, false], ['model-call', true, false],
  ] as const)('rejects conflicting %s attempt counts with stored completeness=%s and incoming completeness=%s',
    (level, storedComplete, incomingComplete) => {
    const f = fixture();
    const runId = required(f.create());
    const counted = { ...usage, attempts: 1, attemptsComplete: storedComplete };
    const initial: UsageRecord = { ...counted, version: 2, calls: [{ callSequence: 1, usage: counted, tokens }] };
    required(f.runs.finish(runId, { ...f.terminal, usage: initial }));
    const beforeRun = required(f.runs.get(runId));
    const beforeRow = f.db.query('SELECT * FROM runs WHERE id=?').get(runId);
    const beforeEvents = f.query(runId);
    const beforeEventRows = f.db.query('SELECT * FROM runtime_events WHERE run_id=? ORDER BY sequence').all(runId);
    f.published.length = 0;
    const incoming: UsageRecord = { ...initial, updatedAt: later,
      ...(level === 'run' ? { attempts: 2, attemptsComplete: incomingComplete } : { calls: [{ callSequence: 1,
        usage: { ...counted, attempts: 2, attemptsComplete: incomingComplete, updatedAt: later }, tokens }] }) };

    expect(f.runs.supplementUsage(runId, incoming, tokens)).toEqual({ ok: true, data: false });
    expect(required(f.runs.get(runId))).toEqual(beforeRun);
    expect(f.db.query('SELECT * FROM runs WHERE id=?').get(runId)).toEqual(beforeRow);
    expect(f.query(runId)).toEqual(beforeEvents);
    expect(f.db.query('SELECT * FROM runtime_events WHERE run_id=? ORDER BY sequence').all(runId)).toEqual(beforeEventRows);
    expect(f.published).toEqual([]);
  });

  it.each([null, 2])('accepts complete late attempts for an incomplete count of %s while preserving known values', previousCount => {
    const f = fixture();
    const runId = required(f.create());
    const incomplete = { ...usage, attempts: previousCount };
    const initial: UsageRecord = { ...incomplete, version: 2, calls: [{ callSequence: 1, usage: incomplete, tokens }] };
    required(f.runs.finish(runId, { ...f.terminal, usage: initial }));
    const beforeRun = required(f.runs.get(runId));
    const beforeEvents = f.query(runId);
    const complete = { ...usage, attempts: 2, attemptsComplete: true, updatedAt: later };
    const incoming: UsageRecord = { ...complete, version: 2, calls: [{ callSequence: 1, usage: complete, tokens }] };
    f.published.length = 0;

    expect(f.runs.supplementUsage(runId, incoming, tokens)).toEqual({ ok: true, data: true });
    const saved = required(f.runs.get(runId));
    const attempts = previousCount ?? 2;
    expect(saved).toEqual({ ...beforeRun, usage: { ...incoming, attempts,
      calls: [{ callSequence: 1, usage: { ...complete, attempts }, tokens }] } });
    const afterEvents = f.query(runId);
    expect(afterEvents.items.slice(beforeEvents.items.length)).toMatchObject([{ type: 'run_usage_updated', occurredAt: later,
      payload: { attempts, attemptsComplete: true, source: 'unknown', tokens } }]);
    expect(afterEvents.items.length).toBe(beforeEvents.items.length + 1);
    expect(f.published).toEqual([[{ runId, sequence: afterEvents.highWatermark }]]);
    f.published.length = 0;

    const laterTimestamp = '2026-10-03T00:00:02.000Z';
    const replay: UsageRecord = { ...saved.usage, updatedAt: laterTimestamp,
      ...(saved.usage.version === 2 ? { calls: saved.usage.calls.map(call => ({ ...call,
        usage: { ...call.usage, updatedAt: laterTimestamp } })) } : {}) };
    expect(f.runs.supplementUsage(runId, replay, tokens)).toEqual({ ok: true, data: true });
    expect(f.runs.supplementUsage(runId, { ...initial, updatedAt: laterTimestamp }, tokens)).toEqual({ ok: true, data: true });
    expect(required(f.runs.get(runId))).toEqual(saved);
    expect(f.query(runId)).toEqual(afterEvents);
    expect(f.published).toEqual([]);
  });

  it('keeps two incomplete attempt reports as compatible low-information replays', () => {
    const f = fixture();
    const runId = required(f.create());
    const incomplete = { ...usage, attempts: 1 };
    const initial: UsageRecord = { ...incomplete, version: 2, calls: [{ callSequence: 1, usage: incomplete, tokens }] };
    required(f.runs.finish(runId, { ...f.terminal, usage: initial }));
    const beforeRun = required(f.runs.get(runId));
    const beforeRow = f.db.query('SELECT * FROM runs WHERE id=?').get(runId);
    const beforeEvents = f.query(runId);
    f.published.length = 0;
    const incoming: UsageRecord = { ...initial, attempts: 2, updatedAt: later,
      calls: [{ callSequence: 1, usage: { ...incomplete, attempts: 2, updatedAt: later }, tokens }] };

    expect(f.runs.supplementUsage(runId, incoming, tokens)).toEqual({ ok: true, data: true });
    expect(required(f.runs.get(runId))).toEqual(beforeRun);
    expect(f.db.query('SELECT * FROM runs WHERE id=?').get(runId)).toEqual(beforeRow);
    expect(f.query(runId)).toEqual(beforeEvents);
    expect(f.published).toEqual([]);
  });

  it.each(['tool_failed', 'run_failed', 'input_state_changed'] as const)
    ('recovers old active Run, Tools and input without created backfill; %s failure rolls back everything', rejectedType => {
    const f = agentFixture(false, true);
    const admitted = required(f.admit()).input;
    const runId = admitted.runId!;
    required(f.runs.start(runId, f.agentConfig, stamp));
    required(f.ledger.dispatch(admitted.inputId, stamp));
    const request = { runId, sessionId: f.sessionId, toolName: 'read_fixture', toolVersion: '1', effect: 'READ' as const,
      rawArguments: {}, requestedAt: stamp };
    const requested = required(f.toolCalls.request({ ...request, nativeToolCallId: 'old-requested' }));
    const running = required(f.toolCalls.request({ ...request, nativeToolCallId: 'old-running' }));
    required(f.toolCalls.fixArguments({ toolCallId: running.toolCallId, finalArguments: {} }));
    required(f.toolCalls.start({ toolCallId: running.toolCallId, startedAt: stamp }));
    const oldRun = required(f.runs.get(runId));
    const oldTools = required(f.toolCalls.list({ runId, limit: 10 }));
    expect(f.query(runId, f.sessionId)).toMatchObject({ coverage: 'none', items: [] });
    f.db.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON runtime_events WHEN NEW.type='${rejectedType}' BEGIN SELECT RAISE(ABORT,'fixture recovery failure'); END;`);
    const recovering = createRunRepository(f.db, f.events);
    expect(recovering.failInterrupted(later)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(required(f.runs.get(runId))).toEqual(oldRun);
    expect(required(f.toolCalls.list({ runId, limit: 10 }))).toEqual(oldTools);
    expect(required(f.sessions.loadHistory(f.sessionId))).toEqual(f.history);
    expect(required(f.ledger.query({ sessionId: f.sessionId, inputId: admitted.inputId })).input)
      .toMatchObject({ status: 'queued', processingStatus: 'pending', dispatchedAt: stamp });
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_recovery');
    expect(recovering.failInterrupted(later)).toEqual({ ok: true, data: 1 });
    const page = f.query(runId, f.sessionId);
    expect(page.coverage).toBe('partial');
    expect(page.items.map(event => event.type)).toEqual(['tool_failed', 'tool_failed', 'run_failed', 'input_state_changed']);
    expect(page.items.every(event => 'origin' in event.payload && event.payload.origin === 'recovery')).toBe(true);
    expect(f.db.query("SELECT type,json_extract(payload_json,'$.origin') AS origin FROM runtime_events WHERE run_id=? ORDER BY sequence").all(runId))
      .toEqual([{ type: 'tool_failed', origin: 'recovery' }, { type: 'tool_failed', origin: 'recovery' },
        { type: 'run_failed', origin: 'recovery' }, { type: 'input_state_changed', origin: 'recovery' }]);
    expect(page.items.map(event => event.occurredAt)).toEqual([later, later, later, later]);
    expect(page.items.at(-1)?.payload).toMatchObject({ inputId: admitted.inputId, status: 'delivery_unknown',
      processingStatus: 'failed', nativeEntryId: null, resultEntryId: null });
    expect(required(f.toolCalls.getById(requested.toolCallId))).toMatchObject({ status: 'failed', stoppedAt: null,
      cleanup: { stopped: true } });
    expect(required(f.toolCalls.getById(running.toolCallId))).toMatchObject({ status: 'failed', stoppedAt: null,
      cleanup: { stopped: false } });
    expect(required(f.runs.get(runId))).toMatchObject({ status: 'failed', stoppedAt: null, cleanup: { stopped: false } });
    expect(recovering.failInterrupted(later)).toEqual({ ok: true, data: 0 });
    expect(f.query(runId, f.sessionId)).toEqual(page);
    expect(f.published.length).toBe(1);
  });

  it('recovers only the verified saved response batch of an old completed Run', () => {
    const f = agentFixture(false, true);
    const batch = bindResult(f);
    const output = { version: 2, text: 'Saved batch.', partial: false, stopReason: 'stop', responseId: null,
      responseModel: 'fixture-model', agent: { nativeSessionId: f.history.header.id, turnCount: 1, modelCallCount: 1 } };
    f.db.query("UPDATE runs SET status='completed',output_json=?,cleanup_json=?,ended_at=?,stopped_at=? WHERE id=?")
      .run(JSON.stringify(output), JSON.stringify({ ...cleanup, stopped: true }), later, later, batch.runId);
    const terminal = required(f.runs.get(batch.runId));
    f.db.exec("CREATE TRIGGER reject_verified_completion BEFORE INSERT ON runtime_events WHEN NEW.type='input_state_changed' BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END;");
    const recovering = createRunRepository(f.db, f.events);
    expect(recovering.failInterrupted(later)).toMatchObject({ ok: false });
    expect(required(f.ledger.query({ sessionId: f.sessionId, inputId: batch.inputId })).input?.processingStatus).toBe('pending');
    expect(f.published).toEqual([]);
    f.db.exec('DROP TRIGGER reject_verified_completion');
    expect(recovering.failInterrupted(later)).toEqual({ ok: true, data: 0 });
    expect(required(f.runs.get(batch.runId))).toEqual(terminal);
    const page = f.query(batch.runId, f.sessionId);
    expect(page).toMatchObject({ coverage: 'partial', items: [{ type: 'input_state_changed', payload: {
      origin: 'recovery', inputId: batch.inputId, status: 'consumed', processingStatus: 'completed', resultEntryId: batch.resultEntryId } }] });
    expect(page.items.length).toBe(1);
    expect(f.published.length).toBe(1);
  });
});
