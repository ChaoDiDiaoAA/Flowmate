import { expect, it } from 'bun:test';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createAgentSession, createReadTool, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type CreateAgentSessionOptions, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import * as plugin from '@tintinweb/pi-subagents/dist/index.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync, writeFileSync } from 'node:fs';
import { createHttpProvider, deferCleanup, mkdtempSync } from '../support/resources.ts';
const sourcePlugin = await import(String('@tintinweb/pi-subagents/src/index.ts'));

type Control = {
  role: { name: string; description: string; systemPrompt: string; promptMode: 'replace'; extensions: false; skills: false };
  beforeCreate(agentId: string): Promise<{ options: CreateAgentSessionOptions; promptText: string;
    attach(session: AgentSession): Promise<void>;
    settle(input: { session: AgentSession | null; error: unknown | null }): Promise<void> }>;
};
const delegate = { prompt: 'Read evidence.txt and report the evidence.', description: 'Check source', subagent_type: 'invoice-evidence-checker' };
function factory(input: { controlForCall(id: string): Control }, source = false): ExtensionFactory {
  const create = Reflect.get(source ? sourcePlugin : plugin, 'createManagedSubagentExtension');
  expect(typeof create).toBe('function');
  return create(input);
}
function response(delta: Record<string, unknown>, end = 'stop') {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(chunk({ id: 'p13-fixture', object: 'chat.completion.chunk', model: 'p13', created: 1,
    choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }) +
    chunk({ id: 'p13-fixture', object: 'chat.completion.chunk', model: 'p13', created: 1,
      choices: [{ index: 0, delta: {}, finish_reason: end }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) +
    'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function calls(name: string, args: unknown, id: string) {
  return response({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}
function barrier() {
  let release!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((r, failed) => { release = r; reject = failed; }); return { promise, release, reject };
}

async function fixture(reply: (body: any, request: Request) => Response | Promise<Response>, attachGate = Promise.resolve(), source = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p13-compat-'));
  writeFileSync(join(root, 'evidence.txt'), 'original evidence: invoice 42');
  const requests: any[] = [], attached: AgentSession[] = [], customCalls: string[] = [],
    settled: Array<{ session: AgentSession | null; error: unknown | null }> = [];
  const provider = await createHttpProvider(async request => {
    expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
    const body = await request.json(); requests.push(body); return reply(body, request);
  });
  deferCleanup(() => provider.stop());
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const baseUrl = `http://127.0.0.1:${provider.port}/v1`;
  runtime.registerProvider('p13-fixture', { baseUrl, api: 'openai-completions', models: ['parent', 'child'].map(id => ({
    id, name: id, api: 'openai-completions' as const, baseUrl, reasoning: false, input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000,
  })) });
  await runtime.setRuntimeApiKey('p13-fixture', 'fixture-only-no-paid-key');
  const options = async (id: string, extensions: ExtensionFactory[] = []): Promise<CreateAgentSessionOptions> => {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: 1 } },
      packages: [], extensions: [], skills: [], prompts: [], themes: [], enableSkillCommands: false });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'Controlled P13 compatibility fixture.', extensionFactories: extensions.map(factory => ({ name: 'managed', factory })) });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    return { cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel('p13-fixture', id)!, thinkingLevel: 'off',
      sessionManager: SessionManager.inMemory(root), settingsManager: settings, resourceLoader: loader,
      noTools: 'all', tools: id === 'parent' ? ['Agent'] : ['read', 'grep', 'find', 'ls'] };
  };
  let prepared = 0, complete = false; const attachStarted = barrier();
  const childManagers: SessionManager[] = [];
  const extension = factory({ controlForCall(id) {
    expect(id).toMatch(/^delegate-/);
    return { role: { name: delegate.subagent_type, description: 'Read-only evidence checker', systemPrompt: 'Inspect evidence.',
      promptMode: 'replace', extensions: false, skills: false }, async beforeCreate(agentId) {
      expect(agentId).toMatch(/^[a-f0-9-]+$/);
      prepared++;
      const childOptions = await options('child'); childManagers.push(childOptions.sessionManager!);
      const read = createReadTool(root);
      childOptions.customTools = [defineTool({ ...read, async execute(callId, args, signal) {
        customCalls.push(callId); return read.execute(callId, args, signal);
      } })];
      return { options: childOptions, promptText: delegate.prompt,
        async attach(session) { attached.push(session); attachStarted.release(); await attachGate; complete = true; },
        async settle(value) { settled.push(value); },
      };
    } };
  } }, source);
  const controlled: ExtensionFactory = pi => extension(new Proxy(pi, { get(target, key, receiver) {
    if (key !== 'on' && key !== 'registerTool') throw new Error(`Forbidden managed API: ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } }));
  const parent = (await createAgentSession(await options('parent', [controlled]))).session;
  await parent.bindExtensions({});
  deferCleanup(async () => {
    await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    parent.dispose();
  });
  return { root, requests, parent, attached, settled, childManagers, customCalls, attachStarted: attachStarted.promise,
    prepared: () => prepared, bound: () => complete };
}

it('[F13-01/02] registers only Agent and does no child work without a real delegation', async () => {
  const f = await fixture(() => response({ content: 'Direct parent answer.' }));
  expect(f.parent.extensionRunner.getAllRegisteredTools().map(t => t.definition.name)).toEqual(['Agent']);
  expect(f.parent.getActiveToolNames()).toEqual(['Agent']);
  await f.parent.prompt('Answer directly.');
  expect(f.requests).toHaveLength(1);
  expect(f.prepared()).toBe(0); expect(f.attached).toEqual([]); expect(f.childManagers).toEqual([]);
  expect(readdirSync(f.root)).toEqual(['evidence.txt']);
});

it.each([false, true])('[F13-01/13] awaits binding, runs genuine child read/Loop, and returns plugin output into the actual parent request (source=%s)', async source => {
  const gate = barrier(); let parentCalls = 0, childCalls = 0;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(body => {
    if (body.model === 'parent') {
      if (++parentCalls === 1) return calls('Agent', delegate, 'delegate-1');
      expect(body.messages.find((m: any) => m.role === 'tool')?.content).toContain('Child evidence: invoice 42');
      return response({ content: 'Parent checked the returned evidence.' });
    }
    expect(f.bound()).toBe(true);
    expect(body.tools.map((t: any) => t.function.name).sort()).toEqual(['find', 'grep', 'ls', 'read']);
    if (++childCalls === 1) return calls('read', { path: 'evidence.txt' }, 'child-read-1');
    expect(body.messages.find((m: any) => m.role === 'tool')?.content).toContain('original evidence: invoice 42');
    return response({ content: 'Child evidence: invoice 42' });
  }, gate.promise, source);
  const running = f.parent.prompt('Delegate a source check.');
  try {
    await f.attachStarted;
    // The real child exists and attach is suspended. No model dispatch may cross this barrier.
    expect(childCalls).toBe(0); gate.release(); await running;
    expect(parentCalls).toBe(2); expect(childCalls).toBe(2); expect(f.prepared()).toBe(1);
    expect(f.attached[0]!.sessionManager).toBe(f.childManagers[0]);
    expect(f.customCalls).toEqual(['child-read-1']);
    expect(f.attached[0]!.getAllTools().map(t => t.name).sort()).toEqual(['find', 'grep', 'ls', 'read']);
    expect(f.attached[0]!.sessionId).not.toBe(f.parent.sessionId);
    expect(f.settled).toEqual([{ session: f.attached[0], error: null }]);
    const result = f.parent.messages.find(m => m.role === 'toolResult');
    expect(result).toMatchObject({ role: 'toolResult', toolName: 'Agent', isError: false, details: { status: 'completed', toolUses: 1 } });
    expect(result && Reflect.get(result, 'usage')).toBeUndefined(); // no plugin pendingUsage double-count in parent
    expect(f.attached[0]!.getSessionStats().tokens.total).toBe(14);
    expect(f.parent.getSessionStats().tokens.total).toBe(14);
    expect(readdirSync(f.root)).toEqual(['evidence.txt']);
  } finally { gate.release(); await running; }
});

it.each([{ ...delegate, run_in_background: true }, { ...delegate, subagent_type: 'general-purpose' },
  { ...delegate, resume: 'old' }, { ...delegate, extensions: true }])
  ('[F13-06] rejects unsupported delegation without creating a child (%j)', async args => {
    let count = 0;
    const f = await fixture(() => ++count === 1 ? calls('Agent', args, 'delegate-invalid') : response({ content: 'Rejected.' }));
    await f.parent.prompt('Attempt invalid delegation.');
    expect(f.prepared()).toBe(0); expect(f.attached).toEqual([]);
    expect(f.parent.messages.find(m => m.role === 'toolResult')).toMatchObject({ isError: true });
  });

it('[F13-08] rejects a second true concurrent foreground call instead of queueing it', async () => {
  const gate = barrier(); let parentCalls = 0, childCalls = 0;
  const f = await fixture(body => {
    if (body.model === 'child') { childCalls++; return response({ content: 'One child.' }); }
    if (++parentCalls === 1) return response({ tool_calls: [1, 2].map((number, index) => ({ index,
      id: `delegate-${number}`, type: 'function', function: { name: 'Agent', arguments: JSON.stringify(delegate) } })) }, 'tool_calls');
    return response({ content: 'Parent received one result and one busy error.' });
  }, gate.promise);
  const running = f.parent.prompt('Concurrent calls.');
  try {
    await f.attachStarted; expect(f.prepared()).toBe(1); gate.release(); await running;
    expect(f.prepared()).toBe(1); expect(childCalls).toBe(1);
    const results = f.parent.messages.filter(m => m.role === 'toolResult');
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ toolCallId: 'delegate-2', isError: true });
    expect(JSON.stringify(results[1])).toContain('subagent_busy');
  } finally { gate.release(); await running; }
});

it('[F13-01] preserves real child provider failure and calls settle once before returning it', async () => {
  let parentCalls = 0;
  const f = await fixture(body => {
    if (body.model === 'child') return new Response(JSON.stringify({ error: { message: 'controlled child provider failure' } }),
      { status: 503, headers: { 'content-type': 'application/json' } });
    return ++parentCalls === 1 ? calls('Agent', delegate, 'delegate-error') : response({ content: 'Parent sees failure.' });
  });
  await f.parent.prompt('Delegate a failing check.');
  expect(f.settled).toHaveLength(1); expect(f.settled[0]!.session).toBe(f.attached[0]);
  expect(f.settled[0]!.error).toBeInstanceOf(Error);
  const result = f.parent.messages.find(m => m.role === 'toolResult');
  expect(result).toMatchObject({ details: { status: 'error' } });
  expect(JSON.stringify(result)).toContain('Agent failed:');
  expect(JSON.stringify(f.requests[2])).toContain('Agent failed:');
});

it('[F13-01] propagates parent abort to the genuine child request and awaits its actual settlement', async () => {
  const childRequest = barrier();
  const f = await fixture((body, request) => {
    if (body.model === 'parent') return calls('Agent', delegate, 'delegate-cancel');
    childRequest.release();
    return new Promise<Response>((_resolve, reject) => {
      const aborted = () => reject(new DOMException('Controlled child request aborted', 'AbortError'));
      if (request.signal.aborted) aborted(); else request.signal.addEventListener('abort', aborted, { once: true });
    });
  });
  const running = f.parent.prompt('Delegate until cancelled.');
  await childRequest.promise; await f.parent.abort(); await running;
  expect(f.settled).toHaveLength(1); expect(f.settled[0]!.session).toBe(f.attached[0]);
  expect(f.settled[0]!.error).toBeInstanceOf(Error);
  expect(f.attached[0]!.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'aborted' });
  expect(f.requests).toHaveLength(2);
});

it('[F13-01] settles a failed attach without making the first child request', async () => {
  const gate = barrier(); let parentCalls = 0;
  const f = await fixture(() => ++parentCalls === 1 ? calls('Agent', delegate, 'delegate-attach-failure') : response({ content: 'Failure received.' }), gate.promise);
  const running = f.parent.prompt('Reject child attachment.');
  await f.attachStarted; gate.reject(new Error('controlled binding write failed')); await running;
  expect(f.requests.every(body => body.model === 'parent')).toBe(true);
  expect(f.settled).toHaveLength(1);
  expect(f.settled[0]).toMatchObject({ session: f.attached[0], error: expect.any(Error) });
  expect(JSON.stringify(f.parent.messages.find(m => m.role === 'toolResult'))).toContain('controlled binding write failed');
});
