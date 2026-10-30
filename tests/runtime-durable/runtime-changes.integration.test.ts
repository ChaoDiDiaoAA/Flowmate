import { expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, Type } from '@earendil-works/pi-ai';
import { createRegistry, defineTask, defineTool, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { ok, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createDurableRuntime } from '../../packages/runtime-durable/src/runtime.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Native change was not observed.')), 1500); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function config(port: number): ProviderConfig { return { version: 1, name: 'change-profile', revision: 1,
  modelRef: { provider: 'controlled-change', model: 'change-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
  connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 64_000, maxTokens: 8192 },
  parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } }; }
function toolResponse(lane: string): Response {
  const chunk = { id: lane, object: 'chat.completion.chunk', created: 1, model: 'change-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `start-${lane}`, type: 'function',
      function: { name: 'read_invoice_document', arguments: JSON.stringify({ lane }) } }] }, finish_reason: 'tool_calls' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('official onWake alone does not report one native scope ending while another remains active', async () => {
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()], release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const registry = createRegistry(), wakes: unknown[] = [];
  const background = defineTask<{ lane: number }, { phase: 'wait' }, null>({ name: 'test.wake-active-scopes', version: 1,
    initial: () => ({ phase: 'wait' }), phases: { wait: async (task, api, context) => {
      entered[task.input.lane]!.resolve(); await release[task.input.lane]!.promise;
      await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
    } }, abort: (_task, api, context) => api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  registry.install({ name: 'test-wake-active-scopes', tasks: [background] });
  const models = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() });
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onWake: wake => { wakes.push(wake); } }, BACKGROUND_CONTEXT);
  try {
    const tasks = await harness.commit(async tx => {
      const ids = [];
      for (const lane of [0, 1]) {
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        ids.push(await tx.createTask(background, { lane }, { conversationId: conversation.id, ownership: { kind: 'conversation' }, background: true }));
      }
      return ids;
    }, BACKGROUND_CONTEXT);
    harness.resume(); await bounded(Promise.all(entered.map(value => value.promise))); await tick();
    const before = wakes.length; release[0]!.resolve(); await harness.waitForTask(tasks[0]!, BACKGROUND_CONTEXT); await tick();
    expect(harness.wake().active).toBe(true); expect(wakes.length).toBe(before);
  } finally { for (const value of release) value.resolve(); await harness.close(BACKGROUND_CONTEXT); }
});

test('native graph changes notify closed owned scopes without model polling or read-notification loops', async () => {
  const release = new Map(['A', 'B'].map(lane => [lane, Promise.withResolvers<void>()]));
  const entered = new Map(['A', 'B'].map(lane => [lane, Promise.withResolvers<void>()]));
  const registry = createRegistry(); let requests = 0, notices = 0, nextNotice = Promise.withResolvers<void>();
  const background = defineTask<{ lane: string }, { phase: 'wait' }, null>({ name: 'test.notify-owned-scopes', version: 1,
    initial: () => ({ phase: 'wait' }), phases: { wait: async (task, api, context) => {
      entered.get(task.input.lane)!.resolve(); await release.get(task.input.lane)!.promise;
      await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
    } }, abort: (_task, api, context) => api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  registry.install({ name: 'test-notify-owned-scopes', tasks: [background], tools: [defineTool({ name: 'read_invoice_document',
    description: 'Start the original owned evidence task.', parameters: Type.Object({ lane: Type.String() }), replay: 'safe', execute: async (args, api, context) => {
      await api.commit(async tx => {
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await tx.createTask(background, { lane: args.lane }, { conversationId: child.id, ownership: { kind: 'conversation' }, background: true });
      }, context);
      return { output: [{ type: 'text', text: 'Original owned task started.' }], control: { terminate: true } };
    } })] });
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests++; const body = JSON.stringify(await request.json()); return toolResponse(body.includes('lane-B') ? 'B' : 'A');
  } });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), registry, readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), onChanged: () => { notices++; nextNotice.resolve(); } }));
  const a = { workId: 7, sessionId: 70, attemptId: 700, requestId: 'lane-A' }, b = { workId: 8, sessionId: 80, attemptId: 800, requestId: 'lane-B' };
  try {
    for (const query of [a, b]) {
      need(await runtime.openConversation({ workId: query.workId, sessionId: query.sessionId }));
      need(await runtime.submit({ ...query, text: query.requestId, config: config(server.port!) }));
      await bounded(entered.get(query === a ? 'A' : 'B')!.promise);
      expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
      expect(need(await runtime.observeSubmission(query))?.execution).toBe('active');
    }
    await tick(); nextNotice = Promise.withResolvers<void>(); release.get('A')!.resolve(); await bounded(nextNotice.promise);
    expect(need(await runtime.observeSubmission(a))?.execution).toBe('closed');
    expect(need(await runtime.observeSubmission(b))?.execution).toBe('active');
    await tick(); const before = notices;
    for (const query of [a, b]) {
      need(await runtime.getSubmission(query)); need(await runtime.observeSubmission(query));
      need(await runtime.queryHistory({ workId: query.workId, sessionId: query.sessionId, limit: 100 }));
    }
    await tick(); expect(notices).toBe(before); expect(requests).toBe(2);
    nextNotice = Promise.withResolvers<void>(); release.get('B')!.resolve(); await bounded(nextNotice.promise);
    expect(need(await runtime.observeSubmission(b))?.execution).toBe('closed');
  } finally { for (const value of release.values()) value.resolve(); need(await runtime.close()); server.stop(true); }
});

test('native sleeping owned work still resumes on the SDK timer when change notifications are enabled', async () => {
  const entered = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
  let notices = 0;
  const registry = createRegistry(), background = defineTask<Record<string, never>, { phase: 'sleep' } | { phase: 'finish' }, null>({
    name: 'test.notify-native-sleep', version: 1, initial: () => ({ phase: 'sleep' }), phases: {
      sleep: async (_task, api, context) => { await api.sleepUntil(Date.now() + 60, { phase: 'finish' }, context); entered.resolve(); },
      finish: async (_task, api, context) => { await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context); completed.resolve(); },
    }, abort: (_task, api, context) => api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  registry.install({ name: 'test-notify-native-sleep', tasks: [background], tools: [defineTool({ name: 'read_invoice_document',
    description: 'Start sleeping native evidence work.', parameters: Type.Object({ lane: Type.String() }), replay: 'safe', execute: async (_args, api, context) => {
      await api.createTask(background, {}, { ownership: { kind: 'conversation' }, background: true }, context);
      return { output: [{ type: 'text', text: 'Original sleeping task started.' }], control: { terminate: true } };
    } })] });
  const server = Bun.serve({ port: 0, fetch: () => toolResponse('A') });
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), registry, readApiKey: () => 'synthetic-key',
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined), onChanged: () => { notices++; } }));
  const query = { workId: 7, sessionId: 70, attemptId: 700, requestId: 'native-sleep' };
  try {
    need(await runtime.openConversation({ workId: query.workId, sessionId: query.sessionId }));
    need(await runtime.submit({ ...query, text: 'Let native sleep finish naturally.', config: config(server.port!) }));
    await bounded(entered.promise); expect(need(await runtime.waitForSubmission(query)).status).toBe('done');
    await bounded(completed.promise); await tick();
    expect(need(await runtime.observeSubmission(query))?.execution).toBe('closed'); expect(notices).toBeGreaterThan(0);
  } finally { need(await runtime.close()); server.stop(true); }
});
