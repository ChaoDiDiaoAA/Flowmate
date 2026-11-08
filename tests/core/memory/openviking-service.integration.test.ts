import { expect, test } from 'bun:test';
import * as core from '@flowmate/core';
import { openVikingUserHealth } from '../../support/openviking.ts';

const owner = { accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent' };

test('OpenViking recall uses the real SDK and excludes results outside the original owner', async () => {
  expect(typeof core.createOpenVikingService).toBe('function');
  const requests: Array<{ path: string; key: string | null; peer: string | null; body: unknown }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    if (new URL(request.url).pathname === '/api/v1/content/read') return Response.json({ status: 'ok', result: 'Prefers concise answers.' });
    requests.push({ path: new URL(request.url).pathname, key: request.headers.get('x-api-key'), peer: request.headers.get('x-openviking-actor-peer'), body: await request.json() });
    return Response.json({ status: 'ok', result: { memories: [
      { uri: 'viking://user/alice/memories/preference.md', abstract: 'Prefers concise answers.' },
      { uri: 'viking://user/other/memories/private.md', abstract: 'Another user secret.' },
    ], resources: [], skills: [] } });
  } });
  try {
    const service = core.createOpenVikingService({ endpoint: `http://127.0.0.1:${server.port}`, apiKey: 'synthetic-key', owner });
    const result = await service.recall({ query: 'answer preferences', timeoutMs: 2000,
      allowedEntries: [{ uri: 'viking://user/alice/memories/preference.md', revision: 1, approvedContent: 'Prefers concise answers.' }] });
    expect(result).toMatchObject({ ok: true, data: { status: 'ready', items: [
      { uri: 'viking://user/alice/memories/preference.md', content: 'Prefers concise answers.' },
    ] } });
    if (!result.ok) throw Error(result.error.code);
    expect(result.data.items).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: '/api/v1/search/find', key: 'synthetic-key', peer: owner.peerId, body: {
      query: 'answer preferences', target_uri: ['viking://user/alice/memories/preference.md'], limit: 5,
    } });
  } finally { server.stop(true); }
});

test('an unavailable OpenViking service reports unavailable instead of empty memory', async () => {
  expect(typeof core.createOpenVikingService).toBe('function');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('unavailable', { status: 503 }); } });
  try {
    const service = core.createOpenVikingService({ endpoint: `http://127.0.0.1:${server.port}`, apiKey: 'synthetic-key', owner });
    expect(await service.recall({ query: 'answer preferences', timeoutMs: 2000, allowedEntries: [] })).toMatchObject({ ok: true, data: { status: 'unavailable', items: [] } });
  } finally { server.stop(true); }
});

test.each(['root', 'admin', 'wrong-user', 'trusted-mode'] as const)('personal access refuses %s credentials before a write', async mode => {
  let writes = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ status: 'ok', version: '0.4.23',
      auth_mode: mode === 'trusted-mode' ? 'trusted' : 'api_key', role: mode === 'root' || mode === 'admin' ? mode : 'user',
      account_id: 'account', user_id: mode === 'wrong-user' ? 'other' : 'alice' });
    writes++;
    return Response.json({ status: 'ok', result: { session_id: 'session-original', uri: 'viking://user/alice/sessions/session-original',
      user: { account_id: 'account', user_id: 'alice' }, auto_commit_policy: null } });
  } });
  try {
    const service = core.createOpenVikingService({ endpoint: `http://127.0.0.1:${server.port}`, apiKey: 'synthetic-key', owner });
    expect(await service.createMirrorSession('session-original')).toMatchObject({ ok: false });
    expect(writes).toBe(0);
  } finally { server.stop(true); }
});

test('OpenViking requests never forward credentials to a redirected endpoint', async () => {
  let redirected = 0;
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { redirected++; return Response.json({ status: 'ok', result: {} }); } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${other.port}/unexpected` } });
  } });
  try {
    const service = core.createOpenVikingService({ endpoint: `http://127.0.0.1:${server.port}`, apiKey: 'synthetic-key', owner });
    expect(await service.recall({ query: 'preferences', timeoutMs: 2000, allowedEntries: [] }))
      .toMatchObject({ ok: true, data: { status: 'unavailable' } });
    expect(await service.createMirrorSession('session-original')).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    expect(await service.readMirrorTask('task-original')).toMatchObject({ ok: false });
    expect(redirected).toBe(0);
  } finally { server.stop(true); other.stop(true); }
});

test('mirror Sessions disable auto-commit and retain the original message IDs', async () => {
  const requests: Array<{ path: string; body: unknown; peer: string | null }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const health = openVikingUserHealth(request); if (health) return health;
    requests.push({ path: new URL(request.url).pathname, body: request.method === 'POST' ? await request.json() : null,
      peer: request.headers.get('x-openviking-actor-peer') });
    return Response.json({ status: 'ok', result: request.url.endsWith('/commit') ? { task_id: 'task-original' }
      : { session_id: 'session-original', uri: 'viking://user/alice/sessions/session-original',
        user: { account_id: 'account', user_id: 'alice' }, auto_commit_policy: null } });
  } });
  try {
    const service = core.createOpenVikingService({ endpoint: `http://127.0.0.1:${server.port}/`, apiKey: 'synthetic-key', owner });
    expect((await service.createMirrorSession('session-original')).ok).toBe(true);
    expect((await service.appendMirrorMessage('session-original', { role: 'user', content: 'Authorized turn',
      sourceMessageIds: ['input-41'], turnId: 'turn-41' })).ok).toBe(true);
    expect(await service.commitMirrorSession('session-original')).toMatchObject({ ok: true, data: { task_id: 'task-original' } });
    expect(requests).toEqual([
      { path: '/api/v1/sessions', peer: owner.peerId, body: { session_id: 'session-original', auto_commit_policy: null } },
      { path: '/api/v1/sessions/session-original', peer: owner.peerId, body: null },
      { path: '/api/v1/sessions/session-original/messages', peer: owner.peerId, body: { role: 'user', content: 'Authorized turn', source_message_ids: ['input-41'], turn_id: 'turn-41' } },
      { path: '/api/v1/sessions/session-original', peer: owner.peerId, body: null },
      { path: '/api/v1/sessions/session-original/commit', peer: owner.peerId, body: { keep_recent_count: 0 } },
    ]);
  } finally { server.stop(true); }
});

test('an interrupted mirror write remains unknown and is not retried', async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('unavailable', { status: 503 }); } });
  try {
    const service = core.createOpenVikingService({ endpoint: `http://127.0.0.1:${server.port}`, apiKey: 'synthetic-key', owner });
    expect(await service.appendMirrorMessage('session-original', { role: 'user', content: 'Authorized turn', sourceMessageIds: ['input-41'], turnId: 'turn-41' }))
      .toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

test('a mirror Session is not trusted if the server keeps automatic commit enabled', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { return openVikingUserHealth(request) ?? Response.json({ status: 'ok', result: {
    session_id: 'session-original', auto_commit_policy: { threshold: 1 } } }); } });
  try {
    const service = core.createOpenVikingService({ endpoint: `http://127.0.0.1:${server.port}`, apiKey: 'synthetic-key', owner });
    expect(await service.createMirrorSession('session-original')).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  } finally { server.stop(true); }
});
