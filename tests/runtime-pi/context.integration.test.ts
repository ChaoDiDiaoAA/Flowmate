import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextObservationsSchema, SessionInputContentV2Schema, appError, fail, ok } from '@flowmate/contracts';
import type { AgentRunEvent, Application, ProviderConfig, Result, SessionInputRequest, AgentToolBinding, ToolDefinition, RequestContextBinding } from '@flowmate/contracts';
import { z } from 'zod';
import { createApplication } from '../../apps/composition.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../support/resources.ts';
import { openTestDatabase } from '../support/database.ts';
import { ContextService } from '../../packages/core/src/context/service.ts';
import { RuntimeService } from '../../packages/core/src/runtime/service.ts';
import { SessionService } from '../../packages/core/src/sessions/service.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function barrier() { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; }
function reply(text = 'Controlled answer.') {
  const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p8-context',
    choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
  return new Response(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
async function begin(app: Application, input: SessionInputRequest) {
  let finish!: (event: AgentRunEvent & { type: 'run_finished' }) => void;
  const terminal = new Promise<AgentRunEvent & { type: 'run_finished' }>(resolve => { finish = resolve; });
  const accepted = need(await app.submitInput(input, { onEvent(event) { if (event.type === 'run_finished') finish(event); } }));
  return { accepted, terminal };
}
async function fixture(onRequest: (ordinal: number) => Promise<Response> | Response = () => reply()) {
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
  let adapter!: PiAgentAdapter;
  const app = need(await createApplication({ paths, logger: { write() {}, async close() {} },
    agentFactory: tools => adapter = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-p8-key' }) }));
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
  return { app, adapter, paths, session, payloads, journal, prompt };
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
        } else originalCallId = need(store.toolCalls.request({ runId, sessionId: session.sessionId,
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

describe('P8 actual Pi request context', () => {
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
      expect(requests[index]!.sdkPayload).toBeNull(); expect(requests[index]!.attempts).toEqual([]);
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
