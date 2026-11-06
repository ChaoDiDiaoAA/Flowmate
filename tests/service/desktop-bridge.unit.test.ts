import { expect, test } from 'bun:test';
import { createDesktopBridge } from '../../apps/host/desktop-bridge.ts';

test('a desktop response is bound to the original operation', async () => {
  const sent: any[] = [], bridge = createDesktopBridge(output => { sent.push(output); });
  const pending = bridge.request({ kind: 'observe', workId: 1, itemId: 2 }, new AbortController().signal);
  expect(sent[0]).toMatchObject({ type: 'desktop_request', request: { kind: 'observe', workId: 1, itemId: 2 } });
  bridge.receive(sent[0].requestId, { ok: true, data: { kind: 'list', windows: [] } });
  expect(await pending).toMatchObject({ ok: false });
  bridge.close();
});

test('cancelling a request notifies its original desktop and does not accept a late response', async () => {
  const sent: any[] = [], bridge = createDesktopBridge(output => { sent.push(output); });
  const controller = new AbortController();
  const pending = bridge.request({ kind: 'list', workId: 1, itemId: 2 }, controller.signal);
  const id = sent[0].requestId;
  controller.abort();
  expect(sent[1]).toMatchObject({ type: 'desktop_cancel', requestId: id });
  expect(await pending).toMatchObject({ ok: false });
  expect(bridge.receive(id, { ok: true, data: { kind: 'list', windows: [] } })).toBe(false);
  bridge.close();
});
