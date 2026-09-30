import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'bun:test';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { INVOICE_CHAT_GOAL, appError, fail, ok } from '@flowmate/contracts';
import type { AgentToolBinding, PromptTraceBuffer, ToolDefinition } from '@flowmate/contracts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import type { AgentExecutionInput, AgentObservation } from '../../packages/contracts/src/ports.ts';
import type { ProviderConfig } from '../../packages/contracts/src/runtime.ts';
import { z } from 'zod';

const endpoint = 'https://fixture.invalid/v1';
const fixtureRoots = new Set<string>();
const fixtureAdapters = new Set<PiAgentAdapter>();
const input = (runId: number, sessionId: number, text: string): AgentExecutionInput => ({
  runId, sessionId, goal: INVOICE_CHAT_GOAL, text, messageTimestamp: 1_790_000_000_000,
  verifyModelUse: () => ok(undefined),
});

function sse(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'fixture-response', model: 'invoice-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function response(text = 'fixture answer'): Response {
  return new Response(`${sse({ role: 'assistant', content: text })}${sse({}, 'stop')}data: [DONE]\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

function toolCallResponse(id: string, name: string, args: unknown): Response {
  return new Response(`${sse({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] })}${sse({}, 'tool_calls')}data: [DONE]\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files.push(child.slice(root.length).replaceAll('\\', '/'));
    }
  }
  await walk(root);
  return files.sort();
}

async function fixture(
  reply: (request: Request) => Promise<Response> | Response = async () => response(),
  runtimeApiKey: string | null = 'fixture-only-key',
  promptTrace?: PromptTraceBuffer,
  tools?: readonly ToolDefinition<any, any>[],
) {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p2-agent-'));
  fixtureRoots.add(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(join(cwd, 'AGENTS.md'), 'DO_NOT_DISCOVER_PROJECT_RESOURCES');
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'extensions', 'probe.mjs'), 'throw new Error("unexpected extension load")');
  const requests: { body: { model?: string; messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] }; authorization: string | null }[] = [];
  const adapter = new PiAgentAdapter({
    cwd,
    agentDir,
    credentials: new InMemoryCredentialStore(),
    runtimeApiKey: runtimeApiKey ?? undefined,
    fetch: async (request, init) => {
      const native = request instanceof Request ? request.clone() : new Request(request, init);
      requests.push({ body: await native.json(), authorization: native.headers.get('authorization') });
      return reply(native);
    },
    promptTrace,
    tools,
  });
  fixtureAdapters.add(adapter);
  return { root, cwd, agentDir, requests, adapter };
}

afterEach(async () => {
  await Promise.all([...fixtureAdapters].map((adapter) => adapter.close()));
  fixtureAdapters.clear();
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  fixtureRoots.clear();
});

const config: ProviderConfig = {
  version: 1,
  name: 'Invoice model',
  revision: 1,
  modelRef: { provider: 'flowmate-agent-fixture', model: 'invoice-fixture' },
  native: { authPath: join(tmpdir(), 'flowmate-no-auth.json'), modelsPath: null },
  connection: { baseUrl: endpoint, api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384 },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 },
};

describe('PiAgentAdapter', () => {
  it('publishes saved message snapshots with real entries and keeps their bridge after the Run', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    if (!created.ok) throw new Error('fixture session');
    const bindings: Array<{ entryId: string; runId: number }> = [];
    let saved = app.adapter.exportSession(created.data.nativeSessionId);
    expect(app.adapter.watchSession(created.data.nativeSessionId, (history, context) => {
      saved = ok(history);
      if (context) bindings.push(context);
      return ok(undefined);
    }).ok).toBe(true);
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config,
      { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.code);
    const observations: AgentObservation[] = [];
    const runInput = input(104, 204, 'What is the fixture total?');
    const result = await prepared.data.execute(runInput, new AbortController().signal, (event) => observations.push(event));
    expect(result.error).toBeNull();
    const messages = observations.filter((event) => event.type === 'display_message');
    expect(messages.some((event) => event.message.role === 'user' && event.message.persistence === 'saved')).toBe(true);
    expect(messages.some((event) => event.message.role === 'assistant' && event.message.persistence === 'saved')).toBe(true);
    expect(bindings.length).toBe(2);
    if (!saved.ok) throw new Error(saved.error.code);
    const projected = app.adapter.projectSessionMessages({ history: saved.data, bindings,
      runInputs: [{ runId: 104, input: { version: 1, goal: runInput.goal, text: runInput.text,
        messageTimestamp: runInput.messageTimestamp }, goalMode: null }], limit: 50 });
    expect(projected.ok).toBe(true);
    if (!projected.ok) throw new Error(projected.error.code);
    expect(projected.data.items.map((item) => item.liveOrdinal)).toEqual([1, 2]);
    expect(projected.data.items.every((item) => item.entryId !== null && item.runId === 104)).toBe(true);
    expect((await app.adapter.releaseSession(created.data.nativeSessionId)).closed).toBe(true);
    const noBridge = app.adapter.projectSessionMessages({ history: saved.data, bindings,
      runInputs: [{ runId: 104, input: { version: 1, goal: runInput.goal, text: runInput.text,
        messageTimestamp: runInput.messageTimestamp }, goalMode: null }], limit: 50 });
    expect(noBridge.ok && noBridge.data.items.every((item) => item.liveOrdinal === null)).toBe(true);
  });

  it('checks current model permission before conversion and sends no request after revocation', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    if (!created.ok) throw new Error('fixture session');
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config,
      { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.code);
    const result = await prepared.data.execute({ ...input(105, 205, 'Forbidden after revocation'),
      verifyModelUse: () => fail(appError('session_scope_revoked', 'session', 'Revoked fixture')) },
    new AbortController().signal, () => undefined);
    expect(app.requests).toHaveLength(0);
    expect(result.error?.code).toBe('session_scope_revoked');
  });

  it('stops immediately on user persistence failure and retains only the committed prefix', async () => {
    const app = await fixture();
    const native = app.adapter.createSession();
    if (!native.ok) throw new Error(native.error.message);
    let saved = app.adapter.exportSession(native.data.nativeSessionId);
    const attempted: import('@flowmate/contracts').NativeSessionHistory[] = [];
    let failed = false;
    app.adapter.watchSession(native.data.nativeSessionId, (history) => {
      attempted.push(structuredClone(history));
      if (!failed && history.entries.some((entry) => entry.type === 'message' && (entry.message as { role?: string }).role === 'user')) {
        failed = true;
        return fail(appError('storage_write_failed', 'storage', 'Controlled user save failure.'));
      }
      saved = ok(structuredClone(history));
      return ok(undefined);
    });
    const prepared = await app.adapter.prepare(native.data.nativeSessionId, config, { timeoutMs: 60000, stopGraceMs: 5000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const events: AgentObservation[] = [];
    const outcome = await prepared.data.execute(input(106, 206, 'Fail this user save.'), new AbortController().signal, (event) => events.push(event));
    expect(outcome.error?.code).toBe('storage_write_failed');
    expect(outcome.stopped).toBe(true);
    expect(app.requests).toHaveLength(0);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.data.unusable).toBe(true);
    expect(saved.data.entries.filter((entry) => entry.type === 'message')).toHaveLength(0);
    const firstFailure = attempted.findIndex((history) => history.entries.some((entry) => entry.type === 'message'));
    expect(attempted.slice(firstFailure + 1).every((history) => !history.entries.some((entry) => entry.type === 'message'))).toBe(true);
    expect(events.filter((event) => event.type === 'display_message').map((event) => event.message.persistence)).toContain('failed');
    expect(events.some((event) => event.type === 'display_message' && event.message.persistence === 'saved')).toBe(false);
  });

  it('rechecks permission at fetch after the SDK has converted model messages', async () => {
    const app = await fixture();
    const native = app.adapter.createSession();
    if (!native.ok) throw new Error(native.error.message);
    const prepared = await app.adapter.prepare(native.data.nativeSessionId, config, { timeoutMs: 60000, stopGraceMs: 5000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.message);
    let revoked = false;
    const outcome = await prepared.data.execute({ ...input(107, 207, 'Revoke before dispatch.'),
      verifyModelUse: () => revoked ? fail(appError('session_scope_revoked', 'session', 'Revoked before fetch.')) : ok(undefined) },
    new AbortController().signal, (event) => { if (event.type === 'request_budget') revoked = true; });
    expect(app.requests).toHaveLength(0);
    expect(outcome.error?.code).toBe('session_scope_revoked');
    expect(outcome.stopped).toBe(true);
  });

  it.each(['return', 'throw'] as const)('retains the saved prefix and settles an actual stop when final save fails by %s', async (mode) => {
    const app = await fixture();
    const native = app.adapter.createSession();
    if (!native.ok) throw new Error(native.error.message);
    let saved = app.adapter.exportSession(native.data.nativeSessionId);
    let finalFailed = false;
    app.adapter.watchSession(native.data.nativeSessionId, (history, context) => {
      if (!finalFailed && context === undefined && history.entries.filter((entry) => entry.type === 'message').length === 2) {
        finalFailed = true;
        if (mode === 'throw') throw new Error('Controlled final save exception.');
        return fail(appError('storage_write_failed', 'storage', 'Controlled final save failure.'));
      }
      saved = ok(structuredClone(history));
      return ok(undefined);
    });
    const prepared = await app.adapter.prepare(native.data.nativeSessionId, config, { timeoutMs: 60000, stopGraceMs: 5000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const outcome = await prepared.data.execute(input(108, 208, 'Save before finishing.'), new AbortController().signal, () => undefined);
    expect(finalFailed).toBe(true);
    expect(outcome.error?.code).toBe('storage_write_failed');
    expect(outcome.stopped).toBe(true);
    expect(app.requests).toHaveLength(1);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.data.entries.filter((entry) => entry.type === 'message')).toHaveLength(2);
    expect(saved.data.unusable).toBe(true);
    expect(app.adapter.inspect(native.data.nativeSessionId).availability).toBe('unusable');
    expect((await app.adapter.releaseSession(native.data.nativeSessionId)).closed).toBe(true);
    expect(app.adapter.restoreSession(native.data.nativeSessionId, saved.data)).toMatchObject({ ok: false, error: { code: 'session_history_invalid' } });
  });

  it('rejects uncloneable native data without leaving a stopped Session busy or saving its tail', async () => {
    const app = await fixture();
    const nativeId = app.adapter.createSession();
    if (!nativeId.ok) throw new Error(nativeId.error.message);
    let saved = app.adapter.exportSession(nativeId.data.nativeSessionId);
    app.adapter.watchSession(nativeId.data.nativeSessionId, (history) => { saved = ok(history); return ok(undefined); });
    const prepared = await app.adapter.prepare(nativeId.data.nativeSessionId, config, { timeoutMs: 60000, stopGraceMs: 5000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const records = (app.adapter as unknown as { sessions: Map<string, { session: AgentSession }> }).sessions;
    const native = records.get(nativeId.data.nativeSessionId)!.session;
    const unsubscribe = native.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'user') Reflect.set(event.message, 'illegalService', () => undefined);
    });
    try {
      const outcome = await prepared.data.execute(input(109, 209, 'Reject native service fields.'), new AbortController().signal, () => undefined);
      expect(outcome.error?.code).toBe('session_history_invalid');
      expect(outcome.stopped).toBe(true);
      expect(app.requests).toHaveLength(0);
      if (!saved.ok) throw new Error(saved.error.message);
      expect(saved.data.entries.filter((entry) => entry.type === 'message')).toHaveLength(0);
      expect(saved.data.unusable).toBe(true);
      expect((await app.adapter.releaseSession(nativeId.data.nativeSessionId)).closed).toBe(true);
    } finally { unsubscribe(); }
  });

  it.each(['content', 'usage'] as const)('settles malformed native assistant %s without reading the rejected object again', async (field) => {
    const app = await fixture(() => response(field === 'content' ? '' : 'fixture answer'));
    const created = app.adapter.createSession();
    if (!created.ok) throw new Error(created.error.message);
    let saved = app.adapter.exportSession(created.data.nativeSessionId);
    app.adapter.watchSession(created.data.nativeSessionId, (history) => { saved = ok(history); return ok(undefined); });
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60000, stopGraceMs: 5000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const records = (app.adapter as unknown as { sessions: Map<string, { session: AgentSession }> }).sessions;
    const native = records.get(created.data.nativeSessionId)!.session;
    const unsubscribe = native.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') Reflect.set(event.message, field, null);
    });
    try {
      const outcome = await prepared.data.execute(input(110, 210, 'Reject malformed assistant.'), new AbortController().signal, () => undefined);
      expect(outcome.error?.code).toBe('session_history_invalid');
      expect(outcome.stopped).toBe(true);
      expect(app.requests).toHaveLength(1);
      if (!saved.ok) throw new Error(saved.error.message);
      expect(saved.data.entries.filter((entry) => entry.type === 'message')).toHaveLength(1);
      expect(saved.data.unusable).toBe(true);
      expect((await app.adapter.releaseSession(created.data.nativeSessionId)).closed).toBe(true);
    } finally { unsubscribe(); }
  });

  it.each(['orphan', 'duplicate', 'wrong-name', 'unknown-role', 'unknown-block'] as const)
    ('rejects injected %s working memory before any Provider request', async (kind) => {
    const app = await fixture();
    const created = app.adapter.createSession();
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60000, stopGraceMs: 5000 }, new AbortController().signal);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const records = (app.adapter as unknown as { sessions: Map<string, { session: AgentSession }> }).sessions;
    const native = records.get(created.data.nativeSessionId)!.session;
    const assistant = { role: 'assistant', content: [{ type: 'toolCall', id: 'bad-call', name: 'probe', arguments: {} }],
      api: 'openai-completions', provider: 'fixture', model: 'invoice-fixture', timestamp: 1, stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const result = { role: 'toolResult', toolCallId: 'bad-call', toolName: kind === 'wrong-name' ? 'wrong' : 'probe',
      content: [{ type: 'text', text: '{}' }], isError: false, timestamp: 2 };
    const messages = kind === 'orphan' ? [result] : kind === 'duplicate' ? [assistant, result, result]
      : kind === 'wrong-name' ? [assistant, result] : kind === 'unknown-role' ? [{ role: 'invented', content: '', timestamp: 1 }]
        : [{ role: 'user', content: [{ type: 'invented', text: '' }], timestamp: 1 }];
    native.state.messages.push(...messages as unknown as typeof native.state.messages);
    const outcome = await prepared.data.execute(input(111, 211, 'Do not dispatch invalid history.'), new AbortController().signal, () => undefined);
    expect(outcome.error?.code).toBe('session_history_invalid');
    expect(outcome.stopped).toBe(true);
    expect(app.requests).toHaveLength(0);
    expect((await app.adapter.releaseSession(created.data.nativeSessionId)).closed).toBe(true);
  });

  it('restores the native message history after a process boundary', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const nativeId = created.data.nativeSessionId;
    let saved = app.adapter.exportSession(nativeId);
    expect(saved.ok).toBe(true);
    expect(app.adapter.watchSession(nativeId, (history) => { saved = ok(history); return ok(undefined); }).ok).toBe(true);
    const first = await app.adapter.prepare(nativeId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await first.data.execute(input(101, 201, 'Invoice total is 1060.'), new AbortController().signal, () => undefined)).error).toBeNull();
    expect(saved.ok && saved.data.entries.length > 1).toBe(true);
    expect((await app.adapter.releaseSession(nativeId)).closed).toBe(true);
    if (!saved.ok) return;
    expect(app.adapter.restoreSession(nativeId, saved.data)).toEqual(ok(undefined));
    expect(app.adapter.watchSession(nativeId, (history) => { saved = ok(history); return ok(undefined); }).ok).toBe(true);
    const second = await app.adapter.prepare(nativeId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((await second.data.execute(input(102, 201, 'What was the total?'), new AbortController().signal, () => undefined)).error).toBeNull();
    expect(JSON.stringify(app.requests[1]?.body.messages)).toContain('Invoice total is 1060.');
    expect(app.adapter.inspect(nativeId).availability).toBe('ready');
  });
  it('blocks later sends when native history cannot be saved', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const nativeId = created.data.nativeSessionId;
    expect(app.adapter.watchSession(nativeId, () => fail(appError('storage_write_failed', 'storage', 'Fixture write failed.'))))
      .toEqual(ok(undefined));
    const prepared = await app.adapter.prepare(nativeId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(app.adapter.inspect(nativeId).availability).toBe('unusable');
    expect(await app.adapter.prepare(nativeId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal))
      .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
    expect(app.requests).toHaveLength(0);
  });
  it('executes an authorized tool in P3 and sends its result in the next model request', async () => {
    const replies = [toolCallResponse('p3-call-1', 'probe_read', { value: 7 }), response('The checked value is 7.')];
    for (let index = 0; index < replies.length; index += 1) {
      const body = (await replies[index]!.text()).replace('data: [DONE]',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]');
      replies[index] = new Response(body, { headers: replies[index]!.headers });
    }
    const tool: ToolDefinition<{ value: number }, { value: number }> = {
      name: 'probe_read', version: '1', description: 'Read the controlled test value.', label: 'Read value',
      inputSchema: z.object({ value: z.number().int() }).strict(),
      outputSchema: z.object({ value: z.number().int() }).strict(),
      effect: 'READ', executionMode: 'parallel',
      async execute(inputValue) { return { value: inputValue.value }; },
    };
    const app = await fixture(() => replies.shift() ?? response(), 'fixture-only-key', undefined, [tool]);
    const events: string[] = [];
    const binding: AgentToolBinding = {
      context: { runId: 902, sessionId: 19, scope: { version: 2, allowedTools: ['probe_read'],
        allowedDocumentIds: [1], allowedArtifactIds: [2], allowedResourcePaths: [] } },
      observeRequest(name, raw, call) { events.push(`requested:${name}:${call.nativeToolCallId}:${JSON.stringify(raw)}`); return ok(undefined); },
      rejectRequest(name, raw, call) { events.push(`rejected:${name}:${call.nativeToolCallId}:${JSON.stringify(raw)}`); return ok(undefined); },
      recordDelivery(id, delivery) { events.push(`delivery:${id}:${delivery.state}:${delivery.includedInCallSequence ?? ''}`); return ok(undefined); },
      async execute(name, args, call) {
        events.push(`executed:${name}:${call.nativeToolCallId}:${JSON.stringify(args)}`);
        return { result: { status: 'succeeded', data: { value: 7 } }, fatal: false };
      },
    };
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    let saved = app.adapter.exportSession(created.data.nativeSessionId);
    expect(saved.ok).toBe(true);
    expect(app.adapter.watchSession(created.data.nativeSessionId, (history) => { saved = ok(history); return ok(undefined); }).ok).toBe(true);
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config,
      { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal, { activeToolNames: ['probe_read'] });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const runInput: AgentExecutionInput = { ...input(902, 19, 'Use the controlled value.'),
      workspaceInput: { documentRef: { id: 1, version: 'v1' }, job: null, candidate: null }, goalMode: 'answer', toolBinding: binding };
    const outcome = await prepared.data.execute(runInput, new AbortController().signal, () => undefined);
    expect(outcome.error).toBeNull();
    expect(outcome.text).toBe('The checked value is 7.');
    expect(outcome.agent.modelCallCount).toBe(2);
    expect(outcome.usage.version).toBe(2);
    if (outcome.usage.version === 2) expect(outcome.usage.calls.map((call) => call.callSequence)).toEqual([1, 2]);
    expect(outcome.tokens).toEqual({ inputTokens: 6, outputTokens: 4, totalTokens: 10, cost: null, usageComplete: false });
    expect(app.requests).toHaveLength(2);
    const systemMessage = app.requests[0]?.body.messages?.find((message) => message.role === 'system');
    expect(String(systemMessage?.content)).toContain('validate_invoice_candidate is read-only');
    expect(String(systemMessage?.content)).toContain('save_invoice_candidate');
    expect(app.requests[0]?.body.tools?.some((entry) => JSON.stringify(entry).includes('probe_read'))).toBe(true);
    expect(JSON.stringify(app.requests[1]?.body.messages)).toContain('probe_read');
    expect(JSON.stringify(app.requests[1]?.body.messages)).toContain('7');
    expect(events).toEqual([
      'requested:probe_read:p3-call-1:{"value":7}',
      'executed:probe_read:p3-call-1:{"value":7}',
      'delivery:p3-call-1:message_observed:',
      'delivery:p3-call-1:request_observed:2',
    ]);
    if (!saved.ok) return;
    expect(JSON.stringify(saved.data.entries)).toContain('p3-call-1');
    expect((await app.adapter.releaseSession(created.data.nativeSessionId)).closed).toBe(true);
    expect(app.adapter.restoreSession(created.data.nativeSessionId, saved.data)).toEqual(ok(undefined));
    const changed = await app.adapter.prepare(created.data.nativeSessionId,
      { ...config, modelRef: { ...config.modelRef, model: 'different-model' } },
      { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal, { activeToolNames: ['probe_read'] });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    const followup = await changed.data.execute({ ...runInput, runId: 904, text: 'What value did the tool return?',
      toolBinding: { ...binding, context: { ...binding.context, runId: 904 } } },
    new AbortController().signal, () => undefined);
    expect(followup.error).toBeNull();
    expect(app.requests[2]?.body.model).toBe('different-model');
    expect(app.requests[2]?.body.tools?.some((entry) => JSON.stringify(entry).includes('probe_read'))).toBe(true);
    expect(JSON.stringify(app.requests[2]?.body.messages)).toContain('p3-call-1');
    expect(JSON.stringify(app.requests[2]?.body.messages)).toContain('7');
    expect(events).toHaveLength(4);
  });

  it('records an unexposed tool request without executing its business logic', async () => {
    const tool: ToolDefinition<{ value: number }, { value: number }> = {
      name: 'probe_read', version: '1', label: 'Read value', description: 'Read a controlled value.',
      inputSchema: z.object({ value: z.number().int() }).strict(), outputSchema: z.object({ value: z.number().int() }).strict(),
      effect: 'READ', executionMode: 'parallel', async execute(inputValue) { return inputValue; },
    };
    const replies = [toolCallResponse('blocked-call', 'probe_read', { value: 7 }), response('I cannot use that tool.')];
    const app = await fixture(() => replies.shift() ?? response(), 'fixture-only-key', undefined, [tool]);
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const denied: string[] = [];
    let executed = false;
    const binding: AgentToolBinding = {
      context: { runId: 905, sessionId: 19, scope: { version: 2, allowedTools: [],
        allowedDocumentIds: [1], allowedArtifactIds: [2], allowedResourcePaths: [] } },
      observeRequest: () => ok(undefined),
      rejectRequest: (_name, _raw, _call, error) => { denied.push(error.code); return ok(undefined); },
      recordDelivery: () => ok(undefined),
      async execute() { executed = true; return { result: { status: 'succeeded', data: { value: 7 } }, fatal: false }; },
    };
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config,
      { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal, { activeToolNames: [] });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const outcome = await prepared.data.execute({ ...input(905, 19, 'Check the value.'),
      workspaceInput: { documentRef: { id: 1, version: 'v1' }, job: null, candidate: null },
      goalMode: 'answer', toolBinding: binding }, new AbortController().signal, () => undefined);
    expect(app.requests[0]?.body.tools ?? []).toEqual([]);
    expect(denied).toContain('tool_access_denied');
    expect(executed).toBe(false);
    expect(outcome.error).toBeNull();
  });

  it('blocks every P3 dispatch when the final native history contains an image and requires a new Session', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config,
      { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal, { activeToolNames: [] });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const runtime = app.adapter as unknown as { sessions: Map<string, { session?: AgentSession }> };
    const native = runtime.sessions.get(created.data.nativeSessionId)?.session;
    expect(native).toBeDefined();
    if (!native) return;
    native.state.messages.push({
      role: 'toolResult', toolCallId: 'legacy-image-result', toolName: 'read_invoice_evidence',
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }], details: { kind: 'original' },
      isError: false, timestamp: 1,
    } as never);
    const binding: AgentToolBinding = {
      context: { runId: 903, sessionId: 20, scope: { version: 2, allowedTools: [],
        allowedDocumentIds: [1], allowedArtifactIds: [2], allowedResourcePaths: [] } },
      observeRequest: () => ok(undefined), rejectRequest: () => ok(undefined), recordDelivery: () => ok(undefined),
      execute: async () => ({ result: { status: 'succeeded', data: {} }, fatal: false }),
    };
    const outcome = await prepared.data.execute({ ...input(903, 20, 'Continue the prior task.'),
      workspaceInput: { documentRef: { id: 1, version: 'v1' }, job: null, candidate: null },
      goalMode: 'answer', toolBinding: binding }, new AbortController().signal, () => undefined);
    expect(app.requests).toHaveLength(0);
    expect(outcome.error).toMatchObject({ code: 'agent_image_history_blocked' });
    expect(outcome.error?.message).toContain('New Session');
    expect(app.adapter.inspect(created.data.nativeSessionId)).toEqual({ availability: 'unusable' });
  });

  it('creates independent native sessions without requests and preserves same-session context', async () => {
    const app = await fixture();
    const directories = await filesUnder(app.root);
    const a = app.adapter.createSession();
    const b = app.adapter.createSession();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.nativeSessionId).not.toBe(b.data.nativeSessionId);
    expect(app.requests).toHaveLength(0);
    expect(app.adapter.inspect(a.data.nativeSessionId).availability).toBe('ready');

    const preparedA = await app.adapter.prepare(a.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(preparedA.ok).toBe(true);
    if (!preparedA.ok) return;
    expect(app.requests).toHaveLength(0);
    expect(app.adapter.inspect(a.data.nativeSessionId).availability).toBe('ready');

    const observations: unknown[] = [];
    const first = await preparedA.data.execute(input(1, 101, 'INVOICE_A: 发票号 INV-2048，价税合计 1060.00 元。'), new AbortController().signal, (event) => observations.push(event));
    const followupPrepared = await app.adapter.prepare(a.data.nativeSessionId, { ...config, name: 'renamed', revision: 2 }, { timeoutMs: 30_000, stopGraceMs: 3_000 }, new AbortController().signal);
    expect(followupPrepared.ok).toBe(true);
    if (!followupPrepared.ok) return;
    const followup = await followupPrepared.data.execute(input(2, 101, '刚才那张发票的价税合计是多少？'), new AbortController().signal, () => undefined);
    const preparedB = await app.adapter.prepare(b.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(preparedB.ok).toBe(true);
    if (!preparedB.ok) return;
    const isolated = await preparedB.data.execute(input(3, 102, '另一张发票号 INV-9001。'), new AbortController().signal, () => undefined);

    expect([first.error, followup.error, isolated.error]).toEqual([null, null, null]);
    expect(first.text).toBe('fixture answer');
    expect(first.agent).toMatchObject({ nativeSessionId: a.data.nativeSessionId, turnCount: 1, modelCallCount: 1 });
    expect([first.stopped, followup.stopped, isolated.stopped]).toEqual([true, true, true]);
    expect(app.requests.map((request) => request.body.messages?.filter((message) => message.role !== 'system').length)).toEqual([1, 3, 1]);
    expect(JSON.stringify(app.requests[1].body)).toContain('INVOICE_A');
    expect(JSON.stringify(app.requests[2].body)).not.toContain('INVOICE_A');
    expect(app.requests.every((request) => (request.body.tools ?? []).length === 0)).toBe(true);
    expect(app.requests.every((request) => request.authorization === 'Bearer fixture-only-key')).toBe(true);
    expect(observations.some((value) => (value as { type?: string }).type === 'agent_event')).toBe(true);
    expect(JSON.stringify(observations.filter((value) => !['display_message', 'display_text_delta'].includes((value as { type: string }).type)))).not.toContain('INVOICE_A');
    expect(app.adapter.inspect(a.data.nativeSessionId).availability).toBe('ready');
    expect((await filesUnder(app.root))).toEqual(directories);
    expect(await app.adapter.releaseSession(a.data.nativeSessionId)).toMatchObject({ stopped: true, closed: true });
    expect(app.adapter.inspect(a.data.nativeSessionId).availability).toBe('missing');
    await app.adapter.close();
    await rm(app.root, { recursive: true, force: true });
  });

  it('keeps a successful Run successful when Prompt Trace cleanup throws', async () => {
    const promptTrace: PromptTraceBuffer = {
      begin() {},
      append() {},
      end() { throw new Error('diagnostic-only trace failure'); },
      clearSession() {},
      query() { throw new Error('diagnostic-only query failure'); },
    };
    const app = await fixture(undefined, 'fixture-only-key', promptTrace);
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const outcome = await prepared.data.execute(input(8, 208, '诊断异常不能改变业务执行结果'), new AbortController().signal, () => undefined);

    expect(app.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ text: 'fixture answer', error: null, stopped: true });
  });

  it('switches the model within the same native session and retains its history', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const first = await prepared.data.execute(input(1, 201, '发票号 INV-2048，价税合计 1060 元。'), new AbortController().signal, () => undefined);
    const changed = await app.adapter.prepare(created.data.nativeSessionId, {
      ...config, modelRef: { ...config.modelRef, model: 'different-model' },
    }, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    const second = await changed.data.execute(input(2, 201, '刚才那张发票的价税合计是多少？'), new AbortController().signal, () => undefined);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(app.requests.map((request) => request.body.model)).toEqual(['invoice-fixture', 'different-model']);
    expect(JSON.stringify(app.requests[1].body)).toContain('INV-2048');
    expect(second.agent.nativeSessionId).toBe(created.data.nativeSessionId);
    expect(app.adapter.inspect(created.data.nativeSessionId).availability).toBe('ready');
    await app.adapter.close();
    await rm(app.root, { recursive: true, force: true });
  });

  it('bounds visible output and refuses reuse after a prompted run fails', async () => {
    const app = await fixture(async () => response('x'.repeat(256 * 1024 + 1)));
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const outcome = await prepared.data.execute(input(1, 201, '输出上限 fixture'), new AbortController().signal, () => undefined);
    expect(outcome.error?.code).toBe('agent_output_limit');
    expect(new TextEncoder().encode(outcome.text).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(outcome.stopped).toBe(true);
    expect(app.adapter.inspect(created.data.nativeSessionId).availability).toBe('unusable');
    const again = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(again).toMatchObject({ ok: false, error: { code: 'agent_session_unusable' } });
    await app.adapter.close();
  });

  it('does not fall back to a missing runtime key and keeps prepare failures before prompt retryable', async () => {
    const app = await fixture(async () => response(), null);
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const nativeConfig: ProviderConfig = {
        ...config,
        modelRef: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        connection: undefined,
      };
      const prepared = await app.adapter.prepare(created.data.nativeSessionId, nativeConfig, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
      expect(prepared).toMatchObject({ ok: false, error: { code: 'provider_auth_failed' } });
      expect(app.adapter.inspect(created.data.nativeSessionId).availability).toBe('ready');
      expect(app.requests).toHaveLength(0);
    } finally {
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
    }
  });

  it('blocks the SDK preflight abort race before it can send a request', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const preflight = deferred<void>();
    const resume = deferred<void>();
    const originalHasConfiguredAuth = ModelRuntime.prototype.hasConfiguredAuth;
    const originalCheckAuth = ModelRuntime.prototype.checkAuth;
    ModelRuntime.prototype.hasConfiguredAuth = () => false;
    ModelRuntime.prototype.checkAuth = async function (providerId, options) {
      preflight.resolve();
      await resume.promise;
      return originalCheckAuth.call(this, providerId, options);
    };
    const controller = new AbortController();
    try {
      const execution = prepared.data.execute(input(1, 301, '取消竞态'), controller.signal, () => undefined);
      await preflight.promise;
      controller.abort('fixture cancellation');
      resume.resolve();
      const outcome = await execution;
      expect(outcome.error?.code).toBe('agent_cancelled');
      expect(outcome.stopped).toBe(true);
      expect(outcome.agent.modelCallCount).toBe(0);
      expect(app.requests).toHaveLength(0);
      expect(app.adapter.inspect(created.data.nativeSessionId).availability).toBe('unusable');
    } finally {
      resume.resolve();
      ModelRuntime.prototype.checkAuth = originalCheckAuth;
      ModelRuntime.prototype.hasConfiguredAuth = originalHasConfiguredAuth;
    }
  });

  it('keeps the session busy while an abort-ignoring transport is unresolved', async () => {
    const entered = deferred<void>();
    const releaseResponse = deferred<Response>();
    const app = await fixture(() => { entered.resolve(); return releaseResponse.promise; });
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const controller = new AbortController();
    const execution = prepared.data.execute(input(1, 401, '慢速传输取消'), controller.signal, () => undefined);
    await entered.promise;
    controller.abort('fixture cancellation');
    expect(await app.adapter.releaseSession(created.data.nativeSessionId)).toMatchObject({ stopped: false, closed: false });
    releaseResponse.resolve(response('late response'));
    const outcome = await execution;
    expect(outcome.stopped).toBe(true);
    expect(outcome.error?.code).toBe('agent_cancelled');
    expect(app.adapter.inspect(created.data.nativeSessionId).availability).toBe('unusable');
  });

  it('rejects oversized complete context before entering the provider', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const outcome = await prepared.data.execute(input(1, 501, 'x'.repeat(520 * 1024)), new AbortController().signal, () => undefined);
    expect(outcome.error?.code).toBe('agent_context_limit');
    expect(outcome.agent.modelCallCount).toBe(0);
    expect(outcome.stopped).toBe(true);
    expect(app.requests).toHaveLength(0);
  });

  it('bounds native assistant content even when visible text is empty', async () => {
    const app = await fixture(() => new Response([
      sse({ role: 'assistant', reasoning_content: 'r'.repeat(512 * 1024 + 1) }),
      sse({}, 'stop'),
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const outcome = await prepared.data.execute(input(1, 551, '隐藏原生内容限制'), new AbortController().signal, () => undefined);
    expect(outcome.error?.code).toBe('agent_content_limit');
    expect(outcome.text).toBe('');
    expect(outcome.stopped).toBe(true);
  });

  it('stops on an unexpected tool call and never starts a continuation request', async () => {
    const app = await fixture(() => new Response([
      sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'read', arguments: '{}' } }] }),
      sse({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const observations: AgentObservation[] = [];
    const outcome = await prepared.data.execute(input(1, 601, '不得调用工具'), new AbortController().signal, (event) => observations.push(event));
    expect(outcome.error?.code).toBe('agent_unexpected_tool_call');
    expect(outcome.stopped).toBe(true);
    expect(outcome.agent.modelCallCount).toBe(1);
    expect(app.requests).toHaveLength(1);
    expect((app.requests[0].body.tools ?? []).length).toBe(0);
    expect(observations.some((event) => event.type === 'agent_event' && event.data.eventName === 'tool_execution_start')).toBe(false);
  });

  it('does not retry a failed provider response at the AgentSession layer', async () => {
    const app = await fixture(() => new Response(JSON.stringify({ error: { message: 'fixture failure' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    }));
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const outcome = await prepared.data.execute(input(1, 701, '服务端错误'), new AbortController().signal, () => undefined);
    expect(outcome.error?.category).toBe('provider');
    expect(outcome.stopped).toBe(true);
    expect(app.requests).toHaveLength(1);
  });

  it('reports a rejected provider response instead of hiding it as a missing P3 final reply', async () => {
    const app = await fixture(() => new Response(JSON.stringify({ error: { message: 'fixture failure Bearer top-secret sk-abcdefghijklmnopqrstuvwxyz0123456789' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }));
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config,
      { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal, { activeToolNames: [] });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const binding: AgentToolBinding = {
      context: { runId: 702, sessionId: 702, scope: { version: 2, allowedTools: [],
        allowedDocumentIds: [1], allowedArtifactIds: [2], allowedResourcePaths: [] } },
      observeRequest: () => ok(undefined), rejectRequest: () => ok(undefined), recordDelivery: () => ok(undefined),
      execute: async () => ({ result: { status: 'succeeded', data: {} }, fatal: false }),
    };
    const runInput: AgentExecutionInput = { ...input(702, 702, '准备发票候选'),
      workspaceInput: { documentRef: { id: 1, version: 'v1' }, job: null, candidate: null },
      goalMode: 'answer', toolBinding: binding };

    const outcome = await prepared.data.execute(runInput, new AbortController().signal, () => undefined);

    expect(app.requests).toHaveLength(1);
    expect(outcome.error).toMatchObject({ code: 'provider_request_rejected', category: 'provider', retryable: false });
    expect(outcome.error?.message).toContain('HTTP 400');
    expect(outcome.error?.message).toContain('fixture failure');
    expect(outcome.error?.message).toContain('Bearer [REDACTED]');
    expect(outcome.error?.message).not.toContain('top-secret');
    expect(outcome.error?.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('reports disposal failures and can release the idle session after cleanup recovers', async () => {
    const app = await fixture();
    const created = app.adapter.createSession();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const prepared = await app.adapter.prepare(created.data.nativeSessionId, config, { timeoutMs: 60_000, stopGraceMs: 5_000 }, new AbortController().signal);
    expect(prepared.ok).toBe(true);
    const dispose = AgentSession.prototype.dispose;
    AgentSession.prototype.dispose = function () { throw new Error('fixture disposal failure'); };
    try {
      expect(await app.adapter.releaseSession(created.data.nativeSessionId)).toMatchObject({
        stopped: true, closed: false, errors: [{ code: 'agent_cleanup_failed' }],
      });
    } finally {
      AgentSession.prototype.dispose = dispose;
    }
    expect(await app.adapter.releaseSession(created.data.nativeSessionId)).toMatchObject({ stopped: true, closed: true });
  });
});
