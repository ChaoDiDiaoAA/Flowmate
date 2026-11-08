import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { researchFixture, researchNeed as need } from '../../support/research.ts';
import { waitFor } from '../../support/resources.ts';
import { openVikingContentFixture, openVikingSessionFixture, openVikingUserHealth } from '../../support/openviking.ts';
import { openTestDatabase } from '../../support/database.ts';
import { createMemoryRuntime } from '@flowmate/core';

const at = '2026-11-07T00:00:00.000Z';
const mirrorSession = (id: string) => ({ session_id: id, uri: `viking://user/alice/sessions/${id}`,
  user: { account_id: 'account', user_id: 'alice' }, auto_commit_policy: null });

test('trusted initial memory settings are applied once without overriding a later user policy', async () => {
  const initial = { endpoint: 'http://127.0.0.1:19338', accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent',
    credentialRef: 'synthetic-reference', recallEnabled: true, captureMode: 'explicit' as const };
  const f = await researchFixture(() => ({ text: 'Controlled answer.' }), undefined,
    { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key', initialConnection: initial } });
  try {
    expect(await f.app.memory.getSettings()).toMatchObject({ ok: true, data: { settings: { revision: 1, provider: 'openviking' } } });
    expect(await f.app.memory.updatePolicy({ expectedRevision: 1, provider: 'native', recallEnabled: false, captureMode: 'off' }))
      .toMatchObject({ ok: true, data: { settings: { revision: 2, provider: 'native' } } });
    await f.reopen();
    expect(await f.app.memory.getSettings()).toMatchObject({ ok: true, data: { settings: { revision: 2, provider: 'native' } } });
  } finally { await f.app.close(); }
});

test('the application remembers an explicitly confirmed Session fact under its own owner', async () => {
  let stored = '', writes = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/content/write') {
      const body = await request.json() as { uri: string; content: string };
      stored = body.content; writes++;
      return Response.json({ status: 'ok', result: { uri: body.uri, mode: 'create', context_type: 'memory', content_updated: true, vector_status: 'complete' } });
    }
    if (path === '/api/v1/content/read') return Response.json({ status: 'ok', result: stored });
    return Response.json({ status: 'ok', result: { memories: [] } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=0,capture_mode='explicit',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    const chat = need(await f.app.createSession({ title: 'Remember chat' }));
    const run = await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
      text: 'Remember this preference.', focus: { page: 'chats' } });
    const input = { requestId: 'explicit-preference', source: { kind: 'session' as const, sessionId: chat.sessionId, inputId: run.accepted.inputId },
      content: 'Prefers concise invoices.', scope: { kind: 'personal' as const }, confirmed: true as const };
    expect(await f.app.memory.getSettings()).toMatchObject({ ok: true, data: { settings: { captureMode: 'explicit' }, identity: { userId: 'alice' } } });
    expect(await f.app.memory.remember({ ...input, owner: { environment: 'local', ownerId: 'other' } } as never)).toMatchObject({ ok: false });
    const result = await f.app.memory.remember(input);
    expect(result).toMatchObject({ ok: true, data: { requestId: input.requestId, state: 'completed' } });
    expect(await f.app.memory.remember(input)).toEqual(result);
    expect(writes).toBe(1);
    await f.app.close();
  } finally { server.stop(true); }
});

test('after restart the application reconciles the original remember request without resending its content', async () => {
  let stored = '', writes = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/content/write') { stored = (await request.json() as { content: string }).content; writes++; return new Response('lost', { status: 503 }); }
    if (path === '/api/v1/content/read') return Response.json({ status: 'ok', result: stored });
    return Response.json({ status: 'ok', result: { memories: [] } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), undefined,
      { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key',
        initialConnection: { endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent',
          credentialRef: 'synthetic-reference', recallEnabled: false, captureMode: 'explicit' } } });
    const chat = need(await f.app.createSession({ title: 'Recover remember' }));
    const run = await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config, text: 'Original request.', focus: { page: 'chats' } });
    expect(await f.app.memory.remember({ requestId: 'remember-restart', source: { kind: 'session', sessionId: chat.sessionId, inputId: run.accepted.inputId },
      content: 'Original approved fact.', scope: { kind: 'personal' }, confirmed: true })).toMatchObject({ ok: true, data: { state: 'unknown' } });
    await f.reopen();
    const operations = need(await f.app.memory.listOperations({ kind: 'remember' })), original = operations.items[0];
    if (!original?.requestId) throw Error('Missing original operation.');
    expect(await f.app.memory.reconcileRememberById({ operationId: original.operationId, requestId: original.requestId }))
      .toMatchObject({ ok: true, data: { operationId: original.operationId, result: { requestId: 'remember-restart', state: 'unknown', contentConfirmed: true } } });
    expect(await f.app.memory.reconcileRememberById({ operationId: original.operationId, requestId: 'another-request' })).toMatchObject({ ok: false });
    expect(writes).toBe(1);
    await f.app.close();
  } finally { server.stop(true); }
});

test('AgentSession sends authorized recalled memory only in the current model request', async () => {
  let recalls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const content = openVikingContentFixture(request, 'Controlled recalled preference.'); if (content) return content;
    recalls++;
    return Response.json({ status: 'ok', result: { memories: [
      { uri: 'viking://user/alice/memories/fact.md', abstract: 'Controlled recalled preference.' },
    ], resources: [], skills: [] } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=1,capture_mode='off',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
      db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(1,1,?,'viking://user/alice/memories/fact.md',1,'active',?,?,?)")
        .run(`http://127.0.0.1:${server.port}`, JSON.stringify({ version: 1, approvedContent: 'Controlled recalled preference.',
          origin: { bindingId: 99, inputId: 99, phaseId: null } }), at, at);
      db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(1,'personal','local-owner',1)").run();
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    const chat = need(await f.app.createSession({ title: 'Memory chat' }));
    const sensitive = await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
      text: 'x'.repeat(510) + '\n"API_KEY"： "synthetic-value"', focus: { page: 'chats' } });
    expect(sensitive.terminal.result.ok).toBe(true);
    expect(recalls).toBe(0);
    const run = await f.run({ sessionId: chat.sessionId, clientSequence: 2, mode: 'prompt', config: f.config,
      text: 'Explain the original preference.', focus: { page: 'chats' } });
    expect(run.terminal.result.ok).toBe(true);
    expect(recalls).toBe(1);
    expect(JSON.stringify(f.requests[0])).not.toContain('Controlled recalled preference.');
    expect(JSON.stringify(f.requests[1])).toContain('Controlled recalled preference.');
    await f.app.close();
    const db = new Database(f.paths.databaseFile, { readonly: true });
    try {
      const entries = JSON.stringify(db.query('SELECT entry_json FROM session_native_entries WHERE session_id=?').all(chat.sessionId));
      expect(entries).not.toContain('Controlled recalled preference.');
    } finally { db.close(); }
  } finally { server.stop(true); }
});

test('manual memory search uses the original input and only its authorized entries', async () => {
  let searches = 0;
  let gate: { promise: Promise<void>; resolve(): void } | undefined, entered: { promise: Promise<void>; resolve(): void } | undefined;
  const uri = 'viking://user/alice/memories/preference.md', content = 'Controlled personal preference.';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const item = openVikingContentFixture(request, content); if (item) return item;
    searches++; if (gate && entered) { entered.resolve(); await gate.promise; }
    return Response.json({ status: 'ok', result: { memories: [{ uri },
      { uri: 'viking://user/alice/memories/unapproved.md', abstract: 'Not authorized.' }] } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=0,capture_mode='explicit',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
      db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(1,1,?,?,1,'active',?,?,?)")
        .run(`http://127.0.0.1:${server.port}`, uri, JSON.stringify({ version: 1, approvedContent: content,
          origin: { bindingId: 99, inputId: 99, phaseId: null } }), at, at);
      db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(1,'personal','local-owner',1)").run();
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    try {
      const chat = need(await f.app.createSession({ title: 'Manual memory search' }));
      const run = await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
        text: 'Original input.', focus: { page: 'chats' } });
      const input = { query: 'api_key: synthetic-value', source: { kind: 'session' as const, sessionId: chat.sessionId, inputId: run.accepted.inputId } };
      expect(await f.app.memory.search(input)).toMatchObject({ ok: true, data: { status: 'ready', items: [{ uri, content }] } });
      expect(await f.app.memory.search({ ...input, source: { ...input.source, inputId: input.source.inputId + 1 } })).toMatchObject({ ok: false });
      expect(await f.app.memory.search({ ...input, ownerId: 'another-owner' } as never)).toMatchObject({ ok: false });
      expect(searches).toBe(1);
      gate = Promise.withResolvers<void>(); entered = Promise.withResolvers<void>();
      const pending = f.app.memory.search(input); await entered.promise;
      expect(await f.app.memory.updatePolicy({ expectedRevision: 1, provider: 'native', recallEnabled: false, captureMode: 'off' })).toMatchObject({ ok: true });
      gate.resolve();
      expect(await pending).toMatchObject({ ok: true, data: { status: 'unavailable', items: [] } });
    } finally { await f.app.close(); }
  } finally { server.stop(true); }
});

test('a Session started without external memory keeps its native binding', async () => {
  const f = await researchFixture(() => ({ text: 'Original answer.' }));
  const chat = need(await f.app.createSession({ title: 'Native chat' }));
  const run = await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
    text: 'Original request.', focus: { page: 'chats' } });
  expect(run.terminal.result.ok).toBe(true);
  await f.app.close();
  const db = new Database(f.paths.databaseFile, { readonly: true });
  try { expect(db.query("SELECT provider FROM memory_bindings WHERE runtime_kind='agent_session' AND session_id=?").get(chat.sessionId))
    .toEqual({ provider: 'native' }); }
  finally { db.close(); }
});

test('an authorized completed chat turn is captured once with original input and output references', async () => {
  const messages: Array<{ path: string; body: Record<string, unknown> }> = [];
  let remoteSession = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
      ? { task_id: 'original-task', task_type: 'session_commit', resource_id: remoteSession, status: 'completed',
          result: { session_id: remoteSession, memory_diff_uri: null, memories_extracted: {} } } : mirrorSession(path.split('/').at(-1)!) });
    const body = await request.json() as Record<string, unknown>;
    messages.push({ path, body });
    if (path.endsWith('/commit')) remoteSession = path.split('/').at(-2)!;
    return Response.json({ status: 'ok', result: path === '/api/v1/sessions'
      ? mirrorSession(String(body.session_id)) : path.endsWith('/commit') ? { task_id: 'original-task' } : { session_id: path.split('/').at(-2) } });
  } });
  try {
    const f = await researchFixture((_request, index) => ({ text: index === 2
      ? '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-value' : 'Controlled captured answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=0,capture_mode='auto',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    const chat = need(await f.app.createSession({ title: 'Capture chat' }));
    const questions = ['Authorization: Bearer synthetic-value', 'Controlled question with a sensitive answer.', '如何重置密码？'];
    for (const [index, text] of questions.entries()) {
      const run = await f.run({ sessionId: chat.sessionId, clientSequence: index + 1, mode: 'prompt', config: f.config,
        text, focus: { page: 'chats' } });
      expect(run.terminal.result.ok).toBe(true);
    }
    await waitFor(async () => { const result = await f.app.memory.listOperations({ kind: 'sync' });
      return result.ok && result.data.items.length > 0 && result.data.items.every(item => item.state === 'completed'); }, 5000);
    expect(need(await f.app.memory.listOperations({ kind: 'sync' })).items).toHaveLength(1);
    await f.app.close();
    const written = messages.filter(item => item.path.endsWith('/messages')).map(item => item.body);
    expect(written.map(item => [item.role, item.content])).toEqual([
      ['user', '如何重置密码？'], ['assistant', 'Controlled captured answer.'],
    ]);
    expect(written.every(item => Array.isArray(item.source_message_ids) && item.source_message_ids.length > 0)).toBe(true);
    expect(messages.filter(item => item.path.endsWith('/commit'))).toHaveLength(1);
  } finally { server.stop(true); }
}, 15_000);

test.each([0, 1, 2])('restart with a protected pending memory batch at cursor %i suppresses its writes', async cursor => {
  const writes: Array<{ path: string; content?: string }> = [];
  let reads = 0, remoteSession = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') {
      reads++;
      return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
        ? { task_id: 'normal-task', task_type: 'session_commit', resource_id: remoteSession, status: 'completed',
            result: { session_id: remoteSession, memory_diff_uri: null, memories_extracted: {} } }
        : mirrorSession(path.split('/').at(-1)!) });
    }
    const body = await request.json() as { session_id?: string; content?: string };
    writes.push({ path, content: body.content });
    if (path.endsWith('/commit')) remoteSession = path.split('/').at(-2)!;
    return Response.json({ status: 'ok', result: path === '/api/v1/sessions' ? mirrorSession(body.session_id!)
      : path.endsWith('/commit') ? { task_id: 'normal-task' } : { session_id: path.split('/').at(-2) } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Ordinary answer.' }), undefined,
      { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key',
        initialConnection: { endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent',
          credentialRef: 'synthetic-reference', recallEnabled: false, captureMode: 'explicit' } } });
    try {
      const { sessionId } = need(await f.app.createSession({ title: 'Legacy queued capture' }));
      const send = (clientSequence: number, text: string) => f.run({ sessionId, clientSequence, text, mode: 'prompt',
        config: f.config, focus: { page: 'chats' } });
      const first = await send(1, '我的密码：synthetic-value');
      expect(first.terminal.result.ok).toBe(true);
      await f.app.close();
      const db = new Database(f.paths.databaseFile);
      let syncId: number;
      try {
        const input = db.query<{ binding_id: number; run_id: number; result_entry_id: string }, [number]>(
          'SELECT b.binding_id,i.run_id,i.result_entry_id FROM session_inputs i JOIN memory_input_bindings b ON b.input_id=i.id WHERE i.id=?')
          .get(first.accepted.inputId);
        if (!input?.result_entry_id) throw Error('Missing original turn.');
        const source = { version: 1, sessionId, runId: input.run_id, inputIds: [first.accepted.inputId], resultEntryId: input.result_entry_id };
        syncId = Number(db.query(`INSERT INTO memory_sync(binding_id,input_id,phase_id,state,source_json,cursor,created_at,updated_at)
          VALUES(?,?,NULL,'pending',?,?,?,?)`).run(input.binding_id, first.accepted.inputId, JSON.stringify(source), cursor, at, at).lastInsertRowid);
        db.query("UPDATE memory_config SET capture_mode='auto' WHERE id=1").run();
      } finally { db.close(); }
      await f.reopen();
      if (cursor < 2) {
        expect((await send(2, 'Ordinary question.')).terminal.result.ok).toBe(true);
        await waitFor(async () => need(await f.app.memory.listOperations({ kind: 'sync' })).items.some(row => row.state === 'completed'), 5000);
        expect(need(await f.app.memory.listOperations({ kind: 'sync' })).items).toEqual([
          expect.objectContaining({ operationId: syncId, state: 'cancelled' }),
          expect.objectContaining({ state: 'completed' }),
        ]);
        expect(writes.filter(write => write.path.endsWith('/messages')).map(write => write.content)).toEqual(['Ordinary question.', 'Ordinary answer.']);
      } else {
        await waitFor(async () => need(await f.app.memory.listOperations({ kind: 'sync' })).items[0]?.state === 'unknown', 5000);
        expect(await f.app.memory.reconcileSync(syncId)).toMatchObject({ ok: true, data: { state: 'unknown' } });
        expect(writes).toHaveLength(0);
        expect(reads).toBe(0);
      }
    } finally { await f.app.close(); }
  } finally { server.stop(true); }
}, 15000);

test('an authorized extracted memory becomes available to a later Session only after its original task is verified', async () => {
  let remoteSession = '';
  const uri = 'viking://user/alice/memories/preferences/alice/controlled.md', content = 'Prefers concise invoice explanations.';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const url = new URL(request.url), path = url.pathname;
    if (path === '/api/v1/content/read') {
      const target = url.searchParams.get('uri');
      if (target?.endsWith('/memory_diff.json')) return Response.json({ status: 'ok', result: JSON.stringify({
        archive_uri: `viking://user/alice/sessions/${remoteSession}/history/archive_001`,
        operations: { adds: [{ uri, after: content }], updates: [], deletes: [] } }) });
      return Response.json({ status: 'ok', result: content });
    }
    if (path === '/api/v1/search/find') return Response.json({ status: 'ok', result: { memories: [{ uri }] } });
    if (request.method === 'GET') return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
      ? { task_id: 'task-original', task_type: 'session_commit', resource_id: remoteSession, status: 'completed', result: { session_id: remoteSession,
          memory_diff_uri: `viking://user/alice/sessions/${remoteSession}/history/archive_001/memory_diff.json`, memories_extracted: { memory_write: 1 } } }
      : mirrorSession(path.split('/').at(-1)!) });
    const body = await request.json() as { session_id?: string };
    if (path.endsWith('/commit')) { remoteSession = path.split('/').at(-2)!; return Response.json({ status: 'ok', result: { task_id: 'task-original' } }); }
    return Response.json({ status: 'ok', result: path === '/api/v1/sessions' ? mirrorSession(body.session_id!) : { session_id: path.split('/').at(-2) } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), undefined,
      { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key',
        initialConnection: { endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent',
          credentialRef: 'synthetic-reference', recallEnabled: true, captureMode: 'auto' } } });
    const first = need(await f.app.createSession({ title: 'Original chat' }));
    expect((await f.run({ sessionId: first.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
      text: 'I prefer concise invoice explanations.', focus: { page: 'chats' } })).terminal.result.ok).toBe(true);
    await waitFor(async () => { const entries = await f.app.memory.listEntries({}); return entries.ok && entries.data.items.some(item => item.uri === uri); }, 5000);
    const second = need(await f.app.createSession({ title: 'Later chat' }));
    expect((await f.run({ sessionId: second.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
      text: 'Explain the invoice.', focus: { page: 'chats' } })).terminal.result.ok).toBe(true);
    expect(JSON.stringify(f.requests.at(-1))).toContain(content);
    await f.app.close();
  } finally { server.stop(true); }
}, 15000);

test('extraction reconciliation requires an unambiguous diff and the original content without resending', async () => {
  let remoteSession = '', commits = 0, messages = 0, mode: 'overlap' | 'mismatch' | 'valid' = 'overlap';
  const uri = 'viking://user/alice/memories/preferences/alice/recovered.md', content = 'Original extracted preference.';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const url = new URL(request.url), path = url.pathname;
    if (path === '/api/v1/content/read') {
      if (url.searchParams.get('uri')?.endsWith('/memory_diff.json')) return Response.json({ status: 'ok', result: JSON.stringify({
        archive_uri: `viking://user/alice/sessions/${remoteSession}/history/archive_001`, operations: {
          adds: [{ uri, after: content }], updates: mode === 'overlap' ? [{ uri }] : [], deletes: [],
        } }) });
      return Response.json({ status: 'ok', result: mode === 'mismatch' ? 'Changed elsewhere.' : content });
    }
    if (request.method === 'GET') return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
      ? { task_id: 'task-original', task_type: 'session_commit', resource_id: remoteSession, status: 'completed', result: { session_id: remoteSession,
          memory_diff_uri: `viking://user/alice/sessions/${remoteSession}/history/archive_001/memory_diff.json`, memories_extracted: { memory_write: 1 } } }
      : mirrorSession(path.split('/').at(-1)!) });
    const body = await request.json() as { session_id?: string };
    if (path.endsWith('/messages')) messages++;
    if (path.endsWith('/commit')) { commits++; remoteSession = path.split('/').at(-2)!; return Response.json({ status: 'ok', result: { task_id: 'task-original' } }); }
    return Response.json({ status: 'ok', result: path === '/api/v1/sessions' ? mirrorSession(body.session_id!) : { session_id: path.split('/').at(-2) } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), undefined,
      { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key',
        initialConnection: { endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent',
          credentialRef: 'synthetic-reference', recallEnabled: true, captureMode: 'auto' } } });
    try {
      const chat = need(await f.app.createSession({ title: 'Interrupted extraction' }));
      expect((await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
        text: 'Original preference.', focus: { page: 'chats' } })).terminal.result.ok).toBe(true);
      await waitFor(async () => { const result = await f.app.memory.listOperations({ kind: 'sync' });
        return result.ok && result.data.items[0]?.state === 'unknown'; }, 5000);
      const original = need(await f.app.memory.listOperations({ kind: 'sync' })).items[0]!;
      expect(need(await f.app.memory.listEntries({})).items).toHaveLength(0);
      await f.reopen();
      mode = 'mismatch';
      expect(await f.app.memory.reconcileSync(original.operationId)).toMatchObject({ ok: true, data: { state: 'unknown' } });
      expect(need(await f.app.memory.listEntries({})).items).toHaveLength(0);
      mode = 'valid';
      expect(await f.app.memory.reconcileSync(original.operationId)).toMatchObject({ ok: true, data: { state: 'completed' } });
      expect(need(await f.app.memory.listEntries({})).items.map(item => item.uri)).toEqual([uri]);
      expect([messages, commits]).toEqual([2, 1]);
    } finally { await f.app.close(); }
  } finally { server.stop(true); }
}, 15000);

test('after rewind new turns use a new remote Session while original inputs keep their original binding', async () => {
  const tasks = new Map<string, string>(), sent: Array<{ session: string; content: string }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') {
      const taskId = path.split('/').at(-1)!, session = tasks.get(taskId);
      return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
        ? { task_id: taskId, task_type: 'session_commit', resource_id: session, status: 'completed',
            result: { session_id: session, memory_diff_uri: null, memories_extracted: {} } } : mirrorSession(taskId) });
    }
    const body = await request.json() as { session_id?: string; content?: string };
    const session = path.split('/').at(-2)!;
    if (path.endsWith('/messages')) sent.push({ session, content: body.content! });
    if (path.endsWith('/commit')) { const taskId = `task-${tasks.size + 1}`; tasks.set(taskId, session);
      return Response.json({ status: 'ok', result: { task_id: taskId } }); }
    return Response.json({ status: 'ok', result: path === '/api/v1/sessions' ? mirrorSession(body.session_id!) : { session_id: session } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), undefined,
      { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key',
        initialConnection: { endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent',
          credentialRef: 'synthetic-reference', recallEnabled: false, captureMode: 'auto' } } });
    try {
      const chat = need(await f.app.createSession({ title: 'Rewound capture' }));
      const first = await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
        text: 'First original turn.', focus: { page: 'chats' } });
      await waitFor(async () => (await f.app.memory.listOperations({ kind: 'sync' })).ok && tasks.size === 1, 5000);
      const history = need(await f.app.querySessionHistory({ sessionId: chat.sessionId }));
      const target = history.items.find(item => item.preview === 'First original turn.' && item.canSelect);
      if (!target) throw Error('The original user position is unavailable.');
      expect(await f.app.branchSession({ sessionId: chat.sessionId, expectedCommitRevision: history.commit.commitRevision,
        expectedEntryCount: history.commit.entryCount, expectedLeafId: history.commit.leafId, targetEntryId: target.entryId })).toMatchObject({ ok: true });
      const second = await f.run({ sessionId: chat.sessionId, clientSequence: 2, mode: 'prompt', config: f.config,
        text: 'Turn after rewind.', focus: { page: 'chats' } });
      await waitFor(async () => tasks.size === 2, 5000);
      expect(new Set(sent.map(item => item.session)).size).toBe(2);
      await f.app.close();
      const db = new Database(f.paths.databaseFile, { readonly: true });
      try {
        const bindings = db.query<{ input_id: number; branch: number }, [number, number]>(`SELECT m.input_id,b.branch FROM memory_input_bindings m
          JOIN memory_bindings b ON b.id=m.binding_id WHERE m.input_id IN (?,?) ORDER BY m.input_id`).all(first.accepted.inputId, second.accepted.inputId);
        expect(bindings).toEqual([{ input_id: first.accepted.inputId, branch: 0 }, { input_id: second.accepted.inputId, branch: 1 }]);
      } finally { db.close(); }
    } finally { await f.app.close(); }
  } finally { server.stop(true); }
}, 15000);

test('an uncertain memory write stays unknown across restart and blocks later writes for that Session', async () => {
  const paths: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname; paths.push(path);
    if (request.method === 'GET') return Response.json({ status: 'ok', result: mirrorSession(path.split('/').at(-1)!) });
    if (path.endsWith('/messages')) return new Response('unavailable', { status: 503 });
    const body = await request.json() as { session_id: string };
    return Response.json({ status: 'ok', result: mirrorSession(body.session_id) });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=0,capture_mode='auto',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    const chat = need(await f.app.createSession({ title: 'Interrupted capture' }));
    const send = (clientSequence: number) => f.run({ sessionId: chat.sessionId, clientSequence, mode: 'prompt', config: f.config,
      text: `Question ${clientSequence}.`, focus: { page: 'chats' } });
    expect((await send(1)).terminal.result.ok).toBe(true);
    await waitFor(async () => paths.some(path => path.endsWith('/messages')), 5000);
    await f.reopen();
    const count = paths.length;
    expect((await send(2)).terminal.result.ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(paths).toHaveLength(count);
    await f.app.close();
    const db = new Database(f.paths.databaseFile, { readonly: true });
    try { expect(db.query('SELECT state FROM memory_sync ORDER BY id').all()).toEqual([{ state: 'unknown' }, { state: 'pending' }]); }
    finally { db.close(); }
  } finally { server.stop(true); }
}, 15_000);

test('a running extraction does not block another Session memory sync', async () => {
  let commits = 0; const tasks = new Map<string, string>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
      ? { task_id: path.split('/').at(-1), task_type: 'session_commit', resource_id: tasks.get(path.split('/').at(-1)!), status: 'running' }
      : mirrorSession(path.split('/').at(-1)!) });
    const body = await request.json() as { session_id?: string };
    if (path.endsWith('/commit')) { const taskId = `task-${++commits}`; tasks.set(taskId, path.split('/').at(-2)!);
      return Response.json({ status: 'ok', result: { task_id: taskId } }); }
    return Response.json({ status: 'ok', result: path === '/api/v1/sessions' ? mirrorSession(body.session_id!) : { session_id: path.split('/').at(-2) } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=0,capture_mode='auto',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    const first = need(await f.app.createSession({ title: 'First capture' })), second = need(await f.app.createSession({ title: 'Second capture' }));
    const send = (sessionId: number) => f.run({ sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
      text: 'Original question.', focus: { page: 'chats' } });
    expect((await send(first.sessionId)).terminal.result.ok).toBe(true);
    await waitFor(async () => commits === 1, 5000);
    expect((await send(second.sessionId)).terminal.result.ok).toBe(true);
    await waitFor(async () => commits === 2, 3000);
    await f.app.close();
  } finally { server.stop(true); }
}, 15_000);

test('a task receipt for another remote Session cannot complete the original memory sync', async () => {
  let commits = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
      ? { task_id: 'task-original', task_type: 'session_commit', resource_id: 'another-session', status: 'completed', result: { session_id: 'another-session' } }
      : mirrorSession(path.split('/').at(-1)!) });
    const body = await request.json() as { session_id?: string };
    if (path.endsWith('/commit')) { commits++; return Response.json({ status: 'ok', result: { task_id: 'task-original' } }); }
    return Response.json({ status: 'ok', result: path === '/api/v1/sessions' ? mirrorSession(body.session_id!) : { session_id: path.split('/').at(-2) } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=0,capture_mode='auto',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    const chat = need(await f.app.createSession({ title: 'Original capture' }));
    expect((await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
      text: 'Original question.', focus: { page: 'chats' } })).terminal.result.ok).toBe(true);
    await waitFor(async () => commits === 1, 5000); await new Promise(resolve => setTimeout(resolve, 300));
    await f.app.close();
    const db = new Database(f.paths.databaseFile, { readonly: true });
    try { expect(db.query('SELECT state FROM memory_sync').get()).toEqual({ state: 'accepted' }); }
    finally { db.close(); }
    expect(commits).toBe(1);
  } finally { server.stop(true); }
}, 15000);

test('reconciliation confirms the original remote message without sending it twice', async () => {
  const appended: Array<{ role: string; content: string; source_message_ids: string[]; turn_id: string }> = [];
  let first = true, commits = 0, conflict = true, remoteSession = '';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    const url = new URL(request.url), path = url.pathname;
    if (path === '/api/v1/content/read') {
      const entries = appended.map(item => ({ role: item.role, parts: [{ type: 'text', text: item.content }],
        source_message_ids: item.source_message_ids, turn_id: item.turn_id }));
      if (conflict && entries[0]) entries.push({ ...entries[0], parts: [{ type: 'text', text: 'Conflicting original identity' }] });
      return Response.json({ status: 'ok', result: entries.map(item => JSON.stringify(item)).join('\n') });
    }
    if (request.method === 'GET') return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
      ? { task_id: 'task-1', task_type: 'session_commit', resource_id: remoteSession, status: 'completed',
          result: { session_id: remoteSession, memory_diff_uri: null, memories_extracted: {} } } : mirrorSession(path.split('/').at(-1)!) });
    const body = await request.json() as { session_id?: string; role: string; content: string; source_message_ids: string[]; turn_id: string };
    if (path === '/api/v1/sessions') return Response.json({ status: 'ok', result: mirrorSession(body.session_id!) });
    if (path.endsWith('/commit')) { commits++; remoteSession = path.split('/').at(-2)!; return Response.json({ status: 'ok', result: { task_id: 'task-1' } }); }
    appended.push(body);
    if (first) { first = false; return new Response('lost receipt', { status: 503 }); }
    return Response.json({ status: 'ok', result: { session_id: path.split('/').at(-2) } });
  } });
  try {
    const f = await researchFixture(() => ({ text: 'Controlled answer.' }), db => {
      db.query("UPDATE memory_config SET revision=1,provider='openviking',recall_enabled=0,capture_mode='auto',endpoint=?,updated_at=? WHERE id=1")
        .run(`http://127.0.0.1:${server.port}`, at);
      db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','local-owner','account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(at, at);
    }, { memory: { owner: { environment: 'local', ownerId: 'local-owner' }, readCredential: async () => 'synthetic-key' } });
    const chat = need(await f.app.createSession({ title: 'Reconcile capture' }));
    expect((await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
      text: 'Original question.', focus: { page: 'chats' } })).terminal.result.ok).toBe(true);
    await waitFor(async () => appended.length === 1, 5000);
    await f.app.close();
    const db = need(openTestDatabase(f.paths));
    const runtime = createMemoryRuntime({ database: db, owner: { environment: 'local', ownerId: 'local-owner' },
      readCredential: async () => 'synthetic-key', now: () => at });
    try {
      const row = db.db.query<{ id: number; state: string }, []>('SELECT id,state FROM memory_sync').get()!;
      expect(row.state).toBe('unknown');
      expect(await runtime.sync.reconcile(row.id)).toMatchObject({ ok: true, data: { state: 'unknown' } });
      conflict = false;
      expect(await runtime.sync.reconcile(row.id)).toMatchObject({ ok: true, data: { state: 'pending' } });
      await waitFor(async () => db.db.query<{ state: string }, []>('SELECT state FROM memory_sync').get()?.state === 'completed', 5000);
      expect(appended.map(item => item.role)).toEqual(['user', 'assistant']);
      expect(commits).toBe(1);
    } finally { await runtime.sync.close(); await db.close(); }
  } finally { server.stop(true); }
}, 15_000);
