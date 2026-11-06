import { expect, test } from 'bun:test';
import { appError, fail, ok, parseCloudDesktopResult } from '@flowmate/contracts';
import { CloudDesktopController } from '../../apps/desktop/main/cloud-desktop-controller.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const profile = { workspaceId, target: { host: '127.0.0.1', port: 22, username: 'flowmate',
  privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\known_hosts' } };
const owner = { workId: 7, sessionId: 8, attemptId: 9 };
const command = { type: 'cloud_queue_read' as const, input: owner };

test('desktop cloud requests require the connected workspace and only expose the allowed protocol', async () => {
  let calls = 0, closes = 0, uploads = 0;
  const session = { request: async () => { calls++; return ok({ ...owner, version: 1, items: [] }); },
    close: async () => { closes++; return ok(undefined); } };
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async input => {
    uploads++; return ok({ workspaceId: input.workspaceId, uploadId: '11111111-1111-4111-8111-111111111111',
      sourceDocumentRef: input.documentRef, cloudDocumentRef: { id: 44, version: 'cloud-v1' } });
  } });
  expect(await controller.state()).toEqual({ ok: true, data: { workspaceId: null } });
  expect(await controller.request({ workspaceId, command })).toMatchObject({ ok: false });
  expect(await controller.connect(profile)).toEqual({ ok: true, data: { workspaceId } });
  expect(await controller.state()).toEqual({ ok: true, data: { workspaceId } });
  expect(await controller.connect(profile)).toMatchObject({ ok: false });
  expect(await controller.request({ workspaceId: otherWorkspace, command })).toMatchObject({ ok: false });
  expect(await controller.request({ workspaceId, command: { type: 'call_provider', input: {} } })).toMatchObject({ ok: false });
  expect(calls).toBe(0);
  expect(await controller.request({ workspaceId, command })).toEqual({ ok: true, data: { ...owner, version: 1, items: [] } });
  expect(await controller.upload({ workspaceId: otherWorkspace, documentRef: { id: 1, version: 'v1' } })).toMatchObject({ ok: false });
  expect(await controller.upload({ workspaceId, documentRef: { id: 1, version: 'v1' } }))
    .toMatchObject({ ok: true, data: { workspaceId, cloudDocumentRef: { id: 44 } } });
  expect(uploads).toBe(1);
  expect(await controller.disconnect({ workspaceId })).toEqual({ ok: true, data: undefined });
  expect(await controller.state()).toEqual({ ok: true, data: { workspaceId: null } });
  expect(closes).toBe(1); expect(await controller.request({ workspaceId, command })).toMatchObject({ ok: false });
});

test('an older cloud service stays usable when its desktop relay is unavailable', async () => {
  const session = { request: async (request: unknown) => typeof request === 'object' && request !== null && 'type' in request
    && request.type === 'cloud_queue_read' ? ok({ ...owner, version: 1, items: [] }) : fail(appError('input_invalid', 'input', 'Unsupported.')),
    close: async () => ok(undefined) };
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); },
    desktop: { verify: async () => ok(undefined), execute: async () => fail(appError('desktop_unavailable', 'runtime', 'Unavailable.')) } });
  expect(await controller.connect(profile)).toEqual(ok({ workspaceId }));
  expect(await controller.state()).toEqual(ok({ workspaceId, desktopReady: false }));
  expect(await controller.request({ workspaceId, command })).toEqual(ok({ ...owner, version: 1, items: [] }));
  expect(await controller.close()).toEqual(ok(undefined));
});

test('a late result cannot be presented as belonging to a reconnected workspace', async () => {
  const reply = Promise.withResolvers<ReturnType<typeof ok>>(); let closes = 0;
  const first = { request: async () => reply.promise, close: async () => { closes++; return ok(undefined); } };
  const second = { request: async () => ok({ ...owner, version: 2, items: [] }), close: async () => ok(undefined) };
  let connections = 0;
  const controller = new CloudDesktopController({ connect: async () => ok(connections++ ? second : first),
    upload: async () => { throw Error('unused'); } });
  expect(await controller.connect(profile)).toMatchObject({ ok: true });
  const pending = controller.request({ workspaceId, command });
  expect(await controller.disconnect({ workspaceId })).toMatchObject({ ok: true });
  expect(await controller.connect(profile)).toMatchObject({ ok: true });
  reply.resolve(ok({ ...owner, version: 1, items: [] }));
  expect(await pending).toMatchObject({ ok: false }); expect(closes).toBe(1);
  expect(await controller.request({ workspaceId, command })).toMatchObject({ ok: true, data: { version: 2 } });
  expect(await controller.close()).toMatchObject({ ok: true });
});

test('desktop shutdown confirms the exit of an SSH process that was still connecting', async () => {
  const ready = Promise.withResolvers<void>(); let closes = 0;
  const session = { request: async () => ok(undefined), close: async () => { closes++;
    return fail(appError('cloud_ssh_close_unconfirmed', 'runtime', 'SSH exit was not confirmed.', true)); } };
  const controller = new CloudDesktopController({ connect: async () => { await ready.promise; return ok(session); },
    upload: async () => { throw Error('unused'); } });
  const connecting = controller.connect(profile), closing = controller.close(); ready.resolve();
  expect(await connecting).toMatchObject({ ok: false });
  expect(await closing).toMatchObject({ ok: false, error: { code: 'cloud_ssh_close_unconfirmed' } });
  expect(closes).toBe(1);
});

test('desktop shutdown reports an unconfirmed SSH exit while its desktop relay is attaching', async () => {
  const attaching = Promise.withResolvers<void>(), finishAttach = Promise.withResolvers<void>(); let closes = 0;
  const session = { request: async (raw: unknown) => {
    const command = raw as { type: string; input: { connectionId: string } };
    if (command.type === 'cloud_desktop_attach') { attaching.resolve(); await finishAttach.promise; return ok({ connectionId: command.input.connectionId }); }
    return fail(appError('desktop_unavailable', 'runtime', 'Relay stopped.'));
  }, close: async () => { closes++; return fail(appError('cloud_ssh_close_unconfirmed', 'runtime', 'SSH exit was not confirmed.', true)); } };
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); },
    desktop: { verify: async () => ok(undefined), execute: async () => fail(appError('desktop_unavailable', 'runtime', 'Unavailable.')) } });
  const connecting = controller.connect(profile); await attaching.promise;
  const closing = controller.close(); finishAttach.resolve();
  expect(await connecting).toMatchObject({ ok: false });
  expect(await closing).toMatchObject({ ok: false, error: { code: 'cloud_ssh_close_unconfirmed' } });
  expect(closes).toBe(1);
});

test('an unconfirmed SSH disconnect remains visible during later shutdown', async () => {
  const session = { request: async () => ok(undefined), close: async () =>
    fail(appError('cloud_ssh_close_unconfirmed', 'runtime', 'SSH exit was not confirmed.', true)) };
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); } });
  expect(await controller.connect(profile)).toMatchObject({ ok: true });
  expect(await controller.disconnect({ workspaceId })).toMatchObject({ ok: false });
  expect(await controller.connect(profile)).toMatchObject({ ok: false });
  expect(await controller.close()).toMatchObject({ ok: false, error: { code: 'cloud_ssh_close_unconfirmed' } });
});

test('selected resource upload stays in the connected workspace and verifies the original version', async () => {
  let uploads = 0, wrong = false;
  const ref = { kind: 'prompt' as const, id: 'invoice', version: 'v1' };
  const session = { request: async () => ok(undefined), close: async () => ok(undefined) };
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); },
    uploadResource: async input => { uploads++; return ok({ workspaceId: input.workspaceId,
      uploadId: '11111111-1111-4111-8111-111111111111', ref: wrong ? { ...input.ref, version: 'different' } : input.ref }); } });
  expect(await controller.connect(profile)).toMatchObject({ ok: true });
  expect(await controller.uploadResource({ workspaceId: otherWorkspace, ref })).toMatchObject({ ok: false });
  expect(await controller.uploadResource({ workspaceId, ref })).toMatchObject({ ok: true, data: { ref } });
  wrong = true; expect(await controller.uploadResource({ workspaceId, ref })).toMatchObject({ ok: false });
  expect(uploads).toBe(2); expect(await controller.close()).toMatchObject({ ok: true });
});

test('the cloud review boundary accepts a full 10 MiB image and rejects malformed bytes', () => {
  const input = { workId: 1, itemId: 2, documentRef: { id: 3, version: 'v1' }, page: 1 as const };
  const command = { type: 'cloud_review_original' as const, input };
  const base64 = Buffer.alloc(10 * 1024 * 1024, 123).toString('base64');
  const image = { workId: input.workId, itemId: input.itemId, documentRef: input.documentRef, mimeType: 'image/png', base64 };
  expect(parseCloudDesktopResult(command, ok(image))).toMatchObject({ ok: true });
  expect(parseCloudDesktopResult(command, ok({ ...image, base64: base64.slice(0, 70000) + '!' + base64.slice(70001) }))).toBeNull();
  expect(parseCloudDesktopResult(command, ok({ ...image, base64: base64.slice(0, -4) + 'A===' }))).toBeNull();
});
