import { expect, test } from 'bun:test';
import { readManagementTaskStatus, runOpenVikingManagement, verifyManagementOutcome } from '../../../packages/core/src/openviking/management.ts';
import type { OpenVikingManagementConnection } from '../../../packages/contracts/src/openviking-management.ts';

test('OpenViking management verifies P/A/S and scopes the transmitted options', async () => {
  const observed: { path: string; query: string; method: string; body: unknown }[] = [];
  const transport = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(resource));
    if (url.pathname === '/health') {
      const role = new Headers(init?.headers).get('X-API-Key');
      return Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key', role, account_id: 'account', user_id: 'alice' });
    }
    observed.push({ path: url.pathname, query: url.search, method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (url.pathname.endsWith('/role')) throw Error('reply lost');
    return Response.json({ status: 'ok', result: [{ user_id: 'alice', api_key: 'sensitive' }], has_more: true });
  }) as typeof fetch;
  const endpoint = 'http://127.0.0.1:19338';
  const personal = { role: 'P', endpoint, apiKey: 'user', accountId: 'account', userId: 'alice', peerId: 'flowmate' } as const;
  const account = { role: 'A', endpoint, apiKey: 'admin', accountId: 'account', userId: 'alice' } as const;
  const system = { role: 'S', endpoint, apiKey: 'root' } as const;
  const run = (connection: OpenVikingManagementConnection, method: string, input: unknown, confirmed = true) =>
    runOpenVikingManagement(connection, { connectionId: crypto.randomUUID(), method, input }, async () => confirmed, transport);
  expect(await run(personal, 'AdminListUsers', {})).toMatchObject({ ok: false });
  expect(await run(personal, 'ListPage', { uri: 'viking://user/alice/%2e%2e/bob' })).toMatchObject({ ok: false });
  expect(await run(account, 'AdminListUsers', { accountId: 'other' })).toMatchObject({ ok: false });
  expect(await run({ ...account, apiKey: 'user' }, 'AdminListUsers', {})).toMatchObject({ ok: false });
  expect(await run(system, 'AdminListGroups', {})).toMatchObject({ ok: false });
  expect(await run(account, 'AdminSetRole', { userId: 'alice', role: 'user' }, false)).toMatchObject({ ok: false });
  expect(observed).toHaveLength(0);
  expect(await run(account, 'AdminListUsersWithOptions', { limit: 0, page: 0, role: 'user' }))
    .toEqual({ ok: true, data: [{ user_id: 'alice' }] });
  expect(observed[0]).toMatchObject({ path: '/api/v1/admin/accounts/account/users', query: '?role=user&limit=0&page=0' });
  expect(await run(personal, 'ListPage', { uri: 'viking://user/alice/memories', include_abstract: false, tags: ['a', 'b'] }))
    .toMatchObject({ ok: true, data: { hasMore: true } });
  const query = new URLSearchParams(observed[1]?.query);
  expect(query.get('include_abstract')).toBe('false');
  expect(query.getAll('tags')).toEqual(['a', 'b']);
  expect(await run(system, 'AdminListAccounts', {})).toMatchObject({ ok: true });
  expect(await run(account, 'AdminSetRole', { userId: 'alice', role: 'user' }))
    .toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  expect(observed).toHaveLength(4);
});

test('reconciliation checks only the original remote task and never replays a mutation', async () => {
  const identity = { role: 'P', endpoint: 'http://127.0.0.1:19338', apiKey: 'user', accountId: 'account', userId: 'alice', peerId: 'flowmate' } as const;
  const request = { connectionId: crypto.randomUUID(), method: 'CreateSession' as const,
    input: { sessionId: 'flowmate-management-test', disableAutoCommit: true } };
  let status = 'pending', taskId = 'task-1';
  const requests: string[] = [];
  const transport = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(resource)).pathname;
    expect(init?.method ?? 'GET').toBe('GET');
    if (path === '/health') return Response.json({ status: 'ok', auth_mode: 'api_key', version: '0.4.23', role: 'user', account_id: 'account', user_id: 'alice' });
    requests.push(path);
    return Response.json({ status: 'ok', result: path.startsWith('/api/v1/tasks/')
      ? { task_id: taskId, status } : { session_id: 'flowmate-management-test', auto_commit_policy: { idle_timeout: 10 } } });
  }) as typeof fetch;
  expect(await verifyManagementOutcome(identity, request, transport)).toBe(false);
  expect(await readManagementTaskStatus(identity, request, 'task-1', transport)).toBe('accepted');
  status = 'completed';
  taskId = 'other-task';
  expect(await readManagementTaskStatus(identity, request, 'task-1', transport)).toBeUndefined();
  taskId = 'task-1';
  expect(await readManagementTaskStatus(identity, request, 'task-1', transport)).toBe('completed');
  expect(requests).toEqual(['/api/v1/sessions/flowmate-management-test', '/api/v1/tasks/task-1', '/api/v1/tasks/task-1', '/api/v1/tasks/task-1']);
});

test('management search obtains local images only through the native file port', async () => {
  const identity = { role: 'P', endpoint: 'http://127.0.0.1:19338', apiKey: 'user', accountId: 'account', userId: 'alice', peerId: 'flowmate' } as const;
  const base = { connectionId: crypto.randomUUID(), method: 'Find',
    input: { query: 'image', target_uri: 'viking://user/alice/memories', imageFromFile: true } };
  let input: unknown;
  const transport = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(resource)).pathname === '/health')
      return Response.json({ status: 'ok', auth_mode: 'api_key', version: '0.4.23', role: 'user', account_id: 'account', user_id: 'alice' });
    input = JSON.parse(String(init?.body));
    return Response.json({ status: 'ok', result: { memories: [] } });
  }) as typeof fetch;
  expect(await runOpenVikingManagement(identity, { ...base, input: { ...base.input, image_url: 'C:/private.png' } },
    async () => false, transport)).toMatchObject({ ok: false });
  expect(input).toBeUndefined();
  const files = { selectUpload: async () => ({ name: 'selected.png', body: new Blob([new Uint8Array([1, 2, 3])]) }),
    selectOutput: async () => null, selectPrivateOptions: async () => null };
  expect(await runOpenVikingManagement(identity, base, async () => false, transport, files)).toMatchObject({ ok: true });
  expect(input).toMatchObject({ image_url: 'data:image/png;base64,AQID' });
});
