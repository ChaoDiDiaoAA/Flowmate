import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, type Result } from '@flowmate/contracts';
import { callCloudUnixRpc, listenCloudUnixRpc } from '../../apps/cloud-unix-rpc.ts';
import { callCloudModelSocket, listenCloudModelSocket } from '../../apps/cloud-model-socket.ts';
import type { CloudDeepSeekProxy } from '../../apps/cloud-deepseek-proxy.ts';
import { mkdtempSync, waitFor } from '../support/resources.ts';

const linux = test.skipIf(process.platform !== 'linux');
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

linux('Unix RPC uses an owner-controlled socket, bounded JSON and no automatic retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-rpc-')), socket = join(root, 'rpc.sock');
  const received: unknown[] = [];
  const server = need(await listenCloudUnixRpc({ socketPath: socket, handle: async value => { received.push(value); return { reply: value }; } }));
  try {
    expect(statSync(socket).mode & 0o777).toBe(0o660);
    const request = { version: 1, type: 'controlled-test', input: { workId: 7 } };
    expect(await callCloudUnixRpc(socket, request)).toEqual({ ok: true, data: { reply: request } });
    expect(received).toEqual([request]);
    const malformed = await fetch('http://localhost/rpc', { unix: socket, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await callCloudUnixRpc(socket, { data: 'x'.repeat(1_100_001) })).toMatchObject({ ok: false });
    expect(received).toEqual([request]);
  } finally { need(await server.close()); }
  expect(existsSync(socket)).toBe(false);
  expect(await callCloudUnixRpc(socket, { version: 1 })).toMatchObject({ ok: false });
  expect(received).toHaveLength(1);
});

linux('Unix RPC refuses an existing path and a directory writable by other users', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-rpc-path-')), socket = join(root, 'rpc.sock');
  writeFileSync(socket, 'preserve original file');
  expect(await listenCloudUnixRpc({ socketPath: socket, handle: async () => null })).toMatchObject({ ok: false });
  expect(await listenCloudUnixRpc({ socketPath: socket, allowStaleSocket: true, handle: async () => null })).toMatchObject({ ok: false });
  expect(readFileSync(socket, 'utf8')).toBe('preserve original file');
  const unsafe = mkdtempSync(join(tmpdir(), 'flowmate-cloud-rpc-unsafe-')); chmodSync(unsafe, 0o777);
  try {
    expect(await listenCloudUnixRpc({ socketPath: join(unsafe, 'rpc.sock'), handle: async () => null })).toMatchObject({ ok: false });
    expect(existsSync(join(unsafe, 'rpc.sock'))).toBe(false);
    const nested = join(unsafe, 'owned'); mkdirSync(nested, { mode: 0o700 });
    expect(await listenCloudUnixRpc({ socketPath: join(nested, 'rpc.sock'), handle: async () => null })).toMatchObject({ ok: false });
    expect(existsSync(join(nested, 'rpc.sock'))).toBe(false);
  } finally { chmodSync(unsafe, 0o700); }
});

linux('an exclusively owned server can recover its dead socket without removing a live server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-stale-socket-')), socket = join(root, 'rpc.sock');
  const script = `import {chmodSync} from 'node:fs'; Bun.serve({unix:${JSON.stringify(socket)},fetch:()=>new Response('old')});
    chmodSync(${JSON.stringify(socket)},0o660); setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '' } });
  try {
    await waitFor(async () => existsSync(socket) && (statSync(socket).mode & 0o777) === 0o660, 5000);
    child.kill('SIGKILL'); await child.exited;
    expect(existsSync(socket)).toBe(true);
    expect(await listenCloudUnixRpc({ socketPath: socket, handle: async () => null })).toMatchObject({ ok: false });
    const server = need(await listenCloudUnixRpc({ socketPath: socket, allowStaleSocket: true, handle: async () => ({ recovered: true }) }));
    try {
      expect(await listenCloudUnixRpc({ socketPath: socket, allowStaleSocket: true, handle: async () => null })).toMatchObject({ ok: false });
      expect(await callCloudUnixRpc(socket, {})).toEqual({ ok: true, data: { recovered: true } });
    } finally { need(await server.close()); }
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
}, 15_000);

linux('Unix RPC does not expose oversized responses or retry their original request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-rpc-large-')), socket = join(root, 'rpc.sock');
  let calls = 0;
  const server = need(await listenCloudUnixRpc({ socketPath: socket, handle: async () => { calls++; return 'x'.repeat(14 * 1024 * 1024 + 64 * 1024); } }));
  try {
    expect(await callCloudUnixRpc(socket, { version: 1 })).toMatchObject({ ok: false, error: { code: 'cloud_transport_result_unknown' } });
    expect(calls).toBe(1);
  } finally { need(await server.close()); }
});

linux('closing the Unix RPC server waits for a handler that already started', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-rpc-drain-')), socket = join(root, 'rpc.sock');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const server = need(await listenCloudUnixRpc({ socketPath: socket, handle: async () => {
    entered.resolve(); await release.promise; return { committed: true };
  } }));
  try {
    const request = callCloudUnixRpc(socket, { version: 1 });
    await entered.promise;
    let closed = false;
    const closing = server.close().then(result => { closed = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release.resolve(); need(await closing); await request;
    expect(closed).toBe(true);
  } finally { release.resolve(); need(await server.close()); }
});

linux('a long native wait and a quiet model stream remain connected beyond the default idle window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-cloud-long-socket-'));
  const rpcSocket = join(root, 'rpc.sock'), modelSocket = join(root, 'model.sock');
  const rpc = need(await listenCloudUnixRpc({ socketPath: rpcSocket, handle: async () => {
    await new Promise(resolve => setTimeout(resolve, 22_500)); return { completed: true };
  } }));
  let cancelled = false;
  const proxy = { send: async () => ok(new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('first'));
    setTimeout(() => { if (!cancelled) { controller.enqueue(new TextEncoder().encode('last')); controller.close(); } }, 22_500);
  }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } })) } as unknown as CloudDeepSeekProxy;
  const model = need(await listenCloudModelSocket({ socketPath: modelSocket, proxy }));
  const request = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111',
    workId: 1, sessionId: 2, attemptId: 3, phaseId: 4, requestId: 'original', nativeConversationId: 5, nativeSubmissionId: 6,
    nativeTaskId: 7, checkpointEntryId: 8, transportOrdinal: 0, modelAttemptId: '22222222-2222-4222-8222-222222222222',
    model: 'fixture', body: '{"model":"fixture"}' };
  try {
    const [observed, stream] = await Promise.all([callCloudUnixRpc(rpcSocket, { version: 1 }, AbortSignal.timeout(30_000)),
      (async () => { const response = need(await callCloudModelSocket(modelSocket, request, AbortSignal.timeout(30_000))); return response.text(); })()]);
    expect(observed).toEqual({ ok: true, data: { completed: true } });
    expect(stream).toBe('firstlast');
  } finally { need(await rpc.close()); need(await model.close()); }
}, 35_000);
