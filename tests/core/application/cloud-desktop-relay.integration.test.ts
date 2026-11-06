import { expect, test } from 'bun:test';

const connectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('a cloud desktop request reaches only its attached receiver and accepts only its original response', async () => {
  const module = await import('../../../apps/cloud-desktop-relay.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) return;
  const relay = new module.CloudDesktopRelay(), signal = new AbortController();
  expect(relay.attach(connectionId)).toEqual({ ok: true, data: { connectionId } });
  expect(relay.attach(otherId)).toMatchObject({ ok: false });
  const pending = relay.request({ kind: 'observe', workId: 1, itemId: 2 }, signal.signal);
  const event = await relay.next(connectionId, signal.signal);
  expect(event).toMatchObject({ ok: true, data: { connectionId, event: { kind: 'request', request: { kind: 'observe', workId: 1, itemId: 2 } } } });
  if (!event.ok || !event.data.event || event.data.event.kind !== 'request') throw Error('Original request was not delivered.');
  const id = event.data.event.id;
  const result = { ok: true as const, data: { kind: 'observe' as const, observationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    window: { id: 3, app: 'Controlled', title: 'Sample' }, tree: '[4] Edit', truncated: false } };
  expect(relay.reply(otherId, id, result)).toMatchObject({ ok: false });
  expect(relay.reply(connectionId, id, { ok: true, data: { kind: 'dispatch' } })).toMatchObject({ ok: false });
  expect(relay.reply(connectionId, id, result)).toEqual({ ok: true, data: { connectionId } });
  expect(await pending).toEqual(result);
  expect(relay.reply(connectionId, id, result)).toMatchObject({ ok: false });
  relay.detach(connectionId);
});

test('cancellation or disconnection does not redeliver a possibly dispatched input', async () => {
  const module = await import('../../../apps/cloud-desktop-relay.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) return;
  const relay = new module.CloudDesktopRelay(), signal = new AbortController();
  expect(relay.attach(connectionId).ok).toBe(true);
  const action = { kind: 'click' as const, observationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', elementIndex: 4 };
  const target = { connectionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', window: { id: 3, app: 'Controlled', title: 'Sample' }, element: '[4] Button' };
  const pending = relay.request({ kind: 'dispatch', workId: 1, itemId: 2, action, target, proposalId: 9 }, signal.signal);
  const event = await relay.next(connectionId, new AbortController().signal);
  if (!event.ok || !event.data.event || event.data.event.kind !== 'request') throw Error('Original request was not delivered.');
  signal.abort();
  expect(await pending).toMatchObject({ ok: false });
  expect(await relay.next(connectionId, new AbortController().signal)).toMatchObject({ ok: true,
    data: { connectionId, event: { kind: 'cancel', id: event.data.event.id } } });
  expect(relay.reply(connectionId, event.data.event.id, { ok: true, data: { kind: 'dispatch' } })).toMatchObject({ ok: false });
  expect(relay.detach(connectionId)).toEqual({ ok: true, data: { connectionId } });
  expect(relay.attach(otherId)).toEqual({ ok: true, data: { connectionId: otherId } });
  relay.detach(otherId);
});
