import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { appError, fail, ok, CandidateDraftSchema, invoiceHeaderFields, NativeSessionHistorySchema } from '@flowmate/contracts';
import type { AgentRunEvent, Application, CandidateRepository, ProviderConfig, Result, WorkspaceSnapshot } from '@flowmate/contracts';
import { ContextService, createFileStore, createToolExecutor, createToolRecorder, JobService, makeApplication, openDatabase,
  RuntimeService, SessionService, WorkspaceService } from '@flowmate/core';
import type { DbHandle } from '@flowmate/core';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools } from '@flowmate/employee-invoice';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';
import { createTestWorkspaceVerifier } from '../support/workspace.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
function barrier() { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; }
function response(text: string, tool: boolean | { name: string; args: unknown; id: string } = false) {
  const call = typeof tool === 'object' ? tool : { name: 'calculate_invoice_amounts',
    args: { operation: 'sum', values: ['1', '2'], scale: 2 }, id: 'original-runtime-call' };
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
    : { role: 'assistant', content: text };
  const chunk = (value: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'runtime-admission',
    choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
  return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
type Payload = { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
function fixture(fetch: (body: Payload, ordinal: number) => Response | Promise<Response>, setup?: (session: AgentSession) => void,
  options: { maxResultBytes?: number; p8?: boolean;
    candidateSave?: (save: CandidateRepository['save'], input: Parameters<CandidateRepository['save']>[0],
      store: DbHandle, app: Application) => ReturnType<CandidateRepository['save']> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-admission-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs') };
  const store = need(openDatabase(paths));
  const now = () => new Date().toISOString();
  for (const id of [1, 2]) {
    const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
    const parsed = Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text',
      text: `Synthetic invoice ${id}`, sourceIndex: 0, sourceType: 'synthetic', bbox: null }] }],
      completeness: { status: 'complete', checks: [], warnings: [] } }));
    for (const [artifactId, filename, bytes] of [[2 * id - 1, 'original.png', original], [2 * id, 'parsed.json', parsed]] as const) {
      mkdirSync(join(paths.artifactsDir, String(artifactId)), { recursive: true });
      writeFileSync(join(paths.artifactsDir, String(artifactId), filename), bytes);
      store.contents.remember({ ownerKind: 'artifact', ownerId: String(artifactId), relativePath: filename }, bytes);
    }
    const metadata = { version: 1 as const, sourceKey: 'synthetic', sourceRecordId: `runtime-invoice-${id}`, sourceVersion: 'v1',
      files: [{ relativePath: 'original.png', bytes: original.byteLength, mimeType: 'image/png' }] };
    need(store.documents.register({ documentId: id, sourceKey: 'synthetic', sourceRecordId: metadata.sourceRecordId, version: 'v1',
      originalArtifact: { artifactId: 2 * id - 1, kind: 'original', relativePath: `artifacts/${2 * id - 1}/original.png`, bytes: original.byteLength,
        mimeType: 'image/png', metadata, createdAt: now() },
      parsedArtifact: { artifactId: 2 * id, kind: 'parsed', relativePath: `artifacts/${2 * id}/parsed.json`, bytes: parsed.byteLength,
        mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: parsed.byteLength,
          mimeType: 'application/json' }] }, createdAt: now() }, status: 'available',
      metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['synthetic test'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: now(), updatedAt: now() }));
  }
  const files = createFileStore(paths, store.documents);
  const documents = createDocumentService({ paths, repository: store.documents, files, allowedSourceRoot: root, now });
  const verify = createTestWorkspaceVerifier(store, root);
  let business = 0, clockOffset = 0;
  let app!: Application;
  const originalSave = store.candidates.save.bind(store.candidates);
  const candidates: CandidateRepository = { ...store.candidates, save: input => options.candidateSave
    ? options.candidateSave(originalSave, input, store, app) : originalSave(input) };
  const definitions = createInvoiceTools({ documents, documentRepository: store.documents, candidates, now })
    .map(tool => ({ ...tool, execute: (...args: Parameters<typeof tool.execute>) => { business++; return tool.execute(...args); } }));
  const tools = createToolExecutor({ definitions, recorder: createToolRecorder(store.toolCalls, now), now,
    isSessionModelUseBlocked: id => store.sessions.isModelUseBlocked(id), monotonicNow: () => performance.now() + clockOffset,
    maxResultBytes: options.maxResultBytes });
  const payloads: Payload[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: Payload = await request.json(); payloads.push(body); return fetch(body, payloads.length);
  } });
  deferCleanup(() => server.stop(true));
  const agent = new PiAgentAdapter({ cwd: root, agentDir: paths.runtimeDir, tools: definitions,
    credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-runtime-key', sessionSetup: setup });
  const runtime = new RuntimeService({ memory: store.memory, runs: store.runs, sessions: store.sessions, sessionInputs: store.sessionInputs, tools, agent, workspaceVerifier: verify,
    ...(options.p8 ? { contextService: new ContextService({ store, materials: {
      inspectParsed: input => documents.inspectParsedForContext(input) } }), contextRepository: store.context } : {}),
    provider: { async prepare() { throw new Error('No direct Provider request is authorized.'); },
      async close() { return { stopped: true, closed: true, errors: [] }; } }, log: { write() {}, async close() {} },
    now, monotonicNow: () => performance.now() + clockOffset });
  const sessions = new SessionService(store.sessions, agent, () => runtime.state(), now, store.runs, store.memory, store.sessionInputs,
    (request, input, control) => runtime.start(request, control, input), request => runtime.appendInput(request),
    id => runtime.verifySessionMutation(id));
  app = makeApplication(runtime, store.runs, async () => { store.close(); return { stopped: true, closed: true, errors: [] }; },
    sessions, undefined, new WorkspaceService(store.workspace, now, verify), new JobService(store.jobs, now));
  deferCleanup(() => app.close());
  const config: ProviderConfig = { version: 1, name: 'Controlled runtime admission', revision: 1,
    modelRef: { provider: 'runtime-admission-fixture', model: 'runtime-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  return { app, store, tools, config, payloads, paths, now, business: () => business, advanceClock: (ms: number) => { clockOffset += ms; } };
}
function expected(workspace: WorkspaceSnapshot) {
  if (workspace.sessionId === null) throw new Error('Expected a selected Session.');
  return { sessionId: workspace.sessionId, revision: workspace.revision, documentRef: workspace.documentRef,
    jobId: workspace.jobId, candidateRef: workspace.candidateRef };
}
async function select(app: ReturnType<typeof fixture>['app']) {
  const session = need(await app.createSession({ title: 'Runtime admission' }));
  let workspace = need(await app.readWorkspace());
  workspace = need(await app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'session', sessionId: session.sessionId } }));
  workspace = need(await app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'document', documentId: 1 } }));
  return { session, workspace };
}
function completion() {
  let finish!: (value: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
  const ready = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
  return { ready, onEvent: (event: AgentRunEvent) => { if (event.type === 'run_finished') finish(event); } };
}

describe('Runtime final admission after the real SDK before hook awaits', () => {
  it('P9 T08 stops before the SDK appends an unowned budget-refused tool result', async () => {
    let nativeSession!: AgentSession;
    const f = fixture((_body, ordinal) => response('', { name: 'calculate_invoice_amounts',
      args: { operation: 'sum', values: ['1', '2'], scale: 2 }, id: `budget-owner-${ordinal}` }), session => { nativeSession = session; }, { p8: true });
    const { session, workspace } = await select(f.app), terminal = completion();
    const accepted = need(await f.app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt',
      text: 'Calculate with one admitted tool call.', config: f.config, workspace: expected(workspace), goalMode: 'answer',
      budget: { maxToolCalls: 1, maxModelCalls: 4 }, timeoutMs: 5000, stopGraceMs: 500 }, terminal));
    const ended = await terminal.ready;
    expect(ended.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true,
      error: { code: 'tool_budget_exceeded' } } });
    expect(f.payloads).toHaveLength(2); expect(f.business()).toBe(1);
    expect(need(await f.app.queryRun(accepted.runId))).toMatchObject({ toolCallCount: 1, error: { code: 'tool_budget_exceeded' } });
    expect(f.store.db.query('SELECT native_tool_call_id FROM tool_calls ORDER BY id').all()).toEqual([{ native_tool_call_id: 'budget-owner-1' }]);
    const bundle = need(f.store.sessions.loadHistoryForContext(session.sessionId));
    expect(bundle.history!.entries).toEqual(JSON.parse(JSON.stringify(nativeSession.sessionManager.getEntries())));
    expect(bundle.commit).toMatchObject({ entryCount: nativeSession.sessionManager.getEntries().length,
      leafId: nativeSession.sessionManager.getLeafId() });
    expect(bundle.seed.origins.filter(origin => bundle.history!.entries.find(entry => entry.id === origin.nativeEntryId)?.type === 'message')
      .every(origin => origin.originRunId === accepted.runId && origin.originSessionId === session.sessionId)).toBe(true);
    const messages = NativeSessionHistorySchema.parse(bundle.history).entries.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'aborted', errorMessage: 'tool_budget_exceeded',
      content: [{ type: 'text', text: '' }] });
    expect(messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId)).toEqual(['budget-owner-1']);
    expect(messages.filter(message => message.role === 'assistant').flatMap(message => message.content
      .flatMap(part => part.type === 'toolCall' ? [part.id] : []))).toEqual(['budget-owner-1', 'budget-owner-2']);
    expect(await f.app.listSessionInputs({ sessionId: session.sessionId })).toMatchObject({ ok: true,
      data: { items: [{ status: 'consumed' }] } });
    expect(await f.app.listSessionMessages({ sessionId: session.sessionId })).toMatchObject({ ok: true });
    const page = need(await f.app.querySessionHistory({ sessionId: session.sessionId }));
    expect(page.items).toHaveLength(bundle.commit!.entryCount);
    expect(page.items.every(item => !item.canSelect)).toBe(true);
    expect(f.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(await f.app.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
    const reopened = need(openDatabase(f.paths));
    try {
      expect(need(reopened.sessions.loadHistoryForContext(session.sessionId))).toEqual(bundle);
      const cold = new PiAgentAdapter({ cwd: f.paths.root });
      expect(bundle.history!.unusable).toBe(true);
      expect(cold.restoreSession(session.nativeSessionId, bundle.history!, bundle.seed, bundle.commit!)).toMatchObject({ ok: false,
        error: { code: 'session_history_invalid' } });
      expect(cold.inspectSessionHistory({ history: bundle.history!, seed: bundle.seed })).toMatchObject({ ok: true,
        data: { positions: expect.arrayContaining([{ entryId: bundle.commit!.leafId, isCurrentPath: true, contextState: 'incomplete-tool-pair' }]) } });
      expect(await cold.close()).toMatchObject({ stopped: true, closed: true });
      expect(reopened.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(f.payloads).toHaveLength(2);
    } finally { reopened.close(); }
  }, 15_000);

  it('T10 F8-18 rejects original synchronous candidate save after public revocation inside its real handler', async () => {
    const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
    const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])), lines: [], notes: [] });
    const observed: { calls: number; revoke?: ReturnType<Application['revokeDocumentUse']>;
      result?: ReturnType<CandidateRepository['save']>; snapshot?: unknown; input?: unknown; journal?: unknown } = { calls: 0 };
    const f = fixture((_body, ordinal) => ordinal === 1 ? response('', {
      name: 'save_invoice_candidate', args: { documentId: 1, candidate }, id: 't10-revoked-candidate' }) : response('Unexpected later request'),
    undefined, { p8: true, candidateSave(save, input, store, app) {
      observed.calls++;
      const tool = store.db.query<{ context_snapshot_id: number; request_sequence: number; status: string }, [number, string]>
        ('SELECT context_snapshot_id,request_sequence,status FROM tool_calls WHERE run_id=? AND native_tool_call_id=?')
        .get(input.runId, input.nativeToolCallId)!;
      expect(tool).toMatchObject({ context_snapshot_id: expect.any(Number), request_sequence: 1, status: 'running' });
      observed.snapshot = store.db.query('SELECT * FROM context_snapshots WHERE run_id=?').get(input.runId);
      expect(observed.snapshot).toMatchObject({ id: tool.context_snapshot_id, run_id: input.runId, session_id: input.sessionId });
      observed.input = store.db.query('SELECT id,content_json,context_snapshot_id FROM session_inputs WHERE run_id=?').get(input.runId);
      observed.journal = store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(input.runId);
      observed.revoke = app.revokeDocumentUse(input.documentId);
      expect(need(store.sessions.isModelUseBlocked(input.sessionId))).toBe(true);
      // No await: the unchanged synchronous repository must itself enter the revoked transaction.
      const result = save(input); observed.result = result;
      expect(result).toMatchObject({ ok: false, error: { code: 'session_scope_revoked', category: 'session', retryable: false } });
      expect(store.db.query('SELECT * FROM context_snapshots WHERE id=?').get(tool.context_snapshot_id)).toEqual(observed.snapshot);
      expect(store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(input.runId)).toEqual(observed.journal);
      return result;
    } });
    const selected = await select(f.app);
    const task = need(await f.app.startTask({ clientSequence: 1, expectedRevision: selected.workspace.revision,
      documentRef: { id: 1, version: 'v1' }, goal: 'Save a candidate at the actual commit gate' }));
    const terminal = completion();
    const accepted = need(await f.app.submitInput({ sessionId: selected.session.sessionId, clientSequence: 1, mode: 'prompt',
      text: 'Save the selected invoice candidate', goalMode: 'save-candidate', workspace: expected(task.workspace),
      config: f.config, timeoutMs: 5000, stopGraceMs: 500 }, terminal));
    const ended = await terminal.ready;
    expect(observed.calls).toBe(1); expect(observed.result?.ok).toBe(false);
    expect(observed.revoke).toBeDefined();
    expect(await observed.revoke!).toEqual({ ok: true, data: { affectedSessionIds: [selected.session.sessionId], stopRequested: true } });
    expect(ended.result).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(need(f.store.sessions.get(selected.session.sessionId)).modelUseBlocked).toBe(true);
    expect(f.payloads).toHaveLength(1); expect(f.business()).toBe(1);
    expect(f.store.db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: 0 });
    expect(f.store.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_generated'").get()).toEqual({ count: 0 });
    expect(f.store.db.query('SELECT id,content_json,context_snapshot_id FROM session_inputs WHERE run_id=?').get(accepted.runId)).toEqual(observed.input);
    expect(f.store.db.query('SELECT * FROM context_snapshots WHERE run_id=?').get(accepted.runId)).toEqual(observed.snapshot);
    const journal = JSON.parse(f.store.db.query<{ context_observations_json: string }, [number]>
      ('SELECT context_observations_json FROM runs WHERE id=?').get(accepted.runId)!.context_observations_json);
    expect(journal.requests[0].binding).toMatchObject({ runId: accepted.runId, sessionId: selected.session.sessionId,
      inputId: accepted.inputId, snapshotId: need(f.store.sessionInputs.get(accepted.inputId))!.contextSnapshotId });
    expect(journal.requests[0].sdkPayload.inclusion).toBe('confirmed'); expect(journal.requests[0].attempts).toHaveLength(1);
    expect(f.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(await f.app.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
  });

  it('charges the actual SDK blocked feedback against the shared Run context limit', async () => {
    let after = 0;
    const reason = 'Controlled SDK refusal: ' + 'x'.repeat(2048);
    const f = fixture((_body, ordinal) => response('Completed.', ordinal === 1), session => {
      const priorAfter = session.agent.afterToolCall;
      session.agent.beforeToolCall = async () => ({ block: true, reason });
      session.agent.afterToolCall = async (...args) => { after++; return priorAfter?.(...args); };
    }, { maxResultBytes: 1024 });
    const { session, workspace } = await select(f.app); const terminal = completion();
    const accepted = need(await f.app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt',
      text: 'Calculate this invoice.', config: f.config, workspace: expected(workspace), goalMode: 'answer', timeoutMs: 5000, stopGraceMs: 500 }, terminal));
    const end = await terminal.ready;
    expect(f.business()).toBe(0); expect(after).toBe(0);
    const row = need(f.store.toolCalls.get({ runId: accepted.runId, sessionId: session.sessionId, nativeToolCallId: 'original-runtime-call' }));
    expect(row).toMatchObject({ startedAt: null, stoppedAt: null, args: { final: null },
      result: { status: 'failed', error: { code: 'tool_context_limit' } },
      runtimeObservation: { beforeOutcome: 'rejected', failureStage: 'sdk_before', diagnosticCode: 'tool_context_limit', executionDurationMs: null } });
    expect(end.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'tool_context_limit' } } });
    expect(f.payloads).toHaveLength(1); expect(row.delivery.state).not.toBe('request_observed');
    need(await f.app.close());
  }, 15_000);

  for (const mode of ['revoked', 'closed', 'deadline'] as const) it(`rechecks ${mode} before business execution and invokes the real SDK after hook`, async () => {
    const entered = barrier(), release = barrier(); let after = 0;
    const f = fixture((_body, ordinal) => response('Completed.', ordinal === 1), session => {
      const priorBefore = session.agent.beforeToolCall, priorAfter = session.agent.afterToolCall;
      session.agent.beforeToolCall = async (...args) => { const result = await priorBefore?.(...args); entered.release(); await release.ready; return result; };
      session.agent.afterToolCall = async (...args) => { after++; return priorAfter?.(...args); };
    });
    deferCleanup(release.release);
    const { session, workspace } = await select(f.app); const terminal = completion();
    const accepted = need(await f.app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt',
      text: 'Calculate this invoice.', config: f.config, workspace: expected(workspace), goalMode: 'answer', timeoutMs: 5000, stopGraceMs: 500 }, terminal));
    await entered.ready;
    const requested = need(f.store.toolCalls.get({ runId: accepted.runId, sessionId: session.sessionId, nativeToolCallId: 'original-runtime-call' }));
    expect(requested).toMatchObject({ status: 'requested', args: { final: null }, startedAt: null });
    if (mode === 'revoked') need(f.store.sessions.revokeDocumentUse({ documentId: 1, at: f.now() }));
    else if (mode === 'closed') f.tools.closeRun(accepted.runId);
    else f.advanceClock(5001);
    release.release(); await terminal.ready;
    expect(f.business()).toBe(0); expect(after).toBe(1);
    const rejected = need(f.store.toolCalls.getById(requested.toolCallId));
    expect(rejected).toMatchObject({ startedAt: null, stoppedAt: null, args: { final: { operation: 'sum', values: ['1', '2'], scale: 2 } },
      result: { status: 'failed', error: { code: mode === 'revoked' ? 'session_scope_revoked' : mode === 'closed' ? 'tool_budget_exceeded' : 'agent_timeout' } },
      runtimeObservation: { beforeOutcome: 'rejected', failureStage: 'before', executionDurationMs: null, timingComplete: false,
        afterStructure: 'not_applicable', afterDomain: 'not_applicable' } });
    if (mode !== 'closed') expect(f.payloads).toHaveLength(1);
    need(await f.app.close());
  }, 15_000);

  for (const route of ['sdk', 'host'] as const) for (const fault of ['transaction', 'response-loss', 'response-throw'] as const)
    it(`settles ${route} refusal through ${fault} before releasing feedback`, async () => {
      const entered = barrier(), release = barrier(); let after = 0;
      const f = fixture((_body, ordinal) => response('Completed.', ordinal === 1), session => {
        const priorBefore = session.agent.beforeToolCall, priorAfter = session.agent.afterToolCall;
        session.agent.beforeToolCall = async (...args) => { await priorBefore?.(...args); entered.release(); await release.ready;
          return route === 'sdk' ? { block: true, reason: 'Controlled SDK refusal.' } : undefined; };
        session.agent.afterToolCall = async (...args) => { after++; return priorAfter?.(...args); };
      });
      deferCleanup(release.release);
      const { session, workspace } = await select(f.app); const terminal = completion();
      const accepted = need(await f.app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt',
        text: 'Calculate this invoice.', config: f.config, workspace: expected(workspace), goalMode: 'answer', timeoutMs: 5000, stopGraceMs: 500 }, terminal));
      await entered.ready;
      if (route === 'host') f.tools.closeRun(accepted.runId);
      let fixed: ReturnType<typeof f.store.toolCalls.reject> | undefined;
      if (fault === 'transaction') f.store.db.exec(`CREATE TRIGGER reject_runtime_observation BEFORE UPDATE OF runtime_observation_json ON tool_calls
        WHEN NEW.runtime_observation_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'controlled observation write failure'); END;`);
      else {
        const original = f.store.toolCalls.reject;
        f.store.toolCalls.reject = input => { fixed = original(input);
          if (fixed.ok && fault === 'response-throw') throw new Error('Controlled rejection response loss.');
          return fixed.ok ? fail(appError('storage_write_failed', 'storage', 'Controlled rejection response loss.')) : fixed; };
      }
      release.release(); const end = await terminal.ready;
      expect(after).toBe(route === 'sdk' ? 0 : 1); expect(f.business()).toBe(0);
      const rows = need(f.store.toolCalls.list({ runId: accepted.runId, limit: 100 })).items;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('The original ToolCall must remain available.');
      expect(row).toMatchObject({ startedAt: null, stoppedAt: null, args: { final: route === 'sdk' ? null : { operation: 'sum', values: ['1', '2'], scale: 2 } } });
      expect(f.store.db.query('SELECT tool_call_count AS count FROM runs WHERE id=?').get(accepted.runId)).toEqual({ count: 1 });
      if (fault === 'transaction') {
        expect(row).toMatchObject({ status: 'requested', result: null, runtimeObservation: null });
        expect(end.result).toMatchObject({ ok: true, data: { status: 'failed' } });
        expect(f.payloads).toHaveLength(1); expect(row.delivery.state).not.toBe('request_observed');
      } else {
        if (!fixed?.ok) throw new Error('The initial refusal did not commit.');
        expect(row.endedAt).toBe(fixed.data.endedAt); expect(row.result).toEqual(fixed.data.result);
        expect(row.runtimeObservation).toEqual(fixed.data.runtimeObservation);
        expect(row.runtimeObservation).toMatchObject({ beforeOutcome: 'rejected', failureStage: route === 'sdk' ? 'sdk_before' : 'before', executionDurationMs: null });
        expect(f.payloads).toHaveLength(2); expect(row.delivery.state).toBe('request_observed');
        expect(end.result).toMatchObject({ ok: true, data: { status: 'completed' } });
      }
      need(await f.app.close());
    }, 15_000);
});

describe('Runtime queued inputs preserve their admitted invoice', () => {
  for (const mode of ['switch', 'revoke'] as const) it(`uses original frozen input facts after current invoice ${mode}`, async () => {
    const entered = barrier(), release = barrier();
    const f = fixture(async (_body, ordinal) => { if (ordinal === 1) { entered.release(); await release.ready; } return response(`Reply ${ordinal}.`); });
    deferCleanup(release.release);
    const { session, workspace } = await select(f.app); const terminal = completion();
    const prompt = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt' as const,
      text: 'Initial invoice request.', config: f.config, workspace: expected(workspace), goalMode: 'answer' as const, timeoutMs: 5000, stopGraceMs: 500 };
    const initial = need(await f.app.submitInput(prompt, terminal)); await entered.ready;
    const additional = { sessionId: session.sessionId, clientSequence: 2, mode: 'followUp' as const,
      runId: initial.runId, text: 'Continue the original invoice.', workspace: expected(workspace) };
    const queued = need(await f.app.submitInput(additional));
    const firstFrozen = need(f.store.sessionInputs.get(queued.inputId));
    if (!firstFrozen) throw new Error('The admitted queued input must be persisted.');
    if (firstFrozen.content.version !== 2) throw new Error('The queued input must use the current native input content.');
    const switched = need(await f.app.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'document', documentId: 2 } }));
    expect(await f.app.submitInput({ ...additional, clientSequence: 3, workspace: expected(switched) }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.app.submitInput({ ...additional, clientSequence: 3 }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(need(await f.app.listSessionInputs({ sessionId: session.sessionId, runId: initial.runId })).items).toHaveLength(2);
    expect(firstFrozen.content).toMatchObject({ workspaceContext: { documentRef: { id: 1, version: 'v1' } },
      workspaceInput: { documentRef: { id: 1, version: 'v1' } }, allowedDocumentIds: [1], allowedArtifactIds: [2] });
    if (mode === 'revoke') expect(need(await f.app.revokeDocumentUse(1)))
      .toEqual({ affectedSessionIds: [session.sessionId], stopRequested: true });
    expect(await f.app.submitInput(additional)).toEqual(ok(queued));
    release.release(); await terminal.ready;
    const input = need(f.store.sessionInputs.get(queued.inputId));
    if (!input) throw new Error('The original queued input must remain available.');
    expect(input.content).toEqual(firstFrozen.content); expect(f.business()).toBe(0);
    if (mode === 'switch') {
      expect(input).toMatchObject({ runId: initial.runId, status: 'consumed', processingStatus: 'completed',
        nativeEntryId: expect.any(String), resultEntryId: expect.any(String) });
      expect(f.payloads).toHaveLength(2);
      const subsequent = f.payloads[1];
      if (!subsequent) throw new Error('The queued input must reach a subsequent native model request.');
      const actual = subsequent.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string'
        ? message.content : Array.isArray(message.content) ? message.content.flatMap((block: unknown) => block && typeof block === 'object'
          && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('') : '');
      expect(actual.at(-1)).toContain(firstFrozen.content.promptText);
      expect(firstFrozen.content.promptText).toContain('"id":1');
      expect(firstFrozen.content.promptText).not.toContain('"id":2');
    } else {
      expect(f.payloads).toHaveLength(1); expect(input.nativeEntryId).toBeNull(); expect(input.resultEntryId).toBeNull();
      expect(input.processingStatus).not.toBe('completed');
      expect(need(await f.app.querySession(session.sessionId)).modelUseBlocked).toBe(true);
      expect(await f.app.submitInput({ ...prompt, clientSequence: 3, workspace: expected(switched) }))
        .toMatchObject({ ok: false, error: { code: 'session_scope_revoked' } });
    }
    expect(need(await f.app.queryRun(initial.runId)).scope).toMatchObject({ allowedDocumentIds: [1], allowedArtifactIds: [2] });
    need(await f.app.close());
  }, 15_000);
});
