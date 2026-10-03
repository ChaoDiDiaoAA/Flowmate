import { createTestWorkspaceVerifier, prepareTestWorkspaceVerifier } from '../../support/workspace.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { appError, INVOICE_CHAT_GOAL, INVOICE_CHAT_SYSTEM_PROMPT, ok } from '@flowmate/contracts';
import type { RunAgentConfigFacts, AgentNativeOutcome, AgentPort, P3AgentConfigFacts, PreparedAgent, ProviderConfig, ProviderPort, SafeConfigSnapshot } from '@flowmate/contracts';
import { createToolExecutor, createToolRecorder, JobService, makeApplication, RuntimeService, SessionService, WorkspaceService } from '@flowmate/core';
import type { RuntimeServicePort } from '@flowmate/core';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import { createAgentHistoryFixture } from './agent-history-fixture.ts';

const now = () => '2026-09-28T00:00:00.000Z';
const config: ProviderConfig = {
  version: 1, name: 'fixture', revision: 1, modelRef: { provider: 'fixture', model: 'offline' },
  native: { authPath: 'C:\\fixture\\auth.json', modelsPath: null },
  connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions' },
  parameters: { maxRetries: 0, maxRetryDelayMs: 100 },
};

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

function seedDocument(db: { db: Database }) {
  const artifactMetadata = JSON.stringify({ version: 1, sourceKey: 'synthetic', sourceRecordId: 'invoice-1', sourceVersion: 'v1',
    files: [{ relativePath: 'fixture.json', bytes: 1, mimeType: 'application/json' }] });
  db.db.query(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES
    (1,'original','artifacts/1/original.png',1,'image/png',?,'${now()}'),
    (2,'parsed','artifacts/2/parsed.json',1,'application/json',?,'${now()}')`).run(artifactMetadata, artifactMetadata);
  const metadata = JSON.stringify({ version: 2, pageCount: 1, warnings: [],
    allowedUsesClaim: ['synthetic test'], licenseVerification: 'not_verified', unavailableReason: null });
  db.db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,
    status,metadata_json,created_at,updated_at)
    VALUES (1,'synthetic','invoice-1','v1',1,2,'available',?,?,?)`).run(metadata, now(), now());
}

function preparedP2Agent(onPrepare: () => void, onExecute: () => void): AgentPort {
  const history = createAgentHistoryFixture(process.cwd(), now);
  return {
    createSession: () => ok({ nativeSessionId: 'native-fixture' }),
    exportSession: history.exportSession,
    watchSession: history.watchSession,
    inspect: () => ({ availability: 'ready' }),
    async prepare(nativeSessionId, receivedConfig, limits, _signal, options): Promise<ReturnType<typeof ok<PreparedAgent>>> {
      onPrepare();
      const facts: RunAgentConfigFacts = { policyVersion: 'p5-session-inputs-v1', nativeSessionId,
        systemPrompt: INVOICE_CHAT_SYSTEM_PROMPT, thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
        maxContextBytes: 524_288, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12, sessionRetry: false };
      const preparedFacts: RunAgentConfigFacts = options?.activeToolNames ? { ...facts, policyVersion: 'p3-invoice-tools-v1',
        maxContextBytes: 8_388_608, maxModelCalls: 16, maxToolCalls: 24, toolTimeoutMs: 10_000 } : facts;
      const snapshot: SafeConfigSnapshot & { agent: RunAgentConfigFacts } = { version: 1, name: receivedConfig.name,
        revision: receivedConfig.revision, requestedModel: receivedConfig.modelRef, resolvedModel: receivedConfig.modelRef,
        api: receivedConfig.connection?.api ?? null, endpoint: receivedConfig.connection?.baseUrl ?? null,
        sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: receivedConfig.parameters, limits,
        native: { authSource: 'pi-native', modelsSelection: null }, agent: preparedFacts };
      return ok({ snapshot, async execute(input, signal) {
        history.saveUser(nativeSessionId, input);
        onExecute();
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        const outcome: AgentNativeOutcome = { text: 'stopped', partial: false, stopReason: 'stop', responseId: null,
          responseModel: 'offline', error: null,
          usage: { version: 1, source: 'unknown', reason: 'test', sdkValues: null, attempts: 1, attemptsComplete: true,
            costSource: null, updatedAt: now() },
          tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
          stopped: true, cleanupErrors: [], agent: { nativeSessionId, turnCount: 1, modelCallCount: 1 } };
        history.saveResult(nativeSessionId, input, outcome, false);
        return outcome;
      } });
    },
    async releaseSession() { return { stopped: true, closed: true, errors: [] }; },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  };
}

const provider: ProviderPort = {
  async prepare() { return { ok: false, error: appError('unused', 'provider', 'unused', false) }; },
  async close() { return { stopped: true, closed: true, errors: [] }; },
};

describe('P3 Workspace and Run admission', () => {
  it('commits Task and Workspace together and returns the same Job for an identical client sequence', async () => {
    const opened = openTestDatabase(paths(mkdtempSync(join(tmpdir(), 'flowmate-app-invoice-'))));
    if (!opened.ok) throw new Error(opened.error.message);
    seedDocument(opened.data);
    const workspace = new WorkspaceService(opened.data.workspace, now, prepareTestWorkspaceVerifier(opened.data));
    const jobs = new JobService(opened.data.jobs, now);
    const stubRuntime: RuntimeServicePort = {
      callProvider: async () => ({ ok: false, error: appError('unused', 'provider', 'unused', false) }),
      start: async () => ({ ok: false, error: appError('unused', 'runtime', 'unused', false) }),
      cancel: (runId) => ok({ runId, accepted: false }), state: () => ({ active: null, blocked: false, error: null }),
      revokeDocumentUse: async () => ok({ affectedSessionIds: [], stopRequested: false }),
      close: async () => ({ stopped: true, closed: true, errors: [] }),
    };
    const sessionAgent = preparedP2Agent(() => undefined, () => undefined);
    const sessionService = new SessionService(opened.data.sessions, sessionAgent, () => stubRuntime.state(), now, opened.data.runs);
    const productApplication = { documents: opened.data.documents, jobs: opened.data.jobs, candidates: opened.data.candidates,
      events: opened.data.businessEvents, importInvoiceMaterial: async () => opened.data.documents.get(1),
      readDocumentPage: () => ({ ok: false as const, error: appError('unused', 'input', 'unused') }),
      listDocumentPages: () => ({ ok: false as const, error: appError('unused', 'input', 'unused') }),
      readDocumentOriginal: () => ({ ok: false as const, error: appError('unused', 'input', 'unused') }) };
    const app = makeApplication(stubRuntime, opened.data.runs, async () => ({ stopped: true, closed: true, errors: [] }),
      sessionService, undefined, workspace, jobs, productApplication);
    expect(await app.listDocuments()).toMatchObject({ ok: true, data: { items: [{ documentRef: { id: 1, version: 'v1' } }] } });
    expect(await app.queryDocument(1)).toMatchObject({ ok: true, data: { status: 'available' } });
    expect(await app.queryDocument(0)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    const initial = await app.readWorkspace();
    expect(initial).toMatchObject({ ok: true, data: { revision: 0, nextTaskSequence: 1 } });
    const session = await app.createSession({ expectedRevision: 0 });
    expect(session).toMatchObject({ ok: true, data: { sessionId: 1 } });
    expect(await app.readWorkspace()).toMatchObject({ ok: true, data: { revision: 1, sessionId: 1 } });
    expect(await app.createSession({ expectedRevision: 0 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(exists(opened.data.db, 'sessions')).toBe(1);
    const selected = await app.updateWorkspace({ expectedRevision: 1, change: { kind: 'document', documentId: 1 } });
    expect(selected).toMatchObject({ ok: true, data: { revision: 2, documentRef: { id: 1, version: 'v1' } } });
    if (!selected.ok) return;
    expect(await app.updateWorkspace({ expectedRevision: 2, change: { kind: 'document', documentId: 1 } }))
      .toMatchObject({ ok: true, data: { revision: 2 } });
    expect(await app.updateWorkspace({ expectedRevision: 1, change: { kind: 'view', view: 'parsed' } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    const request = { clientSequence: 1, expectedRevision: selected.data.revision, documentRef: { id: 1, version: 'v1' }, goal: '  Review totals  ' };
    const created = await app.startTask(request);
    expect(created).toMatchObject({ ok: true, data: { job: { jobId: 1, goal: 'Review totals', status: 'pending' }, workspace: { jobId: 1, revision: 3 } } });
    if (!created.ok) return;
    expect(await app.listJobs({ documentId: 1 })).toMatchObject({ ok: true,
      data: { items: [{ jobId: 1, documentRef: { id: 1, version: 'v1' }, status: 'pending' }] } });
    expect(await app.queryJob(1)).toMatchObject({ ok: true, data: { goal: 'Review totals', status: 'pending' } });
    expect(await app.listJobCandidates({ jobId: 1 })).toMatchObject({ ok: true, data: { items: [], nextBeforeSequence: null } });
    expect(await app.listActivity({ jobId: 1 })).toMatchObject({ ok: true,
      data: { items: [{ type: 'task_started', result: 'succeeded' }] } });
    expect(await app.listActivity({ jobId: 1, documentId: 1 } as never)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await app.selectCandidate({ jobId: created.data.job.jobId, candidateId: 1,
      expectedCandidateId: null, expectedRevision: created.data.workspace.revision - 1 }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(opened.data.db.query('SELECT current_candidate_id FROM jobs WHERE id=?').get(created.data.job.jobId))
      .toEqual({ current_candidate_id: null });
    expect(opened.data.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_selected'").get())
      .toEqual({ count: 0 });
    expect(await app.startTask(request)).toMatchObject({ ok: true, data: { job: { jobId: 1 }, workspace: { revision: 3 } } });
    expect(await app.startTask({ ...request, goal: 'Different goal' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await app.startTask({ ...request, clientSequence: 2, expectedRevision: 2 }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
    expect(opened.data.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='task_started'").get()).toEqual({ count: 1 });
  });

  it('rejects stale Workspace admission before preparing a model and preserves frozen facts over SDK config', async () => {
    const opened = openTestDatabase(paths(mkdtempSync(join(tmpdir(), 'flowmate-app-stale-run-'))));
    if (!opened.ok) throw new Error(opened.error.message);
    seedDocument(opened.data);
    const native = opened.data.sessions.create({ nativeSessionId: 'native-fixture', title: 'Fixture', at: now(),
      nativeHistory: { storageVersion: 1, header: { type: 'session', version: 3, id: 'native-fixture', timestamp: now(), cwd: process.cwd() },
        entries: [], leafId: null, unusable: false } });
    expect(native.ok).toBe(true);
    if (!native.ok) return;
    const workspace = new WorkspaceService(opened.data.workspace, now, prepareTestWorkspaceVerifier(opened.data));
    await workspace.update({ expectedRevision: 0, change: { kind: 'document', documentId: 1 } });
    await workspace.update({ expectedRevision: 1, change: { kind: 'session', sessionId: native.data.sessionId } });
    const current = workspace.read();
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    let preparations = 0;
    let executes = 0;
    const agent = preparedP2Agent(() => { preparations += 1; }, () => { executes += 1; });
    agent.watchSession!('native-fixture', (history, context) => opened.data.sessions.saveHistory(native.data.sessionId, history, context));
    const tools = createToolExecutor({ definitions: [], recorder: createToolRecorder(opened.data.toolCalls, now), now });
    const runtime = new RuntimeService({ workspaceVerifier: createTestWorkspaceVerifier(opened.data), runs: opened.data.runs, sessions: opened.data.sessions, sessionInputs: opened.data.sessionInputs, agent, provider, tools,
      log: { write: () => undefined, close: async () => undefined }, now, monotonicNow: () => performance.now() });
    const stale = { revision: current.data.revision - 1, documentRef: current.data.documentRef, jobId: current.data.jobId,
      candidateRef: current.data.candidateRef, sessionId: native.data.sessionId };
    const sessionService = new SessionService(opened.data.sessions, agent, () => runtime.state(), now, opened.data.runs);
    const app = makeApplication(runtime, opened.data.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessionService);
    expect(await app.startRun({ sessionId: native.data.sessionId, text: 'Review invoice', config, workspace: stale }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(exists(opened.data.db, 'runs')).toBe(0);
    expect(preparations).toBe(0);

    const expected = { revision: current.data.revision, documentRef: current.data.documentRef, jobId: current.data.jobId,
      candidateRef: current.data.candidateRef, sessionId: native.data.sessionId };
    const accepted = await app.startRun({ sessionId: native.data.sessionId, text: 'Review invoice', config, workspace: expected });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    let run;
    for (let retry = 0; retry < 50; retry += 1) {
      run = opened.data.runs.get(accepted.data.runId);
      if (run.ok && run.data.status === 'running') break;
      await Bun.sleep(2);
    }
    expect(run).toMatchObject({ ok: true, data: { status: 'running', kind: 'agent', scope: {
      version: 2, allowedTools: expect.arrayContaining(['list_invoice_pages', 'validate_invoice_candidate']),
    }, config: { workspaceContext: { revision: current.data.revision, documentRef: { id: 1, version: 'v1' } }, goalMode: 'answer' },
      input: { version: 2, workspaceInput: { documentRef: { id: 1, version: 'v1' }, job: null, candidate: null } } } });
    expect(preparations).toBe(1);
    runtime.cancel(accepted.data.runId);
    for (let retry = 0; retry < 50; retry += 1) {
      run = opened.data.runs.get(accepted.data.runId);
      if (run.ok && ['cancelled', 'failed', 'completed'].includes(run.data.status)) break;
      await Bun.sleep(2);
    }
  });

  it('revokes material use for affected Sessions and stops their active Run before any next request', async () => {
    const opened = openTestDatabase(paths(mkdtempSync(join(tmpdir(), 'flowmate-app-revocation-'))));
    if (!opened.ok) throw new Error(opened.error.message);
    seedDocument(opened.data);
    let preparations = 0;
    let executions = 0;
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const agent = preparedP2Agent(() => { preparations += 1; }, () => { executions += 1; executionStarted(); });
    const toolExecutor = createToolExecutor({ definitions: [],
      recorder: createToolRecorder(opened.data.toolCalls, now), isSessionModelUseBlocked: (sessionId) => opened.data.sessions.isModelUseBlocked(sessionId), now });
    const runtime = new RuntimeService({ workspaceVerifier: createTestWorkspaceVerifier(opened.data), runs: opened.data.runs, sessions: opened.data.sessions, sessionInputs: opened.data.sessionInputs, agent, provider, tools: toolExecutor,
      log: { write: () => undefined, close: async () => undefined }, now, monotonicNow: () => performance.now() });
    const sessionService = new SessionService(opened.data.sessions, agent, () => runtime.state(), now, opened.data.runs);
    const workspaceService = new WorkspaceService(opened.data.workspace, now, prepareTestWorkspaceVerifier(opened.data));
    const app = makeApplication(runtime, opened.data.runs, async () => ({ stopped: true, closed: true, errors: [] }), sessionService,
      undefined, workspaceService);
    const session = await app.createSession({ expectedRevision: 0 });
    expect(session).toMatchObject({ ok: true, data: { sessionId: 1, modelUseBlocked: false, hasBusinessHistory: false } });
    if (!session.ok) return;
    const selected = await app.updateWorkspace({ expectedRevision: 1, change: { kind: 'document', documentId: 1 } });
    if (!selected.ok) return;
    const request = { sessionId: session.data.sessionId, text: 'Review this document', config,
      workspace: { revision: selected.data.revision, documentRef: selected.data.documentRef, jobId: selected.data.jobId,
        candidateRef: selected.data.candidateRef, sessionId: session.data.sessionId }, goalMode: 'answer' as const, timeoutMs: 30_000 };
    let finished!: () => void;
    const completed = new Promise<void>((resolve) => { finished = resolve; });
    const accepted = await app.startRun(request, { onEvent(event) { if (event.type === 'run_finished') finished(); } });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await Promise.race([started, Bun.sleep(2_000).then(() => { throw new Error('fixture_agent_did_not_start'); })]);
    expect(executions).toBe(1);

    expect(await app.revokeDocumentUse(1)).toEqual({ ok: true, data: { affectedSessionIds: [session.data.sessionId], stopRequested: true } });
    await Promise.race([completed, Bun.sleep(2_000).then(() => { throw new Error('revoked_run_did_not_stop'); })]);
    expect(await app.queryRun(accepted.data.runId)).toMatchObject({ ok: true, data: { status: 'cancelled', jobId: null } });
    expect(await app.querySession(session.data.sessionId)).toMatchObject({ ok: true, data: { modelUseBlocked: true } });
    expect(await app.startRun(request)).toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
    expect(preparations).toBe(1);
    expect(executions).toBe(1);
    expect(await app.revokeDocumentUse(99)).toMatchObject({ ok: false, error: { code: 'document_not_found' } });
  });

  it('freezes exactly 2, 9, 12, or 13 authorized tool names from the trusted Workspace and goal mode', () => {
    const pure = ['normalize_invoice_values', 'calculate_invoice_amounts'];
    const documentTools = ['list_invoice_pages', 'read_invoice_document', 'search_invoice_document', 'list_invoice_tables',
      'read_invoice_evidence', 'check_invoice_sources', ...pure, 'validate_invoice_candidate'];
    const jobTools = [...documentTools, 'list_invoice_candidates', 'get_invoice_candidate', 'compare_invoice_candidates'];
    expect(admission('none', 'answer').scope.allowedTools).toEqual(pure);
    expect(admission('document', 'answer').scope.allowedTools).toEqual(documentTools);
    expect(admission('job', 'answer').scope.allowedTools).toEqual(jobTools);
    expect(admission('job', 'save-candidate').scope.allowedTools).toEqual([...jobTools, 'save_invoice_candidate']);
    expect(admission('document', 'answer').scope.allowedArtifactIds).toEqual([2]);
    expect(admission('job', 'save-candidate').scope.allowedArtifactIds).toEqual([2]);
  });
});

function exists(db: { query(sql: string): { get(): unknown } }, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function admission(kind: 'none' | 'document' | 'job', goalMode: 'answer' | 'save-candidate') {
  const opened = openTestDatabase(paths(mkdtempSync(join(tmpdir(), 'flowmate-scope-admission-'))));
  if (!opened.ok) throw new Error(opened.error.message);
  if (kind !== 'none') seedDocument(opened.data);
  const verify = prepareTestWorkspaceVerifier(opened.data);
  const session = opened.data.sessions.create({ nativeSessionId: 'native-scope', title: 'Scope', at: now() });
  if (!session.ok) throw new Error(session.error.message);
  let workspace = opened.data.workspace.read(now());
  if (!workspace.ok) throw new Error(workspace.error.message);
  workspace = opened.data.workspace.update({ expectedRevision: workspace.data.revision, change: { kind: 'session', sessionId: session.data.sessionId }, at: now() }, verify);
  if (!workspace.ok) throw new Error(workspace.error.message);
  if (kind !== 'none') {
    workspace = opened.data.workspace.update({ expectedRevision: workspace.data.revision, change: { kind: 'document', documentId: 1 }, at: now() }, verify);
    if (!workspace.ok) throw new Error(workspace.error.message);
  }
  if (kind === 'job') {
    const job = opened.data.jobs.create({ clientSequence: 1, expectedRevision: workspace.data.revision,
      documentRef: { id: 1, version: 'v1' }, goal: 'Review fixture', at: now() });
    if (!job.ok) throw new Error(job.error.message);
    workspace = ok(job.data.workspace);
  }
  if (!workspace.ok) throw new Error(workspace.error.message);
  const expected = { revision: workspace.data.revision, documentRef: workspace.data.documentRef, jobId: workspace.data.jobId,
    candidateRef: workspace.data.candidateRef, sessionId: session.data.sessionId };
  const agent: P3AgentConfigFacts = { policyVersion: 'p3-invoice-tools-v1', nativeSessionId: 'native-scope',
    systemPrompt: 'test', thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 8_388_608,
    maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10_000,
    sessionRetry: false };
  const p3Config: SafeConfigSnapshot & { agent: P3AgentConfigFacts } = { version: 1, name: 'fixture', revision: 1,
    requestedModel: config.modelRef, resolvedModel: null, api: config.connection?.api ?? null, endpoint: config.connection?.baseUrl ?? null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' }, parameters: config.parameters,
    limits: { timeoutMs: 60_000, stopGraceMs: 5_000 }, native: { authSource: 'unknown', modelsSelection: null }, agent };
  const created = opened.data.runs.createWorkspaceAgent({ sessionId: session.data.sessionId, expected, goalMode, text: 'Review',
    messageTimestamp: 1, goal: INVOICE_CHAT_GOAL, config: p3Config,
    usage: { version: 1, source: 'unknown', reason: 'request-not-finished', sdkValues: null, attempts: null,
      attemptsComplete: false, costSource: null, updatedAt: now() },
    cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: now() }, verify);
  if (!created.ok) throw new Error(created.error.message);
  return created.data;
}
