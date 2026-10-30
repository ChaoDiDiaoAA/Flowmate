import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { createRegistry, Harness, type Storage } from '@earendil-works/pi-durable';
import { createExpectAssertions, createStorageConformance } from '@earendil-works/pi-durable/testing';
import { createDatabaseCoordinator, openDatabase, type DatabaseCoordinator } from '@flowmate/core';
import * as durable from '@flowmate/runtime-durable';

const models = () => createModels({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
  authContext: { env: async () => undefined, fileExists: async () => false } });
const openHarness = (storage: Storage) => Harness.open(storage, { models: models(), registry: createRegistry() }, BACKGROUND_CONTEXT);

test('the actual product database and Durable share its owner queue without changing product migrations or closing legacy storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-owned-durable-storage-'));
  const opened = openDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  if (!opened.ok) throw Error(opened.error.code);
  const owner = opened.data, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let harness: Harness | undefined;
  try {
    const before = await owner.read(scope => scope.db.query('SELECT version FROM schema_migrations ORDER BY version').all());
    const storage = await durable.createDurableSqliteStorage(owner.coordinator);
    harness = await openHarness(storage);
    const writing = owner.transaction(async scope => {
      const session = scope.sessions.create({ nativeSessionId: 'legacy-shared-owner', title: 'Shared owner', at: '2026-10-28T00:00:00.000Z' });
      if (!session.ok) throw Error(session.error.code);
      entered.resolve(); await release.promise;
    });
    await Promise.race([entered.promise, writing]);
    let nativeDone = false, productRead = false;
    const native = harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT)
      .then(value => { nativeDone = true; return value; });
    const reading = owner.read(scope => { productRead = true; return scope.sessions.get(1); });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(nativeDone).toBe(false); expect(productRead).toBe(false);
    release.resolve(); await writing;
    const conversation = await native;
    expect(await storage.conversation(conversation.id, BACKGROUND_CONTEXT)).toEqual(conversation);
    expect(await reading).toMatchObject({ ok: true, data: { title: 'Shared owner' } });
    await harness.close(BACKGROUND_CONTEXT); harness = undefined;
    expect(await owner.read(scope => scope.sessions.get(1))).toMatchObject({ ok: true, data: { nativeSessionId: 'legacy-shared-owner' } });
    expect(await owner.read(scope => scope.db.query('SELECT version FROM schema_migrations ORDER BY version').all())).toEqual(before);
  } finally { release.resolve(); if (harness) await harness.close(BACKGROUND_CONTEXT); await owner.close(); await rm(root, { recursive: true, force: true }); }
});

const upstreamCases = createStorageConformance({
  assertions: createExpectAssertions(expect),
  withStorage: async use => {
    const coordinator = createDatabaseCoordinator(new Database(':memory:'));
    let storage: Storage | undefined;
    try { storage = await durable.createDurableSqliteStorage(coordinator); await use(storage); }
    finally { if (storage) await storage.close(BACKGROUND_CONTEXT); await coordinator.close(); }
  },
});
for (const sample of upstreamCases) test(`Durable SQLite official conformance: ${sample.name}`, () => sample.run(), 15_000);


test('the product Durable factory persists a real model/tool result and reads its original receipt after reopening without replaying the unsafe write', async () => {
  const { Type } = await import('@earendil-works/pi-ai');
  const { defineTool } = await import('@earendil-works/pi-durable');
  const { ok } = await import('@flowmate/contracts');
  const root = await mkdtemp(join(tmpdir(), 'flowmate-durable-sqlite-tool-')), path = join(root, 'app.sqlite');
  let coordinator = createDatabaseCoordinator(new Database(path, { create: true }));
  let runtime: Awaited<ReturnType<typeof durable.createDurableRuntime>> | undefined;
  let requests = 0, calls = 0, credentialReads = 0;
  const server = Bun.serve({ port: 0, fetch: () => {
    requests++;
    const tool = requests === 1;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'save-seven', type: 'function',
      function: { name: 'save_product_fact', arguments: '{}' } }] } : { role: 'assistant', content: 'Product fact saved.' };
    const chunk = { id: 'sqlite-round', object: 'chat.completion.chunk', created: 1, model: 'sqlite-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    await coordinator.transaction(async sql => { await sql.exec('CREATE TABLE product_values (id INTEGER PRIMARY KEY, value TEXT)'); });
    const registry = createRegistry();
    registry.install({ name: 'controlled-product', tools: [defineTool({ name: 'save_product_fact', description: 'Persist the controlled product fact.',
      parameters: Type.Object({}), replay: 'unsafe', execute: async () => {
        calls++; await coordinator.transaction(async sql => { await sql.run('INSERT INTO product_values VALUES (?,?)', 7, 'saved-once'); });
        return { output: [{ type: 'text', text: 'saved-once' }] };
      } })] });
    const options = { registry, readApiKey: () => { credentialReads++; return 'synthetic-key'; },
      verifyModelUse: () => ok(undefined), reserveModelRequest: () => ok(undefined) };
    runtime = await durable.createDurableRuntime({ ...options, storage: await durable.createDurableSqliteStorage(coordinator) });
    if (!runtime.ok) throw Error(runtime.error.code);
    expect(await runtime.data.openConversation({ workId: 7, sessionId: 70 })).toMatchObject({ ok: true });
    const query = { workId: 7, sessionId: 70, attemptId: 700, requestId: 'sqlite-input' };
    const config = { version: 1, name: 'sqlite-profile', revision: 1,
      modelRef: { provider: 'controlled-sqlite', model: 'sqlite-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
      connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64_000, maxTokens: 8_192 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } } satisfies import('@flowmate/contracts').ProviderConfig;
    const submitted = await runtime.data.submit({ ...query, config, text: 'Save the selected fact.' });
    if (!submitted.ok) throw Error(submitted.error.code);
    expect(await runtime.data.waitForSubmission(query)).toMatchObject({ ok: true, data: { status: 'done', answer: 'Product fact saved.' } });
    expect(requests).toBe(2); expect(calls).toBe(1);
    await runtime.data.close(); runtime = undefined;
    expect(await coordinator.read(sql => sql.get('SELECT value FROM product_values WHERE id=7'))).toEqual({ value: 'saved-once' });
    await coordinator.close();
    coordinator = createDatabaseCoordinator(new Database(path));
    runtime = await durable.createDurableRuntime({ ...options, storage: await durable.createDurableSqliteStorage(coordinator) });
    if (!runtime.ok) throw Error(runtime.error.code);
    const reads = credentialReads;
    expect(await runtime.data.getSubmission(query)).toMatchObject({ ok: true, data: {
      nativeSubmissionId: submitted.data.nativeSubmissionId, status: 'done', answer: 'Product fact saved.',
    } });
    expect(await runtime.data.submit({ ...query, config, text: 'Save the selected fact.' })).toMatchObject({ ok: true,
      data: { nativeSubmissionId: submitted.data.nativeSubmissionId } });
    const history = await runtime.data.queryHistory({ workId: 7, sessionId: 70, limit: 100 });
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.data.entries.some(entry => entry.json.includes('Product fact saved.'))).toBe(true);
    expect(await runtime.data.resumeAttempt({ workId: 7, sessionId: 70, attemptId: 700 })).toMatchObject({ ok: false });
    expect(credentialReads).toBe(reads); expect(requests).toBe(2); expect(calls).toBe(1);
    expect(await coordinator.read(sql => sql.get('SELECT COUNT(*) AS n FROM product_values'))).toEqual({ n: 1 });
  } finally { if (runtime?.ok) await runtime.data.close(); await coordinator.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 15_000);


test('Durable SQLite shares the product connection, preserves its modes and reopens its own prefixed records', async () => {
  expect(durable.createDurableSqliteStorage).toBeFunction();
  const root = await mkdtemp(join(tmpdir(), 'flowmate-durable-sqlite-')), path = join(root, 'app.sqlite');
  let coordinator: DatabaseCoordinator | undefined, storage: Storage | undefined, harness: Harness | undefined;
  try {
    const db = new Database(path, { create: true });
    db.exec('PRAGMA foreign_keys=ON'); db.exec('PRAGMA journal_mode=DELETE'); db.exec('PRAGMA locking_mode=EXCLUSIVE'); db.exec('PRAGMA user_version=20');
    coordinator = createDatabaseCoordinator(db);
    await coordinator.transaction(async sql => {
      await sql.exec('CREATE TABLE product_values (id INTEGER PRIMARY KEY, value TEXT)');
      await sql.run('INSERT INTO product_values VALUES (?,?)', 7, 'original product fact');
    });
    storage = await durable.createDurableSqliteStorage(coordinator);
    harness = await openHarness(storage);
    const recorded = await harness.commit(async tx => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      const entry = await tx.appendEntry(conversation.id, { kind: 'flowmate.test.fact', data: { invoiceId: 7 } });
      return { conversationId: conversation.id, entryId: entry.id };
    }, BACKGROUND_CONTEXT);
    expect(await coordinator.read(sql => sql.get('PRAGMA foreign_keys'))).toEqual({ foreign_keys: 1 });
    expect(await coordinator.read(sql => sql.get('PRAGMA journal_mode'))).toEqual({ journal_mode: 'delete' });
    expect(await coordinator.read(sql => sql.get('PRAGMA locking_mode'))).toEqual({ locking_mode: 'exclusive' });
    expect(await coordinator.read(sql => sql.get('PRAGMA user_version'))).toEqual({ user_version: 20 });
    const tables = await coordinator.read(sql => sql.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"));
    expect(tables.some(table => table.name === 'fm_durable_conversations')).toBe(true);
    expect(tables.every(table => table.name === 'product_values' || table.name.startsWith('fm_durable_'))).toBe(true);
    await harness.close(BACKGROUND_CONTEXT); harness = undefined; storage = undefined;
    expect(await coordinator.read(sql => sql.get('SELECT value FROM product_values WHERE id=7'))).toEqual({ value: 'original product fact' });
    await coordinator.close(); coordinator = undefined;
    coordinator = createDatabaseCoordinator(new Database(path));
    storage = await durable.createDurableSqliteStorage(coordinator);
    harness = await openHarness(storage);
    expect(await storage.entry(recorded.entryId, BACKGROUND_CONTEXT)).toMatchObject({
      entry: { id: recorded.entryId, conversationId: recorded.conversationId, kind: 'flowmate.test.fact', data: { invoiceId: 7 } },
    });
    expect(await coordinator.read(sql => sql.get('SELECT value FROM product_values WHERE id=7'))).toEqual({ value: 'original product fact' });
  } finally {
    if (harness) await harness.close(BACKGROUND_CONTEXT); else if (storage) await storage.close(BACKGROUND_CONTEXT);
    await coordinator?.close(); await rm(root, { recursive: true, force: true });
  }
});

test('Durable storage queries and native commits wait behind the same cross-await product transaction', async () => {
  expect(durable.createDurableSqliteStorage).toBeFunction();
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const storage = await durable.createDurableSqliteStorage(coordinator), harness = await openHarness(storage);
  try {
    const product = coordinator.transaction(async sql => {
      await sql.exec('CREATE TABLE product_values (id INTEGER)'); await sql.run('INSERT INTO product_values VALUES (7)');
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    let commitDone = false, readDone = false;
    const native = harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT)
      .then(value => { commitDone = true; return value; });
    const reading = storage.scanConversations({}, 100, undefined, BACKGROUND_CONTEXT).then(value => { readDone = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(commitDone).toBe(false); expect(readDone).toBe(false);
    release.resolve(); await product;
    const conversation = await native; await reading;
    expect(await storage.conversation(conversation.id, BACKGROUND_CONTEXT)).toEqual(conversation);
    expect(await coordinator.read(sql => sql.get('SELECT id FROM product_values'))).toEqual({ id: 7 });
  } finally { release.resolve(); await harness.close(BACKGROUND_CONTEXT); await coordinator.close(); }
});

test('a failed native SQLite commit rolls back its identifiers without closing or rewriting the shared product connection', async () => {
  expect(durable.createDurableSqliteStorage).toBeFunction();
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const storage = await durable.createDurableSqliteStorage(coordinator), harness = await openHarness(storage);
  try {
    await coordinator.transaction(async sql => {
      await sql.exec('CREATE TABLE product_values (id INTEGER)'); await sql.run('INSERT INTO product_values VALUES (7)');
      await sql.exec("CREATE TRIGGER refuse_native_conversation BEFORE INSERT ON fm_durable_conversations BEGIN SELECT RAISE(ABORT,'controlled native refusal'); END");
    });
    await expect(harness.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT)).rejects.toThrow();
    expect(await coordinator.read(sql => sql.get('SELECT COUNT(*) AS n FROM fm_durable_conversations'))).toEqual({ n: 0 });
    expect(await coordinator.read(sql => sql.get('SELECT COUNT(*) AS n FROM fm_durable_record_ids'))).toEqual({ n: 0 });
    expect(await coordinator.read(sql => sql.get('SELECT id FROM product_values'))).toEqual({ id: 7 });
  } finally { await harness.close(BACKGROUND_CONTEXT); await coordinator.close(); }
});
