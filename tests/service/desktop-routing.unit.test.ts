import { expect, test } from 'bun:test';
import { createDesktopRouting } from '../../apps/service/desktop-routing.ts';

test('only the explicitly bound live client receives a Work item request', () => {
  const first = { live: true }, second = { live: true };
  const routing = createDesktopRouting((client: typeof first) => client.live);
  const owner = { workId: 1, itemId: 2 };
  expect(routing.bind(first, owner)).toBe(true);
  expect(routing.bind(second, { workId: 1, itemId: 3 })).toBe(false);
  expect(routing.recipient(owner)).toBe(first);
  expect(routing.recipient({ workId: 1, itemId: 3 })).toBeNull();
  first.live = false;
  expect(routing.recipient(owner)).toBeNull();
  routing.disconnect(first);
  expect(routing.bind(second, owner)).toBe(true);
});

test('another client cannot answer a pending desktop request', () => {
  const first = { live: true }, second = { live: true };
  const routing = createDesktopRouting((client: typeof first) => client.live);
  const request = { kind: 'list' as const, workId: 1, itemId: 2 };
  routing.bind(first, request);
  expect(routing.remember('request-1', first, request)).toBe(true);
  expect(routing.receive('request-1', second, { ok: true, data: { kind: 'list', windows: [] } })).toBeNull();
  expect(routing.receive('request-1', first, { ok: true, data: { kind: 'observe' } })).toMatchObject({ ok: false });
  expect(routing.receive('request-1', first, { ok: true, data: { kind: 'list', windows: [] } })).toBeNull();
});
