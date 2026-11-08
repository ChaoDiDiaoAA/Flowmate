import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudOpenVikingTransfer } from '../../../apps/cloud-openviking-transfer.ts';
import { CLOUD_OPENVIKING_CHUNK_BYTES } from '../../../packages/contracts/src/cloud-openviking-management.ts';
import { appError, fail } from '@flowmate/contracts';
import { downloadCloudOpenVikingFile, uploadCloudOpenVikingFile } from '../../../apps/desktop/main/cloud-openviking-transfer.ts';
import { createCloudOpenVikingManagementProcess } from '../../../apps/desktop/main/cloud-openviking-link.ts';

test('original upload and download resume at confirmed offsets after reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-ov-transfer-'));
  try {
    const pRoot = join(root, 'p'), aRoot = join(root, 'a');
    const original = createCloudOpenVikingTransfer(pRoot);
    const operationId = randomUUID(), uploadId = randomUUID(), key = { operationId, uploadId };
    const chunk = Buffer.alloc(CLOUD_OPENVIKING_CHUNK_BYTES, 25), tail = Buffer.from([4, 2, 8]);
    const file = { ...key, name: 'original.ovpack', bytes: chunk.byteLength + tail.byteLength };
    expect(await original.handleTransfer({ type: 'upload_begin', input: file })).toMatchObject({ ok: true, data: { ...file, offset: 0 } });
    const append = { ...key, offset: 0, base64: chunk.toString('base64') };
    expect(await original.handleTransfer({ type: 'upload_append', input: append })).toMatchObject({ ok: true, data: { offset: chunk.length } });
    const resumed = createCloudOpenVikingTransfer(pRoot);
    const otherRole = createCloudOpenVikingTransfer(aRoot);
    expect(await otherRole.handleTransfer({ type: 'upload_status', input: key })).toMatchObject({ ok: false });
    expect(await resumed.handleTransfer({ type: 'upload_status', input: key })).toMatchObject({ ok: true, data: { offset: chunk.length } });
    expect(await resumed.handleTransfer({ type: 'upload_append', input: append })).toMatchObject({ ok: true, data: { offset: chunk.length } });
    expect(await resumed.handleTransfer({ type: 'upload_append', input: { ...append, base64: Buffer.alloc(chunk.length).toString('base64') } })).toMatchObject({ ok: false });
    expect(await resumed.handleTransfer({ type: 'upload_append', input: { ...key, offset: chunk.length + 1, base64: tail.toString('base64') } })).toMatchObject({ ok: false });
    const request = { connectionId: randomUUID(), method: 'ImportOVPack' as const, input: {} };
    expect(await resumed.files({ ...key, request }).selectUpload()).toBeNull();
    expect(await resumed.handleTransfer({ type: 'upload_append', input: { ...key, offset: chunk.length, base64: tail.toString('base64') } })).toMatchObject({ ok: true, data: { offset: file.bytes } });
    expect(await resumed.handleTransfer({ type: 'upload_finish', input: key })).toMatchObject({ ok: true, data: { offset: file.bytes } });
    const upload = await resumed.files({ ...key, request }).selectUpload();
    expect(upload?.name).toBe(file.name);
    expect(Buffer.from(await upload!.body.arrayBuffer()).equals(Buffer.concat([chunk, tail]))).toBe(true);
    const output = await resumed.files({ operationId, request, output: true }).selectOutput('result.ovpack');
    await output!(new Blob([chunk, tail]).stream());
    const after = createCloudOpenVikingTransfer(pRoot);
    expect(await after.handleTransfer({ type: 'download_status', input: { operationId } })).toMatchObject({ ok: true, data: { operationId, bytes: file.bytes } });
    expect(await after.handleTransfer({ type: 'download_read', input: { operationId, offset: chunk.length } }))
      .toMatchObject({ ok: true, data: { operationId, offset: chunk.length, base64: tail.toString('base64') } });
    expect(await otherRole.handleTransfer({ type: 'download_read', input: { operationId, offset: 0 } })).toMatchObject({ ok: false });
    expect(await after.handleTransfer({ type: 'upload_release', input: key })).toMatchObject({ ok: true });
    expect(await after.handleTransfer({ type: 'download_release', input: { operationId } })).toMatchObject({ ok: true });
    expect(await after.handleTransfer({ type: 'upload_release', input: key })).toMatchObject({ ok: true });
    expect(await after.handleTransfer({ type: 'download_release', input: { operationId } })).toMatchObject({ ok: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop resumes safe chunks after a lost acknowledgement and never overwrites a destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-ov-transfer-client-'));
  try {
    const remote = createCloudOpenVikingTransfer(join(root, 'spool'));
    const operationId = randomUUID(), uploadId = randomUUID(), name = 'original.ovpack';
    const contents = Buffer.alloc(CLOUD_OPENVIKING_CHUNK_BYTES + 8, 17);
    const upload = { operationId, uploadId, name, body: new Blob([contents]) };
    const lost = () => fail(appError('cloud_openviking_transport_lost', 'runtime', 'Simulated lost reply.', true));
    let lostAppend = false, broken = false;
    const readOffsets: number[] = [];
    const call: Parameters<typeof uploadCloudOpenVikingFile>[0] = async command => {
      const result = await remote.handleTransfer(command);
      if (command.type === 'upload_append' && !lostAppend) { lostAppend = true; return lost(); }
      if (command.type === 'download_read') {
        readOffsets.push(command.input.offset);
        if (broken && command.input.offset > 0) return lost();
      }
      return result;
    };
    expect(await uploadCloudOpenVikingFile(call, upload)).toMatchObject({ ok: true });
    const request = { connectionId: randomUUID(), method: 'ExportOVPack' as const, input: {} };
    const store = await remote.files({ operationId, request, output: true }).selectOutput(name);
    await store!(new Blob([contents]).stream());
    const path = join(root, name);
    broken = true;
    expect(await downloadCloudOpenVikingFile(call, operationId, path)).toMatchObject({ ok: false });
    broken = false;
    readOffsets.length = 0;
    expect(await downloadCloudOpenVikingFile(call, operationId, path)).toMatchObject({ ok: true });
    expect(readOffsets).toEqual([CLOUD_OPENVIKING_CHUNK_BYTES]);
    expect((await readFile(path)).equals(contents)).toBe(true);
    expect(await downloadCloudOpenVikingFile(call, operationId, path)).toMatchObject({ ok: true });
    const newId = randomUUID(), other = await remote.files({ operationId: newId, request, output: true }).selectOutput(name);
    await other!(new Blob(['must not overwrite']).stream());
    expect(await downloadCloudOpenVikingFile(call, newId, path)).toMatchObject({ ok: false });
    expect((await readFile(path)).equals(contents)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop accepts only the original dedicated SSH response and stops on mismatched identity', async () => {
  const child = spawn(process.execPath, ['-e', `
    import { createInterface } from 'node:readline';
    import { randomUUID } from 'node:crypto';
    let count = 0;
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      const requestId = count++ === 0 ? request.requestId : randomUUID();
      process.stdout.write(JSON.stringify({ version: 1, requestId, result: { ok: true, data: null } }) + '\\n');
    }
  `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  const client = createCloudOpenVikingManagementProcess(child, randomUUID());
  try {
    expect(await client.request({ type: 'info' })).toEqual({ ok: true, data: null });
    expect(await client.request({ type: 'info' })).toMatchObject({ ok: false, error: { code: 'cloud_openviking_transport_lost' } });
    expect(client.ended).toBe(true);
  } finally { client.stop(); await closed; }
});
