import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'bun:test';
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { INVOICE_CHAT_GOAL } from '@flowmate/contracts';
import type { PromptTraceBuffer } from '@flowmate/contracts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import type { AgentExecutionInput, NativeObservation } from '../../packages/contracts/src/ports.ts';
import type { ProviderConfig } from '../../packages/contracts/src/runtime.ts';

const endpoint = 'https://fixture.invalid/v1';
const fixtureRoots = new Set<string>();
const fixtureAdapters = new Set<PiAgentAdapter>();
const input = (runId: number, sessionId: number, text: string): AgentExecutionInput => ({
  runId, sessionId, goal: INVOICE_CHAT_GOAL, text, messageTimestamp: 1_790_000_000_000,
});

function sse(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'fixture-response', model: 'invoice-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function response(text = 'fixture answer'): Response {
  return new Response(`${sse({ role: 'assistant', content: text })}${sse({}, 'stop')}data: [DONE]\n\n`, {
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
  connection: { baseUrl: endpoint, api: 'openai-completions' },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 },
};

describe('PiAgentAdapter', () => {
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
    expect(JSON.stringify(observations)).not.toContain('INVOICE_A');
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
    const observations: NativeObservation[] = [];
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
