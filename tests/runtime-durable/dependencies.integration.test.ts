import { expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, MemoryStorage, createRegistry, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { appError, fail, ok, type ProviderConfig } from '@flowmate/contracts';
import * as durable from '@flowmate/runtime-durable';

test('Durable Models uses the explicit product model and credential across a genuine Harness tool round', async () => {
  expect(durable.createDurableModels).toBeFunction();
  const requests: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
  const toolArguments: number[] = [];
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as Record<string, unknown>;
    requests.push({ body, authorization: request.headers.get('authorization') });
    const tool = requests.length === 1;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-1', type: 'function',
      function: { name: 'read_invoice_document', arguments: JSON.stringify({ documentId: 7 }) } }] }
      : { role: 'assistant', content: 'Invoice seven checked.' };
    const chunk = { id: 'controlled', object: 'chat.completion.chunk', created: 1, model: 'selected-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  let modelCalls = 0;
  const config: ProviderConfig = { version: 1, name: 'durable-controlled', revision: 1,
    modelRef: { provider: 'durable-controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const prepared = await durable.createDurableModels(config, { readApiKey: async () => 'synthetic-managed-key',
    verifyModelUse: async () => ok(undefined), reserveModelRequest: async () => { modelCalls++; return ok(undefined); } });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) { server.stop(true); throw Error(prepared.error.code); }
  const registry = createRegistry();
  const extension = { name: 'invoice-tools', tools: [defineTool({ name: 'read_invoice_document', description: 'Read the selected invoice.',
    parameters: Type.Object({ documentId: Type.Integer() }), replay: 'safe', execute: async args => {
      toolArguments.push(args.documentId); return { output: [{ type: 'text', text: 'document-seven' }] };
    } })] };
  registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models: prepared.data.models, registry,
    settings: { retry: { enabled: false }, stream: { maxRetries: 0 }, compaction: { enabled: false } } }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: prepared.data.modelRef, extensions: [extension] } });
    const submission = await conversation.submit({ type: 'input', content: 'Review invoice seven.', requestId: 'first' }, BACKGROUND_CONTEXT);
    expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe('done');
    const context = await conversation.context(BACKGROUND_CONTEXT);
    expect(context.messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Invoice seven checked.' }] });
    expect(toolArguments).toEqual([7]); expect(modelCalls).toBe(2); expect(requests).toHaveLength(2);
    expect(requests.map(value => value.authorization)).toEqual(['Bearer synthetic-managed-key', 'Bearer synthetic-managed-key']);
    expect(requests.map(value => value.body.model)).toEqual(['selected-model', 'selected-model']);
    expect(requests[1]!.body.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'read-1', content: 'document-seven' }));
  } finally { await harness.close(BACKGROUND_CONTEXT); server.stop(true); }
}, 15_000);

test('Durable Models refuses missing credentials and withdrawn authorization without a transport or budget charge', async () => {
  expect(durable.createDurableModels).toBeFunction();
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic-ambient-must-not-be-used';
  let requests = 0, charged = 0;
  const config: ProviderConfig = { version: 1, name: 'durable-denial', revision: 1,
    modelRef: { provider: 'openai', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  try {
    for (const reason of ['missing-key', 'revoked', 'budget'] as const) {
      const prepared = await durable.createDurableModels(config, { readApiKey: async () => reason === 'missing-key' ? undefined : 'synthetic-managed-key',
        verifyModelUse: () => reason === 'revoked' ? fail(appError('session_scope_revoked', 'session', 'Revoked.')) : ok(undefined),
        reserveModelRequest: () => reason === 'budget' ? fail(appError('agent_budget_exceeded', 'runtime', 'Budget exhausted.')) : (charged++, ok(undefined)),
        fetch: async () => { requests++; throw Error('Unexpected transport'); } });
      expect(prepared.ok).toBe(true); if (!prepared.ok) throw Error(prepared.error.code);
      const model = prepared.data.models.getModel(prepared.data.modelRef.provider, prepared.data.modelRef.modelId);
      if (!model) throw Error('Missing prepared model');
      expect((await prepared.data.models.completeSimple(model, { messages: [{ role: 'user', content: 'Review.', timestamp: 1 }] })).stopReason).toBe('error');
    }
    expect(requests).toBe(0); expect(charged).toBe(0);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test.each(['credential', 'authorization', 'model'] as const)('Durable Models rechecks %s after the final payload callback before transport', async reason => {
  let key: string | undefined = 'synthetic-managed-key', allowed = true, requests = 0, charged = 0, payloadObserved = false;
  const config: ProviderConfig = { version: 1, name: 'durable-late-change', revision: 1,
    modelRef: { provider: 'durable-controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const prepared = await durable.createDurableModels(config, { readApiKey: async () => key,
    verifyModelUse: () => allowed ? ok(undefined) : fail(appError('session_scope_revoked', 'session', 'Revoked.')),
    reserveModelRequest: () => { charged++; return ok(undefined); }, fetch: async () => { requests++; throw Error('Unexpected transport'); } });
  if (!prepared.ok) throw Error(prepared.error.code);
  const model = prepared.data.models.getModel(prepared.data.modelRef.provider, prepared.data.modelRef.modelId);
  if (!model) throw Error('Missing prepared model');
  const result = await prepared.data.models.completeSimple(model, { messages: [{ role: 'user', content: 'Review.', timestamp: 1 }] }, {
    onPayload: async payload => {
      payloadObserved = true;
      if (reason === 'credential') key = undefined;
      if (reason === 'authorization') allowed = false;
      if (reason === 'model') {
        if (!payload || typeof payload !== 'object') throw Error('Missing SDK payload');
        return { ...payload, model: 'unapproved-model' };
      }
    },
  });
  expect(payloadObserved).toBe(true); expect(result.stopReason).toBe('error'); expect(requests).toBe(0); expect(charged).toBe(0);
});

test('Durable Models does not let a websocket transport bypass a refused model budget', async () => {
  let connections = 0;
  const server = Bun.serve({ port: 0, fetch: () => { connections++; return new Response('Controlled refusal', { status: 400 }); } });
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url');
  const config: ProviderConfig = { version: 1, name: 'durable-transport', revision: 1,
    modelRef: { provider: 'openai-codex', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-codex-responses', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  try {
    const prepared = await durable.createDurableModels(config, { readApiKey: async () => `fixture.${payload}.fixture`,
      verifyModelUse: () => ok(undefined),
      reserveModelRequest: () => fail(appError('agent_budget_exceeded', 'runtime', 'Budget exhausted.')) });
    if (!prepared.ok) throw Error(prepared.error.code);
    const model = prepared.data.models.getModel(prepared.data.modelRef.provider, prepared.data.modelRef.modelId);
    if (!model) throw Error('Missing prepared model');
    const result = await prepared.data.models.completeSimple(model, { messages: [{ role: 'user', content: 'Review.', timestamp: 1 }] },
      { transport: 'websocket', timeoutMs: 1000, websocketConnectTimeoutMs: 1000, maxRetries: 0 });
    expect(result.stopReason).toBe('error'); expect(connections).toBe(0);
  } finally { server.stop(true); }
}, 10_000);

test('Durable Models applies an explicit native catalog snapshot without using its credential or refreshing it', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'flowmate-durable-model-file-'));
  const modelsPath = join(root, 'models.json');
  const requests: Array<{ body: Record<string, unknown>; catalog: string | null; invoice: string | null; authorization: string | null }> = [];
  let charged = 0, keyReads = 0, managedKey: string | undefined = 'synthetic-managed-key';
  const server = Bun.serve({ port: 0, fetch: async request => {
    requests.push({ body: await request.json() as Record<string, unknown>, catalog: request.headers.get('x-catalog'),
      invoice: request.headers.get('x-invoice'), authorization: request.headers.get('authorization') });
    const chunk = { id: 'native-catalog', object: 'chat.completion.chunk', created: 1, model: 'invoice-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Catalog invoice checked.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    await writeFile(modelsPath, JSON.stringify({ providers: { 'invoice-native': {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'synthetic-file-key-must-not-be-used', headers: { 'X-Catalog': 'frozen-catalog' },
      models: [{ id: 'invoice-model', name: 'Invoice file model', input: ['text'], contextWindow: 96_000, maxTokens: 4_096,
        headers: { 'X-Invoice': 'seven' }, cost: { input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0 },
        compat: { maxTokensField: 'max_tokens' } }],
    } } }));
    const config: ProviderConfig = { version: 1, name: 'native-file', revision: 1,
      modelRef: { provider: 'invoice-native', model: 'invoice-model' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    const prepared = await durable.createDurableModels(config, { readApiKey: async () => { keyReads++; return managedKey; },
      verifyModelUse: () => ok(undefined), reserveModelRequest: () => { charged++; return ok(undefined); } });
    expect(prepared.ok).toBe(true); if (!prepared.ok) throw Error(prepared.error.code);
    const model = prepared.data.models.getModel('invoice-native', 'invoice-model');
    expect(model).toMatchObject({ id: 'invoice-model', provider: 'invoice-native', name: 'Invoice file model',
      contextWindow: 96_000, maxTokens: 4_096, cost: { input: 0.25, output: 0.5 }, compat: { maxTokensField: 'max_tokens' } });
    expect(requests).toHaveLength(0); expect(charged).toBe(0); expect(keyReads).toBe(0);
    await writeFile(modelsPath, '{ invalid later file');
    if (!model) throw Error('Missing configured model');
    const result = await prepared.data.models.completeSimple(model, { messages: [{ role: 'user', content: 'Review invoice.', timestamp: 1 }] },
      { maxTokens: 321 });
    expect(result.stopReason).toBe('stop'); expect(charged).toBe(1); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ body: { model: 'invoice-model', max_tokens: 321 },
      catalog: 'frozen-catalog', invoice: 'seven', authorization: 'Bearer synthetic-managed-key' });
    expect(await Bun.file(join(root, 'unused-auth.json')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'models-store.json')).exists()).toBe(false);
    managedKey = undefined;
    expect((await prepared.data.models.completeSimple(model, { messages: [{ role: 'user', content: 'Review again.', timestamp: 2 }] })).stopReason).toBe('error');
    expect(charged).toBe(1); expect(requests).toHaveLength(1);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);


test('Durable Models does not use a catalog default when an explicit native model file is unavailable', async () => {
  const config: ProviderConfig = { version: 1, name: 'explicit-native-file', revision: 1,
    modelRef: { provider: 'deepseek', model: 'deepseek-flash' }, native: { authPath: 'unused-auth.json', modelsPath: 'explicit-models.json' },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  expect(await durable.createDurableModels(config, { readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }))
    .toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
});

test('Durable Models rejects prototype property names as unsupported APIs during preparation', async () => {
  for (const api of ['constructor', '__proto__', 'toString']) {
    const config: ProviderConfig = { version: 1, name: 'invalid-api', revision: 1,
      modelRef: { provider: 'durable-controlled', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
      connection: { api, baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 64_000, maxTokens: 8_192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    expect(await durable.createDurableModels(config, { readApiKey: () => 'synthetic-key', verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }))
      .toMatchObject({ ok: false, error: { code: 'provider_api_unsupported' } });
  }
});

test('Durable Models checks a late credential change on an API without custom fetch support', async () => {
  let key: string | undefined = 'synthetic-managed-key', requests = 0, charged = 0, payloadObserved = false;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response('Controlled refusal', { status: 400 }); } });
  const config: ProviderConfig = { version: 1, name: 'durable-google-late-change', revision: 1,
    modelRef: { provider: 'google', model: 'selected-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'google-generative-ai', baseUrl: `http://127.0.0.1:${server.port}`, contextWindow: 64_000, maxTokens: 8_192 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  try {
    const prepared = await durable.createDurableModels(config, { readApiKey: async () => key,
      verifyModelUse: () => ok(undefined), reserveModelRequest: () => { charged++; return ok(undefined); } });
    if (!prepared.ok) throw Error(prepared.error.code);
    const model = prepared.data.models.getModel(prepared.data.modelRef.provider, prepared.data.modelRef.modelId);
    if (!model) throw Error('Missing prepared model');
    const result = await prepared.data.models.completeSimple(model, { messages: [{ role: 'user', content: 'Review.', timestamp: 1 }] },
      { timeoutMs: 1000, onPayload: () => { payloadObserved = true; key = undefined; } });
    expect(payloadObserved).toBe(true); expect(result.stopReason).toBe('error'); expect(charged).toBe(0); expect(requests).toBe(0);
  } finally { server.stop(true); }
}, 10_000);

test('Durable Runtime submits through the explicit native model file and returns only its original receipt', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'flowmate-durable-file-runtime-'));
  const modelsPath = join(root, 'models.json');
  let requests = 0, charged = 0;
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as Record<string, unknown>;
    expect(body.model).toBe('file-invoice-model'); requests++;
    const chunk = { id: 'file-runtime', object: 'chat.completion.chunk', created: 1, model: 'file-invoice-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Native file result.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  let port: Awaited<ReturnType<typeof durable.createDurableRuntime>> | undefined;
  try {
    await writeFile(modelsPath, JSON.stringify({ providers: { 'file-invoice': {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: [{ id: 'file-invoice-model', contextWindow: 80_000, maxTokens: 4_096 }],
    } } }));
    const config: ProviderConfig = { version: 1, name: 'runtime-file', revision: 1,
      modelRef: { provider: 'file-invoice', model: 'file-invoice-model' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    port = await durable.createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => 'synthetic-managed-key',
      verifyModelUse: () => ok(undefined), reserveModelRequest: () => { charged++; return ok(undefined); } });
    expect(port.ok).toBe(true); if (!port.ok) throw Error(port.error.code);
    expect(await port.data.openConversation({ workId: 71, sessionId: 81 })).toMatchObject({ ok: true });
    const input = { workId: 71, sessionId: 81, attemptId: 91, requestId: 'file-input', text: 'Review this invoice.', config };
    const submitted = await port.data.submit(input);
    expect(submitted.ok).toBe(true); if (!submitted.ok) throw Error(submitted.error.code);
    const query = { workId: 71, sessionId: 81, attemptId: 91, requestId: 'file-input' };
    expect(await port.data.waitForSubmission(query)).toMatchObject({ ok: true, data: { status: 'done', answer: 'Native file result.' } });
    await writeFile(modelsPath, '{ invalid file after original submission');
    expect(await port.data.submit(input)).toMatchObject({ ok: true, data: { nativeSubmissionId: submitted.data.nativeSubmissionId } });
    expect(await port.data.getSubmission(query)).toMatchObject({ ok: true, data: { answer: 'Native file result.' } });
    expect(charged).toBe(1); expect(requests).toBe(1);
  } finally { if (port?.ok) await port.data.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);

test('Durable Models refuses a malformed explicit native file instead of falling back to the built-in model', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'flowmate-durable-invalid-model-file-'));
  try {
    const modelsPath = join(root, 'models.json');
    const config: ProviderConfig = { version: 1, name: 'invalid-file', revision: 1,
      modelRef: { provider: 'deepseek', model: 'deepseek-flash' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    let sideEffects = 0;
    for (const content of ['{ invalid json', JSON.stringify({ providers: { deepseek: { modelOverrides: { 'deepseek-flash': { maxTokens: 0 } } } } })]) {
      await writeFile(modelsPath, content);
      expect(await durable.createDurableModels(config, { readApiKey: () => { sideEffects++; return 'synthetic-managed-key'; },
        verifyModelUse: () => ok(undefined), reserveModelRequest: () => { sideEffects++; return ok(undefined); } }))
        .toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
    }
    expect(sideEffects).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
