import { expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { runCloudDesktopBridge } from '../../../apps/cloud-desktop-bridge.ts';
import { createCloudDesktopHandler } from '../../../apps/cloud-desktop-gateway.ts';
import { callCloudUnixRpc, listenCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { mkdtempSync } from '../../support/resources.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstId = '11111111-1111-4111-8111-111111111111', secondId = '22222222-2222-4222-8222-222222222222';
const rejectedId = '33333333-3333-4333-8333-333333333333';
const at = '2026-10-29T00:00:00.000Z';
const snapshot = { personalAgentId: 1, revision: 0, runtimeKind: 'durable', createdAt: at, updatedAt: at,
  configuration: { modelId: null, thinkingLevel: 'off', resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' } };
const request = (requestId: string) => ({ version: 1, workspaceId, requestId, command: { type: 'personal_agent_get', input: {} } });
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test('the SSH bridge forwards only scoped commands and allows an independent read while another request waits', async () => {
  const input = new PassThrough(), output = new PassThrough(), chunks: Buffer[] = [], called: string[] = [];
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), secondDone = Promise.withResolvers<void>();
  const running = runCloudDesktopBridge(input, output, async envelope => {
    called.push(envelope.requestId);
    if (envelope.requestId === firstId) { started.resolve(); await release.promise; }
    else secondDone.resolve();
    return ok(ok(snapshot));
  });
  input.write(JSON.stringify(request(firstId)) + '\n');
  await started.promise;
  input.write(JSON.stringify({ ...request(rejectedId), command: { type: 'call_provider', input: {} } }) + '\n');
  input.write(JSON.stringify(request(secondId)) + '\n'); input.end();
  await secondDone.promise; expect(called).toEqual([firstId, secondId]);
  release.resolve(); expect(await running).toEqual({ ok: true, data: undefined });
  const responses = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(responses).toEqual(expect.arrayContaining([
    expect.objectContaining({ version: 1, requestId: firstId, result: { ok: true, data: snapshot } }),
    expect.objectContaining({ version: 1, requestId: secondId, result: { ok: true, data: snapshot } }),
    expect.objectContaining({ version: 1, requestId: rejectedId, result: expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'input_invalid' }) }) }),
  ]));
});

test('a transport request ID cannot be reused after its response on the same bridge', async () => {
  const input = new PassThrough(), output = new PassThrough(), replied = Promise.withResolvers<void>(); let calls = 0;
  output.on('data', () => replied.resolve());
  const running = runCloudDesktopBridge(input, output, async () => { calls++; return ok(ok(snapshot)); });
  input.write(JSON.stringify(request(firstId)) + '\n'); await replied.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  input.end(JSON.stringify(request(firstId)) + '\n');
  expect(await running).toMatchObject({ ok: false, error: { code: 'cloud_bridge_frame_invalid' } });
  expect(calls).toBe(1);
});

test('ordinary requests cannot consume the slots reserved for stopping or cancelling a Work', async () => {
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const release = Promise.withResolvers<void>(), filled = Promise.withResolvers<void>(), control = Promise.withResolvers<void>();
  let normal = 0;
  const running = runCloudDesktopBridge(input, output, async envelope => {
    if (envelope.command.type === 'invoice_work_cancel') {
      control.resolve(); return ok(ok({ operation: 'cancelWork', workId: 7, requestId: 'original-cancel',
        revision: 1, receivedAt: at, cancelled: true }));
    }
    normal++; if (normal === 30) filled.resolve(); await release.promise; return ok(ok(snapshot));
  });
  for (let index = 0; index < 32; index++) input.write(JSON.stringify(request(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)) + '\n');
  await filled.promise;
  input.end(JSON.stringify({ ...request(firstId), command: { type: 'invoice_work_cancel',
    input: { workId: 7, requestId: 'original-cancel', expectedRevision: 0 } } }) + '\n');
  const admitted = await Promise.race([control.promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
  release.resolve(); await running;
  expect(admitted).toBe(true); expect(normal).toBe(30);
});

test('a lost cloud write response remains unknown and is not retried', async () => {
  const input = new PassThrough(), output = new PassThrough(), chunks: Buffer[] = []; let calls = 0;
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const running = runCloudDesktopBridge(input, output, async () => { calls++; return fail(appError('cloud_transport_result_unknown', 'runtime', 'Lost.', true)); });
  input.end(JSON.stringify({ ...request(firstId), command: { type: 'invoice_work_cancel',
    input: { workId: 7, requestId: 'original-cancel', expectedRevision: 0 } } }) + '\n');
  expect(await running).toEqual({ ok: true, data: undefined }); expect(calls).toBe(1);
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toMatchObject({ requestId: firstId,
    result: { ok: false, error: { code: 'operation_result_unknown' } } });
});

test('a failed output write reports unconfirmed delivery after the original request executes once', async () => {
  const input = new PassThrough(), output = new Writable({ write(_chunk, _encoding, callback) { callback(Error('controlled closed output')); } });
  let calls = 0;
  const running = runCloudDesktopBridge(input, output, async () => { calls++; return ok(ok(snapshot)); });
  input.end(JSON.stringify(request(firstId)) + '\n');
  expect(await running).toMatchObject({ ok: false, error: { code: 'cloud_bridge_output_unconfirmed' } });
  expect(calls).toBe(1);
});

test('a truncated or unidentifiable frame closes the bridge without dispatch', async () => {
  const input = new PassThrough(), output = new PassThrough(); let calls = 0;
  const running = runCloudDesktopBridge(input, output, async () => { calls++; return ok(null); });
  input.end('{"version":1');
  expect(await running).toMatchObject({ ok: false, error: { code: 'cloud_bridge_frame_invalid' } });
  expect(calls).toBe(0);
});

test.skipIf(process.platform !== 'linux')('the bridge forwards over a real Unix socket to the authorized desktop gateway', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-bridge-socket-')), socket = join(root, 'desktop.sock');
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(snapshot) });
  const server = need(await listenCloudUnixRpc({ socketPath: socket, handle: handler }));
  try {
    const input = new PassThrough(), output = new PassThrough(), chunks: Buffer[] = [];
    output.on('data', chunk => chunks.push(Buffer.from(chunk)));
    const running = runCloudDesktopBridge(input, output, envelope => callCloudUnixRpc(socket, envelope));
    input.end(JSON.stringify(request(firstId)) + '\n');
    expect(await running).toEqual({ ok: true, data: undefined });
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ version: 1, requestId: firstId, result: { ok: true, data: snapshot } });
  } finally { need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('the forced bridge process rejects an SSH command or extra arguments', async () => {
  const entry = new URL('../../../apps/cloud-desktop-bridge.ts', import.meta.url).pathname;
  for (const variant of [{ args: [] as string[], command: 'untrusted command' }, { args: ['extra'], command: '' }]) {
    const child = Bun.spawn([process.execPath, '--no-env-file', entry, ...variant.args],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', SSH_ORIGINAL_COMMAND: variant.command } });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(2); expect(stdout).toBe('');
  }
});

test.skipIf(process.platform !== 'linux')('Authority handling continues after the desktop bridge process disconnects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-bridge-offline-')), socket = join(root, 'desktop.sock');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), committed = Promise.withResolvers<void>();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => {
    entered.resolve(); await release.promise; committed.resolve(); return ok(snapshot);
  } });
  const server = need(await listenCloudUnixRpc({ socketPath: socket, handle: handler }));
  const bridge = new URL('../../../apps/cloud-desktop-bridge.ts', import.meta.url).href;
  const transport = new URL('../../../apps/cloud-unix-rpc.ts', import.meta.url).href;
  const script = `import {runCloudDesktopBridge} from ${JSON.stringify(bridge)}; import {callCloudUnixRpc} from ${JSON.stringify(transport)};
    await runCloudDesktopBridge(process.stdin,process.stdout,envelope=>callCloudUnixRpc(${JSON.stringify(socket)},envelope));`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '' } });
  try {
    child.stdin.write(JSON.stringify(request(firstId)) + '\n');
    await entered.promise; child.kill(); await child.exited;
    release.resolve(); await committed.promise;
  } finally { release.resolve(); if (child.exitCode === null) { child.kill(); await child.exited; } need(await server.close()); }
});
