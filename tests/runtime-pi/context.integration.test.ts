import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { streamSimple as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { ModelRuntime, type AgentSession } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  nativeUnavailable?: boolean;
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
    ...(options.networkThrow || options.ignoreAbort || options.syncThrow ? { fetch: (input, init) => {
      baseCalls++; if (options.syncThrow) throw new Error('PRIVATE_SYNC_THROW');
      return options.networkThrow ? Promise.reject(new Error('PRIVATE_TOKEN_BODY_DO_NOT_PERSIST'))
        : globalThis.fetch(input, { ...init, signal: undefined }); } } : {}) });
  const native = need(adapter.createSession());
  const at = () => new Date().toISOString();
  const session = need(store.sessions.create({ nativeSessionId: native.nativeSessionId, title: 'Evidence', at: at(),
    nativeHistory: need(adapter.exportSession(native.nativeSessionId)) }));
  need(adapter.watchSession(native.nativeSessionId, (history, context) => store.sessions.saveHistory(session.sessionId, history, context)));
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
  const runtime = new RuntimeService({ runs: store.runs, sessions: store.sessions, sessionInputs: store.sessionInputs, agent: adapter,
    contextService: new ContextService({ store, materials: { inspectParsed() { throw new Error('No chat material.'); } } }),
    contextRepository: { bindRequest: store.context.bindRequest, resolveToolResult: store.context.resolveToolResult,
      recordRequest(binding, update) { updates.push(update);
        if (options.reject?.(update)) return fail(appError('storage_write_failed', 'storage', 'Controlled necessary evidence rejection.', true));
        const saved = store.context.recordRequest(binding, update); if (saved.ok) options.afterRecord?.(update); return saved; } },
    provider: { async prepare() { throw new Error('No direct Provider.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: at, monotonicNow: () => performance.now() });
  deferCleanup(() => runtime.close());
  const sessions = new SessionService(store.sessions, adapter, () => runtime.state(), at, store.runs, store.sessionInputs,
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
  return { store, adapter, sdk, session, runtime, sessions, config, payloads, updates, start, journal, baseCalls: () => baseCalls };
}
async function begin(app: Application, input: SessionInputRequest) {
  let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
  const accepted = need(await app.submitInput(input, { onEvent(event) { if (event.type === 'run_finished') finish(event); } }));
  return { accepted, terminal };
}
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
  let calls = 0, seededPreledger = false;
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
      if (!seededPreledger) {
        for (let index = 0; index < preledgerUsers; index++)
          session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'legacy same text' }], timestamp: index + 1 });
        seededPreledger = true;
      }
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
  const session = need(store.sessions.create({ nativeSessionId: native.nativeSessionId, title: 'Stored context', at: at(),
    nativeHistory: need(adapter.exportSession(native.nativeSessionId)) }));
  need(adapter.watchSession(native.nativeSessionId, (history, context) => store.sessions.saveHistory(session.sessionId, history, context)));
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
  const runtime = new RuntimeService({ runs: store.runs, sessions: store.sessions, sessionInputs: store.sessionInputs, agent: adapter,
    contextService, ...(withRepository ? { contextRepository: store.context } : {}),
    provider: { async prepare() { throw new Error('No direct Provider.'); }, async close() { return { stopped: true, closed: true, errors: [] }; } },
    log: { write() {}, async close() {} }, now: at, monotonicNow: () => performance.now() });
  deferCleanup(() => runtime.close());
  const sessions = new SessionService(store.sessions, adapter, () => runtime.state(), at, store.runs, store.sessionInputs,
    (request, submission, control) => runtime.start(request, control, submission), request => runtime.appendInput(request));
  const start = async (clientSequence: number) => {
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
    need(await f.app.branchSession({ sessionId: f.session.sessionId, expectedLeafId: history.leafId,
      expectedEntryCount: history.entries.length, targetEntryId: target }));
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
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, [])).toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
    expect(f.adapter.inspect(f.session.nativeSessionId).availability).toBe('missing');
    const source = bundle.bindings[0]!;
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, [{ ...source, nativeEntryId: 'missing-entry' }]))
      .toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, [source, { ...source, snapshotId: source.snapshotId! + 100 }]))
      .toMatchObject({ ok: false, error: { code: 'context_binding_conflict' } });
    need(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, bundle.bindings));
    expect(f.adapter.restoreSessionLeaf(f.session.nativeSessionId, bundle.history, [{ ...source, snapshotId: source.snapshotId! + 100 }]))
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
    const a = bundle.bindings[0]!, b = bundle.bindings[1]!;
    expect(f.adapter.restoreSession(f.session.nativeSessionId, bundle.history, [a, { ...a, nativeEntryId: b.nativeEntryId }]))
      .toMatchObject({ ok: false, error: { code: 'context_binding_conflict' } });
    expect(f.calls()).toBe(2);
  });

  it('keeps the original sequence gate for a duplicate native tool result and sends no new HTTP', async () => {
    const f = await storedFixture(true, 'legacy', 1); expect(f.calls()).toBe(2);
    const run = await f.start(1);
    expect((await run.terminal).result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'session_history_invalid' } } });
    expect(f.calls()).toBe(2); expect(f.journal(run.accepted.runId).requests).toEqual([]);
  });
});
