import { expect, test } from 'bun:test';
import * as core from '@flowmate/core';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase } from '../../support/database.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';
import { openVikingContentFixture, openVikingSessionFixture, openVikingUserHealth } from '../../support/openviking.ts';
import { mkdtempSync } from '../../support/resources.ts';
import type { Result } from '@flowmate/contracts';

const at = '2026-11-07T00:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-ov-repository-'));
  return need(openTestDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') }));
}

test('memory settings default to native with all external access disabled', async () => {
  const db = fixture();
  try {
    expect(db.memoryIntegration).toBeDefined();
    expect(await db.read(scope => scope.memoryIntegration.getSettings())).toMatchObject({ ok: true, data: {
      revision: 0, provider: 'native', recallEnabled: false, captureMode: 'off', endpoint: null } });
  } finally { await db.close(); }
});

test('memory settings preserve the first revision and reject stale or remote endpoint updates', async () => {
  const db = fixture();
  try {
    expect(db.memoryIntegration).toBeDefined();
    const update = { expectedRevision: 0, provider: 'openviking' as const, recallEnabled: true,
      captureMode: 'explicit' as const, endpoint: 'http://127.0.0.1:19338', at };
    expect(await db.transaction(scope => scope.memoryIntegration.saveSettings(update))).toMatchObject({ ok: true, data: {
      revision: 1, provider: 'openviking', recallEnabled: true, captureMode: 'explicit', endpoint: update.endpoint } });
    expect(await db.transaction(scope => scope.memoryIntegration.saveSettings(update))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await db.transaction(scope => scope.memoryIntegration.saveSettings({ ...update, expectedRevision: 1,
      endpoint: 'http://example.com:19338' }))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await db.transaction(scope => scope.memoryIntegration.saveSettings({ ...update, expectedRevision: 1,
      endpoint: 'http://127.0.0.1:19338/#' }))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await db.read(scope => scope.memoryIntegration.getSettings())).toMatchObject({ ok: true, data: { revision: 1, endpoint: update.endpoint } });
  } finally { await db.close(); }
});

test('a Session keeps its first native binding after the default backend changes', async () => {
  const db = fixture();
  try {
    expect(db.memoryIntegration).toBeDefined();
    const session = need(await db.transaction(scope => scope.sessions.create({ nativeSessionId: 'memory-original', title: 'Original', at })));
    const binding = need(await db.transaction(scope => scope.memoryIntegration.bindSession({ sessionId: session.sessionId, branch: 0,
      provider: 'native', identityId: null, remoteSessionId: null, at })));
    need(await db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: 'http://127.0.0.1:19338', at })));
    expect(await db.read(scope => scope.memoryIntegration.getSessionBinding({ sessionId: session.sessionId, branch: 0 })))
      .toEqual({ ok: true, data: binding });
    expect(await db.transaction(scope => scope.memoryIntegration.bindSession({ sessionId: session.sessionId, branch: 0,
      provider: 'native', identityId: null, remoteSessionId: null, at }))).toEqual({ ok: true, data: binding });
  } finally { await db.close(); }
});

test('automatic capture retains all inputs in a completed batch larger than 100', async () => {
  const f = await recallFixture();
  const runtime = core.createMemoryRuntime({ database: f.db, owner: { environment: 'local', ownerId: 'owner' },
    readCredential: async () => undefined, now: () => at });
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: false, captureMode: 'auto', endpoint: 'http://127.0.0.1:19338', at })));
    const inputIds = Array.from({ length: 101 }, (_, index) => index + 41);
    const saved = await f.db.transaction(scope => {
      runtime.sync.enqueue(scope, { version: 1, sessionId: f.binding.sessionId, runId: 1, inputIds, resultEntryId: 'original-result' });
      return scope.db.query<{ source_json: string }, [number]>('SELECT source_json FROM memory_sync WHERE binding_id=?').get(f.binding.id);
    });
    expect(saved && JSON.parse(saved.source_json).inputIds).toEqual(inputIds);
  } finally { await runtime.sync.close(); await f.db.close(); }
});

test('each Durable invoice keeps its own original memory binding', async () => {
  const f = await invoiceWorkToolsFixture({ itemLane: true });
  try {
    expect(typeof f.database.memoryIntegration.bindWork).toBe('function');
    const view = need(await f.database.read(scope => scope.invoiceWorks.get({ view: 'work', workId: f.created.workId, limit: 10 })));
    if (view.view !== 'work' || view.items.length !== 2) throw Error('Expected two controlled invoices');
    const common = { sessionId: f.created.sessionId, workId: f.created.workId, branch: 0,
      provider: 'native' as const, identityId: null, remoteSessionId: null, at };
    const first = need(await f.database.transaction(scope => scope.memoryIntegration.bindWork({ ...common, itemId: view.items[0]!.itemId })));
    const second = need(await f.database.transaction(scope => scope.memoryIntegration.bindWork({ ...common, itemId: view.items[1]!.itemId })));
    expect(first.id).not.toBe(second.id);
    expect(await f.database.read(scope => scope.memoryIntegration.getWorkBinding({ workId: f.created.workId, itemId: first.itemId, branch: 0 })))
      .toEqual({ ok: true, data: first });
    expect(await f.database.read(scope => scope.memoryIntegration.getWorkBinding({ workId: f.created.workId, itemId: second.itemId, branch: 0 })))
      .toEqual({ ok: true, data: second });
    expect(await f.database.transaction(scope => scope.memoryIntegration.bindWork({ ...common, sessionId: f.created.sessionId + 100,
      itemId: view.items[0]!.itemId }))).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  } finally { await f.database.close(); }
});

async function recallFixture(endpoint = 'http://127.0.0.1:19338', approvedContent = 'Original fact') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-ov-recall-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') };
  const db = need(openTestDatabase(paths));
  db.db.query('UPDATE memory_config SET endpoint=? WHERE id=1').run(endpoint);
  const session = need(await db.transaction(scope => scope.sessions.create({ nativeSessionId: 'memory-recall', title: 'Recall', at })));
  db.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(41,?,1,'prompt','answer','{\"version\":1}','failed','failed',?,?)").run(session.sessionId, at, at);
  db.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
  const binding = need(await db.transaction(scope => scope.memoryIntegration.bindSession({ sessionId: session.sessionId, branch: 0,
    provider: 'openviking', identityId: 1, remoteSessionId: 'original-remote', at })));
  need(await db.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: session.sessionId, inputId: 41, bindingId: binding.id })));
  db.db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(1,1,?,'viking://user/alice/memories/fact.md',1,'active',?,?,?)")
    .run(endpoint, JSON.stringify({ version: 1, approvedContent, origin: { bindingId: binding.id, inputId: 41, phaseId: null } }), at, at);
  db.db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(1,'personal','owner',1)").run();
  return { db, binding, paths, key: { bindingId: binding.id, inputId: 41, phaseId: null } };
}

test('a recall snapshot keeps its original input identity and refuses conflicting results', async () => {
  const f = await recallFixture();
  try {
    expect(typeof f.db.memoryIntegration.reserveRecall).toBe('function');
    const first = need(await f.db.transaction(scope => scope.memoryIntegration.reserveRecall({ ...f.key, at })));
    expect(first).toMatchObject({ created: true, snapshot: { status: 'pending', items: [] } });
    expect(await f.db.transaction(scope => scope.memoryIntegration.reserveRecall({ ...f.key, at })))
      .toMatchObject({ ok: true, data: { created: false, snapshot: { id: first.snapshot.id, status: 'pending' } } });
    const result = { status: 'ready' as const, items: [{ uri: 'viking://user/alice/memories/fact.md', revision: 1, content: 'Original fact', truncated: false }] };
    const saved = need(await f.db.transaction(scope => scope.memoryIntegration.completeRecall({ ...f.key, result })));
    expect(saved).toMatchObject({ id: first.snapshot.id, status: 'ready', items: result.items });
    expect(await f.db.transaction(scope => scope.memoryIntegration.completeRecall({ ...f.key, result }))).toEqual({ ok: true, data: saved });
    expect(await f.db.transaction(scope => scope.memoryIntegration.completeRecall({ ...f.key,
      result: { ...result, items: [{ ...result.items[0]!, content: 'Changed fact' }] } })))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await f.db.read(scope => scope.memoryIntegration.getRecall(f.key))).toEqual({ ok: true, data: saved });
  } finally { await f.db.close(); }
});

test('a pending recall becomes unavailable after restart without a new external read', async () => {
  const f = await recallFixture();

  try {
    expect(typeof f.db.memoryIntegration.reserveRecall).toBe('function');
    need(await f.db.transaction(scope => scope.memoryIntegration.reserveRecall({ ...f.key, at })));
  } finally { await f.db.close(); }
  const reopened = need(openTestDatabase(f.paths));
  try { expect(await reopened.read(scope => scope.memoryIntegration.getRecall(f.key)))
    .toMatchObject({ ok: true, data: { status: 'unavailable', items: [] } }); }
  finally { await reopened.close(); }
});

test('a lost remote Session creation receipt is checked by its original identity without creating twice', async () => {
  let created = '', creates = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/sessions' && request.method === 'POST') {
      creates++; created = (await request.json() as { session_id: string }).session_id; return new Response('lost receipt', { status: 503 });
    }
    if (path === `/api/v1/sessions/${created}` && request.method === 'GET') return Response.json({ status: 'ok', result: {
      session_id: created, uri: `viking://user/alice/sessions/${created}`, user: { account_id: 'account', user_id: 'alice' }, auto_commit_policy: null } });
    if (path === '/api/v1/content/read') return Response.json({ status: 'ok', result: 'Original fact' });
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md' }] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  let db = f.db;
  try {
    need(await db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    db.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(42,?,2,'prompt','answer','{\"version\":1}','failed','failed',?,?)")
      .run(f.binding.sessionId, at, at);
    need(await db.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: f.binding.sessionId, inputId: 42, bindingId: f.binding.id })));
    let runtime = core.createMemoryRuntime({ database: db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'unavailable', items: [] } });
    await runtime.sync.close(); await db.close();
    db = need(openTestDatabase(f.paths));
    runtime = core.createMemoryRuntime({ database: db, readCredential: async () => 'synthetic-key', now: () => at });
    expect(await runtime.recall({ ...input, inputId: 42 })).toMatchObject({ ok: true, data: { status: 'ready', items: [{ content: 'Original fact' }] } });
    expect(creates).toBe(1);
    await runtime.sync.close();
  } finally { server.stop(true); await db.close(); }
});

test('switching the default to native does not disable an already bound OpenViking Session', async () => {
  const f = await recallFixture();
  try {
    expect(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'native',
      recallEnabled: true, captureMode: 'auto', endpoint: 'http://127.0.0.1:19338', at })))
      .toMatchObject({ ok: true, data: { provider: 'native', recallEnabled: true, captureMode: 'auto' } });
    expect(await f.db.read(scope => scope.memoryIntegration.getSessionBinding({ sessionId: f.binding.sessionId, branch: 0 })))
      .toMatchObject({ ok: true, data: { provider: 'openviking', id: f.binding.id } });
  } finally { await f.db.close(); }
});

test('turning recall off removes cached memory text and prevents a stale result from being restored', async () => {
  const f = await recallFixture();
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: 'http://127.0.0.1:19338', at })));
    need(await f.db.transaction(scope => scope.memoryIntegration.reserveRecall({ ...f.key, at })));
    const result = { status: 'ready' as const, items: [{ uri: 'viking://user/alice/memories/fact.md', revision: 1, content: 'Private fact', truncated: false }] };
    need(await f.db.transaction(scope => scope.memoryIntegration.completeRecall({ ...f.key, result })));
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 1, provider: 'openviking',
      recallEnabled: false, captureMode: 'explicit', endpoint: 'http://127.0.0.1:19338', at })));
    expect(await f.db.read(scope => scope.memoryIntegration.getRecall(f.key))).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    expect(await f.db.transaction(scope => scope.memoryIntegration.completeRecall({ ...f.key, result })))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  } finally { await f.db.close(); }
});

test('one authorized input reuses its recall and revocation removes the result', async () => {
  expect(typeof core.createMemoryRuntime).toBe('function');
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const content = openVikingContentFixture(request, 'Original fact'); if (content) return content;
    requests++; await new Promise(resolve => setTimeout(resolve, 30));
    return Response.json({ status: 'ok', result: { memories: [
      { uri: 'viking://user/alice/memories/fact.md', abstract: 'Original fact' },
      { uri: 'viking://user/alice/memories/ungranted.md', abstract: 'Not authorized' },
    ], resources: [], skills: [] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original question', timeoutMs: 2000 };
    const [first, second] = await Promise.all([runtime.recall(input), runtime.recall(input)]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, data: { status: 'ready', items: [{ content: 'Original fact' }] } });
    expect(requests).toBe(1);
    expect(await runtime.recall({ ...input, owner: { ...input.owner, ownerId: 'another-owner' } }))
      .toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
    f.db.db.query('DELETE FROM memory_grants WHERE entry_id=1').run();
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    expect(await f.db.read(scope => scope.memoryIntegration.getRecall(f.key)))
      .toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 1, provider: 'openviking',
      recallEnabled: false, captureMode: 'explicit', endpoint: `http://127.0.0.1:${server.port}`, at })));
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    expect(requests).toBe(1);
  } finally { server.stop(true); await f.db.close(); }
});

test('a Durable recall belongs to the original Work, invoice and phase', async () => {
  const f = await invoiceWorkToolsFixture({ itemLane: true }); let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const content = openVikingContentFixture(request, 'Work preference'); if (content) return content;
    requests++;
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/work.md', abstract: 'Work preference' }] } });
  } });
  try {
    f.database.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    f.database.db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(1,1,?,'viking://user/alice/memories/work.md',1,'active',?,?,?)")
      .run(`http://127.0.0.1:${server.port}`, JSON.stringify({ version: 1, approvedContent: 'Work preference' }), at, at);
    f.database.db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(1,'work',?,1)").run(String(f.created.workId));
    need(await f.database.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.database, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { workId: f.created.workId, sessionId: f.created.sessionId, itemId: f.itemId, attemptId: f.attemptId,
      phaseId: f.phase.phaseId, requestId: f.phase.requestId, owner: { environment: 'local' as const, ownerId: 'owner' },
      query: 'original invoice work', timeoutMs: 2000 };
    expect(await runtime.recallWork(input)).toMatchObject({ ok: true, data: { status: 'ready', items: [{ content: 'Work preference' }] } });
    expect(await runtime.recallWork({ ...input, itemId: input.itemId + 1 })).toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
    expect(await runtime.recallWork({ ...input, attemptId: input.attemptId + 1 })).toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
    expect(await runtime.recallWork(input)).toMatchObject({ ok: true, data: { status: 'ready' } });
    expect(requests).toBe(1);
  } finally { server.stop(true); await f.database.close(); }
});

test('the same owner recalls only its original runtime lane, including when reopening a saved snapshot', async () => {
  const f = await invoiceWorkToolsFixture({ itemLane: true });
  const chatUri = 'viking://user/alice/memories/chat.md', workUri = 'viking://user/alice/memories/work.md';
  const legacyUri = 'viking://user/alice/memories/unknown-origin.md';
  const contents = new Map([[chatUri, 'Chat preference'], [workUri, 'Work preference'], [legacyUri, 'Unknown origin']]);
  const targets: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const uri = new URL(request.url).searchParams.get('uri');
    const content = openVikingContentFixture(request, contents.get(uri ?? '') ?? 'Unexpected read'); if (content) return content;
    targets.push((await request.json() as { target_uri: unknown }).target_uri);
    return Response.json({ status: 'ok', result: { memories: [...contents].map(([uri]) => ({ uri })) } });
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const db = f.database.db;
    db.query("INSERT INTO memory_identities VALUES(1,'local','owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    need(await f.database.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint, at })));
    const session = need(await f.database.transaction(scope => scope.sessions.create({ nativeSessionId: 'memory-lane', title: 'Chat', at })));
    const input = db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at)
      VALUES(?,1,'prompt','answer','{"version":1}','failed','failed',?,?)`).run(session.sessionId, at, at);
    const inputId = Number(input.lastInsertRowid);
    const chat = need(await f.database.transaction(scope => scope.memoryIntegration.bindSession({ sessionId: session.sessionId, branch: 0,
      provider: 'openviking', identityId: 1, remoteSessionId: 'lane-chat', at })));
    need(await f.database.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: session.sessionId, inputId, bindingId: chat.id })));
    const work = need(await f.database.transaction(scope => scope.memoryIntegration.bindWork({ workId: f.created.workId, sessionId: f.created.sessionId,
      itemId: f.itemId, branch: 0, provider: 'openviking', identityId: 1, remoteSessionId: 'lane-work', at })));
    const chatKey = { bindingId: chat.id, inputId, phaseId: null }, workKey = { bindingId: work.id, inputId: null, phaseId: f.phase.phaseId };
    for (const [uri, origin] of [[chatUri, chatKey], [workUri, workKey], [legacyUri, undefined]] as const) {
      const entry = db.query(`INSERT INTO memory_entries(identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at)
        VALUES(1,?,?,1,'active',?,?,?)`).run(endpoint, uri, JSON.stringify({ version: 1, approvedContent: contents.get(uri), origin }), at, at);
      db.query("INSERT INTO memory_grants VALUES(?,'personal','owner',1)").run(entry.lastInsertRowid);
    }
    need(await f.database.transaction(scope => scope.memoryIntegration.reserveRecall({ ...workKey, at })));
    need(await f.database.transaction(scope => scope.memoryIntegration.completeRecall({ ...workKey, result: { status: 'ready',
      items: [...contents].map(([uri, content]) => ({ uri, content, revision: 1, truncated: false })) } })));
    const runtime = core.createMemoryRuntime({ database: f.database, readCredential: async () => 'synthetic-key', now: () => at });
    const request = { owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'preference', timeoutMs: 2000 };
    expect(need(await runtime.recall({ ...chatKey, ...request })).items.map(item => item.uri)).toEqual([chatUri]);
    expect(need(await runtime.recall({ ...workKey, ...request })).items.map(item => item.uri)).toEqual([workUri]);
    expect(need(await runtime.search({ ...workKey, ...request })).items.map(item => item.uri)).toEqual([workUri]);
    expect(targets).toEqual([[chatUri], [workUri]]);
    expect(need(await f.database.read(scope => scope.memoryIntegration.getRecall(workKey)))?.items.map(item => item.uri)).toEqual([workUri]);
    expect(db.query('SELECT uri FROM memory_entries ORDER BY id').values().flat()).toEqual([...contents.keys()]);
  } finally { server.stop(true); await f.database.close(); }
});

test('enabling recall later does not retrospectively query the original disabled input', async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json({ status: 'ok', result: { memories: [] } }); } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: false, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 1, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    expect(requests).toBe(0);
  } finally { server.stop(true); await f.db.close(); }
});

test('permanently deleting a Session also removes its local memory binding and recall', async () => {
  const f = await recallFixture();
  try {
    f.db.db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(1,'session',?,1)").run(String(f.binding.sessionId));
    need(await f.db.transaction(scope => scope.memoryIntegration.reserveRecall({ ...f.key, at })));
    need(await f.db.transaction(scope => scope.memoryIntegration.completeRecall({ ...f.key,
      result: { status: 'ready', items: [{ uri: 'viking://user/alice/memories/fact.md', revision: 1, content: 'Original fact', truncated: false }] } })));
    need(await f.db.transaction(scope => scope.sessions.prepareDelete(f.binding.sessionId, at)));
    expect(await f.db.transaction(scope => scope.sessions.delete(f.binding.sessionId, at))).toEqual({ ok: true, data: 'permanent' });
    expect(f.db.db.query('SELECT id FROM memory_bindings WHERE id=?').get(f.binding.id)).toBeNull();
    expect(f.db.db.query('SELECT id FROM memory_recalls WHERE binding_id=?').get(f.binding.id)).toBeNull();
    expect(f.db.db.query('SELECT scope_kind,scope_id FROM memory_grants WHERE entry_id=1').all()).toEqual([{ scope_kind: 'personal', scope_id: 'owner' }]);
    const replacement = need(await f.db.transaction(scope => scope.sessions.create({ nativeSessionId: 'reused-session-id', title: 'Replacement', at })));
    expect(replacement.sessionId).toBe(f.binding.sessionId);
    expect(f.db.db.query("SELECT entry_id FROM memory_grants WHERE scope_kind='session' AND scope_id=?").all(String(replacement.sessionId))).toEqual([]);
    expect(f.db.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { await f.db.close(); }
});

test('unresolved remote memory operations survive Session deletion and input cascades', async () => {
  const f = await recallFixture();
  try {
    f.db.db.query(`INSERT INTO memory_sync(binding_id,input_id,state,source_json,created_at,updated_at)
      VALUES(?,?,'unknown','{}',?,?)`).run(f.binding.id, f.key.inputId, at, at);
    expect(await f.db.transaction(scope => scope.sessions.prepareDelete(f.binding.sessionId, at)))
      .toMatchObject({ ok: false, error: { code: 'memory_operation_unresolved' } });
    expect(() => f.db.db.query('DELETE FROM session_inputs WHERE id=?').run(f.key.inputId)).toThrow();
    expect(f.db.db.query('SELECT state FROM memory_sync WHERE binding_id=?').get(f.binding.id)).toEqual({ state: 'unknown' });
    f.db.db.query("UPDATE memory_sync SET state='completed' WHERE binding_id=?").run(f.binding.id);
    f.db.db.query(`INSERT INTO memory_remember_requests(identity_id,binding_id,input_id,request_id,uri,content,scope_kind,scope_id,state,created_at,updated_at)
      VALUES(1,?,?,'remember-original','viking://user/alice/memories/example.md','approved','personal','owner','sending',?,?)`)
      .run(f.binding.id, f.key.inputId, at, at);
    expect(await f.db.transaction(scope => scope.sessions.prepareDelete(f.binding.sessionId, at)))
      .toMatchObject({ ok: false, error: { code: 'memory_operation_unresolved' } });
    expect(() => f.db.db.query('DELETE FROM session_inputs WHERE id=?').run(f.key.inputId)).toThrow();
    f.db.db.query("UPDATE memory_remember_requests SET state='completed' WHERE binding_id=?").run(f.binding.id);
    f.db.db.query("UPDATE memory_bindings SET remote_state='unknown' WHERE id=?").run(f.binding.id);
    expect(await f.db.transaction(scope => scope.sessions.prepareDelete(f.binding.sessionId, at)))
      .toMatchObject({ ok: false, error: { code: 'memory_operation_unresolved' } });
    expect(() => f.db.db.query('DELETE FROM memory_bindings WHERE id=?').run(f.binding.id)).toThrow();
    f.db.db.query("UPDATE memory_bindings SET remote_state='ready' WHERE id=?").run(f.binding.id);
    need(await f.db.transaction(scope => scope.sessions.prepareDelete(f.binding.sessionId, at)));
    expect(await f.db.transaction(scope => scope.sessions.delete(f.binding.sessionId, at))).toEqual({ ok: true, data: 'permanent' });
  } finally { await f.db.close(); }
});

test('a new Work fixes separate OpenViking Sessions for all invoices at creation', async () => {
  const f = await invoiceWorkToolsFixture({ itemLane: true });
  try {
    f.database.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    need(await f.database.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: 'http://127.0.0.1:19338', at })));
    const memory = core.createMemoryRuntime({ database: f.database, readCredential: async () => undefined, now: () => at });
    const works = new core.InvoiceWorkService({ database: f.database, now: () => at, assessExecution: () => ({ ok: true,
      data: { kind: 'waiting', reason: 'Controlled test.' } }), onChanged: () => {},
      bindMemoryWork: (scope, work) => memory.bindWorkInStore(scope, work, { environment: 'local', ownerId: 'owner' }) });
    const agent = need(await f.database.read(scope => scope.personalAgents.getDefault())); if (!agent) throw Error('Missing controlled agent');
    const input = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision, requestId: 'memory-work',
      goal: 'Keep each invoice separate.', documents: [{ id: 1, version: 'v1' }, { id: 2, version: 'v1' }] };
    const receipt = need(await works.create(input));
    const before = f.database.db.query<{ provider: string; remote_session_id: string }, [number]>(
      "SELECT provider,remote_session_id FROM memory_bindings WHERE runtime_kind='durable' AND work_id=? ORDER BY item_id").all(receipt.workId);
    expect(before).toHaveLength(2); expect(before.every(item => item.provider === 'openviking')).toBe(true);
    expect(before[0]!.remote_session_id).not.toBe(before[1]!.remote_session_id);
    need(await f.database.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 1, provider: 'native',
      recallEnabled: true, captureMode: 'off', endpoint: 'http://127.0.0.1:19338', at })));
    expect(need(await works.create(input))).toEqual(receipt);
    expect(f.database.db.query("SELECT provider,remote_session_id FROM memory_bindings WHERE work_id=? ORDER BY item_id").all(receipt.workId)).toEqual(before);
  } finally { await f.database.close(); }
});

test('changing the server does not send an existing Session to the new endpoint', async () => {
  let newRequests = 0;
  const original = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    return await openVikingSessionFixture(request) ?? Response.json({ status: 'ok', result: { memories: [] } }); } });
  const replacement = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { newRequests++; return Response.json({ status: 'ok', result: { memories: [] } }); } });
  const f = await recallFixture(`http://127.0.0.1:${original.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${original.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect((await runtime.recall(input)).ok).toBe(true);
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 1, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${replacement.port}`, at })));
    f.db.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(42,?,2,'prompt','answer','{\"version\":1}','failed','failed',?,?)")
      .run(f.binding.sessionId, at, at);
    need(await f.db.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: f.binding.sessionId, inputId: 42, bindingId: f.binding.id })));
    expect(await runtime.recall({ ...input, inputId: 42 })).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    expect(newRequests).toBe(0);
  } finally { original.stop(true); replacement.stop(true); await f.db.close(); }
});

test('a new Session cannot reuse grants from the previous OpenViking endpoint', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const content = openVikingContentFixture(request, 'Original fact'); if (content) return content;
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md', abstract: 'Original fact' }] } });
  } });
  const f = await recallFixture();
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: 'http://127.0.0.1:19338', at })));
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 1, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const next = need(await f.db.transaction(scope => scope.sessions.create({ nativeSessionId: 'new-endpoint-session', title: 'New endpoint', at })));
    f.db.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(42,?,1,'prompt','answer','{\"version\":1}','failed','failed',?,?)").run(next.sessionId, at, at);
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const owner = { environment: 'local' as const, ownerId: 'owner' };
    const binding = need(await f.db.transaction(scope => runtime.bindSessionInStore(scope, next.sessionId, owner)));
    if (!binding) throw Error('Missing new Session binding.');
    need(await f.db.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: next.sessionId, inputId: 42, bindingId: binding.id })));
    expect(await runtime.recall({ bindingId: binding.id, inputId: 42, phaseId: null, owner, query: 'original fact', timeoutMs: 2000 }))
      .toMatchObject({ ok: true, data: { status: 'empty', items: [] } });
  } finally { server.stop(true); await f.db.close(); }
});

test('a reauthorized new memory revision cannot revive an old input snapshot', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { return await openVikingSessionFixture(request)
    ?? openVikingContentFixture(request, 'Old revision')
    ?? Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md', abstract: 'Old revision' }] } }); } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`, 'Old revision');
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'ready', items: [{ content: 'Old revision' }] } });
    f.db.db.query('UPDATE memory_entries SET revision=2 WHERE id=1').run();
    f.db.db.query('UPDATE memory_grants SET revision=2 WHERE entry_id=1').run();
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
    expect(await f.db.read(scope => scope.memoryIntegration.getRecall(f.key))).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
  } finally { server.stop(true); await f.db.close(); }
});

test('a mismatched OpenViking account cannot be used for semantic recall', async () => {
  let searches = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/sessions') {
      const body = await request.json() as { session_id: string };
      return Response.json({ status: 'ok', result: { session_id: body.session_id, uri: `viking://user/alice/sessions/${body.session_id}`,
        user: { account_id: 'wrong-account', user_id: 'alice' }, auto_commit_policy: null } });
    }
    if (path.endsWith('/find')) searches++;
    return Response.json({ status: 'ok', result: { memories: [] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'unavailable', items: [] } });
    expect(searches).toBe(0);
  } finally { server.stop(true); await f.db.close(); }
});

test('out-of-band remote content changes are not recalled under an old grant', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    if (new URL(request.url).pathname === '/api/v1/content/read') return Response.json({ status: 'ok', result: 'Changed outside Flowmate' });
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md', abstract: 'Changed outside Flowmate' }] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'unavailable', items: [] } });
  } finally { server.stop(true); await f.db.close(); }
});

test('a previously saved recall is withheld if its remote content later changes', async () => {
  let changed = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const content = openVikingContentFixture(request, changed ? 'Changed outside Flowmate' : 'Original fact'); if (content) return content;
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md', abstract: 'Original fact' }] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'ready' } });
    changed = true;
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'unavailable', items: [] } });
  } finally { server.stop(true); await f.db.close(); }
});

test('revocation during verification of a saved recall removes the late result', async () => {
  let pause = false; const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    if (new URL(request.url).pathname === '/api/v1/content/read') {
      if (pause) { entered.resolve(); await release.promise; }
      return Response.json({ status: 'ok', result: 'Original fact' });
    }
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md' }] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'ready' } });
    pause = true; const pending = runtime.recall(input); await entered.promise;
    await f.db.transaction(scope => scope.db.query('DELETE FROM memory_grants WHERE entry_id=1').run());
    release.resolve();
    expect(await pending).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
  } finally { release.resolve(); server.stop(true); await f.db.close(); }
});

test('a policy disabled immediately after authorization cannot release a saved recall', async () => {
  let verified = false, disableAfterRead = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    if (new URL(request.url).pathname === '/api/v1/content/read') {
      if (disableAfterRead) verified = true;
      return Response.json({ status: 'ok', result: 'Original fact' });
    }
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md' }] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const database: Pick<typeof f.db, 'read' | 'transaction'> = { transaction: f.db.transaction,
      async read(operation) {
        const value = await f.db.read(operation);
        if (verified && value && typeof value === 'object' && 'ok' in value && value.ok && 'data' in value
          && value.data && typeof value.data === 'object' && 'identity' in value.data) {
          verified = false;
          need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 1, provider: 'openviking',
            recallEnabled: false, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
        }
        return value;
      } };
    const runtime = core.createMemoryRuntime({ database, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, query: 'original input', timeoutMs: 2000 };
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'ready' } });
    disableAfterRead = true;
    expect(await runtime.recall(input)).toMatchObject({ ok: true, data: { status: 'disabled', items: [] } });
  } finally { server.stop(true); await f.db.close(); }
});

test('an explicitly confirmed memory is written once and can be recalled under its owner grant', async () => {
  let writes = 0, storedUri = '', storedContent = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/content/write') {
      const body = await request.json() as { uri: string; content: string; mode: string; wait: boolean };
      expect(body.mode).toBe('create'); expect(body.wait).toBe(true);
      writes++; storedUri = body.uri; storedContent = body.content;
      await new Promise(resolve => setTimeout(resolve, 30));
      return Response.json({ status: 'ok', result: { uri: storedUri, mode: 'create', context_type: 'memory',
        content_updated: true, vector_status: 'complete' } });
    }
    if (path === '/api/v1/content/read') return Response.json({ status: 'ok', result: storedContent });
    if (path === '/api/v1/fs' && request.method === 'DELETE') return Response.json({ status: 'ok', result: { uri: storedUri } });
    return Response.json({ status: 'ok', result: { memories: [{ uri: storedUri, abstract: storedContent }] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const owner = { environment: 'local' as const, ownerId: 'owner' };
    const input = { ...f.key, owner, requestId: 'remember-original', content: 'Prefers concise invoices.', scope: { kind: 'personal' as const }, confirmed: true as const };
    const [first, conflicting] = await Promise.all([runtime.remember(input), runtime.remember({ ...input, content: 'Different content.' })]);
    const saved = need(first);
    expect(saved).toMatchObject({ state: 'completed', uri: storedUri });
    expect(conflicting).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(need(await runtime.remember(input))).toEqual(saved);
    expect(await runtime.remember({ ...input, content: 'Different content.' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(writes).toBe(1);
    expect(await runtime.recall({ ...f.key, owner, query: 'invoice preference', timeoutMs: 2000 }))
      .toMatchObject({ ok: true, data: { status: 'ready', items: [{ uri: storedUri, content: 'Prefers concise invoices.' }] } });
    if (!saved.entryId) throw Error('Missing remembered entry.');
    expect(await runtime.forget({ entryId: saved.entryId, expectedRevision: 1, requestId: 'forget-saved', owner, confirmed: true }))
      .toMatchObject({ ok: true, data: { state: 'completed' } });
    expect(f.db.db.query('SELECT content,state FROM memory_remember_requests WHERE entry_id=?').get(saved.entryId))
      .toEqual({ content: '', state: 'forgotten' });
    expect(JSON.stringify(f.db.db.query('SELECT source_json FROM memory_entries WHERE id=?').get(saved.entryId)))
      .not.toContain('Prefers concise invoices.');
    expect(await runtime.remember(input)).toMatchObject({ ok: false, error: { code: 'memory_forgotten' } });
    expect(writes).toBe(1);
  } finally { server.stop(true); await f.db.close(); }
});

test('an uncertain remember write is reconciled by its original URI and content without replay', async () => {
  let writes = 0, storedContent = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/content/write') {
      const body = await request.json() as { content: string }; writes++; storedContent = body.content;
      return new Response('lost receipt', { status: 503 });
    }
    if (path === '/api/v1/content/read') return Response.json({ status: 'ok', result: storedContent });
    return Response.json({ status: 'ok', result: { memories: [] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`);
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: false, captureMode: 'explicit', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const runtime = core.createMemoryRuntime({ database: f.db, readCredential: async () => 'synthetic-key', now: () => at });
    const input = { ...f.key, owner: { environment: 'local' as const, ownerId: 'owner' }, requestId: 'lost-remember',
      content: 'Keep this original preference.', scope: { kind: 'personal' as const }, confirmed: true as const };
    expect(need(await runtime.remember(input)).state).toBe('unknown');
    expect(need(await runtime.remember(input)).state).toBe('unknown');
    expect(writes).toBe(1);
    expect(need(await runtime.reconcileRemember(input))).toMatchObject({ state: 'unknown', contentConfirmed: true });
    expect(need(await runtime.remember(input)).state).toBe('unknown');
    expect(writes).toBe(1);
  } finally { server.stop(true); await f.db.close(); }
});

test.each(['completed', 'unknown'] as const)('forget revokes the original grant and never repeats a %s remote delete', async outcome => {
  let deletes = 0;
  let stat: 'opaque-404' | 'absent' = 'opaque-404';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/content/read') return Response.json({ status: 'ok', result: 'Original fact' });
    if (url.pathname === '/api/v1/fs/stat') return stat === 'opaque-404' ? new Response('Not Found', { status: 404 })
      : Response.json({ status: 'error', error: { code: 'NOT_FOUND', message: 'File missing' } }, { status: 404 });
    if (url.pathname === '/api/v1/fs' && request.method === 'DELETE') {
      deletes++;
      return outcome === 'unknown' ? new Response('lost receipt', { status: 503 })
        : Response.json({ status: 'ok', result: { uri: url.searchParams.get('uri') } });
    }
    return Response.json({ status: 'ok', result: { memories: [{ uri: 'viking://user/alice/memories/fact.md' }] } });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`), owner = { environment: 'local' as const, ownerId: 'owner' };
  let db = f.db;
  try {
    need(await db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const other = need(await db.transaction(scope => scope.sessions.create({ nativeSessionId: 'other-memory-owner', title: 'Other owner', at })));
    db.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(42,?,1,'prompt','answer','{\"version\":1}','failed','failed',?,?)").run(other.sessionId, at, at);
    db.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(2,'local','other-owner','other-account','alice','other-agent','synthetic-reference','active',?,?)").run(at, at);
    const otherBinding = need(await db.transaction(scope => scope.memoryIntegration.bindSession({ sessionId: other.sessionId, branch: 0,
      provider: 'openviking', identityId: 2, remoteSessionId: 'other-session', at })));
    need(await db.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: other.sessionId, inputId: 42, bindingId: otherBinding.id })));
    const otherKey = { bindingId: otherBinding.id, inputId: 42, phaseId: null };
    need(await db.transaction(scope => scope.memoryIntegration.reserveRecall({ ...otherKey, at })));
    need(await db.transaction(scope => scope.memoryIntegration.completeRecall({ ...otherKey, result: { status: 'ready',
      items: [{ uri: 'viking://user/alice/memories/fact.md', revision: 1, content: 'Other owner fact', truncated: false }] } })));
    let runtime = core.createMemoryRuntime({ database: db, owner, readCredential: async () => 'synthetic-key', now: () => at });
    expect(await runtime.recall({ ...f.key, owner, query: 'original fact', timeoutMs: 2000 })).toMatchObject({ ok: true, data: { status: 'ready' } });
    const input = { entryId: 1, expectedRevision: 1, requestId: `forget-${outcome}`, owner, confirmed: true as const };
    expect(await runtime.forget(input)).toMatchObject({ ok: true, data: { state: outcome, requestId: input.requestId } });
    expect(await runtime.recall({ ...f.key, owner, query: 'original fact', timeoutMs: 2000 })).toMatchObject({ ok: true, data: { status: 'disabled' } });
    expect(db.db.query('SELECT state FROM memory_entries WHERE id=1').get()).toEqual({ state: 'forgotten' });
    expect(db.db.query('SELECT entry_id FROM memory_grants WHERE entry_id=1').all()).toEqual([]);
    expect(await db.read(scope => scope.memoryIntegration.getRecall(otherKey))).toMatchObject({ ok: true, data: { status: 'ready',
      items: [{ content: 'Other owner fact' }] } });
    await runtime.sync.close(); await db.close();
    db = need(openTestDatabase(f.paths));
    runtime = core.createMemoryRuntime({ database: db, owner, readCredential: async () => 'synthetic-key', now: () => at });
    expect(await runtime.forget(input)).toMatchObject({ ok: true, data: { state: outcome, requestId: input.requestId } });
    if (outcome === 'unknown') {
      const row = db.db.query<{ id: number }, []>('SELECT id FROM memory_forget_requests').get()!;
      const check = { entryId: input.entryId, requestId: input.requestId, operationId: row.id, owner };
      expect(await runtime.forget({ ...check, operationId: row.id + 1 })).toMatchObject({ ok: false });
      expect(await runtime.forget(check)).toMatchObject({ ok: true, data: { state: 'unknown' } });
      stat = 'absent';
      expect(await runtime.forget(check)).toMatchObject({ ok: true, data: { state: 'completed' } });
    }
    expect(deletes).toBe(1);
    await runtime.sync.close();
  } finally { server.stop(true); await db.close(); }
});

test('forget does not delete an independently changed remote memory', async () => {
  let deletes = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    if (request.method === 'DELETE') deletes++;
    return Response.json({ status: 'ok', result: 'Changed outside Flowmate' });
  } });
  const f = await recallFixture(`http://127.0.0.1:${server.port}`), owner = { environment: 'local' as const, ownerId: 'owner' };
  const runtime = core.createMemoryRuntime({ database: f.db, owner, readCredential: async () => 'synthetic-key', now: () => at });
  try {
    need(await f.db.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'explicit', endpoint: `http://127.0.0.1:${server.port}`, at })));
    expect(await runtime.forget({ entryId: 1, expectedRevision: 1, requestId: 'changed-forget', owner, confirmed: true }))
      .toMatchObject({ ok: true, data: { state: 'conflict' } });
    expect(deletes).toBe(0);
    expect(f.db.db.query('SELECT state FROM memory_entries WHERE id=1').get()).toEqual({ state: 'forgotten' });
  } finally { await runtime.sync.close(); server.stop(true); await f.db.close(); }
});

test('a trusted owner configures one private memory identity without returning its credential reference', async () => {
  const db = fixture();
  try {
    const manager = core.createMemoryManager({ database: db, owner: { environment: 'local', ownerId: 'installation-one' },
      readCredential: async ref => ref === 'synthetic-reference' ? 'synthetic-key' : undefined, now: () => at });
    const input = { expectedRevision: 0, endpoint: 'http://127.0.0.1:19338', accountId: 'account', userId: 'alice',
      peerId: 'flowmate.alice.agent', credentialRef: 'synthetic-reference', recallEnabled: true, captureMode: 'explicit' as const };
    const result = need(await manager.configure(input));
    expect(result).toMatchObject({ settings: { revision: 1, provider: 'openviking', recallEnabled: true },
      identity: { accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent' } });
    expect(JSON.stringify(result)).not.toContain('synthetic-reference');
    expect(JSON.stringify(result)).not.toContain('synthetic-key');
    expect(await manager.configure({ ...input, userId: 'bob' })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(db.db.query('SELECT user_id,state FROM memory_identities').all()).toEqual([{ user_id: 'alice', state: 'active' }]);
    expect(await manager.configure({ ...input, expectedRevision: 1, endpoint: 'http://example.com:19338' })).toMatchObject({ ok: false });
    expect(await manager.updatePolicy({ expectedRevision: 1, provider: 'native', recallEnabled: true, captureMode: 'explicit' }))
      .toMatchObject({ ok: true, data: { settings: { revision: 2, provider: 'native', recallEnabled: true }, identity: { userId: 'alice' } } });
    expect(await manager.get()).toMatchObject({ ok: true, data: { settings: { revision: 2, provider: 'native' } } });
  } finally { await db.close(); }
});

test('memory entry listings contain only the trusted owner and paginate by entry identity', async () => {
  const f = await recallFixture();
  try {
    f.db.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(2,'local','other-owner','account','alice','other-agent','synthetic-reference','active',?,?)").run(at, at);
    f.db.db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(2,2,?,'viking://user/alice/memories/other.md',1,'active',?,?,?)")
      .run('http://127.0.0.1:19338', JSON.stringify({ version: 1, approvedContent: 'Other owner secret' }), at, at);
    f.db.db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(3,1,?,'viking://user/alice/memories/next.md',1,'active',?,?,?)")
      .run('http://127.0.0.1:19338', JSON.stringify({ version: 1, approvedContent: 'Next fact' }), at, at);
    const manager = core.createMemoryManager({ database: f.db, owner: { environment: 'local', ownerId: 'owner' },
      readCredential: async () => undefined, now: () => at });
    const result = await manager.listEntries({ limit: 1 });
    expect(result).toMatchObject({ ok: true, data: { items: [{ entryId: 1, revision: 1, state: 'active' }], nextAfterId: 1 } });
    expect(JSON.stringify(result)).not.toContain('Other owner secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-reference');
    expect(await manager.listEntries({ limit: 1, afterId: 1 })).toMatchObject({ ok: true, data: { items: [{ entryId: 3 }], nextAfterId: null } });
    expect(await manager.readEntry({ entryId: 1 })).toMatchObject({ ok: true, data: { entryId: 1, content: 'Original fact', origin: f.key } });
    expect(await manager.readEntry({ entryId: 3 })).toMatchObject({ ok: true, data: { entryId: 3, content: 'Next fact', origin: null } });
    expect(await manager.readEntry({ entryId: 2 })).toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
  } finally { await f.db.close(); }
});

test('the owner can find the original unknown synchronization and forget operations after restart', async () => {
  const f = await recallFixture(); let db = f.db;
  try {
    db.db.query("INSERT INTO memory_sync(binding_id,input_id,state,source_json,created_at,updated_at) VALUES(?,?,'unknown','{}',?,?)")
      .run(f.binding.id, f.key.inputId, at, at);
    db.db.query("INSERT INTO memory_forget_requests(identity_id,entry_id,request_id,expected_revision,state,created_at,updated_at) VALUES(1,1,'original-forget',1,'unknown',?,?)")
      .run(at, at);
    await db.close(); db = need(openTestDatabase(f.paths));
    const manager = core.createMemoryManager({ database: db, owner: { environment: 'local', ownerId: 'owner' }, readCredential: async () => undefined, now: () => at });
    expect(await manager.listOperations({ kind: 'sync' })).toMatchObject({ ok: true, data: { items: [{ state: 'unknown', sessionId: f.binding.sessionId,
      inputId: f.key.inputId }], nextAfterId: null } });
    expect(await manager.listOperations({ kind: 'forget' })).toMatchObject({ ok: true, data: { items: [{ state: 'unknown', entryId: 1,
      requestId: 'original-forget' }], nextAfterId: null } });
    const other = core.createMemoryManager({ database: db, owner: { environment: 'local', ownerId: 'other-owner' }, readCredential: async () => undefined, now: () => at });
    expect(await other.listOperations({ kind: 'forget' })).toEqual({ ok: true, data: { items: [], nextAfterId: null } });
    const original = need(await manager.listOperations({ kind: 'sync' })).items[0]!;
    const runtime = (ownerId: string) => core.createMemoryRuntime({ database: db, owner: { environment: 'local', ownerId },
      readCredential: async () => { throw Error('abandonment must not access the remote service'); }, now: () => at });
    expect(await runtime('other-owner').sync.reconcile(original.operationId, true)).toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
    expect(await runtime('owner').sync.reconcile(original.operationId, true)).toEqual({ ok: true, data: { state: 'abandoned' } });
    expect(need(await manager.listOperations({ kind: 'sync' })).items[0]).toMatchObject({ operationId: original.operationId, state: 'abandoned' });
  } finally { await db.close(); }
});
