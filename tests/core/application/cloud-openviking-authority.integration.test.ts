import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import type { OpenVikingManagementConnection } from '../../../packages/contracts/src/openviking-management.ts';
import { createCloudOpenVikingManagementHandler, startCloudOpenVikingManagement } from '../../../apps/cloud-openviking-authority.ts';
import { runCloudOpenVikingBridge } from '../../../apps/cloud-openviking-bridge.ts';
import { createCloudOpenVikingTransfer } from '../../../apps/cloud-openviking-transfer.ts';
import { callCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { mkdtempSync } from '../../support/resources.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const endpoint = 'http://127.0.0.1:19338';
const connections = {
  P: { role: 'P', endpoint, apiKey: 'private-p', accountId: 'account', userId: 'alice', peerId: 'peer' },
  A: { role: 'A', endpoint, apiKey: 'private-a', accountId: 'account', userId: 'admin' },
  S: { role: 'S', endpoint, apiKey: 'private-s' },
} as const satisfies Record<string, OpenVikingManagementConnection>;
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
function envelope(command: unknown) { return { version: 1, workspaceId, requestId: randomUUID(), command }; }
function health(connection: OpenVikingManagementConnection) {
  return Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key',
    role: { P: 'user', A: 'admin', S: 'root' }[connection.role],
    account_id: 'account', user_id: 'userId' in connection ? connection.userId : 'root' });
}
function setup(connection: OpenVikingManagementConnection, fetch: typeof globalThis.fetch) {
  return { workspaceId, connection, transport: fetch, root: mkdtempSync(join(tmpdir(), 'flowmate-ov-authority-')) };
}

test('dedicated roles authorize only their configured account and never return Authority credentials', async () => {
  for (const connection of Object.values(connections)) {
    const calls: string[] = [];
    const transport = (async (resource, init) => {
      const path = new URL(String(resource)).pathname;
      expect(new Headers(init?.headers).get('X-API-Key')).toBe(connection.apiKey);
      calls.push(path);
      return path === '/health' ? health(connection) : Response.json({ status: 'ok', result: [] });
    }) as typeof fetch;
    const handle = createCloudOpenVikingManagementHandler(setup(connection, transport));
    const info = await handle(envelope({ type: 'info' }));
    expect(info).toMatchObject({ ok: true, data: { workspaceId, role: connection.role } });
    expect(JSON.stringify(info)).not.toContain(connection.apiKey);
    expect(await handle({ ...envelope({ type: 'info' }), workspaceId: randomUUID() })).toMatchObject({ ok: false });
    expect(await handle(envelope({ type: 'info', role: 'S' }))).toMatchObject({ ok: false });
    const denied = connection.role === 'A' ? { method: 'AdminListUsersWithOptions', input: { accountId: 'another' } }
      : connection.role === 'P' ? { method: 'AdminListAccounts', input: {} }
      : { method: 'Remove', input: { uri: 'viking://resources/x' } };
    expect(await handle(envelope({ type: 'execute', input: { operationId: randomUUID(),
      request: { connectionId: randomUUID(), ...denied } } }))).toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
    expect(calls).toEqual(['/health']);
  }
});

test('a lost original cloud management write survives reconnect and is reconciled without another write', async () => {
  let writes = 0, reads = 0;
  const connection = connections.P;
  const transport = (async (resource, init) => {
    const path = new URL(String(resource)).pathname;
    if (path === '/health') return health(connection);
    if (init?.method === 'POST') { writes++; return new Response('lost acknowledgement', { status: 503 }); }
    reads++;
    return Response.json({ status: 'ok', result: 'original content' });
  }) as typeof fetch;
  const options = setup(connection, transport), operationId = randomUUID();
  let handle = createCloudOpenVikingManagementHandler(options);
  const request = { connectionId: randomUUID(), method: 'Write', input: {
    uri: 'viking://user/alice/memories/controlled.md', content: 'original content' } };
  expect(await handle(envelope({ type: 'execute', input: { operationId, request } })))
    .toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  handle = createCloudOpenVikingManagementHandler(options);
  const reconnected = { ...request, connectionId: randomUUID() };
  expect(await handle(envelope({ type: 'execute', input: { operationId, request: reconnected } })))
    .toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  expect(await handle(envelope({ type: 'outcome', input: { operationId,
    request: { ...reconnected, input: { ...request.input, uri: 'viking://user/alice/memories/other.md' } } } })))
    .toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
  expect(await handle(envelope({ type: 'outcome', input: { operationId, request: reconnected, taskId: 'foreign-task' } })))
    .toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
  expect(await handle(envelope({ type: 'outcome', input: { operationId, request: reconnected } })))
    .toMatchObject({ ok: true, data: { state: 'verified' } });
  expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
});

test('a dedicated file download is readable by its original role after reconnect without repeating the OpenViking operation', async () => {
  let downloads = 0;
  const connection = connections.P, operationId = randomUUID(), bytes = 'controlled binary content';
  const transport = (async resource => {
    const url = new URL(String(resource));
    if (url.pathname === '/health') return health(connection);
    downloads++;
    expect(url.pathname).toBe('/api/v1/content/download');
    expect(url.searchParams.get('uri')).toBe('viking://user/alice/memories/controlled.md');
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
  }) as typeof fetch;
  const options = setup(connection, transport), directory = join(options.root, 'transfer');
  const reconnect = () => createCloudOpenVikingManagementHandler({ ...options, transfer: createCloudOpenVikingTransfer(directory) });
  let handle = reconnect();
  const execute = { type: 'execute', input: { operationId, output: true,
    request: { connectionId: randomUUID(), method: 'DownloadBytes', input: { uri: 'viking://user/alice/memories/controlled.md' } } } };
  expect(await handle(envelope(execute))).toMatchObject({ ok: true, data: { saved: true } });
  handle = reconnect();
  const read = envelope({ type: 'download_read', input: { operationId, offset: 0 } });
  expect(await handle(read)).toMatchObject({ ok: true, data: { operationId, offset: 0, bytes: bytes.length,
    base64: Buffer.from(bytes).toString('base64') } });
  expect(await handle(envelope(execute))).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  const another = setup(connections.A, transport);
  expect(await createCloudOpenVikingManagementHandler({ ...another,
    transfer: createCloudOpenVikingTransfer(join(another.root, 'transfer')) })(read)).toMatchObject({ ok: false });
  expect(downloads).toBe(1);
});

test('a role serializes management writes and keeps the original operation active while its reply is pending', async () => {
  let writes = 0;
  const began = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const transport = (async resource => {
    if (new URL(String(resource)).pathname === '/health') return health(connections.P);
    writes++;
    began.resolve();
    await released.promise;
    return Response.json({ status: 'ok', result: { saved: true } });
  }) as typeof fetch;
  const handle = createCloudOpenVikingManagementHandler(setup(connections.P, transport));
  const operationId = randomUUID(), request = { connectionId: randomUUID(), method: 'Write',
    input: { uri: 'viking://user/alice/memories/controlled.md', content: 'original' } };
  const pending = handle(envelope({ type: 'execute', input: { operationId, request } }));
  try {
    await began.promise;
    expect(await handle(envelope({ type: 'outcome', input: { operationId, request } })))
      .toMatchObject({ ok: true, data: { state: 'unknown' } });
    expect(await handle(envelope({ type: 'execute', input: { operationId: randomUUID(), request } })))
      .toMatchObject({ ok: false, error: { code: 'cloud_openviking_busy' } });
  } finally { released.resolve(); }
  expect(await pending).toMatchObject({ ok: true });
  expect(writes).toBe(1);
});

test('dedicated bridge accepts a scoped frame and rejects a Work frame', async () => {
  const input = new PassThrough(), output = new PassThrough(), chunks: Buffer[] = [];
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  let calls = 0;
  const running = runCloudOpenVikingBridge(input, output, async value => {
    calls++;
    expect(value.command.type).toBe('info');
    return ok(ok({ workspaceId, role: 'P', accountId: 'account', userId: 'alice', peerId: 'peer' }));
  });
  const allowed = envelope({ type: 'info' }), denied = envelope({ type: 'personal_agent_get', input: {} });
  input.end(JSON.stringify(allowed) + '\n' + JSON.stringify(denied) + '\n');
  need(await running);
  const responses = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(responses).toMatchObject([{ requestId: allowed.requestId, result: { ok: true, data: { role: 'P' } } },
    { requestId: denied.requestId, result: { ok: false, error: { code: 'input_invalid' } } }]);
  expect(calls).toBe(1);
});

test('the dedicated bridge preserves an unknown transport result without replaying a command', async () => {
  const input = new PassThrough(), output = new PassThrough(), chunks: Buffer[] = [];
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  let calls = 0;
  const running = runCloudOpenVikingBridge(input, output, async () => {
    calls++;
    return fail(appError('cloud_transport_result_unknown', 'runtime', 'Fixture transport failure.', true));
  });
  input.end(JSON.stringify(envelope({ type: 'info' })) + '\n');
  need(await running);
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toMatchObject({ result: { ok: false, error: { code: 'operation_result_unknown' } } });
  expect(calls).toBe(1);
});

test('a lost SSH response is reported after dispatch without replay', async () => {
  const input = new PassThrough(), output = new Writable({ write(_chunk, _encoding, callback) { callback(Error('lost output')); } });
  let calls = 0;
  const running = runCloudOpenVikingBridge(input, output, async () => { calls++; return ok(ok(null)); });
  input.end(JSON.stringify(envelope({ type: 'info' })) + '\n');
  expect(await running).toMatchObject({ ok: false, error: { code: 'cloud_bridge_output_unconfirmed' } });
  expect(calls).toBe(1);
});

test.skipIf(process.platform !== 'linux')('three real Unix sockets select the three configured OpenViking roles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-ov-sockets-'));
  const roles = Object.values(connections).map(connection => {
    const directory = join(root, connection.role);
    mkdirSync(directory, { mode: 0o750 });
    return { socketPath: join(directory, 'management.sock'), connection };
  });
  const transport = (async (_resource, init) => {
    const key = new Headers(init?.headers).get('X-API-Key');
    const connection = Object.values(connections).find(item => item.apiKey === key);
    return connection ? health(connection) : new Response(null, { status: 401 });
  }) as typeof fetch;
  const listener = need(await startCloudOpenVikingManagement({ workspaceId, productRoot: root, roles, transport }));
  try {
    for (const { socketPath, connection } of roles) {
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o660);
      expect(need(await callCloudUnixRpc(socketPath, envelope({ type: 'info' })))).toMatchObject({ ok: true, data: { role: connection.role } });
    }
  } finally { need(await listener.close()); }
});

test.skipIf(process.platform !== 'linux')('the forced bridge rejects a caller-supplied command and unsupported fixed roles', async () => {
  const path = new URL('../../../apps/cloud-openviking-bridge.ts', import.meta.url).pathname;
  for (const [role, command] of [['P', 'S'], ['ROOT', '']] as const) {
    const child = Bun.spawn([process.execPath, '--no-env-file', path, role], { stdin: 'ignore',
      stdout: 'ignore', stderr: 'ignore', env: { SSH_ORIGINAL_COMMAND: command } });
    expect(await child.exited).toBe(2);
  }
});
