import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseCoordinator, openDatabase } from '@flowmate/core';
import { createRegistry, defineTask, defineTool, MemoryStorage } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { appError, DurableModelBindingSchema, fail, ok, PersonalAgentConfigurationSchema,
  type DurableModelBinding, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createDurableRuntime, createDurableSqliteStorage } from '@flowmate/runtime-durable';
import { readDurableModelBinding } from '../../packages/runtime-durable/src/models.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const identity = { workId: 7, sessionId: 70, attemptId: 700 };
const query = { ...identity, requestId: 'original-phase' };
function config(modelsPath: string): ProviderConfig {
  return { version: 1, name: 'frozen-profile', revision: 3, credentialRef: 'managed-product-key',
    modelRef: { provider: 'frozen-provider', model: 'frozen-model' }, native: { authPath: 'unused-auth.json', modelsPath },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
}
function catalog(port: number, label: string, headers: Record<string, string> = { 'X-Catalog': label }) {
  return JSON.stringify({ providers: { 'frozen-provider': { api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-file-key-must-not-persist',
    headers, authHeader: true,
    models: [{ id: 'frozen-model', name: 'Original resolved model', input: ['text'], reasoning: false,
      contextWindow: 96_000, maxTokens: 4_096, cost: { input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0 },
      compat: { maxTokensField: 'max_tokens' } }] } } });
}
function answer(): Response {
  const chunk = { id: 'original-response', object: 'chat.completion.chunk', created: 1, model: 'frozen-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Original configuration restored.' }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('model preparation captures complete explicit facts without credentials or scheduling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-model-prepare-')), modelsPath = join(root, 'models.json');
  let reads = 0, checks = 0, charged = 0;
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(),
    readApiKey: () => { reads++; return 'synthetic-current-key'; }, verifyModelUse: () => { checks++; return ok(undefined); },
    reserveModelRequest: () => { charged++; return ok(undefined); } }));
  try {
    await writeFile(modelsPath, catalog(1, 'original'));
    expect(runtime.prepareModel).toBeFunction();
    const binding = need(await runtime.prepareModel({ ...query, config: config(modelsPath) }));
    expect(binding.configuration).toEqual(config(modelsPath));
    expect(JSON.parse(binding.modelJson)).toMatchObject({ provider: 'frozen-provider', id: 'frozen-model',
      name: 'Original resolved model', contextWindow: 96_000, maxTokens: 4_096,
      cost: { input: 0.25, output: 0.5 }, compat: { maxTokensField: 'max_tokens' } });
    expect(binding.request).toMatchObject({ authHeader: true, headers: { 'X-Catalog': 'original' } });
    expect(JSON.stringify(binding)).not.toContain('synthetic-');
    expect(reads).toBe(0); expect(checks).toBe(0); expect(charged).toBe(0);
    await writeFile(modelsPath, '{ unavailable later configuration');
    expect(need(await runtime.prepareModel({ ...query, requestId: 'later-phase', config: config(modelsPath) }))).toEqual(binding);
  } finally { need(await runtime.close()); await rm(root, { recursive: true, force: true }); }
});

test('SQLite reopen restores original model binding without replay, latest file reads, or credential fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-model-recovery-')), path = join(root, 'app.sqlite'), modelsPath = join(root, 'models.json');
  let coordinator = createDatabaseCoordinator(new Database(path, { create: true }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const requests: Array<{ lane: string; key: string | null; catalog: string | null; body: Record<string, unknown> }> = [];
  const servers = ['original', 'latest'].map(lane => Bun.serve({ port: 0, fetch: async request => {
    requests.push({ lane, key: request.headers.get('authorization'), catalog: request.headers.get('x-catalog'),
      body: await request.json() as Record<string, unknown> });
    if (requests.length === 1) { entered.resolve(); await release.promise; }
    return answer();
  } }));
  let credential = 'synthetic-before-reopen-key', reads = 0, allowed = true, charged = 0;
  const refusal = appError('session_scope_revoked', 'session', 'The original attempt is no longer admitted.');
  const options = { readApiKey: () => { reads++; return credential; }, verifyModelUse: () => allowed ? ok(undefined) : fail(refusal),
    reserveModelRequest: () => { charged++; return ok(undefined); } };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  try {
    await writeFile(modelsPath, catalog(servers[0]!.port!, 'original'));
    expect(runtime.prepareModel).toBeFunction(); expect(runtime.restoreModel).toBeFunction();
    const binding = need(await runtime.prepareModel({ ...query, config: config(modelsPath) }));
    await coordinator.transaction(sql => sql.exec('CREATE TABLE saved_phase_model (binding_json TEXT NOT NULL)'));
    await coordinator.transaction(sql => sql.run('INSERT INTO saved_phase_model VALUES (?)', JSON.stringify(binding)));
    need(await runtime.openConversation({ workId: query.workId, sessionId: query.sessionId }));
    const submitted = need(await runtime.submit({ ...query, config: config(modelsPath), binding, text: 'Use the original model configuration.' }));
    await entered.promise;
    need(await runtime.close()); release.resolve(); await coordinator.close();
    await writeFile(modelsPath, catalog(servers[1]!.port!, 'latest'));
    coordinator = createDatabaseCoordinator(new Database(path));
    credential = 'synthetic-current-reopened-key'; allowed = false;
    runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
    const saved = await coordinator.read(sql => sql.get<{ binding_json: string }>('SELECT binding_json FROM saved_phase_model'));
    if (!saved) throw Error('Missing saved phase model.');
    const readsBeforeRestore = reads, requestsBeforeRestore = requests.length, chargedBeforeRestore = charged;
    expect(await runtime.resumeAttempt(identity)).toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
    need(await runtime.restoreModel({ ...query, binding: JSON.parse(saved.binding_json) }));
    expect(reads).toBe(readsBeforeRestore); expect(charged).toBe(chargedBeforeRestore); expect(requests).toHaveLength(requestsBeforeRestore);
    expect(need(await runtime.getSubmission(query))).toMatchObject({ nativeSubmissionId: submitted.nativeSubmissionId, status: 'placed' });
    expect(await runtime.resumeAttempt(identity)).toEqual(fail(refusal));
    expect(await runtime.waitForSubmission(query)).toEqual(fail(refusal));
    need(await runtime.openConversation({ workId: 8, sessionId: 80 }));
    expect(await runtime.submit({ workId: 8, sessionId: 80, attemptId: 800, requestId: 'foreground',
      text: 'A new foreground request cannot wake the denied original phase.', config: config(modelsPath) }))
      .toEqual(fail(refusal));
    expect(requests).toHaveLength(requestsBeforeRestore); expect(reads).toBe(readsBeforeRestore);
    allowed = true;
    need(await runtime.resumeAttempt(identity));
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ nativeSubmissionId: submitted.nativeSubmissionId,
      status: 'done', answer: 'Original configuration restored.' });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ lane: 'original', key: 'Bearer synthetic-current-reopened-key', catalog: 'original',
      body: { model: 'frozen-model', max_tokens: 4096 } });
    expect(saved.binding_json).not.toContain('synthetic-');
    const persisted = await coordinator.read(async sql => {
      const rows: unknown[] = [];
      for (const table of ['fm_durable_conversations', 'fm_durable_entries', 'fm_durable_tasks', 'fm_durable_submissions',
        'fm_durable_documents', 'fm_durable_document_revisions']) rows.push(await sql.all(`SELECT * FROM ${table}`));
      return JSON.stringify(rows);
    });
    for (const secret of ['synthetic-file-key-must-not-persist', 'synthetic-before-reopen-key', 'synthetic-current-reopened-key'])
      expect(persisted).not.toContain(secret);
    expect(need(await runtime.getSubmission(query))).toMatchObject({ nativeSubmissionId: submitted.nativeSubmissionId, status: 'done' });
    expect(requests).toHaveLength(2);
  } finally { release.resolve(); need(await runtime.close()); await coordinator.close();
    for (const server of servers) server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);

function rawBinding(fields: Record<string, unknown> = {}): DurableModelBinding {
  return { version: 1, configuration: config('unused-models.json'), request: { authHeader: true, headers: { 'X-Catalog': 'original' } },
    modelJson: JSON.stringify({ id: 'frozen-model', name: 'Original model', provider: 'frozen-provider', api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1', input: ['text'], reasoning: false, contextWindow: 96_000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...fields }) };
}
const unsafeModelFields: Array<{ name: string; fields: Record<string, unknown> }> = [
  { name: 'URL username', fields: { baseUrl: 'https://synthetic-user@example.invalid/v1' } },
  { name: 'URL password', fields: { baseUrl: 'https://user:synthetic-password@example.invalid/v1' } },
  { name: 'known query key', fields: { baseUrl: 'https://example.invalid/v1?api_key=synthetic-value' } },
  { name: 'ordinary query key', fields: { baseUrl: 'https://example.invalid/v1?session=synthetic-value' } },
  { name: 'URL fragment', fields: { baseUrl: 'https://example.invalid/v1#synthetic-value' } },
  { name: 'non-HTTP URL', fields: { baseUrl: 'ftp://example.invalid/v1' } },
  { name: 'compat API key', fields: { compat: { apiKey: 'synthetic-value' } } },
  { name: 'nested bearer header', fields: { compat: { request: { headers: { Authorization: 'Bearer synthetic-value' } } } } },
  { name: 'nested custom key header', fields: { compat: { request: { headers: { 'X-Api-Key': 'synthetic-value' } } } } },
  { name: 'nested cookie header', fields: { compat: { request: { headers: { Cookie: 'synthetic-value' } } } } },
  { name: 'array credential', fields: { compat: { routes: [{ credentials: { clientSecret: 'synthetic-value' } }] } } },
  { name: 'sampling API key', fields: { samplingParams: { api_key: 'synthetic-value' } } },
  { name: 'thinking refresh token', fields: { samplingParamsByThinkingLevel: { high: { refresh_token: 'synthetic-value' } } } },
];
test.each(unsafeModelFields)('the storage contract and adapter refuse unsafe resolved model facts: $name', ({ fields }) => {
  const binding = rawBinding(fields);
  expect(DurableModelBindingSchema.safeParse(binding).success).toBe(false);
  expect(readDurableModelBinding(binding)).toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
});

async function bindingOwner(root: string) {
  const at = '2026-10-29T00:00:00.000Z';
  const database = need(openDatabase({ root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') }));
  const receipt = need(await database.transaction(scope => {
    const agent = need(scope.personalAgents.ensureDefault(PersonalAgentConfigurationSchema.parse({ modelId: 'binding-security-model',
      thinkingLevel: 'off', resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [],
      workingDirectory: null, preferences: '' }), at));
    const metadata = { version: 1 as const, sourceKey: 'binding-security', sourceRecordId: '1', sourceVersion: 'v1' };
    need(scope.documents.register({ documentId: 1, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
      originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/original.pdf', bytes: 1, mimeType: 'application/pdf',
        metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: 1, mimeType: 'application/pdf' }] }, createdAt: at },
      parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1, mimeType: 'application/json',
        metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
      status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled binding security fixture'],
        licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    return scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'create-binding-security-work', goal: 'Check the fixed binding.', documents: [{ id: 1, version: 'v1' }] },
    { at, admission: { kind: 'ready' } });
  }));
  if (!receipt.execution.attempt) throw Error('Missing admitted original attempt.');
  const owner = { workId: receipt.workId, attemptId: receipt.execution.attempt.attemptId };
  const save = (binding: DurableModelBinding) => database.transaction(scope => scope.invoiceWorkModelBindings.save({ ...owner,
    modelId: 'binding-security-model', binding, at }));
  const count = () => database.read(scope => scope.db.query<{ count: number }, []>('SELECT COUNT(*) count FROM invoice_work_model_bindings').get()!.count);
  return { database, owner: { ...owner, sessionId: receipt.sessionId }, save, count };
}

test('raw bindings cannot bypass the shared owner storage boundary through headers or nested model credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-model-binding-security-')), fixture = await bindingOwner(root);
  try {
    const unsafe = [...unsafeModelFields.map(({ fields }) => rawBinding(fields)),
      ...unsafeHeaders.map(headers => ({ ...rawBinding(), request: { authHeader: true, headers } })),
      { ...rawBinding(), configuration: { ...config('unused-models.json'), connection: { api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1?session=synthetic-value', contextWindow: 96000, maxTokens: 4096 } } }];
    for (const binding of unsafe) {
      expect(DurableModelBindingSchema.safeParse(binding).success).toBe(false);
      expect(await fixture.save(binding)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
      expect(await fixture.count()).toBe(0);
    }
    const allowed = rawBinding({ compat: { maxTokensField: 'max_tokens', thinkingTokenBudgetField: 'thinking_token_budget',
      chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } } },
      samplingParams: { max_tokens: 4096, thinking_token_budget: 1024 },
      samplingParamsByThinkingLevel: { high: { thinking_token_budget: 2048 } } });
    expect(DurableModelBindingSchema.safeParse(allowed).success).toBe(true);
    expect(readDurableModelBinding(allowed)).toMatchObject({ ok: true });
    expect(need(await fixture.save(allowed)).binding).toEqual(allowed); expect(await fixture.count()).toBe(1);
  } finally { await fixture.database.close(); await rm(root, { recursive: true, force: true }); }
});

test('unsafe facts from a real native models file fail before keys, requests or a product binding row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-native-model-security-')), fixture = await bindingOwner(root), modelsPath = join(root, 'models.json');
  let reads = 0, requests = 0, charged = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return answer(); } });
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(fixture.database.coordinator),
    readApiKey: () => { reads++; return 'synthetic-current-key'; }, verifyModelUse: () => ok(undefined),
    reserveModelRequest: () => { charged++; return ok(undefined); } }));
  try {
    for (const fields of [
      { baseUrl: `http://127.0.0.1:${server.port}/v1?session=synthetic-value` },
      { baseUrl: `http://127.0.0.1:${server.port}/v1#synthetic-value` },
      { compat: { maxTokensField: 'max_tokens', apiKey: 'synthetic-nested-key' } },
      { compat: { maxTokensField: 'max_tokens', request: { headers: { Authorization: 'Bearer synthetic-nested-key' } } } },
      { samplingParams: { api_key: 'synthetic-nested-key' } },
      { samplingParamsByThinkingLevel: { high: { refresh_token: 'synthetic-nested-key' } } },
    ]) {
      const contents = JSON.parse(catalog(server.port!, 'original'));
      Object.assign(contents.providers['frozen-provider'].models[0], fields);
      await writeFile(modelsPath, JSON.stringify(contents));
      const prepared = await runtime.prepareModel({ ...fixture.owner, requestId: 'unsafe-native-model', config: config(modelsPath) });
      // A successful prepare would otherwise be the service's source for the Core binding write.
      if (prepared.ok) await fixture.save(prepared.data);
      expect(prepared).toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
      expect(reads).toBe(0); expect(requests).toBe(0); expect(charged).toBe(0); expect(await fixture.count()).toBe(0);
    }
  } finally { need(await runtime.close()); await fixture.database.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);

test('a completed input with surviving owned tasks still gates global scheduling after SQLite reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-owned-model-recovery-')), path = join(root, 'app.sqlite'), modelsPath = join(root, 'models.json');
  let coordinator = createDatabaseCoordinator(new Database(path, { create: true }));
  const entered = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
  let runs = 0, requests = 0, originalAllowed = true;
  const background = defineTask<Record<string, never>, { phase: 'wait' }, null>({ name: 'test.restored-owned-work', version: 1,
    initial: () => ({ phase: 'wait' }), phases: { wait: async (_task, api, context) => {
      runs++;
      if (runs === 1) {
        const signal = context.abortSignal; if (!signal) throw Error('Missing owned task cancellation.');
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
      completed.resolve();
    } }, abort: (_task, api, context) => api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  const registry = createRegistry();
  registry.install({ name: 'controlled-owned-recovery', tasks: [background], tools: [defineTool({ name: 'start_owned_work',
    description: 'Start the original owned task.', parameters: Type.Object({}), replay: 'safe', execute: async (_args, api, context) => {
      await api.createTask(background, {}, { ownership: { kind: 'conversation' }, background: true }, context);
      return { output: [{ type: 'text', text: 'Original owned work started.' }], control: { terminate: true } };
    } })] });
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    if (requests !== 1) return answer();
    const chunk = { id: 'owned-response', object: 'chat.completion.chunk', created: 1, model: 'frozen-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'original-owned-task', type: 'function',
        function: { name: 'start_owned_work', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const refusal = appError('session_scope_revoked', 'session', 'Original owned work is not admitted.');
  const options = { registry, readApiKey: () => 'synthetic-owned-key',
    verifyModelUse: (input: { attemptId: number }) => input.attemptId === identity.attemptId && !originalAllowed ? fail(refusal) : ok(undefined),
    reserveModelRequest: () => ok(undefined) };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const foreground = { workId: 8, sessionId: 80, attemptId: 800, requestId: 'new-foreground' };
  try {
    await writeFile(modelsPath, catalog(server.port!, 'original'));
    const binding = need(await runtime.prepareModel({ ...query, config: config(modelsPath) }));
    need(await runtime.openConversation({ workId: query.workId, sessionId: query.sessionId }));
    need(await runtime.submit({ ...query, config: config(modelsPath), binding, text: 'Start original owned work.' }));
    await entered.promise;
    expect(need(await runtime.waitForSubmission(query))).toMatchObject({ status: 'done' });
    expect(need(await runtime.observeSubmission(query))).toMatchObject({ execution: 'active' });
    need(await runtime.close()); await coordinator.close();
    coordinator = createDatabaseCoordinator(new Database(path));
    runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
    need(await runtime.openConversation({ workId: foreground.workId, sessionId: foreground.sessionId }));
    const input = { ...foreground, config: config(modelsPath), text: 'New work must not wake unprepared owned work.' };
    expect(await runtime.submit(input)).toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
    expect(runs).toBe(1); expect(requests).toBe(1);
    originalAllowed = false;
    need(await runtime.restoreModel({ ...query, binding }));
    expect(await runtime.resumeAttempt(identity)).toEqual(fail(refusal));
    expect(await runtime.submit(input)).toEqual(fail(refusal));
    expect(runs).toBe(1); expect(requests).toBe(1);
    originalAllowed = true;
    need(await runtime.resumeAttempt(identity)); await completed.promise;
    expect(runs).toBe(2); expect(requests).toBe(1);
    expect(await runtime.resumeAttempt(identity)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    need(await runtime.submit(input)); need(await runtime.waitForSubmission(foreground));
    expect(runs).toBe(2); expect(requests).toBe(2);
  } finally { need(await runtime.close()); await coordinator.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);

const unsafeHeaders: Record<string, string>[] = [
  { Authorization: 'Bearer synthetic-file-secret' }, { 'X-Api-Key': 'synthetic-file-secret' },
  { Cookie: 'synthetic-file-secret' }, { 'X-Secret': 'synthetic-file-secret' },
  { 'X-Catalog': '$PRIVATE_CATALOG' }, { 'X-Catalog': '!echo must-not-execute' },
];
test.each(unsafeHeaders)('persistent model preparation refuses credential-bearing or dynamic headers: %j', async headers => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-model-header-boundary-')), modelsPath = join(root, 'models.json');
  let reads = 0;
  const runtime = need(await createDurableRuntime({ storage: new MemoryStorage(), readApiKey: () => { reads++; return 'synthetic-product-key'; },
    verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) }));
  try {
    await writeFile(modelsPath, catalog(1, 'original', headers));
    expect(await runtime.prepareModel({ ...query, config: config(modelsPath) }))
      .toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
    expect(reads).toBe(0);
  } finally { need(await runtime.close()); await rm(root, { recursive: true, force: true }); }
});

test.each(['resume', 'stop'] as const)('restoring a queued binding cannot bypass recovery and admission gates: %s', async action => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-queued-model-recovery-')), path = join(root, 'app.sqlite'), modelsPath = join(root, 'models.json');
  let coordinator = createDatabaseCoordinator(new Database(path, { create: true }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0, reads = 0, allowed = true;
  const server = Bun.serve({ port: 0, fetch: async () => {
    requests++;
    if (requests === 1) { entered.resolve(); await release.promise; }
    return answer();
  } });
  const refusal = appError('session_scope_revoked', 'session', 'The restored queue is not admitted.');
  const options = { readApiKey: () => { reads++; return 'synthetic-current-key'; }, verifyModelUse: () => allowed ? ok(undefined) : fail(refusal),
    reserveModelRequest: () => ok(undefined) };
  let runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
  const queued = { ...query, requestId: 'queued-phase' };
  try {
    await writeFile(modelsPath, catalog(server.port!, 'original'));
    const binding = need(await runtime.prepareModel({ ...query, config: config(modelsPath) }));
    need(await runtime.openConversation({ workId: query.workId, sessionId: query.sessionId }));
    const first = need(await runtime.submit({ ...query, config: config(modelsPath), binding, text: 'Original input.' }));
    await entered.promise;
    const next = need(await runtime.submit({ ...queued, config: config(modelsPath), binding, text: 'Queued input.' }));
    expect(next.status).toBe('queued');
    need(await runtime.close()); release.resolve(); await coordinator.close();
    await writeFile(modelsPath, '{ original file is no longer available');
    coordinator = createDatabaseCoordinator(new Database(path)); allowed = false;
    runtime = need(await createDurableRuntime({ ...options, storage: await createDurableSqliteStorage(coordinator) }));
    const readsBefore = reads;
    need(await runtime.restoreModel({ ...queued, binding }));
    allowed = true;
    expect(await runtime.resumeAttempt(identity)).toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
    allowed = false;
    need(await runtime.restoreModel({ ...query, binding }));
    expect(await runtime.resumeAttempt(identity)).toEqual(fail(refusal));
    expect(await runtime.waitForSubmission(queued)).toEqual(fail(refusal));
    expect(requests).toBe(1); expect(reads).toBe(readsBefore);
    if (action === 'stop') {
      expect(need(await runtime.stopAttempt({ ...identity, stopGraceMs: 1000 }))).toMatchObject({ stopped: true });
      need(await runtime.restoreModel({ ...query, binding }));
      expect(await runtime.resumeAttempt(identity)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(need(await runtime.getSubmission(query))).toMatchObject({ nativeSubmissionId: first.nativeSubmissionId, status: 'unanswered' });
      expect(need(await runtime.getSubmission(queued))).toMatchObject({ nativeSubmissionId: next.nativeSubmissionId, status: 'unanswered' });
      expect(requests).toBe(1); expect(reads).toBe(readsBefore);
    } else {
      allowed = true; need(await runtime.resumeAttempt(identity));
      expect(need(await runtime.waitForSubmission(queued))).toMatchObject({ nativeSubmissionId: next.nativeSubmissionId, status: 'done' });
      expect(need(await runtime.getSubmission(query))).toMatchObject({ nativeSubmissionId: first.nativeSubmissionId, status: 'done' });
      expect(requests).toBe(3);
    }
  } finally { release.resolve(); need(await runtime.close()); await coordinator.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);
