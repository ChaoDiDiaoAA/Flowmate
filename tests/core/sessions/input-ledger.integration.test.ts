import { saveTestHistory, nativeAssistantFacts } from '../../support/history.ts';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { makeApplication } from '../../../packages/core/src/application.ts';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { appError, fail, FillInvoiceFormInputSchema, FillInvoiceFormOutputSchema, normalizeSessionInputRequest, ok, formatExecutionPrompt, StoredCandidateDraftSchema, LegacySessionInputRequestSchema } from '@flowmate/contracts';
import type { AgentRunEvent, FillInputRequest, InvoiceFormTarget, P3AgentConfigFacts, PreparedAgent, Result, SafeConfigSnapshot, SessionInputRequest, WorkspaceContext } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { openDatabase } from '../../../packages/core/src/storage/database.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createToolRecorder } from '../../../packages/core/src/tools/recorder.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { finishSessionInputs } from '../../../packages/core/src/sessions/input-ledger.ts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { createTestWorkspaceVerifier } from '../../support/workspace.ts';

const at = '2026-10-01T00:00:00.000Z';
const workspace: WorkspaceContext = { formatVersion: 1, revision: 3, sessionId: 1,
  documentRef: { id: 1, version: 'v1' }, jobId: 1, candidateRef: { id: 1, sequence: 1 },
  activeView: 'candidate', selection: null };
const request: FillInputRequest = { sessionId: 1, clientSequence: 1, mode: 'prompt', goalMode: 'fill-form',
  text: 'Fill the selected invoice form.', workspace: { revision: 3, sessionId: 1,
    documentRef: { id: 1, version: 'v1' }, jobId: 1, candidateRef: { id: 1, sequence: 1 } },
  formTarget: { formInstanceId: 'form-1', expectedRevision: 0 }, config: { version: 1, name: 'fixture', revision: 1,
    modelRef: { provider: 'fixture', model: 'fixture' }, native: { authPath: 'D:/isolated/auth.json', modelsPath: null },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } }, timeoutMs: 1000, stopGraceMs: 100 };
const usage = { version: 1 as const, source: 'unknown' as const, reason: 'fixture', sdkValues: null,
  attempts: null, attemptsComplete: false, costSource: null, updatedAt: at };
const cleanup = { version: 1 as const, stopped: true, stopReason: null, errors: [], lateObservationRequired: false };
const fixtureCandidate = { id: 1, sequence: 1, fields: StoredCandidateDraftSchema.parse({ fields: Object.fromEntries(
  ['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount']
    .map(field => [field, { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }])), lines: [], notes: [] }).fields,
  lines: [], issues: [] };
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
function fixture(withMaterial = false) {
  const selected = withMaterial ? makeSelectedCandidate() : null;
  const root = selected?.root ?? mkdtempSync(join(tmpdir(), 'flowmate-input-ledger-'));
  const paths = { root, databaseFile: join(root, 'data', selected ? 'flowmate.sqlite' : 'test.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const store = selected ?? need(openDatabase(paths));
  if (!('memory' in store)) throw new Error('Runtime input fixtures require the current committed MemoryStore.');
  deferCleanup(() => store.close());
  const history = { storageVersion: 1 as const, header: { type: 'session' as const, id: 'native-fill-input', version: 3,
    timestamp: at, cwd: root }, entries: [], leafId: null, unusable: false };
  if (selected) {
    store.db.query("UPDATE sessions SET native_session_id='native-fill-input' WHERE id=1").run();
    need(saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore : undefined, 1, history));
  } else need(store.sessions.create({ nativeSessionId: 'native-fill-input', title: 'Fill input', at, nativeHistory: history }));
  const ledger = Reflect.get(store, 'sessionInputs') as import('../../../packages/core/src/sessions/input-ledger.ts').SessionInputLedger;
  expect(ledger).toBeDefined();
  let creates = 0;
  const createRun = (input?: { config: unknown }) => {
    creates++;
    const inserted = store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,
      cleanup_json,usage_json,created_at) VALUES ('agent',1,?,'created','Fill form',?,?,?, ?,?)`)
      .run(JSON.stringify({ version: 2, allowedTools: ['fill_invoice_form'], allowedDocumentIds: [1],
        allowedArtifactIds: [2], allowedResourcePaths: [] }), JSON.stringify({ version: 1, goal: 'Fill form',
        text: request.text, messageTimestamp: 1 }), JSON.stringify(input
          ? { ...(input.config as Record<string, unknown>), goalMode: 'fill-form', workspaceContext: workspace, formTarget: request.formTarget }
          : safeConfig), JSON.stringify(cleanup), JSON.stringify(usage), at);
    return ok({ runId: Number(inserted.lastInsertRowid), jobId: 1,
      content: { version: 2 as const, text: request.text, workspaceContext: workspace,
        workspaceInput: { documentRef: workspace.documentRef, job: { id: 1, goal: 'Fill form' }, candidate: fixtureCandidate },
        allowedDocumentIds: [1], allowedArtifactIds: [2], promptText: 'Fixture frozen Fill prompt.' },
      scope: { version: 2 as const, allowedTools: ['fill_invoice_form'], allowedDocumentIds: [1],
        allowedArtifactIds: [2], allowedResourcePaths: [] }, workspaceContext: workspace,
      workspaceInput: { documentRef: workspace.documentRef, job: { id: 1, goal: 'Fill form' }, candidate: fixtureCandidate },
      formTarget: request.formTarget });
  };
  const tools = createToolExecutor({ definitions: [{ name: 'fill_invoice_form', version: '1', description: 'Fixture form tool',
    effect: 'LOCAL_WRITE', executionMode: 'sequential', inputSchema: FillInvoiceFormInputSchema,
    outputSchema: FillInvoiceFormOutputSchema, async execute() { throw new Error('Unexpected tool execution.'); } }],
    recorder: createToolRecorder(store.toolCalls, () => at), now: () => at });
  return { store, ledger, paths, createRun, tools, verify: createTestWorkspaceVerifier(store, root), creates: () => creates };
}

describe('idle Fill prompt input ledger', () => {
  it('keeps new raw budget intent distinct from resolved defaults and old identity hashes', () => {
    const { ledger, createRun, creates } = fixture();
    const { timeoutMs: _timeout, stopGraceMs: _grace, ...raw } = request;
    const admit = () => {
      const created = createRun();
      return created.ok ? ok({ ...created.data, content: { ...created.data.content,
        requestIdentityVersion: 1 as const, originalBudgetOverrides: {} } }) : created;
    };
    const first = need(ledger.admit(raw, admit, at)).input;
    expect(need(ledger.lookup(raw))).toMatchObject({ inputId: first.inputId,
      content: { version: 2, requestIdentityVersion: 1, originalBudgetOverrides: {} } });
    expect(ledger.lookup({ ...raw, timeoutMs: 60_000 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(ledger.lookup({ ...raw, budget: {} })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(creates()).toBe(1);
  });

  it('reads an old v2 hash using its original defaulting algorithm without rewriting it', () => {
    const { store, ledger, createRun } = fixture();
    const first = need(ledger.admit(request, createRun, at)).input;
    const { timeoutMs: _timeout, stopGraceMs: _grace, ...raw } = request;
    const oldRequest = need(normalizeSessionInputRequest({ ...raw, timeoutMs: 60_000, stopGraceMs: 5000 }));
    const hash = createHash('sha256').update(JSON.stringify(oldRequest)).digest('hex');
    store.db.query('UPDATE session_inputs SET request_hash=? WHERE id=?').run(hash, first.inputId);
    expect(need(ledger.lookup(raw))).toHaveProperty('inputId', first.inputId);
    expect(store.db.query('SELECT request_hash FROM session_inputs WHERE id=?').get(first.inputId)).toEqual({ request_hash: hash });
  });
  it('rechecks the trusted Desktop identity in the admission transaction independently of a later config', () => {
    const { store, ledger, createRun, creates } = fixture();
    const desktopRequestHash = 'a'.repeat(64);
    const admission = () => {
      const created = createRun();
      return created.ok ? ok({ ...created.data, content: { ...created.data.content, desktopRequestHash } }) : created;
    };
    const first = need(ledger.admit(request, admission, at, desktopRequestHash));
    const changedConfig = { ...request, config: { ...request.config, revision: 2 } };
    expect(ledger.lookup(changedConfig)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(need(ledger.admit(changedConfig, admission, at, desktopRequestHash)))
      .toMatchObject({ created: false, input: { inputId: first.input.inputId, runId: first.input.runId } });
    expect(ledger.admit(changedConfig, admission, at, 'b'.repeat(64)))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(ledger.lookup(changedConfig, 'invalid')).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(creates()).toBe(1);
    expect(store.db.query('SELECT COUNT(*) AS count FROM session_inputs').get()).toEqual({ count: 1 });
  });
  it('preserves old Fill hash bytes and rejects a new valid mode or goal as an input conflict', () => {
    const { store, ledger, createRun } = fixture();
    const input = need(ledger.admit(request, createRun, at)).input;
    const legacyRequest = LegacySessionInputRequestSchema.parse(request);
    store.db.query('UPDATE session_inputs SET content_json=?,request_hash=? WHERE id=?').run(JSON.stringify({ version: 1,
      text: request.text, workspaceContext: workspace, allowedDocumentIds: [1], allowedArtifactIds: [2] }),
      createHash('sha256').update(JSON.stringify(legacyRequest)).digest('hex'), input.inputId);
    expect(need(ledger.lookup(request))).toMatchObject({ inputId: input.inputId, content: { version: 1 }, resultEntryId: null });
    expect(ledger.lookup({ sessionId: 1, clientSequence: 1, mode: 'steer', runId: input.runId!, text: request.text }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(ledger.lookup({ sessionId: 1, clientSequence: 1, mode: 'prompt', goalMode: 'answer', text: request.text, config: request.config }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  });
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

  it('validates a Run filter belongs to this Session before returning its input page', () => {
    const { store, ledger, createRun } = fixture();
    const input = need(ledger.admit(request, createRun, at)).input;
    expect(need(ledger.list({ sessionId: 1, runId: input.runId! })).items.map(item => item.inputId)).toEqual([input.inputId]);
    store.db.query("UPDATE runs SET status='failed',ended_at=?,error_json=? WHERE id=?")
      .run(at, JSON.stringify(appError('agent_cancelled', 'runtime', 'Filter fixture ended.')), input.runId!);
    const emptyRunId = need(createRun()).runId;
    expect(need(ledger.list({ sessionId: 1, runId: emptyRunId })).items).toEqual([]);
    const otherSession = need(store.sessions.create({ title: 'Other Session', at, nativeSessionId: 'native-other-input' }));
    store.db.query('UPDATE runs SET session_id=? WHERE id=?').run(otherSession.sessionId, emptyRunId);
    expect(ledger.list({ sessionId: 1, runId: emptyRunId })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    store.db.query("UPDATE runs SET kind='provider',session_id=NULL,scope_json=NULL WHERE id=?").run(emptyRunId);
    expect(ledger.list({ sessionId: 1, runId: emptyRunId })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(ledger.list({ sessionId: 1, runId: emptyRunId + 1 })).toMatchObject({ ok: false, error: { code: 'run_not_found' } });
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
    expect(() => markInputConsumed(store.db, first.input.inputId, first.input.runId!, 'missing-entry', at)).toThrow();
    const entry = { type: 'message', id: 'real-user', parentId: null, timestamp: at,
      message: { role: 'user', content: request.text, timestamp: 1 } };
    store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES (1,0,?,?,?)')
      .run(entry.id, JSON.stringify(entry), first.input.runId);
    store.db.transaction(() => markInputConsumed(store.db, first.input.inputId, first.input.runId!, entry.id, at)).immediate();
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
    expect(() => markInputConsumed(store.db, first.input.inputId, first.input.runId!, 'assistant', at)).toThrow();
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input?.status).toBe('queued');
  });

  it('keeps a completed processing fact when a later cancellation arrives', async () => {
    const { store, ledger, createRun } = fixture();
    const { markInputConsumed, finishSessionInputs } = await import('../../../packages/core/src/sessions/input-ledger.ts');
    const first = need(ledger.admit(request, createRun, at));
    const entry = { type: 'message', id: 'user-complete', parentId: null, message: { role: 'user', content: request.text } };
    store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES (1,0,?,?,?)')
      .run(entry.id, JSON.stringify(entry), first.input.runId);
    markInputConsumed(store.db, first.input.inputId, first.input.runId!, entry.id, at);
    const result = { type: 'message', id: 'complete-result', parentId: entry.id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Complete.' }], stopReason: 'stop' } };
    store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES (1,1,?,?,?)')
      .run(result.id, JSON.stringify(result), first.input.runId);
    const { associateInputResult } = await import('../../../packages/core/src/sessions/input-ledger.ts');
    associateInputResult(store.db, first.input.runId!, [first.input.inputId], result.id, at);
    need(ledger.completeResult(first.input.runId!, [first.input.inputId], result.id, at));
    finishSessionInputs(store.db, first.input.runId!, 'completed', null, at);
    finishSessionInputs(store.db, first.input.runId!, 'cancelled', appError('agent_cancelled', 'runtime', 'late cancel'), at);
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'consumed', processingStatus: 'completed', error: null });
  });

  it('records unknown delivery after a dispatch gap and never retries it on duplicate admission', async () => {
    const { store, ledger, createRun, creates } = fixture();
    const { finishSessionInputs } = await import('../../../packages/core/src/sessions/input-ledger.ts');
    const first = need(ledger.admit(request, createRun, at));
    need(ledger.dispatch(first.input.inputId, at));
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
    expect(saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore : undefined, 1, history, { entryId: entry.id, runId: first.input.runId!, inputId: first.input.inputId }))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(need(store.sessions.loadHistory(1))).toMatchObject({ entries: [], leafId: null });
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'queued', nativeEntryId: null });
    store.db.exec('DROP TRIGGER reject_consumption');
    need(saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore : undefined, 1, history, { entryId: entry.id, runId: first.input.runId!, inputId: first.input.inputId }));
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input).toMatchObject({ status: 'consumed', nativeEntryId: entry.id });
    need(saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore : undefined, 1, history, { entryId: entry.id, runId: first.input.runId!, inputId: first.input.inputId }));
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
    need(ledger.dispatch(first.input.inputId, at));
    store.close();
    const restarted = need(openDatabase(paths));
    deferCleanup(() => restarted.close());
    expect(need(restarted.sessionInputs.query({ sessionId: 1, clientSequence: 1 })).input)
      .toMatchObject({ inputId: first.input.inputId, runId: first.input.runId, status: 'delivery_unknown',
        processingStatus: 'failed', nativeEntryId: null, dispatchedAt: at, error: { code: 'runtime_interrupted' } });
    expect(need(restarted.runs.get(first.input.runId!))).toMatchObject({ status: 'failed', cleanup: { stopped: false } });
    expect(need(restarted.sessionInputs.admit(request, () => { throw new Error('Restart must not re-admit input.'); }, at)))
      .toMatchObject({ created: false, input: { inputId: first.input.inputId, runId: first.input.runId } });
    expect(restarted.sessionInputs.dispatch(first.input.inputId, at)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(restarted.db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
    expect(creates()).toBe(1);
  });

  it('returns the original input and Run before poisoned Runtime or stale Workspace admission', async () => {
    const { store, ledger, createRun, paths } = fixture();
    const first = need(ledger.admit(request, createRun, at));
    const runtime = new RuntimeService({ memory: store.memory, runs: store.runs, sessions: store.sessions, sessionInputs: ledger,
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
    const runtime = new RuntimeService({ memory: store.memory, runs: store.runs, sessions: store.sessions, sessionInputs: ledger,
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
    const { store, ledger, paths, createRun, tools, verify } = fixture(true);
    const agent = new PiAgentAdapter({ cwd: paths.root, agentDir: paths.runtimeDir });
    const snapshot: PreparedAgent['snapshot'] & { formTarget: { formInstanceId: string; expectedRevision: number } } = { ...safeConfig, historyPolicyVersion: 'p9-native-history-v1', agent: { ...safeConfig.agent, maxModelCalls: 16 as const }, api: 'openai-completions', resolvedModel: request.config.modelRef,
      formTarget: { formInstanceId: 'prepared-other-form', expectedRevision: 99 } };
    let preparedOptions: unknown;
    agent.prepare = async (_nativeId, _config, _limits, _signal, options) => { preparedOptions = options; return ok({ snapshot,
      async execute() { throw new Error('This preparation-boundary test must not execute a model.'); },
    } satisfies PreparedAgent); };
    let startedTarget: unknown;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const runtime = new RuntimeService({ memory: store.memory, workspaceVerifier: verify, runs: { ...store.runs, createWorkspaceAgent: createRun,
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
    expect(preparedOptions).toEqual({ activeToolNames: ['fill_invoice_form'], goalMode: 'fill-form', sessionInputs: true,
      runtimeBudget: { maxModelCalls: 16, maxToolCalls: 24, toolTimeoutMs: 10_000 } });
    expect(startedTarget).toEqual(request.formTarget);
    expect(need(ledger.query({ sessionId: 1, clientSequence: 1 })).input)
      .toMatchObject({ status: 'failed', processingStatus: 'failed', dispatchedAt: null });
  });

  it('requires actual applied and delivered tool facts rather than a final model claim', async () => {
    const { store, ledger, paths, createRun, tools, verify } = fixture(true);
    const agent = new PiAgentAdapter({ cwd: paths.root, agentDir: paths.runtimeDir });
    agent.prepare = async () => ok({ snapshot: { ...safeConfig, historyPolicyVersion: 'p9-native-history-v1', agent: { ...safeConfig.agent, maxModelCalls: 16 } }, async execute(input) {
      const previous = need(store.sessions.loadHistory(input.sessionId))!;
      const entry = { type: 'message', id: 'true-input', parentId: null, timestamp: at,
        message: { role: 'user', content: input.text, timestamp: input.messageTimestamp } };
      need(saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore : undefined, input.sessionId, { ...previous, entries: [entry], leafId: entry.id },
        { entryId: entry.id, runId: input.runId, inputId: input.inputId }));
      return { text: 'The form was filled.', partial: false, stopReason: 'stop' as const,
        responseId: null, responseModel: null, error: null, usage,
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        stopped: true, cleanupErrors: [], agent: { nativeSessionId: 'native-fill-input', turnCount: 1, modelCallCount: 1 } };
    } } satisfies PreparedAgent);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const runtime = new RuntimeService({ memory: store.memory, workspaceVerifier: verify, runs: { ...store.runs, createWorkspaceAgent: createRun },
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
    const { store, ledger, paths, createRun, creates, verify } = fixture(true);
    const agent = new PiAgentAdapter({ cwd: paths.root, agentDir: paths.runtimeDir });
    const runtime = new RuntimeService({ memory: store.memory, workspaceVerifier: verify, runs: { ...store.runs, createWorkspaceAgent: createRun },
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
      () => at, store.runs, store.memory, ledger, async () => fail(appError('runtime_busy', 'runtime', 'Busy.')));
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

const p5At = '2026-10-02T00:00:00.000Z';
const p5Config = { version: 1 as const, name: 'fixture', revision: 1,
  modelRef: { provider: 'fixture', model: 'fixture' },
  native: { authPath: 'D:/isolated/auth.json', modelsPath: null },
  parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
function p5Need<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
function p5Fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p5-inputs-'));
  const store = p5Need(openDatabase({ root, databaseFile: join(root, 'data', 'test.sqlite'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') }));
  deferCleanup(() => store.close());
  p5Need(store.sessions.create({ nativeSessionId: 'native-p5', title: 'P5 inputs', at: p5At,
    nativeHistory: { storageVersion: 1, header: { type: 'session', id: 'native-p5', version: 3,
      timestamp: p5At, cwd: root }, entries: [], leafId: null, unusable: false } }));
  const request: SessionInputRequest = { sessionId: 1, clientSequence: 1, mode: 'prompt', text: 'same text', config: p5Config,
    timeoutMs: 1000, stopGraceMs: 100 };
  let created = 0;
  const admit = (raw: SessionInputRequest, runId?: number) => store.sessionInputs.admit(raw, () => {
    if (runId === undefined) {
      created++;
      runId = Number(store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,
        cleanup_json,usage_json,created_at) VALUES ('agent',1,?,'created','Chat',?,?,?,?,?)`)
        .run(JSON.stringify({ version: 1, allowedTools: [], allowedDocumentIds: [], allowedArtifactIds: [] }),
          JSON.stringify({ version: 1, goal: 'Chat', text: raw.text, messageTimestamp: 1 }), '{}', '{}', '{}', p5At).lastInsertRowid);
    }
    return ok({ runId, content: { version: 2 as const, text: raw.text, workspaceContext: null,
      workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [], promptText: raw.text } });
  }, p5At);
  const append = (runId: number, inputId: number, id: string) => {
    const previous = p5Need(store.sessions.loadHistory(1))!;
    const entry = { type: 'message', id, parentId: previous.leafId, timestamp: p5At,
      message: { role: 'user', content: 'same text', timestamp: 1 } };
    return saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore : undefined, 1, { ...previous, entries: [...previous.entries, entry], leafId: id },
      { entryId: id, runId, inputId });
  };
  return { store, request, admit, append, created: () => created };
}

describe('P5 input identity and two-stage processing', () => {
  it('freezes a plain prompt and deduplicates before calling admission again', () => {
    const { store, request, admit, created } = p5Fixture();
    const accepted = p5Need(admit(request));
    const duplicate = p5Need(admit(request));
    expect(duplicate).toMatchObject({ created: false, input: { inputId: accepted.input.inputId,
      runId: accepted.input.runId, content: { version: 2, promptText: 'same text', workspaceContext: null } } });
    expect(created()).toBe(1);
    expect(p5Need(store.sessionInputs.query({ sessionId: 1, inputId: accepted.input.inputId })).input).toEqual(accepted.input);
  });

  it('binds equal prompt, Steer and FollowUp text by input ID within one Run', () => {
    const { store, request, admit, append, created } = p5Fixture();
    const initial = p5Need(admit(request)).input;
    store.db.query("UPDATE runs SET status='running' WHERE id=?").run(initial.runId!);
    const follow = p5Need(admit({ sessionId: 1, clientSequence: 2, mode: 'followUp', runId: initial.runId!, text: 'same text' }, initial.runId!)).input;
    const steer = p5Need(admit({ sessionId: 1, clientSequence: 3, mode: 'steer', runId: initial.runId!, text: 'same text' }, initial.runId!)).input;
    p5Need(append(initial.runId!, initial.inputId, 'initial'));
    p5Need(append(initial.runId!, steer.inputId, 'steer'));
    p5Need(append(initial.runId!, follow.inputId, 'follow'));
    expect(created()).toBe(1);
    expect(store.db.query('SELECT id,native_entry_id,status FROM session_inputs ORDER BY id').all()).toEqual([
      { id: initial.inputId, native_entry_id: 'initial', status: 'consumed' },
      { id: follow.inputId, native_entry_id: 'follow', status: 'consumed' },
      { id: steer.inputId, native_entry_id: 'steer', status: 'consumed' },
    ]);
  });

  it('never upgrades consumed input to completed from a Run terminal status alone', () => {
    const { store, request, admit, append } = p5Fixture();
    const input = p5Need(admit(request)).input;
    p5Need(append(input.runId!, input.inputId, 'user'));
    expect(() => finishSessionInputs(store.db, input.runId!, 'completed', null, p5At)).toThrow('input_processing_unconfirmed');
    expect(p5Need(store.sessionInputs.query({ sessionId: 1, inputId: input.inputId })).input)
      .toMatchObject({ status: 'consumed', processingStatus: 'pending', resultEntryId: null });
  });

  it('keeps completed members unchanged when a later input is cancelled', () => {
    const { store, request, admit, append } = p5Fixture();
    const input = p5Need(admit(request)).input;
    p5Need(append(input.runId!, input.inputId, 'user'));
    const previous = p5Need(store.sessions.loadHistory(1))!;
    const result = { type: 'message', id: 'result', parentId: 'user', timestamp: p5At,
      message: { ...nativeAssistantFacts, role: 'assistant', content: [{ type: 'text', text: 'Finished.' }], stopReason: 'stop', timestamp: 2 } };
    p5Need(saveTestHistory(store.db, 'runtimeEventStore' in store ? store.runtimeEventStore : undefined, 1, { ...previous, entries: [...previous.entries, result], leafId: 'result' },
      { entryId: 'result', runId: input.runId!, resultInputIds: [input.inputId] }));
    expect(p5Need(store.sessionInputs.query({ sessionId: 1, inputId: input.inputId })).input)
      .toMatchObject({ processingStatus: 'pending', resultEntryId: 'result' });
    p5Need(store.sessionInputs.completeResult(input.runId!, [input.inputId], 'result', p5At));
    finishSessionInputs(store.db, input.runId!, 'cancelled', appError('agent_cancelled', 'runtime', 'Later cancellation.'), p5At);
    expect(p5Need(store.sessionInputs.query({ sessionId: 1, inputId: input.inputId })).input)
      .toMatchObject({ status: 'consumed', processingStatus: 'completed', resultEntryId: 'result', error: null });
  });
});

describe('P5 public input chain with real SDK and SQLite', () => {
  it.each(['success', 'residual', 'processing-failure', 'recovery-failure', 'missing-result', 'corrupt-completed-result'] as const)('consumes equal prompt/Steer/FollowUp once and preserves result evidence: %s', async scenario => {
    const rejectCompletion = scenario === 'processing-failure';
    const root = mkdtempSync(join(tmpdir(), 'flowmate-p5-public-'));
    const paths = { root, databaseFile: join(root, 'data', 'test.sqlite'), logsDir: join(root, 'logs'),
      artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
    let entered!: () => void; const firstRequest = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const requests: { messages: { role: string; content?: unknown }[] }[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json());
      if (requests.length === 1) { entered(); await barrier; }
      const chunk = (delta: unknown, finishReason: string | null) => `data: ${JSON.stringify({ id: `p5-${requests.length}`,
        model: 'p5-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(`${chunk({ role: 'assistant', content: `Reply ${requests.length}.` }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } });
    deferCleanup(() => server.stop(true));
    const store = need(openDatabase(paths));
    const agent = new PiAgentAdapter({ cwd: root, agentDir: paths.runtimeDir,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-p5-key' });
    let releasePrepare!: () => void;
    const preparationBarrier = new Promise<void>(resolve => { releasePrepare = resolve; });
    const originalPrepare = agent.prepare.bind(agent);
    agent.prepare = async (...args) => { await preparationBarrier; return originalPrepare(...args); };
    const runtime = new RuntimeService({ memory: store.memory, runs: store.runs, sessions: store.sessions, sessionInputs: store.sessionInputs, agent,
      provider: { async prepare() { throw new Error('Direct provider calls are outside this test.'); },
        async close() { return { stopped: true, closed: true, errors: [] }; } },
      log: { write() {}, async close() {} }, now: () => new Date().toISOString(), monotonicNow: () => performance.now() });
    const service = new SessionService(store.sessions, agent, () => runtime.state(), () => new Date().toISOString(), store.runs, store.memory,
      store.sessionInputs, (request, submission, control) => runtime.start(request, control, submission),
      request => runtime.appendInput(request), id => runtime.verifySessionMutation(id));
    const app = makeApplication(runtime, store.runs, async () => { store.close(); return { stopped: true, closed: true, errors: [] }; }, service);
    deferCleanup(async () => { await app.close(); });
    const session = need(await app.createSession({ title: 'Three equal inputs' }));
    const config = { version: 1 as const, name: 'Controlled P5', revision: 1,
      modelRef: { provider: 'p5-fixture', model: 'p5-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
      connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions' as const, contextWindow: 64_000, maxTokens: 16_384 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
    let finished!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finished = resolve; });
    const prompt = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt' as const, text: 'same text', config,
      timeoutMs: 5000, stopGraceMs: 500 };
    const initial = need(await app.submitInput(prompt, { onEvent(event) { if (event.type === 'run_finished') finished(event); } }));
    expect(await app.submitInput({ sessionId: session.sessionId, clientSequence: 4, mode: 'steer', runId: initial.runId, text: 'prepare-window' }))
      .toMatchObject({ ok: false, error: { code: 'input_admission_closed' } });
    expect(need(await app.listSessionInputs({ sessionId: session.sessionId })).items).toHaveLength(1);
    releasePrepare();
    deferCleanup(() => release());
    await firstRequest;
    const follow = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 2, mode: 'followUp', runId: initial.runId, text: 'same text' }));
    const steer = need(await app.submitInput({ sessionId: session.sessionId, clientSequence: 3, mode: 'steer', runId: initial.runId, text: 'same text' }));
    expect(await app.submitInput(prompt)).toEqual({ ok: true, data: initial });
    if (scenario === 'residual') {
      const records = Reflect.get(agent, 'sessions') as Map<string, { session?: { clearQueue(): void } }>;
      const native = need(store.sessions.get(session.sessionId)).nativeSessionId!;
      records.get(native)!.session!.clearQueue();
    }
    if (rejectCompletion) store.db.exec("CREATE TRIGGER reject_p5_completion BEFORE UPDATE OF processing_status ON session_inputs WHEN NEW.processing_status='completed' BEGIN SELECT RAISE(ABORT,'completion fixture'); END;");
    release();
    const end = await terminal;
    const inputs = need(await app.listSessionInputs({ sessionId: session.sessionId, runId: initial.runId })).items;
    expect(inputs.map(input => input.inputId).sort()).toEqual([initial.inputId, follow.inputId, steer.inputId].sort());
    expect(new Set(inputs.filter(input => input.nativeEntryId !== null).map(input => input.nativeEntryId)).size)
      .toBe(rejectCompletion || scenario === 'residual' ? 1 : 3);
    expect(need(await app.queryRun(initial.runId)).config.agent).toMatchObject({ policyVersion: 'runtime-v1',
      taskPolicyVersion: 'p5-session-inputs-v1', maxModelCalls: 12, maxToolCalls: 0, maxContextBytes: 524_288 });
    const actualSystem = requests[0]!.messages.find(message => message.role === 'system')!.content;
    if (typeof actualSystem !== 'string') throw new Error('Controlled Provider did not receive a textual system prompt.');
    const savedSystem = (need(await app.queryRun(initial.runId)).config.agent as import('@flowmate/contracts').RunAgentConfigFacts).systemPrompt;
    expect(actualSystem.startsWith(savedSystem)).toBe(true);
    expect(savedSystem).not.toContain('Runtime awareness (advisory, current request only):');
    expect(actualSystem).toContain('Runtime awareness (advisory, current request only):');
    if (rejectCompletion) {
      expect(end.result).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
      expect(inputs.find(input => input.inputId === initial.inputId)).toMatchObject({ status: 'consumed', processingStatus: 'failed', resultEntryId: expect.any(String) });
      expect(need(await app.queryRuntimeState()).blocked).toBe(true);
    } else {
      expect(end.result).toMatchObject({ ok: true, data: { status: 'completed' } });
      expect(need(await app.queryRun(initial.runId)).output?.agent).not.toHaveProperty('confirmedUnconsumedInputIds');
      if (scenario === 'residual') {
        expect(inputs.find(input => input.inputId === initial.inputId)).toMatchObject({ status: 'consumed', processingStatus: 'completed', resultEntryId: expect.any(String) });
        for (const inputId of [follow.inputId, steer.inputId]) expect(inputs.find(input => input.inputId === inputId))
          .toMatchObject({ status: 'cancelled', processingStatus: 'cancelled', nativeEntryId: null, resultEntryId: null, error: { code: 'input_not_consumed' } });
        expect(requests).toHaveLength(1);
        expect(need(await app.listSessionMessages({ sessionId: session.sessionId })).items.filter(message => message.role === 'user')).toHaveLength(1);
        expect(need(await app.queryRuntimeState()).blocked).toBe(false);
        return;
      }
      expect(inputs.every(input => input.status === 'consumed' && input.processingStatus === 'completed' && input.resultEntryId !== null)).toBe(true);
      expect(requests).toHaveLength(3);
      const messages = need(await app.listSessionMessages({ sessionId: session.sessionId })).items;
      expect(messages.filter(message => message.role === 'user').map(message => message.blocks.map(block => block.type === 'text' ? block.text : '').join('')))
        .toEqual(['same text', 'same text', 'same text']);
      expect(await app.submitInput({ sessionId: session.sessionId, clientSequence: 4, mode: 'followUp', runId: initial.runId, text: 'too late' }))
        .toMatchObject({ ok: false, error: { code: 'input_admission_closed' } });
      if (scenario !== 'corrupt-completed-result') store.db.query("UPDATE session_inputs SET processing_status='pending' WHERE id=?").run(initial.inputId);
      else store.db.query('UPDATE session_inputs SET result_entry_id=? WHERE id=?')
        .run(inputs.find(input => input.inputId === follow.inputId)!.resultEntryId, initial.inputId);
      if (scenario === 'missing-result') store.db.query('UPDATE session_inputs SET result_entry_id=NULL WHERE id=?').run(initial.inputId);
      if (scenario === 'recovery-failure') store.db.exec("CREATE TRIGGER reject_p5_recovery BEFORE UPDATE OF processing_status ON session_inputs WHEN NEW.processing_status='completed' BEGIN SELECT RAISE(ABORT,'recovery fixture'); END;");
      need(await app.close());
      const restarted = openDatabase(paths);
      if (scenario === 'recovery-failure') {
        expect(restarted).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
        const audited = new Database(paths.databaseFile);
        expect(audited.query('SELECT processing_status,result_entry_id FROM session_inputs WHERE id=?').get(initial.inputId))
          .toEqual({ processing_status: 'pending', result_entry_id: inputs.find(input => input.inputId === initial.inputId)!.resultEntryId });
        expect(audited.query('SELECT status FROM runs WHERE id=?').get(initial.runId)).toEqual({ status: 'completed' });
        audited.close();
        expect(openDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
        const repaired = new Database(paths.databaseFile); repaired.exec('DROP TRIGGER reject_p5_recovery'); repaired.close();
        const requestCount = requests.length;
        const reopened = need(openDatabase(paths));
        deferCleanup(() => reopened.close());
        expect(need(reopened.sessionInputs.get(initial.inputId))).toMatchObject({ processingStatus: 'completed',
          resultEntryId: inputs.find(input => input.inputId === initial.inputId)!.resultEntryId });
        expect(need(reopened.runs.get(initial.runId)).status).toBe('completed');
        expect(requests).toHaveLength(requestCount);
      }
      else {
        const reopened = need(restarted);
        deferCleanup(() => reopened.close());
        expect(need(reopened.sessionInputs.get(initial.inputId))).toMatchObject(scenario === 'missing-result'
          ? { processingStatus: 'failed', resultEntryId: null, error: { code: 'input_processing_unconfirmed' } }
          : scenario === 'corrupt-completed-result' ? { processingStatus: 'completed' }
          : { processingStatus: 'completed', resultEntryId: inputs.find(input => input.inputId === initial.inputId)!.resultEntryId });
        expect(need(reopened.sessions.get(session.sessionId)).nativeUnusable).toBe(['missing-result', 'corrupt-completed-result'].includes(scenario));
        expect(need(reopened.runs.get(initial.runId)).status).toBe('completed');
      }
    }
  });
});
