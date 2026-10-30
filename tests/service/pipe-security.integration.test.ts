import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readCurrentWindowsSid } from '../../packages/shared/src/windows-identity.ts';
import type { DocumentOriginalImage } from '@flowmate/contracts';
import type { ServicePipeServer } from '../../apps/service/pipe.ts';

const windows = process.platform === 'win32' ? test : test.skip;
const servers = new Set<ServicePipeServer>();
const children = new Set<ReturnType<typeof launchClient>>();

function launchClient(mode: string, name: string, raw = '') {
  return Bun.spawn([process.execPath, '--no-env-file', fileURLToPath(new URL('./pipe-fixture.ts', import.meta.url)),
    mode, name, Buffer.from(raw, 'utf8').toString('base64')], { stdout: 'pipe', stderr: 'pipe' });
}
function client(mode: string, name: string, raw = '') {
  const child = launchClient(mode, name, raw); children.add(child); return child;
}
async function result(child: ReturnType<typeof launchClient>) {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  children.delete(child); expect(stderr).toBe(''); expect(code).toBe(0); return stdout;
}
async function ownerSid() {
  const result = await readCurrentWindowsSid(); if (!result.ok) throw Error(result.error.message); return result.data;
}
async function pipe() {
  const module = await import('../../apps/service/pipe.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) throw Error('Service pipe implementation is missing.');
  const sid = await ownerSid(), installationId = randomUUID();
  const server = await module.createServicePipeServer({ installationId, ownerSid: sid }); servers.add(server);
  return { module, sid, installationId, server };
}

afterEach(async () => {
  await Promise.allSettled([...servers].map(server => server.close())); servers.clear();
  for (const child of children) if (child.exitCode === null) child.kill();
  await Promise.allSettled([...children].map(child => child.exited)); children.clear();
});

windows('authenticates the real same-user child SID before exposing bounded JSON frames in both directions', async () => {
  const { server, sid } = await pipe();
  const accepted = server.accept();
  const child = client('exchange', server.name, '{"requestId":"first","text":"原始发票"}\n{"requestId":"second"}\n');
  const connection = await accepted;
  expect(connection.peerSid).toBe(sid);
  expect(await connection.read()).toEqual({ requestId: 'first', text: '原始发票' });
  await connection.write({ requestId: 'first', saved: true });
  expect(await connection.read()).toEqual({ requestId: 'second' });
  await connection.write({ requestId: 'second', saved: true });
  expect((await result(child)).trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { requestId: 'first', saved: true }, { requestId: 'second', saved: true },
  ]);
  await expect(connection.read()).rejects.toThrow('pipe_disconnected');
});

windows('reads back the protected kernel DACL with only the owner and SYSTEM allowed', async () => {
  const { server, sid } = await pipe();
  const accepted = server.accept().catch(error => error);
  const descriptor = JSON.parse(await result(client('security', server.name))) as { sddl: string };
  expect(descriptor.sddl.startsWith('D:P')).toBe(true);
  const entries = [...descriptor.sddl.matchAll(/\(([^)]+)\)/g)].map(match => match[1]!.split(';'));
  expect(entries).toHaveLength(2);
  expect(entries.every(entry => entry[0] === 'A' && entry[2] !== '')).toBe(true);
  expect(entries.map(entry => entry[5]).sort()).toEqual([sid, 'SY'].sort());
  expect(await accepted).toBeInstanceOf(Error);
});

windows('rejects a wrong claimed owner and a second server for the saved installation identity', async () => {
  const { module, server, sid, installationId } = await pipe();
  expect(module.servicePipeName(installationId)).toBe(server.name);
  expect(() => module.servicePipeName('..\\different-installation')).toThrow('pipe_installation_invalid');
  const wrongSid = sid.replace(/\d+$/, value => String(Number(value) + 1));
  await expect(module.createServicePipeServer({ installationId: randomUUID(), ownerSid: wrongSid })).rejects.toThrow('pipe_owner_mismatch');
  await expect(module.createServicePipeServer({ installationId, ownerSid: sid })).rejects.toThrow('CreateNamedPipeW');
});

windows('rejects malformed frames and permits a subsequent client without closing the server', async () => {
  const { server } = await pipe();
  for (const [mode, raw, error] of [['send', '{not-json}\n', 'pipe_frame_invalid'],
    ['invalid-utf8', '', 'pipe_frame_invalid'], ['oversized', '', 'pipe_frame_too_large']]) {
    const accepted = server.accept(), child = client(mode!, server.name, raw);
    const connection = await accepted;
    await expect(connection.read()).rejects.toThrow(error!);
    await result(child);
  }
  const accepted = server.accept(), child = client('send', server.name, '{"requestId":"after-errors"}\n');
  const connection = await accepted;
  expect(await connection.read()).toEqual({ requestId: 'after-errors' });
  await expect(connection.write('界'.repeat(5_000_000))).rejects.toThrow('pipe_frame_too_large');
  await connection.close(); await result(child);
});

windows('disconnect releases only its client and does not terminate the next connection', async () => {
  const { server } = await pipe();
  const abandoned = server.accept().catch(error => error);
  await result(client('disconnect', server.name)); expect(await abandoned).toBeInstanceOf(Error);
  const accepted = server.accept(), child = client('send', server.name, '{');
  const connection = await accepted, pending = connection.read().catch(error => error);
  await connection.close(); expect(await pending).toMatchObject({ message: 'pipe_closed' }); await result(child);
  const next = server.accept().catch(error => error);
  await server.close(); expect(await next).toBeInstanceOf(Error);
  await expect(server.accept()).rejects.toThrow('pipe_closed');
});

windows('keeps the authenticated owner policy independent from subsequent caller object changes', async () => {
  const { module, sid } = await pipe();
  const options = { installationId: randomUUID(), ownerSid: sid };
  const server = await module.createServicePipeServer(options); servers.add(server);
  options.ownerSid = sid.replace(/\d+$/, value => String(Number(value) + 1));
  const accepted = server.accept(), child = client('send', server.name, '{"requestId":"original-owner"}\n');
  const connection = await accepted;
  expect(connection.peerSid).toBe(sid); expect(await connection.read()).toEqual({ requestId: 'original-owner' });
  await connection.close(); await result(child);
});

windows('server close also rejects complete commands already buffered by an authenticated client', async () => {
  const { server } = await pipe();
  const accepted = server.accept(), child = client('send', server.name, '{}\n{"requestId":"after-close"}\n');
  const connection = await accepted;
  expect(await connection.read()).toEqual({});
  await server.close();
  await expect(connection.read()).rejects.toThrow('pipe_closed');
  await result(child);
});

windows('round-trips the existing one-MiB Host history payload with its response envelope', async () => {
  const { server } = await pipe();
  const accepted = server.accept(), child = client('large-exchange', server.name);
  const connection = await accepted, frame = await connection.read();
  expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeGreaterThan(1_048_576);
  await connection.write(frame);
  const received = JSON.parse(await result(child)) as { matches: boolean; bytes: number };
  expect(received.matches).toBe(true); expect(received.bytes).toBeGreaterThan(1_048_576);
  await connection.close();
});

windows('a short original-image query can receive the existing multi-MiB product response', async () => {
  const { server } = await pipe();
  const accepted = server.accept(), child = client('image-response', server.name);
  const connection = await accepted;
  expect(await connection.read()).toEqual({ version: 1, requestId: 'original-image', type: 'read_document_original', documentId: 11, page: 1 });
  const image: DocumentOriginalImage = { documentRef: { id: 11, version: 'v1' }, mimeType: 'image/png', base64: 'AAAA'.repeat(700_000) };
  await connection.write({ version: 1, requestId: 'original-image', result: { ok: true, data: image } });
  expect(JSON.parse(await result(child))).toEqual({ requestId: 'original-image', documentId: 11, documentVersion: 'v1',
    mimeType: 'image/png', base64Bytes: 2_800_000, base64Matches: true });
  await connection.close();
});

for (const mode of ['cancel-client-failure', 'cancel-server-failure']) windows(`${mode} retains real pending I/O and permits closing the original handle again`, async () => {
  const summary = JSON.parse(await result(client(mode, 'isolated-native-fault')));
  expect(summary).toEqual({ firstError: 'pipe_cancel_failed', retryError: null, connectionRetry: true,
    cancellationAttempts: 2, nativeStopped: true, prematureUnloads: 0 });
});
