import { expect, test } from 'bun:test';
import * as core from '@flowmate/core';

test('group management uses only the original account and fixed OpenViking routes', async () => {
  const requests: Array<{ method: string; path: string; key: string | null; body: unknown }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ status: 'ok', version: '0.4.23',
      auth_mode: 'api_key', role: 'admin', account_id: 'account-a', user_id: 'admin' });
    requests.push({ method: request.method, path: new URL(request.url).pathname, key: request.headers.get('x-api-key'),
      body: request.method === 'POST' ? await request.json() : null });
    return Response.json({ status: 'ok', result: request.method === 'GET' && request.url.endsWith('/groups') ? [] : { accepted: true } });
  } });
  try {
    const service = core.createOpenVikingGroupAdmin({ endpoint: `http://127.0.0.1:${server.port}/`,
      accountId: 'account-a', apiKey: 'synthetic-admin-key', role: 'account-admin' });
    for (const command of [{ operation: 'create', groupId: 'team one' }, { operation: 'list' },
      { operation: 'members', groupId: 'team one' }, { operation: 'add', groupId: 'team one', userId: 'alice' },
      { operation: 'remove', groupId: 'team one', userId: 'alice' }, { operation: 'delete', groupId: 'team one' }] as const)
      expect((await service.execute(command)).ok).toBe(true);
    expect(requests.map(item => [item.method, item.path])).toEqual([
      ['POST', '/api/v1/admin/accounts/account-a/groups'], ['GET', '/api/v1/admin/accounts/account-a/groups'],
      ['GET', '/api/v1/admin/accounts/account-a/groups/team%20one/members'],
      ['PUT', '/api/v1/admin/accounts/account-a/groups/team%20one/members/alice'],
      ['DELETE', '/api/v1/admin/accounts/account-a/groups/team%20one/members/alice'],
      ['DELETE', '/api/v1/admin/accounts/account-a/groups/team%20one'],
    ]);
    expect(requests[0]!.body).toEqual({ group_id: 'team one' });
    expect(requests.every(item => item.key === 'synthetic-admin-key')).toBe(true);
    expect(await service.execute({ operation: 'delete', groupId: '../other' })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await service.execute({ operation: 'list', accountId: 'other' } as never)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  } finally { server.stop(true); }
});

test.each(['user', 'root', 'other-account'] as const)('group management rejects %s authority before dispatch', async mode => {
  let operations = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/health') return Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key',
      role: mode === 'other-account' ? 'admin' : mode, account_id: mode === 'other-account' ? 'account-b' : 'account-a', user_id: 'admin' });
    operations++; return Response.json({ status: 'ok', result: [] });
  } });
  try {
    const service = core.createOpenVikingGroupAdmin({ endpoint: `http://127.0.0.1:${server.port}`,
      accountId: 'account-a', apiKey: 'synthetic-admin-key', role: 'account-admin' });
    expect(await service.execute({ operation: 'list' })).toMatchObject({ ok: false });
    expect(operations).toBe(0);
  } finally { server.stop(true); }
});

test('an uncertain group mutation is not reported as completed', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('unavailable', { status: 503 }); } });
  try {
    const service = core.createOpenVikingGroupAdmin({ endpoint: `http://127.0.0.1:${server.port}`,
      accountId: 'account-a', apiKey: 'synthetic-admin-key', role: 'account-admin' });
    expect(await service.execute({ operation: 'create', groupId: 'team' })).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    expect(await service.execute({ operation: 'list' })).toMatchObject({ ok: false, error: { code: 'openviking_unavailable' } });
  } finally { server.stop(true); }
});

test('group management does not follow redirects with an account credential', async () => {
  let redirected = 0;
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { redirected++; return Response.json({ status: 'ok', result: [] }); } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${other.port}/unexpected` } });
  } });
  try {
    const service = core.createOpenVikingGroupAdmin({ endpoint: `http://127.0.0.1:${server.port}`,
      accountId: 'account-a', apiKey: 'synthetic-admin-key', role: 'account-admin' });
    expect(await service.execute({ operation: 'list' })).toMatchObject({ ok: false, error: { code: 'openviking_unavailable' } });
    expect(redirected).toBe(0);
  } finally { server.stop(true); other.stop(true); }
});
