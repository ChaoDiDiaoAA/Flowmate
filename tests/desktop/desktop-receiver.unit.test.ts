import { expect, test } from 'bun:test';
import { createDesktopReceiver } from '../../apps/desktop/main/desktop-receiver.ts';

test('a cancelled desktop request cannot return a late result', async () => {
  const entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>();
  const responses: unknown[] = [];
  const receiver = createDesktopReceiver(async (_request, signal) => { entered.resolve(signal); await release.promise;
    return { ok: true, data: { kind: 'list', windows: [] } }; }, (id, value) => responses.push({ id, value }));
  receiver.request('original', { kind: 'list', workId: 1, itemId: 2 });
  const signal = await entered.promise;
  receiver.cancel('original');
  expect(signal.aborted).toBe(true);
  release.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(responses).toEqual([]);
  receiver.close();
});

test('the receiver rejects a malformed transport request identity', () => {
  const receiver = createDesktopReceiver(async () => ({ ok: true, data: { kind: 'list', windows: [] } }), () => {});
  expect(receiver.request(42 as never, { kind: 'list', workId: 1, itemId: 2 })).toBe(false);
  receiver.close();
});

test('a failed reply write does not escape the receiver', async () => {
  const sent = Promise.withResolvers<void>();
  const receiver = createDesktopReceiver(async () => ({ ok: true, data: { kind: 'list', windows: [] } }), () => {
    sent.resolve(); throw Error('connection already closed');
  });
  receiver.request('original', { kind: 'list', workId: 1, itemId: 2 });
  await sent.promise; await new Promise(resolve => setTimeout(resolve, 0));
  receiver.close();
});
