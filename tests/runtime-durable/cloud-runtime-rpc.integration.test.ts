import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ok, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import { listenCloudUnixRpc } from '../../apps/cloud-unix-rpc.ts';
import { createCloudRuntimeRpcClient, createCloudRuntimeRpcHandler } from '../../apps/cloud-runtime-rpc.ts';
import { mkdtempSync } from '../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

test.skipIf(process.platform !== 'linux')('Authority routes only typed original Runtime operations over the Unix socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-rpc-')), socketPath = join(root, 'runtime.sock');
  let closes = 0, calls = 0, wrongOwner = false;
  const runtime = { async openConversation(input: { workId: number; sessionId: number }) { calls++;
    return ok({ ...input, workId: wrongOwner ? input.workId + 1 : input.workId, nativeConversationId: 23 }); },
    async getSubmission() { return ok(null); }, async close() { closes++; return ok(undefined); } } as unknown as DurableRuntimePort;
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudRuntimeRpcHandler(runtime) }));
  const client = createCloudRuntimeRpcClient(socketPath);
  try {
    expect(await client.openConversation({ workId: 7, sessionId: 8 })).toEqual({ ok: true, data: { workId: 7, sessionId: 8, nativeConversationId: 23 } });
    expect(await client.getSubmission({ workId: 7, sessionId: 8, attemptId: 9, requestId: 'original' })).toEqual({ ok: true, data: null });
    wrongOwner = true;
    expect(await client.openConversation({ workId: 7, sessionId: 8 })).toMatchObject({ ok: false, error: { code: 'cloud_runtime_response_invalid' } });
    expect(calls).toBe(2); need(await client.close()); expect(closes).toBe(0);
    expect(await client.getSubmission({ workId: 7, sessionId: 8, attemptId: 9, requestId: 'original' }))
      .toMatchObject({ ok: false, error: { code: 'cloud_runtime_closed' } });
  } finally { need(await client.close()); need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('Runtime history receipts must match the original entry and watermark', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-history-rpc-')), socketPath = join(root, 'runtime.sock');
  const runtime = { async queryHistoryEntry() { return ok({ owner: { runtimeKind: 'durable', workId: 7, sessionId: 8, childRunId: null },
    throughEntryId: 13, entryId: 5, kind: 'flowmate.input', format: 'pi-durable-entry/v1', offset: 0,
    totalBytes: 1, text: 'x', nextOffset: null }); } } as unknown as DurableRuntimePort;
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudRuntimeRpcHandler(runtime) }));
  const client = createCloudRuntimeRpcClient(socketPath);
  try {
    expect(await client.queryHistoryEntry({ workId: 7, sessionId: 8, entryId: 5, throughEntryId: 12, offset: 0, limit: 100 }))
      .toMatchObject({ ok: false, error: { code: 'cloud_runtime_response_invalid' } });
  } finally { need(await client.close()); need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('queue receipts crossing Runtime RPC retain the original control identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-queue-rpc-')), socketPath = join(root, 'runtime.sock');
  let wrong = false;
  const owner = { workId: 7, sessionId: 8, attemptId: 9 };
  const runtime = { queue: { read: async () => ok({ ...owner, version: 1, items: [] }),
    apply: async (input: { controlRequestId: string }) => ok({ ...owner, controlRequestId: wrong ? 'other' : input.controlRequestId,
      status: 'applied', version: 2 }), queryControl: async () => ok(null) } } as unknown as DurableRuntimePort;
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudRuntimeRpcHandler(runtime) }));
  const client = createCloudRuntimeRpcClient(socketPath);
  try {
    expect(await client.queue.read(owner)).toEqual({ ok: true, data: { ...owner, version: 1, items: [] } });
    const command = { ...owner, controlRequestId: 'original-control', expectedVersion: 1,
      action: { kind: 'reorder' as const, submissionIds: [] } };
    expect(await client.queue.apply(command)).toMatchObject({ ok: true, data: { controlRequestId: 'original-control' } });
    wrong = true;
    expect(await client.queue.apply(command)).toMatchObject({ ok: false, error: { code: 'cloud_runtime_response_invalid' } });
    expect(await client.queue.queryControl({ ...owner, controlRequestId: 'original-control' })).toEqual({ ok: true, data: null });
  } finally { need(await client.close()); need(await server.close()); }
});

test.skipIf(process.platform !== 'linux')('a silent queue RPC times out without interrupting a long native wait', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-runtime-queue-timeout-')), socketPath = join(root, 'runtime.sock');
  const release = Promise.withResolvers<void>(), waitStarted = Promise.withResolvers<void>();
  const owner = { workId: 7, sessionId: 8, attemptId: 9 }, phase = { ...owner, requestId: 'original' };
  const runtime = { queue: { read: async () => { await release.promise; return ok({ ...owner, version: 1, items: [] }); } },
    waitForSubmission: async () => { waitStarted.resolve(); await release.promise; return ok({ ...phase, nativeConversationId: 1,
      nativeSubmissionId: 2, status: 'done', answer: 'Completed', reason: null }); } } as unknown as DurableRuntimePort;
  const server = need(await listenCloudUnixRpc({ socketPath, handle: createCloudRuntimeRpcHandler(runtime) }));
  const client = createCloudRuntimeRpcClient(socketPath); let waitFinished = false;
  try {
    const wait = client.waitForSubmission(phase).then(result => { waitFinished = true; return result; }); await waitStarted.promise;
    const start = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    const queue = await Promise.race([client.queue.read(owner), new Promise<'no-timeout'>(resolve => {
      timer = setTimeout(() => resolve('no-timeout'), 32_000);
    })]);
    if (timer) clearTimeout(timer);
    const elapsed = performance.now() - start;
    expect(queue).not.toBe('no-timeout');
    expect(queue).toMatchObject({ ok: false, error: { code: 'cloud_transport_result_unknown' } });
    expect(elapsed).toBeGreaterThanOrEqual(28_000); expect(elapsed).toBeLessThan(45_000); expect(waitFinished).toBe(false);
    release.resolve(); expect(await wait).toMatchObject({ ok: true, data: { ...phase, status: 'done' } });
  } finally { release.resolve(); need(await client.close()); need(await server.close()); }
}, 50_000);
