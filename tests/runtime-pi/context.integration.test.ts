import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { streamSimple as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { ModelRuntime, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDatabase } from '@flowmate/core';
import { CandidateDraftSchema, invoiceHeaderFields } from '@flowmate/contracts';
import { ContextObservationsSchema, SessionInputContentV2Schema, appError, fail, ok } from '@flowmate/contracts';
import type { AgentRunEvent, Application, ProviderConfig, Result, SessionInputRequest, AgentToolBinding, ToolDefinition, RequestContextBinding, ContextEvidenceUpdate } from '@flowmate/contracts';
import { z } from 'zod';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../support/resources.ts';
import { openTestDatabase } from '../support/database.ts';
import { ContextService } from '../../packages/core/src/context/service.ts';
import { RuntimeService } from '../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../packages/core/src/sessions/service.ts';
import { checkPayload, checkWire, preparePayloadCodec } from '../../packages/runtime-pi/src/context-evidence.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }

function barrier() { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; }
function reply(text = 'Controlled answer.') {
  const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p8-context',
    choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
  return new Response(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
function responsesReply() {
  const item = { id: 'message-1', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Controlled answer.', annotations: [] }] };
  const events = [{ type: 'response.created', response: { id: 'response-1' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Controlled answer.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'response-success' } });
}
async function evidenceFixture(options: {
  api?: 'openai-completions' | 'openai-responses' | 'pi-messages' | 'google-generative-ai'; retries?: 0 | 1;
  response?: (ordinal: number) => Response | Promise<Response>;
  replacement?: (payload: unknown) => unknown | Promise<unknown>;
  reject?: (update: ContextEvidenceUpdate) => boolean;
  onResponse?: (response: { status: number; headers: Record<string, string> }) => void | Promise<void>;
  sdkCallback?: 'same' | 'null-then-id' | 'status' | 'identity' | 'missing-slot';
  wire?: 'request' | 'opaque' | 'remove-user';
  networkThrow?: boolean; ignoreAbort?: boolean;
  syncThrow?: boolean; timeoutMs?: number; afterRecord?: (update: ContextEvidenceUpdate) => void;
  nativeUnavailable?: boolean; ancestor?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p8-evidence-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const store = need(openTestDatabase(paths)), payloads: unknown[] = [], updates: ContextEvidenceUpdate[] = [];
  let baseCalls = 0;
  const api = options.api ?? 'openai-completions';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json());
    if (options.response) return options.response(payloads.length);
    const response = api === 'openai-responses' ? responsesReply() : reply();
    response.headers.set('x-request-id', 'response-success'); return response;
  } });
  deferCleanup(() => server.stop(true));
  let sdk!: AgentSession;
  const adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir,
    credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-evidence-key', sessionSetup: session => { sdk = session; },
    fetch: (input, init) => {
      baseCalls++; if (options.syncThrow) throw new Error('PRIVATE_SYNC_THROW');
      return options.networkThrow ? Promise.reject(new Error('PRIVATE_TOKEN_BODY_DO_NOT_PERSIST'))
        : globalThis.fetch(input, options.ignoreAbort ? { ...init, signal: undefined } : init); } });
  const native = need(adapter.createSession());
  const at = () => new Date().toISOString();
  let initial = need(adapter.exportSession(native.nativeSessionId)); let sourceSessionId: number | null = null;
  if (options.ancestor) {
    const source = SessionManager.inMemory(paths.runtimeDir); source.appendSessionInfo('ancestor authorization fixture');
    const sourceHistory = { storageVersion: 1 as const, header: source.getHeader()!, entries: source.getEntries().map(e => ({ ...e })), leafId: source.getLeafId(), unusable: false };
    sourceSessionId = need(store.sessions.create({ nativeSessionId: sourceHistory.header.id, title: 'Ancestor', at: at(), nativeHistory: sourceHistory })).sessionId;
    initial = { ...initial, entries: structuredClone(sourceHistory.entries), leafId: sourceHistory.leafId };
    await adapter.releaseSession(native.nativeSessionId);
  }
  const session = need(store.sessions.create({ nativeSessionId: native.nativeSessionId, title: 'Evidence', at: at(), nativeHistory: initial }));
  if (sourceSessionId !== null) {
    // Trusted historical provenance in disposable SQL, not the T06 fork producer.
    const source = need(store.memory.load(sourceSessionId))!;
    store.db.query(`INSERT INTO session_forks(target_session_id,source_session_id,source_commit_revision,source_entry_count,
      source_leaf_id,selected_entry_id,inherited_entry_count,client_operation_id,request_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(session.sessionId, sourceSessionId, source.commit.commitRevision, source.commit.entryCount, source.commit.leafId,
        initial.leafId!, initial.entries.length, 't04-ancestor', JSON.stringify({ selectedEntryId: initial.leafId }), at());
  }
  const recovered = need(store.sessions.loadHistoryForContext(session.sessionId));
  if (options.ancestor) need(adapter.restoreSession(native.nativeSessionId, recovered.history!, recovered.seed, recovered.commit!));
  if (!recovered.history || !recovered.commit) throw new Error('Actual SQL receipt required.');
  need(adapter.watchSession(native.nativeSessionId, recovered.commit, recovered.seed, write => store.memory.commit({ sessionId: session.sessionId, expected: write.expected, header: write.history.header, appendEntries: write.history.entries, leafId: write.history.leafId, unusable: write.history.unusable, contexts: write.contexts })));
  const config: ProviderConfig = { version: 1, name: 'Evidence', revision: 1, modelRef: { provider: 'evidence-fixture', model: 'fixture' },
    native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api, contextWindow: 64000, maxTokens: 16384 },
    parameters: { maxRetries: options.retries ?? 0, maxRetryDelayMs: 1000 } };
  need(await adapter.prepare(native.nativeSessionId, config, { timeoutMs: 5000, stopGraceMs: 500 }, new AbortController().signal, { sessionInputs: true }));
  if (options.replacement || options.onResponse) {
    const wrapped = sdk.agent.streamFunction;
    // Public outer wrapper sends original callback options into Pi's evidence wrapper, never around it.
    sdk.agent.streamFunction = (model, context, streamOptions) => wrapped(model, context, { ...streamOptions,
      ...(options.replacement ? { onPayload: payload => options.replacement!(payload) } : {}),
      ...(options.onResponse ? { onResponse: async response => { await options.onResponse!(response); } } : {}) });
  }
  if (options.sdkCallback || options.wire || options.nativeUnavailable) {
    const original = ModelRuntime.prototype.streamSimple;
    ModelRuntime.prototype.streamSimple = function (model, context, streamOptions) {
      if (options.nativeUnavailable) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [{ type: 'text', text: 'Controlled unavailable API answer.' }], stopReason: 'stop', timestamp: 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(async () => {
          try {
            await streamOptions?.onPayload?.({ unsupportedShape: true }, model);
            // Deliberate SDK capability fixture: no custom fetch API still makes a real loopback request.
            const response = await (streamOptions?.fetch ?? globalThis.fetch)(`${config.connection!.baseUrl}/unavailable`,
              { method: 'POST', body: JSON.stringify({ unsupportedShape: true }) });
            await streamOptions?.onResponse?.({ status: response.status, headers: { 'x-request-id': 'unsupported-id' } }, model);
            stream.push({ type: 'done', reason: 'stop', message }); stream.end(message);
          } catch (error) { const failed = { ...message, stopReason: 'error' as const, errorMessage: String(error) };
            stream.push({ type: 'error', reason: 'error', error: failed }); stream.end(failed); }
        });
        return stream;
      }
      return original.call(this, model, context, { ...streamOptions,
        fetch: options.sdkCallback === 'missing-slot' ? globalThis.fetch : options.wire ? Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
          if (options.wire === 'request') return streamOptions!.fetch!(new Request(input, init));
          if (options.wire === 'opaque') return streamOptions!.fetch!(input, { ...init, body: new Blob([String(init?.body)]) });
          const body = JSON.parse(String(init?.body));
          return streamOptions!.fetch!(input, { ...init, body: JSON.stringify({ ...body, messages: [] }) });
        }, { preconnect: globalThis.fetch.preconnect }) : streamOptions?.fetch,
        onResponse: async (response, requested) => {
          const callback = streamOptions?.onResponse;
          if (options.sdkCallback === 'status') { await callback?.({ ...response, status: 201 }, requested); return; }
          if (options.sdkCallback === 'identity') { await callback?.(response, { ...requested, id: 'different-model' }); return; }
          if (options.sdkCallback === 'null-then-id') {
            await callback?.({ ...response, headers: {} }, requested);
            await callback?.(response, requested); return;
          }
          await callback?.(response, requested);
          if (options.sdkCallback === 'same') await callback?.(response, requested);
        } });
    };
    deferCleanup(() => { ModelRuntime.prototype.streamSimple = original; });
  }
  const runtime = new RuntimeService({ memory: store.memory, runs: store.runs, sessions: store.sessions, sessionInputs: store.sessionInputs, agent: adapter,
    contextService: new ContextService({ store, materials: { inspectParsed() { throw new Error('No chat material.'); } } }),
    contextRepository: { bindRequest: store.context.bindRequest, resolveToolResult: store.context.resolveToolResult,
      recordRequest(binding, update) { updates.push(update);
        if (options.reject?.(update)) return fail(appError('storage_write_failed', 'storage', 'Controlled necessary evidence rejection.', true));
        const saved = store.context.recordRequest(binding, update); if (saved.ok) options.afterRecord?.(update); return saved; } },
    provider: { async prepare() { throw new Error('No direct Provider.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: at, monotonicNow: () => performance.now() });
  deferCleanup(() => runtime.close());
  const sessions = new SessionService(store.sessions, adapter, () => runtime.state(), at, store.runs, store.memory, store.sessionInputs,
    (request, submission, control) => runtime.start(request, control, submission), request => runtime.appendInput(request));
  const start = async (text = 'Text with \ud800 lone and 😀 paired', clientSequence = 1) => {
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await sessions.submitInput({ sessionId: session.sessionId, clientSequence, mode: 'prompt', text,
      config, timeoutMs: options.timeoutMs ?? 5000, stopGraceMs: 500 }, { onEvent(event) { if (event.type === 'run_finished') finish(event); } }));
    return { accepted, terminal };
  };
  const journal = (runId: number) => ContextObservationsSchema.parse(JSON.parse(store.db.query<{ context_observations_json: string }, [number]>
    ('SELECT context_observations_json FROM runs WHERE id=?').get(runId)!.context_observations_json));
  return { store, adapter, sdk, session, sourceSessionId, runtime, sessions, config, payloads, updates, start, journal, baseCalls: () => baseCalls };
}
async function begin(app: Application, input: SessionInputRequest) {
  let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
  const accepted = need(await app.submitInput(input, { onEvent(event) { if (event.type === 'run_finished') finish(event); } }));
  return { accepted, terminal };
}
it('T10 F8-12 reopens a real Application and SQLite without query replay, then seeds exact branch identities for new input', async () => {
  let builds = 0;
  const build = ContextService.prototype.build;
  ContextService.prototype.build = function (this: ContextService, ...args) { builds++; return build.apply(this, args); };
  deferCleanup(() => { ContextService.prototype.build = build; });
  const root = mkdtempSync(join(tmpdir(), 'flowmate-t10-reopen-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const payloads: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { payloads.push(await request.json()); return reply(); } });
  deferCleanup(() => server.stop(true));
  const config: ProviderConfig = { version: 1, name: 'T10 restart', revision: 1, modelRef: { provider: 't10-restart', model: 'fixture' },
    native: { authPath: join(root, 'unused.json'), modelsPath: null }, connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`,
      api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  const open = async () => {
    let adapter!: PiAgentAdapter;
    const calls = { restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, inspect: 0 };
    const restored: Array<Parameters<PiAgentAdapter['restoreSessionLeaf']>> = [];
    const app = need(await createApplication({ paths, logger: { write() {}, async close() {} }, agentFactory: tools => {
      adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-reopen-key' });
      const restore = adapter.restoreSession.bind(adapter); adapter.restoreSession = (...args) => { calls.restore++; restored.push(structuredClone(args)); return restore(...args); };
      const leaf = adapter.restoreSessionLeaf.bind(adapter); adapter.restoreSessionLeaf = (...args) => { calls.leaf++; restored.push(structuredClone(args)); return leaf(...args); };
      const watch = adapter.watchSession.bind(adapter); adapter.watchSession = (...args) => { calls.watch++; return watch(...args); };
      const prepare = adapter.prepare.bind(adapter); adapter.prepare = (...args) => { calls.prepare++; return prepare(...args); };
      const enqueue = adapter.enqueueInput.bind(adapter); adapter.enqueueInput = (...args) => { calls.enqueue++; return enqueue(...args); };
      const inspect = adapter.inspect.bind(adapter); adapter.inspect = (...args) => { calls.inspect++; return inspect(...args); };
      return adapter;
    } }));
    deferCleanup(() => app.close()); return { app, adapter, calls, restored };
  };
  const firstApp = await open();
  const session = need(await firstApp.app.createSession({ title: 'Actual restart', expectedRevision: need(await firstApp.app.readWorkspace()).revision }));
  const prompt = (clientSequence: number): SessionInputRequest => ({ sessionId: session.sessionId, clientSequence, mode: 'prompt', text: 'same text', config, timeoutMs: 5000, stopGraceMs: 500 });
  const first = await begin(firstApp.app, prompt(1)); expect((await first.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const second = await begin(firstApp.app, prompt(2)); expect((await second.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const history = need(firstApp.adapter.exportSession(session.nativeSessionId));
  const target = history.entries.find(entry => entry.type === 'message' && typeof entry.message === 'object' && entry.message !== null
    && 'role' in entry.message && entry.message.role === 'assistant')!.id;
  const committed = need(await firstApp.app.querySessionHistory({ sessionId: session.sessionId }));
  expect(committed.session.sessionId).toBe(session.sessionId);
  expect(committed.commit).toMatchObject({ leafId: history.leafId, entryCount: history.entries.length });
  need(await firstApp.app.branchSession({ sessionId: session.sessionId, expectedLeafId: history.leafId, expectedEntryCount: history.entries.length, expectedCommitRevision: committed.commit.commitRevision, targetEntryId: target }));
  const branch = JSON.parse(JSON.stringify(need(firstApp.adapter.exportSession(session.nativeSessionId))));
  const oldInputs = [first, second].map(async run => need(await firstApp.app.querySessionInput({ sessionId: session.sessionId, inputId: run.accepted.inputId })).input!);
  const inputs = await Promise.all(oldInputs);
  expect(inputs[0]!.nativeEntryId).not.toBe(inputs[1]!.nativeEntryId);
  expect(need(await firstApp.app.close()).closed).toBe(true);
  const persisted = () => {
    const db = new Database(paths.databaseFile, { readonly: true });
    try { return { sessions: db.query('SELECT * FROM sessions ORDER BY id').all(), runs: db.query('SELECT * FROM runs WHERE id IN (?,?) ORDER BY id').all(first.accepted.runId, second.accepted.runId),
      inputs: db.query('SELECT * FROM session_inputs WHERE id IN (?,?) ORDER BY id').all(first.accepted.inputId, second.accepted.inputId),
      snapshots: db.query('SELECT * FROM context_snapshots WHERE run_id IN (?,?) ORDER BY id').all(first.accepted.runId, second.accepted.runId),
      fk: db.query('PRAGMA foreign_key_check').all() }; } finally { db.close(); }
  };
  const before = persisted(); expect(before.fk).toEqual([]); expect(payloads).toHaveLength(2);
  const reopened = await open(); expect(reopened.adapter).not.toBe(firstApp.adapter);
  const buildBaseline = builds;
  need(await reopened.app.querySession(session.sessionId));
  expect(reopened.calls).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, inspect: 1 });
  const queryBaseline = { ...reopened.calls };
  for (const [index, run] of [first, second].entries()) {
    need(await reopened.app.queryRun(run.accepted.runId));
    expect(need(await reopened.app.querySessionInput({ sessionId: session.sessionId, inputId: run.accepted.inputId })).input).toEqual(inputs[index]);
    const owner = { sessionId: session.sessionId, runId: run.accepted.runId };
    expect(need(await reopened.app.listContextSnapshots(owner)).items).toHaveLength(1);
    expect(need(await reopened.app.listContextRequests(owner)).items).toHaveLength(1);
    const snapshotId = inputs[index]!.contextSnapshotId;
    if (snapshotId === null) throw new Error('Real P8 snapshot required.');
    expect(need(await reopened.app.queryContextSnapshot({ ...owner, snapshotId })).snapshot.id).toBe(snapshotId);
  }
  expect(reopened.calls).toEqual(queryBaseline);
  expect(builds).toBe(buildBaseline);
  expect(payloads).toHaveLength(2); expect(need(await reopened.app.close()).closed).toBe(true);
  expect(persisted()).toEqual(before);
  const active = await open();
  // Recheck the same newly opened instance immediately before admitting its new input.
  need(await active.app.listContextSnapshots({ sessionId: session.sessionId, runId: first.accepted.runId }));
  need(await active.app.listContextRequests({ sessionId: session.sessionId, runId: first.accepted.runId }));
  need(await active.app.queryContextSnapshot({ sessionId: session.sessionId, runId: first.accepted.runId, snapshotId: inputs[0]!.contextSnapshotId! }));
  expect(active.calls).toEqual({ restore: 0, leaf: 0, watch: 0, prepare: 0, enqueue: 0, inspect: 0 });
  expect(builds).toBe(buildBaseline); expect(payloads).toHaveLength(2);
  const third = await begin(active.app, prompt(3)); expect((await third.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const thirdInput = need(await active.app.querySessionInput({ sessionId: session.sessionId, inputId: third.accepted.inputId })).input!;
  expect(active.calls).toMatchObject({ restore: 1, leaf: 0, watch: 1, prepare: 1 });
  expect(active.restored[0]![0]).toBe(session.nativeSessionId);
  expect(JSON.parse(JSON.stringify(active.restored[0]![1]))).toEqual(branch);
  expect(active.restored[0]![2].inputs).toEqual([first, second].map((run, index) => {
    const nativeEntryId = inputs[index]!.nativeEntryId;
    if (nativeEntryId === null) throw new Error('Persisted user entry required.');
    return { originRunId: run.accepted.runId, inputId: run.accepted.inputId, nativeEntryId, snapshotId: inputs[index]!.contextSnapshotId };
  }));
  expect(thirdInput.nativeEntryId).not.toBe(inputs[0]!.nativeEntryId); expect(thirdInput.nativeEntryId).not.toBe(inputs[1]!.nativeEntryId);
  expect(thirdInput.contextSnapshotId).not.toBe(inputs[0]!.contextSnapshotId); expect(payloads).toHaveLength(3);
  expect(builds).toBe(buildBaseline + 1);
  const requests = need(await active.app.listContextRequests({ sessionId: session.sessionId, runId: third.accepted.runId })).items;
  expect(requests[0]).toMatchObject({ binding: { inputId: third.accepted.inputId, snapshotId: thirdInput.contextSnapshotId, requestSequence: 1,
    includedBindings: [{ originRunId: first.accepted.runId, inputId: first.accepted.inputId, nativeEntryId: inputs[0]!.nativeEntryId, snapshotId: inputs[0]!.contextSnapshotId },
      { originRunId: third.accepted.runId, inputId: third.accepted.inputId, nativeEntryId: thirdInput.nativeEntryId, snapshotId: thirdInput.contextSnapshotId }] },
    sdkPayload: { inclusion: 'confirmed' }, attempts: [expect.objectContaining({ wireInclusion: 'confirmed', responseStatus: 200 })] });
  expect(need(await active.app.close()).closed).toBe(true);
  const after = persisted(); expect(after.runs).toEqual(before.runs); expect(after.inputs).toEqual(before.inputs);
  expect(after.snapshots).toEqual(before.snapshots); expect(after.fk).toEqual([]);
});
async function fixture(onRequest: (ordinal: number) => Promise<Response> | Response = () => reply(), beforeTool?: () => Promise<void>,
  toolFault?: 'error-terminal' | 'error-result' | 'aborted-result' | 'tool-result' | 'binding-lost') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p8-context-sdk-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const payloads: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json()); return onRequest(payloads.length);
  } });
  deferCleanup(() => server.stop(true));
  const config: ProviderConfig = { version: 1, name: 'P8 controlled SDK', revision: 1,
    modelRef: { provider: 'p8-context-fixture', model: 'p8-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  let adapter!: PiAgentAdapter, executions = 0;
  const app = need(await createApplication({ paths, logger: { write() {}, async close() {} },
    agentFactory: tools => {
      adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-p8-key',
      sessionSetup(session) {
        if (beforeTool) { const original = session.agent.beforeToolCall;
          session.agent.beforeToolCall = async (...args) => { await beforeTool(); return original?.(...args); }; }
        if (toolFault && toolFault !== 'binding-lost') {
          const native = session.agent.streamFunction;
          // Fault boundary around the real SDK HTTP stream: partial tool content ends as an error, never done/result success.
          session.agent.streamFunction = (model, context, options) => {
            const output = createAssistantMessageEventStream();
            queueMicrotask(async () => {
              const stream = await native(model, context, options);
              for await (const event of stream) {
                if (event.type === 'done') {
                  if (toolFault === 'tool-result') { output.end(event.message); return; }
                  const failed = { ...event.message, stopReason: toolFault === 'aborted-result' ? 'aborted' as const : 'error' as const,
                    errorMessage: 'Controlled terminal failure.' };
                  if (toolFault === 'error-terminal') output.push({ type: 'error', reason: 'error', error: failed });
                  output.end(failed); return;
                }
                output.push(event);
              }
              output.end(await stream.result());
            });
            return output;
          };
        }
      } });
      const prepare = adapter.prepare.bind(adapter);
      adapter.prepare = async (...args) => {
        const prepared = await prepare(...args); if (!prepared.ok) return prepared;
        const execute = prepared.data.execute;
        return { ...prepared, data: { ...prepared.data, execute(input, signal, observe) {
          const binding = input.toolBinding; if (!binding) return execute(input, signal, observe);
          return execute({ ...input, toolBinding: { ...binding,
            observeRequest(name, raw, call) {
              if (toolFault !== 'binding-lost') return binding.observeRequest(name, raw, call);
              const { requestBinding: _lost, ...withoutBinding } = call;
              return binding.observeRequest(name, raw, withoutBinding);
            },
            execute(...call) { executions++; return binding.execute(...call); },
          } }, signal, observe);
        } } };
      };
      return adapter;
    } }));
  deferCleanup(() => app.close());
  const session = need(await app.createSession({ title: 'Context identity', expectedRevision: need(await app.readWorkspace()).revision }));
  const journal = (runId: number) => {
    const db = new Database(paths.databaseFile, { readonly: true });
    try { return ContextObservationsSchema.parse(JSON.parse(db.query<{ context_observations_json: string }, [number]>
      ('SELECT context_observations_json FROM runs WHERE id=?').get(runId)!.context_observations_json)); }
    finally { db.close(); }
  };
  const prompt = (clientSequence: number, text = 'same text'): SessionInputRequest => ({ sessionId: session.sessionId,
    clientSequence, mode: 'prompt', text, config, timeoutMs: 5000, stopGraceMs: 500 });
  return { app, adapter, paths, session, payloads, journal, prompt, executions: () => executions };
}

async function storedFixture(withRepository = true, toolOrigin: false | 'legacy' | 'p8' = false, extraToolResults = 0, preledgerUsers = 0) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p8-context-store-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
  const store = need(openTestDatabase(paths));
  let calls = 0;
  const tool: ToolDefinition<{ value: number }, { value: number }> = { name: 'probe_read', version: '1', label: 'Read',
    description: 'Read a fixture value.', inputSchema: z.object({ value: z.number() }).strict(), outputSchema: z.object({ value: z.number() }).strict(),
    effect: 'READ', executionMode: 'parallel', execute: async value => value };
  const adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, credentials: new InMemoryCredentialStore(),
    runtimeApiKey: 'synthetic-p8-key', tools: [tool], fetch: async () => {
      calls++;
      if (toolOrigin && calls === 1) {
        return new Response('data: ' + JSON.stringify({ id: 'legacy-tool', choices: [{ index: 0, delta: { role: 'assistant',
          tool_calls: [{ index: 0, id: 'legacy-call', type: 'function', function: { name: 'probe_read', arguments: '{"value":7}' } }] },
          finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'legacy-tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }
      return reply();
    }, sessionSetup: session => {
      if (!extraToolResults) return;
      const convert = session.agent.convertToLlm.bind(session.agent);
      session.agent.convertToLlm = async messages => {
        const converted = await convert(messages); const result = converted.find(message => message.role === 'toolResult');
        return result && calls >= 2 ? [...converted, ...Array.from({ length: extraToolResults }, () => result)] : converted;
      };
    } });
  deferCleanup(() => adapter.close());
  const native = need(adapter.createSession());
  const at = () => new Date().toISOString();
  let initial = need(adapter.exportSession(native.nativeSessionId));
  if (preledgerUsers) {
    const manager = SessionManager.inMemory(paths.runtimeDir);
    for (let index = 0; index < preledgerUsers; index++) manager.appendMessage({ role: 'user', content: 'legacy same text', timestamp: index + 1 });
    initial = { ...initial, entries: manager.getEntries().map(e => ({ ...e })), leafId: manager.getLeafId() };
    await adapter.releaseSession(native.nativeSessionId);
  }
  const session = need(store.sessions.create({ nativeSessionId: native.nativeSessionId, title: 'Stored context', at: at(), nativeHistory: initial }));
  const recovered = need(store.sessions.loadHistoryForContext(session.sessionId));
  if (!recovered.history || !recovered.commit) throw new Error('Actual SQL receipt required.');
  if (preledgerUsers) need(adapter.restoreSession(native.nativeSessionId, recovered.history, recovered.seed, recovered.commit));
  need(adapter.watchSession(native.nativeSessionId, recovered.commit, recovered.seed, write => store.memory.commit({ sessionId: session.sessionId, expected: write.expected, header: write.history.header, appendEntries: write.history.entries, leafId: write.history.leafId, unusable: write.history.unusable, contexts: write.contexts })));
  const config: ProviderConfig = { version: 1, name: 'Stored SDK', revision: 1,
    modelRef: { provider: 'p8-store-fixture', model: 'p8-model' }, native: { authPath: join(root, 'unused.json'), modelsPath: null },
    connection: { baseUrl: 'https://fixture.invalid/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  const contextService = new ContextService({ store, materials: { inspectParsed() { throw new Error('Chat has no parsed material.'); } } });
  let legacyRunId: number | null = null, originalCallId: number | null = null;
  if (toolOrigin) {
    const prepared = need(await adapter.prepare(native.nativeSessionId, config, { timeoutMs: 5000, stopGraceMs: 500 },
      new AbortController().signal, { activeToolNames: ['probe_read'] }));
    const createOriginRun = () => need(store.runs.createAgent({ sessionId: session.sessionId,
      scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] },
      config: { ...prepared.snapshot, ...(toolOrigin === 'p8' ? { contextPolicyVersion: 'p8-context-v1' as const } : {}) }, goal: 'Legacy',
      input: { version: 1, text: 'old question', goal: 'Legacy', messageTimestamp: 1 },
      usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: at() },
      cleanup: { version: 1, stopped: true, stopReason: null, errors: [], lateObservationRequired: false }, createdAt: at() }));
    let originInput: import('@flowmate/contracts').SessionInputSnapshot | undefined;
    if (toolOrigin === 'p8') {
      originInput = need(store.sessionInputs.admit({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'old question', config }, () => {
        legacyRunId = createOriginRun();
        const built = need(contextService.build({ runId: legacyRunId, sessionId: session.sessionId, jobId: null, text: 'old question', goalMode: 'answer',
          workspaceContext: null, workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [], workingDirectory: null, createdAt: at() }));
        return ok({ runId: legacyRunId, contextPolicyVersion: 'p8-context-v1', contextSnapshotId: built.snapshot.id,
          content: SessionInputContentV2Schema.parse({ version: 2, text: 'old question', promptText: built.promptText,
            workspaceContext: null, workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [] }) });
      }, at())).input;
    } else legacyRunId = createOriginRun();
    if (legacyRunId === null) throw new Error('Original Run required.');
    need(store.runs.start(legacyRunId, { ...prepared.snapshot,
      ...(toolOrigin === 'p8' ? { contextPolicyVersion: 'p8-context-v1' as const } : {}) }, at()));
    const runId = legacyRunId;
    let generating: RequestContextBinding | null = null;
    const binding: AgentToolBinding = { context: { runId, sessionId: session.sessionId,
      scope: { version: 2, allowedTools: ['probe_read'], allowedDocumentIds: [], allowedArtifactIds: [], allowedResourcePaths: [] } },
      observeRequest: (name, raw, call) => {
        if (toolOrigin === 'p8') {
          if (!generating) return fail(appError('context_binding_unknown', 'runtime', 'The fixture requires the actual generating request.'));
          // Trusted ToolBinding boundary fixture, not the T07 Executor implementation.
          originalCallId = Number(store.db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,
            delivery_json,cleanup_json,requested_at,context_snapshot_id,request_sequence) VALUES(?,?,?,?,?,'READ',?,?,?,?,?,?)`)
            .run(runId, session.sessionId, call.nativeToolCallId, name, '1', JSON.stringify({ version: 1, raw, final: null }),
              JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null }),
              JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [] }), at(), generating.snapshotId, generating.requestSequence).lastInsertRowid);
          need(store.toolCalls.getById(originalCallId));
        } else originalCallId = need(store.toolCalls.request({ context: null, runId, sessionId: session.sessionId,
          nativeToolCallId: call.nativeToolCallId, toolName: name, toolVersion: '1', effect: 'READ', rawArguments: raw, requestedAt: at() })).toolCallId;
        return ok(undefined); },
      rejectRequest: () => fail(appError('tool_execution_failed', 'tool', 'Unexpected fixture rejection.')),
      recordDelivery: () => ok(undefined), execute: async () => ({ result: { status: 'succeeded', data: { value: 7 } }, fatal: false }) };
    if (originInput) need(store.sessionInputs.dispatch(originInput.inputId, at()));
    const outcome = await prepared.execute({ runId, sessionId: session.sessionId, goal: 'Legacy', text: 'old question',
      ...(originInput ? { inputId: originInput.inputId, promptText: originInput.content.version === 2 ? originInput.content.promptText : '',
        contextSnapshotId: originInput.contextSnapshotId!, verifyInputUse: () => ok(undefined),
        completeInputResult: (ids, entry) => store.sessionInputs.completeResult(runId, ids, entry, at()), contextHooks: {
          resolveToolResult: store.context.resolveToolResult,
          bind: value => { const saved = store.context.bindRequest(value); if (saved.ok) generating ??= value.binding; return saved; },
          record: store.context.recordRequest,
        } } : {}), messageTimestamp: 1, toolBinding: binding, verifyModelUse: () => ok(undefined) }, new AbortController().signal, () => {});
    if (outcome.error) throw new Error(outcome.error.code);
    need(store.runs.finish(runId, { status: 'completed', output: { version: 2, text: outcome.text, partial: outcome.partial,
      stopReason: outcome.stopReason, responseId: outcome.responseId, responseModel: outcome.responseModel, agent: outcome.agent },
      error: null, usage: outcome.usage, tokens: outcome.tokens,
      cleanup: { version: 1, stopped: true, stopReason: 'stop', errors: [], lateObservationRequired: false },
      endedAt: at(), stoppedAt: at(), durationMs: null }));
  }
  const runtime = new RuntimeService({ memory: store.memory, runs: store.runs, sessions: store.sessions, sessionInputs: store.sessionInputs, agent: adapter,
    contextService, ...(withRepository ? { contextRepository: store.context } : {}),
    provider: { async prepare() { throw new Error('No direct Provider.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: at, monotonicNow: () => performance.now() });
  deferCleanup(() => runtime.close());
  const sessions = new SessionService(store.sessions, adapter, () => runtime.state(), at, store.runs, store.memory, store.sessionInputs,
    (request, submission, control) => runtime.start(request, control, submission), request => runtime.appendInput(request));
  const start = async (clientSequence: number) => {
    // This manual Runtime fixture owns its restoration boundary; full Application recovery remains T05.
    if (adapter.inspect(native.nativeSessionId).availability === 'missing') {
      const bundle = need(store.sessions.loadHistoryForContext(session.sessionId));
      if (!bundle.history || !bundle.commit) throw new Error('Actual SQL receipt required.');
      need(adapter.restoreSession(native.nativeSessionId, bundle.history, bundle.seed, bundle.commit));
      need(adapter.watchSession(native.nativeSessionId, bundle.commit, bundle.seed, write => store.memory.commit({ sessionId: session.sessionId,
        expected: write.expected, header: write.history.header, appendEntries: write.history.entries, leafId: write.history.leafId,
        unusable: write.history.unusable, contexts: write.contexts })));
    }
    let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
    const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
    const accepted = need(await sessions.submitInput({ sessionId: session.sessionId, clientSequence, mode: 'prompt', text: 'same text',
      config, timeoutMs: preledgerUsers ? 12000 : 5000, stopGraceMs: 500 }, { onEvent(event) { if (event.type === 'run_finished') finish(event); } }));
    return { accepted, terminal };
  };
  const journal = (runId: number) => ContextObservationsSchema.parse(JSON.parse(store.db.query<{ context_observations_json: string }, [number]>
    ('SELECT context_observations_json FROM runs WHERE id=?').get(runId)!.context_observations_json));
  return { store, adapter, session, config, start, journal, calls: () => calls, legacyRunId, originalCallId };
}

describe('T06 actual payload and transport evidence', () => {
  it.each(['openai-completions', 'openai-responses'] as const)('records final %s replacement and real wire response', async api => {
    let replacements = 0;
    const f = await evidenceFixture({ api, replacement: payload => { replacements++; return { ...(payload as object), temperature: 0 }; } });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const request = f.journal(run.accepted.runId).requests[0]!;
    expect(request.sdkPayload).toMatchObject({ inclusion: 'confirmed', reason: null, observedAt: expect.any(String) });
    expect(request.attempts).toHaveLength(1);
    expect(request.attempts[0]).toMatchObject({ attempt: 1, enteredAt: expect.any(String), responseAt: expect.any(String),
      responseStatus: 200, nativeRequestId: 'response-success', wireInclusion: 'confirmed', wireReason: null });
    expect(f.payloads).toHaveLength(1); expect(f.payloads[0]).toMatchObject({ temperature: 0 }); expect(replacements).toBe(1);
    expect(JSON.stringify(f.payloads[0])).toContain('Text with  lone and 😀 paired');
  });
  it.each(['sdk-payload', 'attempt-prepared'] as const)('stops HTTP at necessary %s rejection', async kind => {
    const f = await evidenceFixture({ reject: update => update.kind === kind });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'storage_write_failed' } } });
    expect(f.payloads).toHaveLength(0); expect(f.journal(run.accepted.runId).requests[0]!.attempts).toEqual([]);
  });
  it('rejects a replacement that removes necessary user content before HTTP', async () => {
    const f = await evidenceFixture({ replacement: payload => ({ ...(payload as object), messages: [] }) });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'context_payload_mismatch' } } });
    expect(f.payloads).toHaveLength(0);
  });
  it.each(['openai-completions', 'openai-responses'] as const)('retains original %s request across SDK retry', async api => {
    let payloadCallbacks = 0, responseCallbacks = 0;
    const f = await evidenceFixture({ api, retries: 1, onResponse: () => { responseCallbacks++; }, replacement: payload => { payloadCallbacks++; return payload; }, response: ordinal =>
      ordinal === 1 ? new Response(JSON.stringify({ error: { message: 'controlled retry' } }), { status: 503,
        headers: { 'content-type': 'application/json', 'retry-after-ms': '1', 'x-request-id': 'failed-attempt' } })
      : api === 'openai-responses' ? responsesReply() : new Response(reply().body, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'response-success' } }) });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const request = f.journal(run.accepted.runId).requests[0]!;
    expect(request.attempts.map(item => ({ attempt: item.attempt, status: item.responseStatus, id: item.nativeRequestId })))
      .toEqual([{ attempt: 1, status: 503, id: null }, { attempt: 2, status: 200, id: 'response-success' }]);
    expect(f.payloads).toHaveLength(2); expect(f.payloads[1]).toEqual(f.payloads[0]); expect(payloadCallbacks).toBe(1);
    expect(f.journal(run.accepted.runId).requests).toHaveLength(1); expect(responseCallbacks).toBe(1);
  });
  it.each(['attempt-entered', 'response', 'id'] as const)('preserves actual dispatched facts when %s write fails', async kind => {
    const f = await evidenceFixture({ ignoreAbort: true, reject: update => kind === 'id'
      ? update.kind === 'response' && update.nativeRequestId !== null : update.kind === kind });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'storage_write_failed' } } });
    expect(f.payloads).toHaveLength(1);
    const attempt = f.journal(run.accepted.runId).requests[0]!.attempts[0]!;
    expect(attempt.preparedAt).toBeString(); expect(attempt.nativeRequestId).toBeNull();
    expect(attempt.enteredAt === null).toBe(kind === 'attempt-entered');
    expect(attempt.responseAt === null).toBe(kind === 'response');
    expect(attempt.transportErrorCode).toBeNull();
  });
  it.each(['request', 'opaque', 'remove-user'] as const)('observes the actual %s wire shape independently of SDK payload', async wire => {
    const f = await evidenceFixture({ wire }); const run = await f.start(); const end = await run.terminal;
    expect(end.result).toMatchObject(wire === 'remove-user' ? { ok: true, data: { status: 'failed', error: { code: 'context_payload_mismatch' } } }
      : { ok: true, data: { status: 'completed' } });
    const request = f.journal(run.accepted.runId).requests[0]!;
    expect(request.sdkPayload?.inclusion).toBe('confirmed');
    expect(f.payloads).toHaveLength(wire === 'remove-user' ? 0 : 1);
    if (wire !== 'remove-user') expect(request.attempts[0]).toMatchObject(wire === 'opaque'
      ? { wireInclusion: 'unavailable', wireReason: 'body_unavailable' } : { wireInclusion: 'confirmed', wireReason: null });
  });
  it.each(['same', 'null-then-id', 'status', 'identity', 'missing-slot'] as const)('checks the SDK success slot at the controlled %s callback boundary', async sdkCallback => {
    const f = await evidenceFixture({ sdkCallback }); const run = await f.start(); const end = await run.terminal;
    expect(end.result).toMatchObject(sdkCallback === 'same' ? { ok: true, data: { status: 'completed' } }
      : { ok: true, data: { status: 'failed', error: { code: sdkCallback === 'missing-slot' ? 'context_binding_unknown' : 'context_binding_conflict' } } });
    expect(f.payloads).toHaveLength(1);
    const request = f.journal(run.accepted.runId).requests[0]!;
    if (sdkCallback === 'missing-slot') expect(request.attempts).toEqual([]);
    else {
      expect(request.attempts[0]?.responseStatus).toBe(200);
      expect(request.attempts[0]?.nativeRequestId).toBe(sdkCallback === 'same' ? 'response-success' : null);
      expect(request.attempts[0]?.transportErrorCode).toBeNull();
    }
  });
  it('captures SDK response values before an existing callback mutates its plain headers', async () => {
    const f = await evidenceFixture({ onResponse: response => { response.status = 409; response.headers['x-request-id'] = 'mutated'; } });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.journal(run.accepted.runId).requests[0]!.attempts[0]).toMatchObject({ responseStatus: 200, nativeRequestId: 'response-success' });
  });
  it.each([null, 'x'.repeat(257)] as const)('keeps an absent or invalid SDK ID as a normal NULL observation: %s', async id => {
    const f = await evidenceFixture({ response: () => new Response(reply().body, { headers: { 'content-type': 'text/event-stream',
      ...(id === null ? {} : { 'x-request-id': id }) } }) });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.journal(run.accepted.runId).requests[0]!.attempts[0]).toMatchObject({ responseStatus: 200, nativeRequestId: null });
  });
  it('records a safe network throw and prevents a second actual dispatch despite configured retry', async () => {
    const f = await evidenceFixture({ networkThrow: true, retries: 1 });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'provider_transport_error' } } });
    const request = f.journal(run.accepted.runId).requests[0]!;
    expect(request.attempts).toHaveLength(1);
    expect(request.attempts[0]).toMatchObject({ responseAt: null, transportErrorCode: 'provider_transport_error' });
    expect(JSON.stringify(request)).not.toContain('PRIVATE_TOKEN_BODY'); expect(f.payloads).toHaveLength(0);
  });
  it('records actual baseFetch invocation when it synchronously throws without claiming server receipt', async () => {
    const f = await evidenceFixture({ syncThrow: true, retries: 1 }); const run = await f.start();
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'provider_transport_error' } } });
    expect(f.baseCalls()).toBe(1); expect(f.payloads).toHaveLength(0);
    expect(f.journal(run.accepted.runId).requests[0]!.attempts).toEqual([expect.objectContaining({ attempt: 1,
      enteredAt: expect.any(String), responseAt: null, transportErrorCode: 'provider_transport_error' })]);
  });
  it.each(['pi-messages', 'google-generative-ai'] as const)('preserves unsupported %s evidence without invented ID or fetch attempt', async api => {
    const f = await evidenceFixture({ api, nativeUnavailable: true }); const run = await f.start();
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const request = f.journal(run.accepted.runId).requests[0]!;
    expect(request.sdkPayload).toMatchObject({ inclusion: 'unavailable', reason: 'payload_codec_unavailable' });
    expect(f.payloads).toHaveLength(1);
    if (api === 'google-generative-ai') { expect(request.transport).toBe('not-observable'); expect(request.attempts).toEqual([]); }
    else expect(request.attempts).toEqual([expect.objectContaining({ responseStatus: 200, nativeRequestId: null,
      wireInclusion: 'unavailable', wireReason: 'payload_codec_unavailable' })]);
  });
  it.each(['openai-completions', 'openai-responses'] as const)('keeps the original %s retry binding after a newer queued Input', async api => {
    const entered = barrier(), release = barrier(); deferCleanup(() => release.release());
    const f = await evidenceFixture({ api, retries: 1, response: async ordinal => {
      if (ordinal === 1) { entered.release(); await release.ready; return new Response(JSON.stringify({ error: { message: 'retry' } }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } }); }
      const response = api === 'openai-responses' ? responsesReply() : reply(); response.headers.set('x-request-id', `success-${ordinal}`); return response;
    } });
    const run = await f.start('First original'); await entered.ready;
    const next = need(await f.sessions.submitInput({ sessionId: f.session.sessionId, runId: run.accepted.runId,
      clientSequence: 2, mode: 'followUp', text: 'Newer queued' }));
    const pointer = need(f.store.runs.get(run.accepted.runId)).currentContextSnapshotId;
    release.release(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const requests = f.journal(run.accepted.runId).requests;
    expect(requests[0]!.binding.inputId).toBe(run.accepted.inputId);
    expect(requests[0]!.binding.snapshotId).not.toBe(pointer); expect(requests[0]!.attempts).toHaveLength(2);
    expect(f.payloads[1]).toEqual(f.payloads[0]); expect(requests[1]!.binding.inputId).toBe(next.inputId);
    expect(requests[0]!.attempts[0]!.nativeRequestId).toBeNull(); expect(requests[0]!.attempts[1]!.nativeRequestId).toBe('success-2');
  });
  it.each(['cancel', 'revoke', 'deadline'] as const)('blocks a second retry attempt after actual first response and %s', async cause => {
    let f!: Awaited<ReturnType<typeof evidenceFixture>>;
    f = await evidenceFixture({ retries: 1, ...(cause === 'deadline' ? { timeoutMs: 200 } : {}), response: () =>
      new Response(JSON.stringify({ error: { message: 'retry after qualification change' } }), { status: 503,
        headers: { 'content-type': 'application/json', 'retry-after-ms': '400' } }),
      afterRecord: update => {
        if (update.kind !== 'response' || update.status !== 503) return;
        if (cause === 'cancel') need(f.runtime.cancel(f.runtime.state().active!.runId));
        if (cause === 'revoke') f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
          .run(JSON.stringify({ documentIds: [1], at: new Date().toISOString(), reason: 'document_use_revoked' }), f.session.sessionId);
      } });
    const run = await f.start(); const end = await run.terminal;
    expect(end.result).toMatchObject({ ok: true, data: { status: cause === 'cancel' ? 'cancelled' : 'failed' } });
    expect(f.payloads).toHaveLength(1); expect(f.journal(run.accepted.runId).requests[0]!.attempts)
      .toEqual([expect.objectContaining({ attempt: 1, responseStatus: 503, nativeRequestId: null, transportErrorCode: null })]);
  });
  it('handles the launched rejection after an entered write failure without inventing a transport failure', async () => {
    const f = await evidenceFixture({ networkThrow: true, retries: 1, reject: update => update.kind === 'attempt-entered' });
    const run = await f.start(); expect((await run.terminal).result).toMatchObject({ ok: true,
      data: { status: 'failed', error: { code: 'storage_write_failed' } } });
    expect(f.baseCalls()).toBe(1); expect(f.payloads).toHaveLength(0);
    expect(f.journal(run.accepted.runId).requests[0]!.attempts).toEqual([expect.objectContaining({ enteredAt: null,
      responseAt: null, transportErrorCode: null })]);
  });
  it.each(['cancel', 'revoke'] as const)('rechecks qualification after an asynchronous payload callback and %s before HTTP', async cause => {
    const entered = barrier(), release = barrier(); deferCleanup(() => release.release());
    const f = await evidenceFixture({ replacement: async payload => { entered.release(); await release.ready; return payload; } });
    const run = await f.start(); await entered.ready;
    if (cause === 'cancel') need(f.runtime.cancel(run.accepted.runId));
    else f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
      .run(JSON.stringify({ documentIds: [1], at: new Date().toISOString(), reason: 'document_use_revoked' }), f.session.sessionId);
    release.release(); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: cause === 'cancel' ? 'cancelled' : 'failed' } });
    expect(f.payloads).toHaveLength(0); expect(f.journal(run.accepted.runId).requests[0]!.attempts).toEqual([]);
  });
  it('supplements only the original request after cancellation has finished with an unconfirmed worker stop', async () => {
    const entered = barrier(), release = barrier(); deferCleanup(() => release.release());
    const f = await evidenceFixture({ ignoreAbort: true, response: async () => { entered.release(); await release.ready;
      const response = reply(); response.headers.set('x-request-id', 'late-original'); return response; } });
    const run = await f.start('Original late request'); await entered.ready;
    need(f.runtime.cancel(run.accepted.runId));
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', stopped: false,
      error: { code: 'agent_cancelled' }, cleanupErrors: [expect.objectContaining({ code: 'stop_unconfirmed' })] } });
    expect(f.journal(run.accepted.runId).requests[0]!.attempts[0]!.responseAt).toBeNull();
    release.release(); await waitFor(async () => f.journal(run.accepted.runId).requests[0]!.attempts[0]!.responseStatus === 200);
    const request = f.journal(run.accepted.runId).requests[0]!;
    expect(request.binding.inputId).toBe(run.accepted.inputId); expect(request.attempts).toHaveLength(1);
    expect(request.attempts[0]!.transportErrorCode).toBeNull(); expect(f.payloads).toHaveLength(1);
    expect(need(f.store.runs.get(run.accepted.runId)).status).toBe('failed'); expect(f.runtime.state().active).toBeNull();
  });
});

describe('T06 public SDK codec conversion', () => {
  it.each(['openai-completions', 'openai-responses'] as const)('preserves actual %s message and text block boundaries', async api => {
    const f = await evidenceFixture({ api });
    const context: Context = { messages: [{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'a\ud800' }, { type: 'text', text: 'b😀' }] },
      { role: 'user', timestamp: 2, content: 'second' }] };
    const codec = need(preparePayloadCodec(api, context, true)); let payload: unknown;
    const options = { apiKey: 'synthetic-codec-key', maxRetries: 0, fetch: globalThis.fetch,
      onPayload: (outgoing: unknown) => { payload = outgoing; expect(need(checkPayload(codec, outgoing)).inclusion).toBe('confirmed'); } };
    const stream = api === 'openai-completions' ? completionsStream({ ...f.sdk.model!, api }, context, options)
      : responsesStream({ ...f.sdk.model!, api }, context, options);
    await stream.result(); expect(f.payloads).toHaveLength(1); expect(payload).toEqual(f.payloads[0]);
    const body = payload as { messages?: Array<{ role: string; content: unknown }>; input?: Array<{ role: string; content: unknown }> };
    const rows = (body.messages ?? body.input)!;
    const changed = { ...body, [api === 'openai-completions' ? 'messages' : 'input']: rows.map(row => row.role === 'user'
      ? { ...row, content: api === 'openai-completions' ? 'ab😀second' : [{ type: 'input_text', text: 'ab😀second' }] } : row) };
    expect(checkPayload(codec, changed)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
  });
  it('checks actual SDK grouped tool images, ordered temporary URLs and synthetic caption without creating an Input', async () => {
    const f = await evidenceFixture();
    const assistant: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: 'evidence-fixture', model: 'fixture',
      content: [{ type: 'toolCall', id: 'read-a', name: 'read', arguments: { path: '/a.png' } },
        { type: 'toolCall', id: 'read-b', name: 'read', arguments: { path: '/b.png' } }], stopReason: 'toolUse', timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const context: Context = { messages: [{ role: 'user', content: 'Read images', timestamp: 1 }, assistant,
      { role: 'toolResult', toolCallId: 'read-a', toolName: 'read', isError: false, timestamp: 3,
        content: [{ type: 'text', text: 'first image' }, { type: 'image', mimeType: 'image/png', data: 'FIRST' }] },
      { role: 'toolResult', toolCallId: 'read-b', toolName: 'read', isError: false, timestamp: 4,
        content: [{ type: 'text', text: 'second image' }, { type: 'image', mimeType: 'image/png', data: 'SECOND' }] }] };
    const codec = need(preparePayloadCodec('openai-completions', context, true)); let payload: unknown;
    const stream = completionsStream({ ...f.sdk.model!, api: 'openai-completions', input: ['text', 'image'] }, context, { apiKey: 'synthetic-codec-key', maxRetries: 0,
      fetch: globalThis.fetch, onPayload: outgoing => { payload = outgoing; expect(need(checkPayload(codec, outgoing)).inclusion).toBe('confirmed'); } });
    const result = await stream.result(); expect(result.stopReason).toBe('stop'); expect(f.payloads).toHaveLength(1);
    const body = payload as { messages: Array<{ role: string; content: unknown }> };
    const synthetic = body.messages.filter(row => row.role === 'user').at(-1)!;
    expect(synthetic.content).toEqual([{ type: 'text', text: 'Attached image(s) from tool result:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,FIRST' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,SECOND' } }]);
    expect(need(await checkWire(codec, 'http://fixture.invalid', { body: JSON.stringify(body) })).inclusion).toBe('confirmed');
    const malformed = { ...body, messages: [...body.messages, synthetic] };
    expect(checkPayload(codec, malformed)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
    const reordered = structuredClone(body); const last = reordered.messages.at(-1)!;
    const blocks = last.content as unknown[]; [blocks[1], blocks[2]] = [blocks[2], blocks[1]];
    expect(checkPayload(codec, reordered)).toMatchObject({ ok: false, error: { code: 'context_payload_mismatch' } });
    expect(f.store.db.query('SELECT count(*) AS count FROM session_inputs').get()).toEqual({ count: 0 });
  });
});

describe('P8 actual Pi request context', () => {
  it.each(['error-terminal', 'error-result', 'aborted-result', 'binding-lost'] as const)('refuses P8 tool execution with %s despite actual SDK HTTP', async fault => {
    const raw = { operation: 'sum', values: ['0.1', '0.2'], scale: 2 };
    const response = () => new Response('data: ' + JSON.stringify({ id: 'untrusted-terminal', choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'untrusted-call', type: 'function',
        function: { name: 'calculate_invoice_amounts', arguments: JSON.stringify(raw) } }] }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ id: 'untrusted-terminal', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const f = await fixture(response, undefined, fault), workspace = need(await f.app.readWorkspace());
    const accepted = await begin(f.app, { ...f.prompt(1), workspace: { revision: workspace.revision, sessionId: f.session.sessionId,
      documentRef: null, jobId: null, candidateRef: null } });
    expect((await accepted.terminal).result).toMatchObject({ ok: true, data: { status: 'failed',
      ...(fault === 'binding-lost' ? { error: { code: 'context_binding_unknown' } } : {}) } });
    expect(f.executions()).toBe(0); expect(f.payloads).toHaveLength(1);
    expect(need(await f.app.listRunToolCalls({ runId: accepted.accepted.runId, sessionId: f.session.sessionId })).items).toEqual([]);
    expect(need(await f.app.queryRun(accepted.accepted.runId))).toMatchObject({ status: 'failed', toolCallCount: 0 });
    need(await f.app.close());
    expect(f.journal(accepted.accepted.runId).requests[0]!.attempts[0]).toMatchObject({ responseStatus: 200 });
    const db = new Database(f.paths.databaseFile, { readonly: true });
    try {
      expect(db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 });
      expect(db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM runtime_events WHERE type LIKE 'tool_%'").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });
  it('keeps valid toolUse and stop result fallbacks bound through real SDK HTTP', async () => {
    const raw = { operation: 'sum', values: ['0.1', '0.2'], scale: 2 };
    const f = await fixture(ordinal => ordinal === 1 ? new Response('data: ' + JSON.stringify({ id: 'valid-result', choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'fallback-call', type: 'function',
        function: { name: 'calculate_invoice_amounts', arguments: JSON.stringify(raw) } }] }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ id: 'valid-result', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : reply(), undefined, 'tool-result');
    const workspace = need(await f.app.readWorkspace());
    const accepted = await begin(f.app, { ...f.prompt(1), workspace: { revision: workspace.revision, sessionId: f.session.sessionId,
      documentRef: null, jobId: null, candidateRef: null } });
    expect((await accepted.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.executions()).toBe(1); expect(f.payloads).toHaveLength(2);
    const input = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: accepted.accepted.inputId })).input!;
    const tools = need(await f.app.listRunToolCalls({ runId: accepted.accepted.runId, sessionId: f.session.sessionId })).items;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ status: 'succeeded', deliveryState: 'request_observed' });
    expect(f.payloads[1]).toMatchObject({ messages: expect.arrayContaining([
      { role: 'tool', tool_call_id: 'fallback-call', content: expect.any(String) }]) });
    need(await f.app.close());
    const journal = f.journal(accepted.accepted.runId);
    expect(journal.requests[1]!.binding.includedToolResults).toEqual([{ nativeToolCallId: 'fallback-call', toolCallId: tools[0]!.toolCallId,
      originRunId: accepted.accepted.runId, context: { snapshotId: input.contextSnapshotId!, requestSequence: 1 } }]);
    expect(journal.requests.map(request => request.attempts[0]?.responseStatus)).toEqual([200, 200]);
  });
  it('keeps the generating tool request after newer input admission and returns the original call after completion', async () => {
    const entered = barrier(), release = barrier();
    const raw = { operation: 'sum', values: ['0.1', '0.2'], scale: 2 };
    const f = await fixture(ordinal => ordinal === 1 ? new Response('data: ' + JSON.stringify({ id: 'p8-tool', choices: [{ index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'original-call', type: 'function',
        function: { name: 'calculate_invoice_amounts', arguments: JSON.stringify(raw) } }] }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ id: 'p8-tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) : reply(),
      async () => { entered.release(); await release.ready; });
    deferCleanup(() => release.release());
    const workspace = need(await f.app.readWorkspace());
    const first = await begin(f.app, { ...f.prompt(1), workspace: { revision: workspace.revision, sessionId: f.session.sessionId,
      documentRef: null, jobId: null, candidateRef: null } });
    const result = await Promise.race([entered.ready.then(() => null), first.terminal]);
    expect(result).toBeNull();
    const a = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: first.accepted.inputId })).input!;
    const tools = need(await f.app.listRunToolCalls({ runId: first.accepted.runId, sessionId: f.session.sessionId })).items;
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.status).toBe('requested');
    const b = need(await f.app.submitInput({ sessionId: f.session.sessionId, runId: first.accepted.runId,
      clientSequence: 2, mode: 'steer', text: 'Use the saved calculation.', workspace: {
        revision: workspace.revision, sessionId: f.session.sessionId, documentRef: null, jobId: null, candidateRef: null } }));
    const inputB = need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: b.inputId })).input!;
    expect(inputB).toMatchObject({ status: 'queued', nativeEntryId: null });
    expect(need(await f.app.queryRun(first.accepted.runId)).currentContextSnapshotId).toBe(inputB.contextSnapshotId);
    expect(inputB.contextSnapshotId).not.toBe(a.contextSnapshotId);
    release.release(); expect((await first.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(f.executions()).toBe(1);
    need(await f.app.close());
    const requests = f.journal(first.accepted.runId).requests;
    expect(requests.map(item => item.binding.inputId)).toEqual([first.accepted.inputId, b.inputId]);
    expect(requests[1]!.binding.includedToolResults).toEqual([{ nativeToolCallId: 'original-call', toolCallId: tool.toolCallId,
      originRunId: first.accepted.runId, context: { snapshotId: a.contextSnapshotId!, requestSequence: 1 } }]);
    expect(f.payloads).toHaveLength(2);
    expect(f.payloads[1]).toMatchObject({ messages: expect.arrayContaining([{ role: 'tool', tool_call_id: 'original-call', content: expect.any(String) }]) });
    const store = need(openTestDatabase(f.paths));
    const original = need(store.toolCalls.getById(tool.toolCallId));
    expect(original.context).toEqual({ snapshotId: a.contextSnapshotId!, requestSequence: 1 });
    expect(original).toMatchObject({ status: 'succeeded', args: { raw, final: raw }, delivery: { state: 'request_observed', includedInCallSequence: 2 } });
    const before = store.db.query('SELECT * FROM tool_calls WHERE id=?').get(tool.toolCallId);
    const input = { runId: first.accepted.runId, sessionId: f.session.sessionId, nativeToolCallId: 'original-call',
      toolName: 'calculate_invoice_amounts', toolVersion: '1', effect: 'PURE' as const, rawArguments: raw,
      context: original.context, requestedAt: new Date().toISOString() };
    // A late repository notification after request2 is not SDK concurrent tool delivery.
    expect(store.toolCalls.request(input)).toEqual(ok(original));
    expect(store.toolCalls.request({ ...input, context: { snapshotId: inputB.contextSnapshotId!, requestSequence: 2 } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.toolCalls.request({ ...input, rawArguments: { ...raw, scale: 3 } }))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(store.toolCalls.request({ ...input, nativeToolCallId: 'unbound-call', context: null }))
      .toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
    expect(store.toolCalls.request({ ...input, nativeToolCallId: 'missing-journal-call',
      context: { snapshotId: a.contextSnapshotId!, requestSequence: 3 } }))
      .toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
    expect(store.db.query('SELECT COUNT(*) AS count FROM tool_calls WHERE run_id=?').get(first.accepted.runId)).toEqual({ count: 1 });
    expect(store.db.query('SELECT * FROM tool_calls WHERE id=?').get(tool.toolCallId)).toEqual(before);
    expect(need(store.runs.get(first.accepted.runId))).toMatchObject({ status: 'completed', toolCallCount: 1 });
    expect(f.executions()).toBe(1);
  });
  it('binds saved prompt steer followUp users and retains completed input provenance', async () => {
    const entered = barrier(), release = barrier(); deferCleanup(() => release.release());
    const f = await fixture(async ordinal => { if (ordinal === 1) { entered.release(); await release.ready; } return reply(); });
    const first = await begin(f.app, f.prompt(1));
    const entry = await Promise.race([entered.ready.then(() => null), first.terminal]);
    if (entry) throw new Error(JSON.stringify(entry.result));
    const follow = need(await f.app.submitInput({ sessionId: f.session.sessionId, runId: first.accepted.runId,
      clientSequence: 2, mode: 'followUp', text: 'same text' }));
    const steer = need(await f.app.submitInput({ sessionId: f.session.sessionId, runId: first.accepted.runId,
      clientSequence: 3, mode: 'steer', text: 'same text' }));
    expect(need(await f.app.querySessionInput({ sessionId: f.session.sessionId, inputId: follow.inputId })).input)
      .toMatchObject({ nativeEntryId: null });
    release.release(); expect((await first.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const inputs = need(await f.app.listSessionInputs({ sessionId: f.session.sessionId })).items;
    const next = await begin(f.app, f.prompt(4)); expect((await next.terminal).result.ok).toBe(true);
    need(await f.app.close());
    const requests = f.journal(first.accepted.runId).requests;
    expect(requests.map(item => item.binding.includedBindings.map(source => source.inputId)))
      .toEqual([[first.accepted.inputId], [first.accepted.inputId, steer.inputId], [first.accepted.inputId, steer.inputId, follow.inputId]]);
    for (const [index, current] of [first.accepted, steer, follow].entries()) {
      const input = inputs.find(item => item.inputId === current.inputId)!;
      if (input.nativeEntryId === null) throw new Error('Saved native entry is required.');
      expect(requests[index]!.binding).toMatchObject({ requestSequence: index + 1, callSequence: index + 1,
        inputId: current.inputId, snapshotId: input.contextSnapshotId, includedToolResults: [] });
      expect(requests[index]!.binding.includedBindings.at(-1)).toEqual({ originRunId: first.accepted.runId,
        inputId: current.inputId, nativeEntryId: input.nativeEntryId, snapshotId: input.contextSnapshotId });
      expect(requests[index]!.sdkPayload).toMatchObject({ inclusion: 'confirmed', reason: null });
      expect(requests[index]!.attempts).toEqual([expect.objectContaining({ attempt: 1, enteredAt: expect.any(String),
        responseAt: expect.any(String), responseStatus: 200, nativeRequestId: null, wireInclusion: 'confirmed', wireReason: null })]);
    }
    expect(new Set(inputs.map(item => item.nativeEntryId)).size).toBe(3);
    expect(f.journal(next.accepted.runId).requests[0]!.binding.includedBindings.map(source => source.inputId))
      .toEqual([first.accepted.inputId, steer.inputId, follow.inputId, next.accepted.inputId]);
  });

  it('reseeds a ready branch and a recreated Session from exact same-text entry IDs without replay', async () => {
    const f = await fixture();
    const first = await begin(f.app, f.prompt(1)); expect((await first.terminal).result.ok).toBe(true);
    const second = await begin(f.app, f.prompt(2)); expect((await second.terminal).result.ok).toBe(true);
    const history = need(f.adapter.exportSession(f.session.nativeSessionId));
    const target = history.entries.find(entry => entry.type === 'message' && typeof entry.message === 'object'
      && entry.message !== null && 'role' in entry.message && entry.message.role === 'assistant')!.id;
    const committed = need(await f.app.querySessionHistory({ sessionId: f.session.sessionId }));
    expect(committed.session.sessionId).toBe(f.session.sessionId);
    expect(committed.commit).toMatchObject({ leafId: history.leafId, entryCount: history.entries.length });
    need(await f.app.branchSession({ sessionId: f.session.sessionId, expectedLeafId: history.leafId,
      expectedEntryCount: history.entries.length, expectedCommitRevision: committed.commit.commitRevision, targetEntryId: target }));
    expect(f.payloads).toHaveLength(2);
    const third = await begin(f.app, f.prompt(3)); expect((await third.terminal).result.ok).toBe(true);
    expect((await f.adapter.releaseSession(f.session.nativeSessionId)).closed).toBe(true);
    const fourth = await begin(f.app, f.prompt(4)); expect((await fourth.terminal).result.ok).toBe(true);
    need(await f.app.close());
    expect(f.journal(third.accepted.runId).requests[0]!.binding.includedBindings.map(source => source.inputId))
      .toEqual([first.accepted.inputId, third.accepted.inputId]);
    expect(f.journal(fourth.accepted.runId).requests[0]!.binding.includedBindings.map(source => source.inputId))
      .toEqual([first.accepted.inputId, third.accepted.inputId, fourth.accepted.inputId]);
    expect(f.payloads).toHaveLength(4);
  });

  it('stops a marked Run without the real repository before SDK preparation or HTTP', async () => {
    const f = await storedFixture(false); const run = await f.start(1);
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'context_binding_unknown' } } });
    expect(f.calls()).toBe(0); expect(f.journal(run.accepted.runId).requests).toEqual([]);
    expect(need(f.store.sessionInputs.get(run.accepted.inputId))).toMatchObject({ nativeEntryId: null });
  });

  it('does not dispatch when the necessary bind write fails after a user was saved', async () => {
    const f = await storedFixture();
    f.store.db.exec("CREATE TRIGGER reject_context_bind BEFORE UPDATE OF context_observations_json ON runs BEGIN SELECT RAISE(ABORT,'bind rejected'); END");
    const run = await f.start(1);
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'storage_write_failed' } } });
    expect(f.calls()).toBe(0); expect(f.journal(run.accepted.runId).requests).toEqual([]);
    expect(need(f.store.sessionInputs.get(run.accepted.inputId))).toMatchObject({ status: 'consumed', nativeEntryId: expect.any(String) });
  });

  it('rejects missing, wrong and conflicting saved seeds without making a model request', async () => {
    const f = await storedFixture(); const run = await f.start(1); expect((await run.terminal).result.ok).toBe(true);
    const bundle = need(f.store.sessions.loadHistoryForContext(f.session.sessionId)); if (!bundle.history) throw new Error('Saved history required.');
    expect((await f.adapter.releaseSession(f.session.nativeSessionId)).closed).toBe(true);
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, { ...bundle.seed, inputs: [] }, bundle.commit!)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(f.adapter.inspect(f.session.nativeSessionId).availability).toBe('missing');
    const source = bundle.seed.inputs[0]!;
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, { ...bundle.seed, inputs: [{ ...source, nativeEntryId: 'missing-entry' }] }, bundle.commit!))
      .toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, { ...bundle.seed, inputs: [source, { ...source, snapshotId: source.snapshotId! + 100 }] }, bundle.commit!))
      .toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    need(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, bundle.seed, bundle.commit!));
    expect(f.adapter.restoreSessionLeaf(f.session.nativeSessionId, bundle.history, { ...bundle.seed, inputs: [{ ...source, snapshotId: source.snapshotId! + 100 }] }, bundle.commit!))
      .toMatchObject({ ok: false, error: { code: 'context_binding_conflict' } });
    expect(f.calls()).toBe(1);
  });

  it('resolves a real prior Run tool result after recreate while preserving its legacy original call', async () => {
    const f = await storedFixture(true, 'legacy'); expect(f.calls()).toBe(2);
    expect((await f.adapter.releaseSession(f.session.nativeSessionId)).closed).toBe(true);
    const run = await f.start(1); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const binding = f.journal(run.accepted.runId).requests[0]!.binding;
    expect(binding.includedToolResults).toEqual([{ nativeToolCallId: 'legacy-call', toolCallId: f.originalCallId,
      originRunId: f.legacyRunId, context: null }]);
    expect(binding.includedBindings).toHaveLength(2);
    expect(binding.includedBindings[0]).toMatchObject({ originRunId: f.legacyRunId, inputId: null, snapshotId: null });
    expect(binding.inputId).toBe(run.accepted.inputId); expect(f.calls()).toBe(3);
  });

  it('keeps the original P8 tool context after a new main snapshot and recreate', async () => {
    const f = await storedFixture(true, 'p8'); expect(f.calls()).toBe(2);
    const original = f.journal(f.legacyRunId!).requests[0]!.binding;
    expect((await f.adapter.releaseSession(f.session.nativeSessionId)).closed).toBe(true);
    const run = await f.start(2); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    const actual = f.journal(run.accepted.runId).requests[0]!.binding;
    expect(actual.snapshotId).not.toBe(original.snapshotId);
    expect(actual.includedToolResults).toEqual([{ nativeToolCallId: 'legacy-call',
      toolCallId: f.originalCallId, originRunId: f.legacyRunId, context: { snapshotId: original.snapshotId, requestSequence: 1 } }]);
    expect(f.calls()).toBe(3);
  });

  it.each([509, 510])('checks the combined 512 budget with %s pre-ledger users and an original tool result', async count => {
    const f = await storedFixture(true, 'legacy', 0, count); expect(f.calls()).toBe(2);
    const run = await f.start(1);
    if (count === 510) {
      expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'context_evidence_too_large' } } });
      expect(f.calls()).toBe(2); expect(f.journal(run.accepted.runId).requests).toEqual([]);
    } else {
      expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
      const binding = f.journal(run.accepted.runId).requests[0]!.binding;
      expect(binding.includedBindings).toHaveLength(511); expect(binding.includedToolResults).toHaveLength(1);
      expect(binding.includedBindings.slice(0, 509).every(source => source.inputId === null && source.originRunId === null && source.snapshotId === null)).toBe(true);
      expect(f.calls()).toBe(3);
    }
    expect(need(f.store.sessionInputs.get(run.accepted.inputId))).toMatchObject({ status: 'consumed', nativeEntryId: expect.any(String) });
  });

  it('rejects one Input claimed by distinct saved native entries', async () => {
    const f = await storedFixture();
    const first = await f.start(1); expect((await first.terminal).result.ok).toBe(true);
    const second = await f.start(2); expect((await second.terminal).result.ok).toBe(true);
    const bundle = need(f.store.sessions.loadHistoryForContext(f.session.sessionId)); if (!bundle.history) throw new Error('Saved history required.');
    expect((await f.adapter.releaseSession(f.session.nativeSessionId)).closed).toBe(true);
    const a = bundle.seed.inputs[0]!, b = bundle.seed.inputs[1]!;
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, { ...bundle.seed, inputs: [a, { ...a, nativeEntryId: b.nativeEntryId }] }, bundle.commit!))
      .toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
    expect(f.calls()).toBe(2);
  });

  it('keeps the original sequence gate for a duplicate native tool result and sends no new HTTP', async () => {
    const f = await storedFixture(true, 'legacy', 1); expect(f.calls()).toBe(2);
    const run = await f.start(1);
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'session_history_invalid' } } });
    expect(f.calls()).toBe(2); expect(f.journal(run.accepted.runId).requests).toEqual([]);
  });
});

for (const boundary of ['payload', 'retry'] as const) for (const cause of ['blocked', 'unknown'] as const)
it(`P9 T04 ancestor-only ${cause} at actual ${boundary} boundary blocks next attempt without target cancellation`, async () => {
  const entered = barrier(), release = barrier(); deferCleanup(() => release.release());
  let f!: Awaited<ReturnType<typeof evidenceFixture>>;
  const revokeOnlyAncestor = () => {
    f.store.db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?")
      .run(JSON.stringify(cause === 'unknown' ? {} : { documentIds: [1], at: new Date().toISOString(), reason: 'document_use_revoked' }), f.sourceSessionId!);
    const target = f.store.db.query<{ status: string; metadata_json: string }, [number]>('SELECT status,metadata_json FROM sessions WHERE id=?').get(f.session.sessionId)!;
    expect(target.status).toBe('active'); expect(JSON.parse(target.metadata_json).model_use_blocked).toBeNull();
  };
  f = await evidenceFixture({ ancestor: true, retries: boundary === 'retry' ? 1 : 0,
    ...(boundary === 'payload' ? { replacement: async (payload: unknown) => { entered.release(); await release.ready; return payload; } }
      : { response: () => new Response('retry', { status: 503 }), afterRecord: (update: ContextEvidenceUpdate) => { if (update.kind === 'response' && update.status === 503) revokeOnlyAncestor(); } }) });
  expect(need(f.store.sessions.isModelUseBlocked(f.session.sessionId))).toBe(false);
  const run = await f.start();
  if (boundary === 'payload') { await entered.ready; revokeOnlyAncestor(); release.release(); }
  const terminal = await run.terminal;
  expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: cause === 'blocked' ? 'session_scope_revoked' : 'storage_read_failed' } } });
  const count = boundary === 'payload' ? 0 : 1;
  expect(f.baseCalls()).toBe(count); expect(f.payloads).toHaveLength(count);
  expect(f.updates.filter(u => u.kind === 'attempt-prepared')).toHaveLength(count);
  expect(f.updates.filter(u => u.kind === 'attempt-entered')).toHaveLength(count);
  expect(f.journal(run.accepted.runId).requests[0]!.attempts).toHaveLength(count);
});


it('P9 T04 persists late idle native facts without reopening the terminal SQL Run or inventing Input ownership', async () => {
  const f = await storedFixture();
  const run = await f.start(1); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const beforeRun = need(f.store.runs.get(run.accepted.runId)), beforeCalls = f.calls();
  const before = need(f.store.sessions.loadHistoryForContext(f.session.sessionId));
  const record = (f.adapter as any).sessions.get(f.session.nativeSessionId);
  expect(record.active).toBeUndefined();
  await record.session.sendCustomMessage({ customType: 'late', content: 'late native context', display: false });
  const userId = record.manager.appendMessage({ role: 'user', content: 'late native user', timestamp: 123 });
  const after = need(f.store.sessions.loadHistoryForContext(f.session.sessionId));
  expect(after.history!.entries.length).toBe(before.history!.entries.length + 2);
  expect(after.seed.origins.slice(-2).every(origin => origin.originSessionId === f.session.sessionId && origin.originRunId === null)).toBe(true);
  expect(after.seed.inputs.find(input => input.nativeEntryId === userId)).toEqual({ nativeEntryId: userId, originRunId: null, inputId: null, snapshotId: null });
  expect(need(f.store.runs.get(run.accepted.runId))).toEqual(beforeRun);
  expect(f.calls()).toBe(beforeCalls); expect(record.active).toBeUndefined();
});

// T07 qualification uses the public Application, actual SQLite ownership, native Pi
// codecs and the original invoice ToolExecutor. Only the remote model is loopback.
const t07Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
async function t07Fixture(api: 'openai-completions' | 'openai-responses' | 'google-generative-ai' = 'openai-completions', imageCapability = true) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p9-t07-'));
  const paths = { root: join(root, 'product'), databaseFile: join(root, 'product/data/app.sqlite'), logsDir: join(root, 'product/logs'), artifactsDir: join(root, 'product/artifacts'),
    outputsDir: join(root, 'product/outputs'), runtimeDir: join(root, 'product/runtime') };
  const payloads: any[] = [], sdkPayloads: unknown[] = [], conversions: Array<{ input: any[]; output: any[] }> = [], bindings: any[] = [], records: any[] = [];
  let loseUnconsumedReceipt = false, rejectM3 = false;
  let replyTool: unknown, responseHook: (() => Response | Promise<Response>) | undefined;
  let replacement: ((p: any) => unknown) | undefined, transform: ((m: any[]) => any[]) | undefined;
  const calls = { http: 0, base: 0, observe: 0, execute: 0, enqueue: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    payloads.push(await request.json()); calls.http++;
    if (responseHook) return responseHook();
    if (replyTool) {
      const tool = replyTool; replyTool = undefined;
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: 't07-original-call', type: 'function', function: { name: 'save_invoice_candidate', arguments: JSON.stringify(tool) } }] },
        finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    return api === 'openai-responses' ? responsesReply() : reply('T07 controlled answer');
  } });
  deferCleanup(() => server.stop(true));
  const modelsPath = join(root, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: { 't07-loopback': { baseUrl: `http://127.0.0.1:${server.port}/v1`, api,
    models: ['M1', 'M2', 'M3'].map(id => ({ id, name: id, reasoning: false, input: imageCapability ? ['text', 'image'] : ['text'],
      contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
  const config = (model = 'M1', retries: 0 | 1 = 0): ProviderConfig => ({ version: 1, name: 'T07', revision: 1,
    modelRef: { provider: 't07-loopback', model }, native: { authPath: join(root, 'unused.json'), modelsPath },
    parameters: { maxRetries: retries, maxRetryDelayMs: 100 } });
  let app!: Application, adapter!: PiAgentAdapter, sdk!: AgentSession, ownedDb!: Database;
  const runtimeState = RuntimeService.prototype.state;
  RuntimeService.prototype.state = function (...args) {
    ownedDb = (this as any).dependencies.contextService.options.store.db; return runtimeState.apply(this, args);
  };
  deferCleanup(() => { RuntimeService.prototype.state = runtimeState; });
  const sql = <T>(fn: (db: Database) => T): T => fn(ownedDb);
  const open = async () => {
    app = need(await createApplication({ paths, invoiceSourceRoot: join(root, 'source'), logger: { write() {}, async close() {} }, agentFactory: tools => {
      adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-t07',
        fetch: (input, init) => { calls.base++; return globalThis.fetch(input, init); }, sessionSetup(session) {
          sdk = session;
        } });
      const prepare = adapter.prepare.bind(adapter);
      adapter.prepare = async (...args) => {
        const prepared = await prepare(...args); if (!prepared.ok) return prepared;
        const stream = sdk.agent.streamFunction;
        sdk.agent.streamFunction = (model, context, options) => stream(model, context, { ...options,
          onPayload: payload => { sdkPayloads.push(structuredClone(payload)); return replacement ? replacement(payload) : undefined; } });
        const convert = sdk.agent.convertToLlm.bind(sdk.agent);
        sdk.agent.convertToLlm = async messages => {
          const output = await convert(messages); conversions.push({ input: [...messages], output: [...output] }); return output;
        };
        if (transform) sdk.agent.transformContext = async messages => transform!(messages);
        const execute = prepared.data.execute;
        return { ...prepared, data: { ...prepared.data, async execute(input, signal, observe) {
          const hooks = input.contextHooks!, binding = input.toolBinding;
          const outcome = await execute({ ...input, contextHooks: { ...hooks,
            bind(value) { bindings.push(structuredClone(value)); return hooks.bind(value); },
            record(binding, update) { records.push(structuredClone({ binding, update })); return hooks.record(binding, update); } },
            ...(binding ? { toolBinding: { ...binding,
              observeRequest(...call) { calls.observe++; return binding.observeRequest(...call); },
              execute(...call) { calls.execute++; return binding.execute(...call); } } } : {}) }, signal, observe);
          if (!loseUnconsumedReceipt) return outcome;
          const { confirmedUnconsumedInputIds: _lost, ...agent } = outcome.agent;
          return { ...outcome, agent };
        } } };
      };
      const enqueue = adapter.enqueueInput.bind(adapter); adapter.enqueueInput = (...args) => { calls.enqueue++; return enqueue(...args); };
      const watch = adapter.watchSession.bind(adapter);
      adapter.watchSession = (id, receipt, seed, write) => watch(id, receipt, seed, value =>
        rejectM3 && value.history.entries.some((e: any) => e.type === 'model_change' && e.modelId === 'M3')
          ? fail(appError('storage_write_failed', 'storage', 'Controlled M3 metadata commit failure.')) : write(value));
      return adapter;
    } }));
    await app.queryRuntimeState();
    const opened = app; deferCleanup(() => opened.close()); return app;
  };
  await open();
  const session = need(await app.createSession({ title: 'T07 source', expectedRevision: need(await app.readWorkspace()).revision }));
  const input = async (sessionId: number, sequence: number, text: string, model = 'M1', material = false, retries: 0 | 1 = 0) => {
    const workspace = need(await app.readWorkspace());
    return begin(app, { sessionId, clientSequence: sequence, mode: 'prompt', text, config: config(model, retries), timeoutMs: 7000, stopGraceMs: 500,
      ...(material ? { goalMode: 'save-candidate' as const, workspace: { revision: workspace.revision, documentRef: workspace.documentRef,
        jobId: workspace.jobId, candidateRef: workspace.candidateRef, sessionId } } : {}) });
  };
  const fork = async (sourceSessionId: number, targetEntryId?: string) => {
    const page = need(await app.querySessionHistory({ sessionId: sourceSessionId }));
    return need(await app.forkSession({ sourceSessionId, expected: page.commit, targetEntryId: targetEntryId ?? page.commit.leafId!,
      title: 'T07 fork', clientOperationId: crypto.randomUUID() }));
  };
  const branch = async (sessionId: number, targetEntryId: string) => {
    const page = need(await app.querySessionHistory({ sessionId }));
    return need(await app.branchSession({ sessionId, targetEntryId, expectedCommitRevision: page.commit.commitRevision,
      expectedEntryCount: page.commit.entryCount, expectedLeafId: page.commit.leafId }));
  };
  const counts = () => sql(db => Object.fromEntries(['runs', 'session_inputs', 'context_snapshots', 'tool_calls', 'invoice_candidates'].map(t => [t,
    (db.query(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n])));
  const facts = (sessionId: number) => sql(db => ({ runs: db.query('SELECT * FROM runs WHERE session_id=? ORDER BY id').all(sessionId),
    inputs: db.query('SELECT * FROM session_inputs WHERE session_id=? ORDER BY id').all(sessionId),
    tools: db.query('SELECT * FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE session_id=?) ORDER BY id').all(sessionId),
    snapshots: db.query('SELECT * FROM context_snapshots WHERE session_id=? ORDER BY id').all(sessionId),
    candidates: db.query('SELECT * FROM invoice_candidates ORDER BY id').all() }));
  const journal = (runId: number) => sql(db => JSON.parse((db.query('SELECT context_observations_json FROM runs WHERE id=?').get(runId) as any).context_observations_json));
  // Controlled historical entries only; ownership of actual user/tool facts is never fabricated.
  const historical = async (sessionId: number, build: (history: import('@flowmate/contracts').NativeSessionHistory) => import('@flowmate/contracts').NativeSessionHistory) => {
    need(await app.close());
    const store = need(openDatabase(paths));
    try {
      const old = need(store.memory.load(sessionId))!, next = build(structuredClone(old.history));
      const receipt = need(store.memory.commit({ sessionId, expected: old.commit, header: next.header, appendEntries: next.entries,
        leafId: next.leafId, unusable: next.unusable, contexts: [] }));
      const bundle = need(store.sessions.loadHistoryForContext(sessionId));
      expect(bundle.commit).toEqual(receipt); expect(bundle.seed.origins).toHaveLength(next.entries.length);
    } finally { store.close(); }
    await open();
  };
  const material = async () => {
    const source = join(root, 'source/000001'); mkdirSync(source, { recursive: true });
    const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'), content = JSON.stringify([{ type: 'text', text: 'T07 invoice 113.00', bbox: [0, 0, 1, 1], page_idx: 0 }]);
    const pages = JSON.stringify([{ pageNumber: 1, text: 'T07 invoice 113.00', blockCount: 1 }]);
    writeFileSync(join(source, 'original.png'), original); writeFileSync(join(source, 'content.json'), content); writeFileSync(join(source, 'pages.json'), pages);
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
      sourceRecordId: 'synthetic-t07', datasetRevision: 'fixture', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
      files: [{ path: 'original.png', bytes: original.length }, { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
    const document = need(await app.importInvoiceMaterial(source)), documentId = document.documentRef.id;
    const selected = need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'document', documentId } }));
    const task = need(await app.startTask({ clientSequence: 1, expectedRevision: selected.revision, documentRef: document.documentRef, goal: 'T07 save actual candidate' }));
    const page = need(await app.readDocumentPage({ documentId, page: 1, afterBlockId: null, limit: 50 }));
    const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
    const candidate = CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])),
      totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{ documentId, version: document.documentRef.version,
        artifactId: document.parsedArtifactId, page: 1, blockId: page.blocks[0]!.id, quote: '113.00' }] } }, lines: [], notes: [] });
    replyTool = { documentId, candidate };
    const run = await input(session.sessionId, 1, 'Original invoice request', 'M1', true);
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(calls).toMatchObject({ http: 2, base: 2, observe: 1, execute: 1 });
    const saved = need(await app.listJobCandidates({ jobId: task.job.jobId })).items;
    expect(saved).toHaveLength(1); expect(saved[0]!.context).toMatchObject({ snapshotId: expect.any(Number), requestSequence: 1 });
    return { run, tool: { documentId, candidate }, saved: saved[0]! };
  };
  return { paths, session, config, input, fork, branch, counts, facts, journal, historical, material, open, sql, calls, payloads, sdkPayloads, bindings, records, conversions,
    get app() { return app; }, get adapter() { return adapter; }, get sdk() { return sdk; },
    loseReceipt(value: boolean) { loseUnconsumedReceipt = value; }, rejectMetadata(value: boolean) { rejectM3 = value; },
    replace(fn: typeof replacement) { replacement = fn; }, transform(fn: typeof transform) { transform = fn; },
    respond(fn: typeof responseHook) { responseHook = fn; }, tool(value: unknown) { replyTool = value; } };
}

it('P9 T07 sends only the selected corrected branch and original tool facts', async () => {
  const f = await t07Fixture(), original = await f.material(), a = f.session.sessionId;
  const base = need(await f.app.querySessionHistory({ sessionId: a })).commit.leafId!;
  const abandoned = await f.input(a, 2, 'ABANDONED amount 999', 'M2'); expect((await abandoned.terminal).result.ok).toBe(true);
  await f.branch(a, base);
  const corrected = await f.input(a, 3, 'CORRECTED amount 113', 'M2'); expect((await corrected.terminal).result.ok).toBe(true);
  const before = f.facts(a), count = f.counts(), effects = { ...f.calls };
  const b = await f.fork(a), c = await f.fork(b.session.sessionId);
  expect(f.counts()).toEqual(count); expect(f.calls).toEqual(effects);
  need(await f.app.close()); await f.open();
  for (const id of [a, b.session.sessionId, c.session.sessionId]) need(await f.app.querySessionHistory({ sessionId: id }));
  need(await f.app.queryRun(original.run.accepted.runId));
  need(await f.app.querySessionInput({ sessionId: a, inputId: original.run.accepted.inputId }));
  need(await f.app.listContextRequests({ sessionId: a, runId: original.run.accepted.runId }));
  expect(f.facts(a)).toEqual(before); expect(f.counts()).toEqual(count); expect(f.calls).toEqual(effects);
  const next = await f.input(c.session.sessionId, 1, 'Use selected correction', 'M3');
  expect((await next.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.counts()).toEqual({ ...count, runs: count.runs! + 1, session_inputs: count.session_inputs! + 1, context_snapshots: count.context_snapshots! + 1 });
  expect(f.calls).toMatchObject({ http: effects.http + 1, base: effects.base + 1, execute: 1, observe: 1 });
  const wire = JSON.stringify(f.payloads.at(-1)); expect(wire).toContain('CORRECTED amount 113'); expect(wire).not.toContain('ABANDONED amount 999');
  expect(wire).toContain('t07-original-call'); expect(wire).toContain('113.00'); expect(f.payloads.at(-1).model).toBe('M3');
  const input = need(await f.app.querySessionInput({ sessionId: c.session.sessionId, inputId: next.accepted.inputId })).input!;
  const request = f.journal(next.accepted.runId).requests[0];
  expect(request.binding).toMatchObject({ sessionId: c.session.sessionId, inputId: next.accepted.inputId, snapshotId: input.contextSnapshotId,
    includedNativeContexts: [] });
  expect(request.binding.includedBindings.map((v: any) => v.inputId)).toEqual([original.run.accepted.inputId, corrected.accepted.inputId, next.accepted.inputId]);
  expect(request.sdkPayload.inclusion).toBe('confirmed'); expect(request.attempts[0].wireInclusion).toBe('confirmed');
  const originalTool = request.binding.includedToolResults[0];
  expect(originalTool).toMatchObject({ originRunId: original.run.accepted.runId, nativeToolCallId: 't07-original-call' });
  const toolView = need(await f.app.queryRunToolCall({ sessionId: a, runId: original.run.accepted.runId, toolCallId: originalTool.toolCallId }));
  expect(toolView).toMatchObject({ toolCallId: originalTool.toolCallId, status: 'succeeded' });
  const originalSnapshot = need(await f.app.queryContextSnapshot({ sessionId: a, runId: original.run.accepted.runId, snapshotId: originalTool.context.snapshotId }));
  expect(originalSnapshot.snapshot.id).toBe(originalTool.context.snapshotId);
  const targetSnapshot = need(await f.app.queryContextSnapshot({ sessionId: c.session.sessionId, runId: next.accepted.runId, snapshotId: input.contextSnapshotId! }));
  expect(targetSnapshot.snapshot.id).not.toBe(originalSnapshot.snapshot.id);
  expect(f.facts(a)).toEqual(before);
  console.log('T07 selected real effects', JSON.stringify({ before: effects, after: f.calls, counts: f.counts() }));
});

it('P9 T07 binds inherited and native derived contexts through request reload', async () => {
  const f = await t07Fixture(), actual = await f.material(), a = f.session.sessionId;
  const history = need(f.adapter.exportSession(f.session.nativeSessionId));
  const users = history.entries.filter((e: any) => e.type === 'message' && e.message.role === 'user');
  const call = history.entries.find((e: any) => e.type === 'message' && e.message.role === 'assistant' && e.message.content.some((b: any) => b.type === 'toolCall'))!;
  const result = history.entries.find((e: any) => e.type === 'message' && e.message.role === 'toolResult')!;
  const oldFacts = f.facts(a);
  await f.historical(a, h => {
    const entries = [...h.entries]; let parentId = h.leafId;
    const add = (id: string, value: any) => { entries.push({ id, parentId, timestamp: '2026-10-04T00:00:00.000Z', ...value }); parentId = id; };
    for (const [id, excludeFromContext] of [['excluded-bash', true], ['included-bash', false]] as const)
      add(id, { type: 'message', message: { role: 'bashExecution', command: 'printf fixture', output: id, excludeFromContext, exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } });
    add('custom-hidden', { type: 'custom_message', customType: 't07', content: 'same derived body', display: false });
    add('custom-visible', { type: 'custom_message', customType: 't07', content: 'same derived body', display: true });
    add('entry-summary', { type: 'branch_summary', fromId: result.id, summary: 'entry summary body' });
    add('message-summary', { type: 'message', message: { role: 'branchSummary', fromId: call.id, summary: 'message summary body', timestamp: 2 } });
    add('message-compaction', { type: 'message', message: { role: 'compactionSummary', summary: 'message compaction body', tokensBefore: 10, timestamp: 3 } });
    add('entry-compaction', { type: 'compaction', firstKeptEntryId: users[0]!.id, summary: 'entry compaction body', tokensBefore: 20 });
    return { ...h, entries, leafId: parentId };
  });
  const b = await f.fork(a), c = await f.fork(b.session.sessionId), before = f.counts(), effects = { ...f.calls };
  const next = await f.input(c.session.sessionId, 1, 'New independent input', 'M3');
  expect((await next.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const converted = f.conversions.at(-1)!;
  expect(converted.input.map(m => m.role)).toEqual(['compactionSummary', 'user', 'assistant', 'toolResult', 'assistant', 'bashExecution', 'bashExecution', 'custom', 'custom', 'branchSummary', 'branchSummary', 'compactionSummary', 'user']);
  expect(converted.output).toHaveLength(12); expect(converted.input[7]).not.toBe(converted.input[8]);
  expect(converted.output[6].content).toEqual([{ type: 'text', text: 'same derived body' }]);
  expect(converted.output[7].content).toEqual(converted.output[6].content);
  expect(JSON.stringify(converted.output[5])).toContain('included-bash'); expect(JSON.stringify(converted.output)).not.toContain('excluded-bash');
  const expected = ([
    ['entry-compaction', 'compaction', 'compactionSummary', 0, [users[0]!.id]],
    ['included-bash', 'message', 'bashExecution', 6, []],
    ['custom-hidden', 'custom_message', 'custom', 7, []], ['custom-visible', 'custom_message', 'custom', 8, []],
    ['entry-summary', 'branch_summary', 'branchSummary', 9, [result.id]],
    ['message-summary', 'message', 'branchSummary', 10, [call.id]],
    ['message-compaction', 'message', 'compactionSummary', 11, []],
  ] as const).map(([nativeEntryId, entryType, messageRole, contextMessageIndex, referenceEntryIds]) => ({ nativeEntryId, originSessionId: a, entryType, messageRole, contextMessageIndex, referenceEntryIds }));
  const request = f.journal(next.accepted.runId).requests[0];
  expect(request.binding.includedNativeContexts).toEqual(expected);
  expect(f.bindings.at(-1).binding).toEqual(request.binding);
  expect(f.records.filter(r => r.binding.runId === next.accepted.runId).every(r => JSON.stringify(r.binding) === JSON.stringify(request.binding))).toBe(true);
  expect(request.binding.includedBindings.map((v: any) => v.inputId)).toEqual([actual.run.accepted.inputId, next.accepted.inputId]);
  expect(request.binding.includedToolResults[0]).toMatchObject({ originRunId: actual.run.accepted.runId });
  expect(request.sdkPayload.inclusion).toBe('confirmed'); expect(request.attempts[0].wireInclusion).toBe('confirmed');
  expect(f.counts()).toEqual({ ...before, runs: before.runs! + 1, session_inputs: before.session_inputs! + 1, context_snapshots: before.context_snapshots! + 1 });
  expect(f.calls).toMatchObject({ http: effects.http + 1, observe: 1, execute: 1 }); expect(f.facts(a)).toEqual(oldFacts);
  need(await f.app.close()); await f.open();
  const publicRequests = need(await f.app.listContextRequests({ sessionId: c.session.sessionId, runId: next.accepted.runId }));
  expect(publicRequests.items[0]!.binding.includedNativeContexts).toEqual(expected);
  const page = need(await f.app.querySessionHistory({ sessionId: c.session.sessionId }));
  for (const source of expected) {
    expect(page.items.find(item => item.entryId === source.nativeEntryId)?.originSessionId).toBe(a);
    const detail = need(await f.app.querySessionHistoryEntry({ sessionId: c.session.sessionId, entryId: source.nativeEntryId, expectedCommitRevision: page.commit.commitRevision }));
    expect(detail.summary.originSessionId).toBe(a);
  }
  expect(f.journal(next.accepted.runId).requests).toEqual([request]);
  const chat = need(await f.app.listSessionMessages({ sessionId: c.session.sessionId }));
  expect(chat.items.every(item => ['user', 'assistant', 'toolResult'].includes(item.role))).toBe(true);
  expect(JSON.stringify(chat)).not.toContain('same derived body');
  for (const text of ['included-bash', 'same derived body', 'entry summary body', 'message summary body', 'message compaction body', 'entry compaction body'])
    expect(JSON.stringify(f.payloads.at(-1))).toContain(text);
  expect(f.calls.http).toBe(effects.http + 1);
  console.log('T07 derived actual input/output indexes', JSON.stringify({ roles: converted.input.map(m => m.role), outputCount: converted.output.length, expected, effects: f.calls }));
});

for (const api of ['openai-completions', 'openai-responses'] as const) it(`P9 T07 delivers restored user and custom images through both real codecs: ${api}`, async () => {
  const f = await t07Fixture(api), a = f.session.sessionId;
  await f.historical(a, h => ({ ...h, entries: [
    { id: 'root', type: 'message', parentId: null, timestamp: '2026-10-04T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Legacy restored image' }, { type: 'image', data: t07Png, mimeType: 'image/png' }], timestamp: 1 } },
    { id: 'image-custom', type: 'custom_message', parentId: 'root', timestamp: '2026-10-04T00:00:00.000Z', customType: 'image', display: false,
      content: [{ type: 'image', data: t07Png, mimeType: 'image/png' }] },
    { id: 'image-compaction', type: 'compaction', parentId: 'image-custom', timestamp: '2026-10-04T00:00:00.000Z', firstKeptEntryId: 'root', summary: 'Preserve literal root reference', tokensBefore: 20 },
  ], leafId: 'image-compaction' }));
  const b = await f.fork(a), before = f.counts();
  const run = await f.input(b.session.sessionId, 1, 'Describe restored images', 'M3');
  expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.sdk.model?.input).toEqual(['text', 'image']);
  expect(f.calls).toMatchObject({ http: 1, base: 1, observe: 0, execute: 0 });
  const wire = JSON.stringify(f.payloads[0]); expect(wire.split(`data:image/png;base64,${t07Png}`).length - 1).toBe(2);
  expect(JSON.stringify(f.sdkPayloads[0]).split(`data:image/png;base64,${t07Png}`).length - 1).toBe(2);
  const request = f.journal(run.accepted.runId).requests[0];
  expect(request.binding.includedBindings[0]).toEqual({ nativeEntryId: 'root', originRunId: null, inputId: null, snapshotId: null });
  expect(request.binding.includedNativeContexts).toEqual([
    { nativeEntryId: 'image-compaction', originSessionId: a, entryType: 'compaction', messageRole: 'compactionSummary', contextMessageIndex: 0, referenceEntryIds: ['root'] },
    { nativeEntryId: 'image-custom', originSessionId: a, entryType: 'custom_message', messageRole: 'custom', contextMessageIndex: 2, referenceEntryIds: [] }]);
  expect(request.sdkPayload.inclusion).toBe('confirmed'); expect(request.attempts[0].wireInclusion).toBe('confirmed');
  expect(JSON.stringify(request)).not.toContain(t07Png);
  expect(f.counts()).toEqual({ ...before, runs: 1, session_inputs: 1, context_snapshots: 1 });
  need(await f.app.close()); await f.open();
  const publicRequests = need(await f.app.listContextRequests({ sessionId: b.session.sessionId, runId: run.accepted.runId }));
  const publicHistory = need(await f.app.querySessionHistory({ sessionId: b.session.sessionId }));
  const publicDetail = need(await f.app.querySessionHistoryEntry({ sessionId: b.session.sessionId, entryId: 'root', expectedCommitRevision: publicHistory.commit.commitRevision }));
  expect(publicDetail.summary.originSessionId).toBe(a);
  expect(publicDetail.fields).toMatchObject({ hasImages: true, imageMimeTypes: ['image/png'] });
  expect(JSON.stringify(publicRequests) + JSON.stringify(publicHistory) + JSON.stringify(publicDetail)).not.toContain(t07Png);
  expect(publicRequests.items[0]!.binding.includedNativeContexts).toEqual(request.binding.includedNativeContexts);
  expect(f.calls.http).toBe(1);
  console.log('T07 actual image codec', api, JSON.stringify({ calls: f.calls, counts: f.counts(), inclusion: request.sdkPayload.inclusion, wire: request.attempts[0].wireInclusion }));
});

it('P9 T07 records M3 separately from historical M1 and M2', async () => {
  const f = await t07Fixture(), a = f.session.sessionId;
  const first = await f.input(a, 1, 'M1 input', 'M1'); expect((await first.terminal).result.ok).toBe(true);
  const second = await f.input(a, 2, 'M2 input', 'M2'); expect((await second.terminal).result.ok).toBe(true);
  const before = f.facts(a), history = need(f.adapter.exportSession(f.session.nativeSessionId));
  need(await f.app.close()); await f.open();
  need(await f.app.querySessionHistory({ sessionId: a })); expect(f.facts(a)).toEqual(before); expect(f.calls.http).toBe(2);
  const third = await f.input(a, 3, 'M3 input', 'M3'); expect((await third.terminal).result.ok).toBe(true);
  const after = f.facts(a), next = need(f.adapter.exportSession(f.session.nativeSessionId));
  expect(after.runs.slice(0, 2)).toEqual(before.runs); expect(after.inputs.slice(0, 2)).toEqual(before.inputs);
  expect(next.entries.slice(0, history.entries.length)).toEqual([...history.entries]);
  const appended = next.entries.slice(history.entries.length), changes = appended.filter((e: any) => e.type === 'model_change');
  expect(changes).toHaveLength(1); expect(changes[0]).toMatchObject({ provider: 't07-loopback', modelId: 'M3' });
  expect(appended.findIndex(e => e.id === changes[0]!.id)).toBeLessThan(appended.findIndex((e: any) => e.type === 'message' && e.message.role === 'user'));
  const config = JSON.parse((after.runs[2] as any).config_json);
  expect(config.requestedModel.model).toBe('M3'); expect(config.resolvedModel.model).toBe('M3');
  expect(config.historyPolicyVersion).toBe('p9-native-history-v1');
  expect(f.payloads.map(p => p.model)).toEqual(['M1', 'M2', 'M3']);
  expect(f.journal(third.accepted.runId).requests[0].binding.includedNativeContexts).toEqual([]);
  expect(f.sql(db => (db.query('SELECT run_id FROM session_native_entries WHERE session_id=? AND entry_id=?').get(a, changes[0]!.id) as any).run_id)).toBeNull();
});

for (const count of [509, 510]) it(`P9 T07 refuses ambiguous sources incomplete pairs and inherited tool IDs before effects: combined ${count + 3}`, async () => {
  const f = await t07Fixture(), original = await f.material(), a = f.session.sessionId;
  await f.historical(a, h => {
    let parentId = h.leafId; const entries = [...h.entries];
    for (let index = 0; index < count; index++) { const id = `d${index}`;
      entries.push({ id, parentId, timestamp: '2026-10-04T00:00:00.000Z', type: 'custom_message', customType: 'c', content: 'x', display: false }); parentId = id; }
    return { ...h, entries, leafId: parentId };
  });
  const b = await f.fork(a), before = f.facts(a), effects = { ...f.calls }, counts = f.counts();
  const next = await f.input(b.session.sessionId, 1, 'Explicit new execution', 'M3');
  const terminal = await next.terminal;
  expect(terminal.result).toMatchObject({ ok: true, data: { status: count === 509 ? 'completed' : 'failed' } });
  expect(f.calls).toMatchObject({ http: effects.http + (count === 509 ? 1 : 0), base: effects.base + (count === 509 ? 1 : 0), observe: 1, execute: 1 });
  expect(f.counts().tool_calls).toBe(counts.tool_calls); expect(f.counts().invoice_candidates).toBe(1); expect(f.facts(a)).toEqual(before);
  if (count === 509) {
    const binding = f.journal(next.accepted.runId).requests[0].binding;
    expect(binding.includedNativeContexts).toHaveLength(509); expect(binding.includedBindings).toHaveLength(2); expect(binding.includedToolResults).toHaveLength(1);
    expect(binding.includedToolResults[0].originRunId).toBe(original.run.accepted.runId);
  } else expect(JSON.stringify(terminal)).toContain('context_evidence_too_large');
  console.log('T07 combined provenance capacity', count + 3, JSON.stringify(f.calls));
});

for (const fault of ['incomplete-pair', 'ambiguous-source', 'object-replacement', 'source-break', 'ancestor-revoked', 'inherited-id', 'retry-revocation'] as const)
  it(`P9 T07 refuses ambiguous sources incomplete pairs and inherited tool IDs before effects: ${fault}`, async () => {
    const f = await t07Fixture(), actual = await f.material(), a = f.session.sessionId;
    const b = await f.fork(a), c = await f.fork(b.session.sessionId), before = f.facts(a), effects = { ...f.calls }, counts = f.counts();
    if (fault === 'incomplete-pair') f.transform(messages => messages.filter(m => m.role !== 'toolResult'));
    if (fault === 'ambiguous-source') f.transform(messages => [...messages, messages.find(m => m.role === 'user')!]);
    if (fault === 'object-replacement') f.transform(messages => messages.map(m => structuredClone(m)));
    if (fault === 'source-break') f.sql(db => db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','changed source') WHERE session_id=? AND entry_id=?")
      .run(a, (before.inputs[0] as any).native_entry_id));
    if (fault === 'ancestor-revoked') f.sql(db => db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?").run(JSON.stringify({ documentIds: [actual.tool.documentId], at: '2026-10-04T00:00:00.000Z', reason: 'document_use_revoked' }), a));
    if (fault === 'inherited-id') {
      need(await f.app.updateWorkspace({ expectedRevision: need(await f.app.readWorkspace()).revision, change: { kind: 'session', sessionId: c.session.sessionId } }));
      f.tool(actual.tool);
    }
    if (fault === 'retry-revocation') f.respond(() => {
      f.sql(db => db.query("UPDATE sessions SET metadata_json=json_set(metadata_json,'$.model_use_blocked',json(?)) WHERE id=?").run(JSON.stringify({ documentIds: [actual.tool.documentId], at: '2026-10-04T00:00:00.000Z', reason: 'document_use_revoked' }), a));
      return new Response('Controlled unavailable', { status: 503 });
    });
    let terminal: unknown;
    try { const run = await f.input(c.session.sessionId, 1, 'Explicit new execution', 'M3', fault === 'inherited-id', fault === 'retry-revocation' ? 1 : 0); terminal = await run.terminal; }
    catch (error) { terminal = String(error); }
    expect(JSON.stringify(terminal)).not.toContain('"status":"completed"');
    const prerequisite = ['inherited-id', 'retry-revocation'].includes(fault) ? 1 : 0;
    expect(f.calls).toMatchObject({ http: effects.http + prerequisite, base: effects.base + prerequisite, observe: 1, execute: 1 });
    expect(f.counts().tool_calls).toBe(counts.tool_calls); expect(f.counts().invoice_candidates).toBe(counts.invoice_candidates);
    expect(f.facts(a)).toEqual(before);
    const expectedError = { 'incomplete-pair': 'session_history_invalid', 'ambiguous-source': 'context_binding_unknown', 'object-replacement': 'context_binding_unknown', 'source-break': 'context_binding_unknown', 'ancestor-revoked': 'session_scope_revoked', 'inherited-id': 'context_binding_conflict', 'retry-revocation': 'session_scope_revoked' }[fault];
    expect(JSON.stringify(terminal)).toContain(expectedError);
    if (fault === 'retry-revocation') {
      const requests = f.sql(db => JSON.parse((db.query('SELECT context_observations_json FROM runs WHERE session_id=?').get(c.session.sessionId) as any).context_observations_json)).requests;
      expect(requests[0].attempts).toHaveLength(1); expect(requests[0].attempts[0].responseStatus).toBe(503);
    }
    console.log('T07 real negative', fault, JSON.stringify({ before: effects, after: f.calls, terminal }));
  });

for (const fault of ['no-capability', 'unsupported-codec', 'changed-payload-image', 'changed-object-image'] as const)
  it(`P9 T07 delivers restored user and custom images through both real codecs: rejects ${fault}`, async () => {
    const f = await t07Fixture(fault === 'unsupported-codec' ? 'google-generative-ai' : 'openai-completions', fault !== 'no-capability');
    await f.historical(f.session.sessionId, h => ({ ...h, entries: [{ id: 'private-image', parentId: null, timestamp: '2026-10-04T00:00:00.000Z',
      type: 'custom_message', customType: 'image', display: false, content: [{ type: 'image', data: t07Png, mimeType: 'image/png' }] }], leafId: 'private-image' }));
    if (fault === 'changed-payload-image') f.replace(payload => JSON.parse(JSON.stringify(payload).replace(t07Png, 'AAAA')));
    if (fault === 'changed-object-image') f.transform(messages => messages.map(m => m.role === 'custom' ? { ...m, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] } : m));
    const run = await f.input(f.session.sessionId, 1, 'Explicit image request', 'M3');
    const terminal = await run.terminal;
    expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed' } }); expect(f.calls).toMatchObject({ http: 0, base: 0, observe: 0, execute: 0 });
    expect(f.counts()).toMatchObject({ tool_calls: 0, invoice_candidates: 0 });
    expect(JSON.stringify(f.journal(run.accepted.runId))).not.toContain(t07Png);
    console.log('T07 image refusal', fault, JSON.stringify({ terminal, calls: f.calls }));
  });

it('P9 T07 records M3 separately from historical M1 and M2: required metadata save precedes HTTP', async () => {
  const f = await t07Fixture(), a = f.session.sessionId;
  for (const [sequence, model] of [[1, 'M1'], [2, 'M2']] as const) { const run = await f.input(a, sequence, model, model); expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } }); }
  const before = f.facts(a), history = need(f.adapter.exportSession(f.session.nativeSessionId));
  need(await f.app.close()); await f.open(); f.rejectMetadata(true);
  const next = await f.input(a, 3, 'Explicit M3', 'M3');
  expect((await next.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'storage_write_failed' } } });
  expect(f.calls.http).toBe(2); expect(f.calls.base).toBe(2);
  expect(f.facts(a).runs.slice(0, 2)).toEqual(before.runs); expect(f.facts(a).inputs.slice(0, 2)).toEqual(before.inputs);
  expect(f.sql(db => db.query('SELECT entry_json FROM session_native_entries WHERE session_id=? ORDER BY sequence').all(a).map((r: any) => JSON.parse(r.entry_json)))).toEqual([...history.entries]);
});

for (const unknown of [false, true]) it(`P9 T07 restores without replaying queued or unknown input after interruption: ${unknown ? 'unknown receipt' : 'confirmed queue'}`, async () => {
  const f = await t07Fixture(), a = f.session.sessionId, entered = barrier(), release = barrier(); deferCleanup(() => release.release());
  f.respond(async () => { entered.release(); await release.ready; return reply(); });
  const first = await f.input(a, 1, 'Consumed original prompt');
  expect(await Promise.race([entered.ready.then(() => 'entered'), first.terminal])).toBe('entered');
  const queued = need(await f.app.submitInput({ sessionId: a, runId: first.accepted.runId, clientSequence: 2, mode: 'followUp', text: 'MUST NOT REPLAY QUEUED' }));
  expect(need(await f.app.querySessionInput({ sessionId: a, inputId: queued.inputId })).input).toMatchObject({ status: 'queued', nativeEntryId: null });
  f.loseReceipt(unknown);
  need(await f.app.cancelRun(first.accepted.runId));
  const terminal = await first.terminal; release.release();
  expect(terminal.result).toMatchObject({ ok: true, data: { status: 'cancelled' } });
  const consumed = need(await f.app.querySessionInput({ sessionId: a, inputId: first.accepted.inputId })).input!;
  const stoppedInput = need(await f.app.querySessionInput({ sessionId: a, inputId: queued.inputId })).input!;
  expect(consumed.status).toBe('consumed'); expect(stoppedInput).toMatchObject({ status: unknown ? 'delivery_unknown' : 'cancelled', nativeEntryId: null });
  const before = f.facts(a), counts = f.counts(), effects = { ...f.calls };
  need(await f.app.close()); await f.open(); f.respond(undefined); f.loseReceipt(false);
  need(await f.app.querySessionHistory({ sessionId: a })); need(await f.app.queryRun(first.accepted.runId));
  expect(need(await f.app.querySessionInput({ sessionId: a, inputId: queued.inputId })).input).toEqual(stoppedInput);
  const messages = need(await f.app.listSessionMessages({ sessionId: a }));
  expect(messages.items.some(item => item.role === 'user')).toBe(true);
  expect(need(await f.app.listSessionInputs({ sessionId: a })).items.find(i => i.inputId === queued.inputId)?.status).toBe(unknown ? 'delivery_unknown' : 'cancelled');
  expect(f.counts()).toEqual(counts); expect(f.calls).toEqual(effects); expect(f.facts(a)).toEqual(before);
  expect(await f.app.submitInput({ sessionId: a, clientSequence: 3, mode: 'prompt', text: 'Blocked original Session', config: f.config('M3') })).toMatchObject({ ok: false });
  expect(f.counts()).toEqual(counts); expect(f.calls).toEqual(effects);
  const fresh = need(await f.app.createSession({ title: 'Explicit safe new Session', expectedRevision: need(await f.app.readWorkspace()).revision }));
  const next = await f.input(fresh.sessionId, 1, 'Explicit new prompt only', 'M3');
  expect((await next.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.calls).toMatchObject({ http: effects.http + 1, base: effects.base + 1, enqueue: effects.enqueue, observe: 0, execute: 0 });
  expect(JSON.stringify(f.payloads.at(-1))).toContain('Explicit new prompt only'); expect(JSON.stringify(f.payloads.at(-1))).not.toContain('MUST NOT REPLAY QUEUED');
  const after = f.facts(a); expect(after.runs.slice(0, 1)).toEqual(before.runs); expect(after.inputs.slice(0, 2)).toEqual(before.inputs);
  expect(f.counts()).toEqual({ ...counts, runs: counts.runs! + 1, session_inputs: counts.session_inputs! + 1, context_snapshots: counts.context_snapshots! + 1 });
  console.log('T07 interruption retained', JSON.stringify({ unknown, consumed: consumed.status, undelivered: stoppedInput.status, before: effects, after: f.calls }));
});

it('P9 T07 keeps frozen fork sources after the ancestor appends and changes leaf', async () => {
  const f = await t07Fixture(), original = await f.material(), a = f.session.sessionId;
  const selected = need(await f.app.querySessionHistory({ sessionId: a })).commit.leafId!;
  const b = await f.fork(a);
  const later = await f.input(a, 2, 'ANCESTOR AFTER FROZEN PREFIX', 'M2');
  expect((await later.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  await f.branch(a, selected);
  const before = f.facts(a), counts = f.counts(), effects = { ...f.calls };
  need(await f.app.close()); await f.open();
  need(await f.app.querySessionHistory({ sessionId: b.session.sessionId }));
  expect(f.calls).toEqual(effects); expect(f.counts()).toEqual(counts);
  const next = await f.input(b.session.sessionId, 1, 'Use frozen original', 'M3');
  expect((await next.terminal).result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads.at(-1).model).toBe('M3'); expect(JSON.stringify(f.payloads.at(-1))).not.toContain('ANCESTOR AFTER FROZEN PREFIX');
  expect(f.journal(next.accepted.runId).requests[0].binding.includedToolResults[0].originRunId).toBe(original.run.accepted.runId);
  expect(f.facts(a)).toEqual(before); expect(f.calls).toMatchObject({ http: effects.http + 1, observe: 1, execute: 1 });
});
