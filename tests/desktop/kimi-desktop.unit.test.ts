import { expect, test } from 'bun:test';
import { createKimiDesktop } from '../../apps/desktop/main/kimi-desktop.ts';
import * as desktopModule from '../../apps/desktop/main/kimi-desktop.ts';

const window = { id: 42, app: 'Invoice example', title: 'Draft' };
const other = { id: 43, app: 'Other app', title: 'Other' };
const signal = new AbortController().signal;
const owner = { workId: 1, itemId: 2 };
const action = (observationId: string) => ({ kind: 'click' as const, observationId, elementIndex: 3 });

test('the Flowmate window handle cannot be chosen as an external target', () => {
  const owns = Reflect.get(desktopModule, 'isOwnDesktopWindow');
  expect(typeof owns).toBe('function'); if (typeof owns !== 'function') return;
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(42n);
  expect(owns(42, [handle])).toBe(true);
  expect(owns(43, [handle])).toBe(false);
  expect(owns(43, [Buffer.alloc(0)])).toBe(true);
});

test('a Kimi input lease held by another session remains a visible busy error', async () => {
  const desktop = createKimiDesktop({ listWindows: async () => { throw Error('computer_use_busy'); },
    observe: async () => ({ window, tree: '[3] Button Submit', focused: null }), click: async () => {},
    setValue: async () => {}, typeText: async () => {}, close: async () => {} });
  expect(await desktop.listWindows(signal)).toMatchObject({ ok: false, error: { code: 'computer_use_busy' } });
});

function fixture() {
  let tree = '[3] Button Submit';
  const calls: string[] = [];
  const api = {
    listWindows: async () => [window, other],
    observe: async () => { calls.push('observe'); await Promise.resolve(); return { window, tree, focused: null }; },
    click: async () => { calls.push('click'); },
    setValue: async () => { calls.push('setValue'); },
    typeText: async () => { calls.push('typeText'); },
    close: async () => {},
  };
  return { desktop: createKimiDesktop(api), calls, change: () => { tree = '[3] Button Changed'; } };
}

test('cloud and local invoice identifiers cannot borrow each other\'s selected window', async () => {
  const f = fixture(), cloud = { ...owner, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  await f.desktop.listWindows(signal); await f.desktop.select(owner, window, signal);
  expect(await f.desktop.selectedWindows(cloud, signal)).toMatchObject({ ok: false });
  expect(await f.desktop.select(cloud, window, signal)).toMatchObject({ ok: true });
  f.desktop.revoke(cloud);
  expect(await f.desktop.selectedWindows(owner, signal)).toEqual({ ok: true, data: [window] });
});

test('the bridge forwards cloud observations only to the selected workspace owner', async () => {
  const handle = Reflect.get(desktopModule, 'handleKimiDesktopRequest');
  expect(typeof handle).toBe('function'); if (typeof handle !== 'function') return;
  const f = fixture(), cloud = { ...owner, workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  await f.desktop.listWindows(signal); await f.desktop.select(cloud, window, signal);
  expect(await handle(f.desktop, owner, { kind: 'observe', ...owner }, signal)).toMatchObject({ ok: false });
  expect(await handle(f.desktop, cloud, { kind: 'observe', ...owner }, signal))
    .toMatchObject({ ok: true, data: { kind: 'observe', window, tree: '[3] Button Submit' } });
});

test('a selected window is scoped to the invoice, and an observation cannot be borrowed', async () => {
  const f = fixture();
  expect((await f.desktop.observe(owner, signal)).ok).toBe(false);
  expect((await f.desktop.select(owner, window, signal)).ok).toBe(false);
  expect((await f.desktop.listWindows(signal)).ok).toBe(true);
  expect((await f.desktop.select(owner, window, signal)).ok).toBe(true);
  const observed = await f.desktop.observe(owner, signal);
  expect(observed.ok).toBe(true);
  if (!observed.ok) return;
  expect(await f.desktop.resolveTarget({ workId: 1, itemId: 9 }, action(observed.data.observationId), signal)).toMatchObject({ ok: false });
  expect(await f.desktop.resolveTarget(owner, action(observed.data.observationId), signal))
    .toMatchObject({ ok: true, data: { window, element: '[3] Button Submit' } });
  const selectedWindows = Reflect.get(f.desktop, 'selectedWindows');
  expect(typeof selectedWindows).toBe('function');
  if (typeof selectedWindows !== 'function') return;
  expect(await selectedWindows(owner, signal)).toEqual({ ok: true, data: [window] });
  expect(await selectedWindows({ workId: 1, itemId: 9 }, signal)).toMatchObject({ ok: false });
});

test('revalidation and dispatch share a queue and changed controls are not clicked', async () => {
  const f = fixture();
  await f.desktop.listWindows(signal); await f.desktop.select(owner, window, signal);
  const observed = await f.desktop.observe(owner, signal); if (!observed.ok) throw Error('observation failed');
  const proposed = action(observed.data.observationId);
  const target = await f.desktop.resolveTarget(owner, proposed, signal); if (!target.ok) throw Error('target failed');
  f.calls.length = 0;
  await Promise.all([f.desktop.dispatch(owner, proposed, target.data, signal), f.desktop.observe(owner, signal)]);
  expect(f.calls).toEqual(['observe', 'click', 'observe']);
  f.change(); f.calls.length = 0;
  expect(await f.desktop.dispatch(owner, proposed, target.data, signal)).toMatchObject({ ok: false });
  expect(f.calls).toEqual(['observe']);
});

test('concurrent Work actions do not interleave revalidation and input', async () => {
  const f = fixture(), otherOwner = { workId: 2, itemId: 1 };
  await f.desktop.listWindows(signal); await f.desktop.select(owner, window, signal); await f.desktop.select(otherOwner, window, signal);
  const a = await f.desktop.observe(owner, signal), b = await f.desktop.observe(otherOwner, signal);
  if (!a.ok || !b.ok) throw Error('observation failed');
  const first = action(a.data.observationId), second = action(b.data.observationId);
  const one = await f.desktop.resolveTarget(owner, first, signal), two = await f.desktop.resolveTarget(otherOwner, second, signal);
  if (!one.ok || !two.ok) throw Error('target failed');
  f.calls.length = 0;
  expect(await Promise.all([f.desktop.dispatch(owner, first, one.data, signal), f.desktop.dispatch(otherOwner, second, two.data, signal)]))
    .toEqual([{ ok: true, data: undefined }, { ok: true, data: undefined }]);
  expect(f.calls).toEqual(['observe', 'click', 'observe', 'click']);
});

test('resolving a proposal rechecks the original control against the current window', async () => {
  const f = fixture();
  await f.desktop.listWindows(signal); await f.desktop.select(owner, window, signal);
  const observed = await f.desktop.observe(owner, signal); if (!observed.ok) throw Error('observation failed');
  f.change();
  expect(await f.desktop.resolveTarget(owner, action(observed.data.observationId), signal))
    .toMatchObject({ ok: false, error: { code: 'desktop_target_changed' } });
});

test('a new selection and connection closure revoke earlier observations', async () => {
  const f = fixture();
  await f.desktop.listWindows(signal); await f.desktop.select(owner, window, signal);
  const observed = await f.desktop.observe(owner, signal); if (!observed.ok) throw Error('observation failed');
  await f.desktop.select(owner, other, signal);
  expect(await f.desktop.resolveTarget(owner, action(observed.data.observationId), signal))
    .toMatchObject({ ok: false, error: { code: 'desktop_target_changed' } });
  await f.desktop.close();
  expect(await f.desktop.listWindows(signal)).toMatchObject({ ok: false });
});

test('an observation reports when its accessible text was shortened', async () => {
  const desktop = createKimiDesktop({ listWindows: async () => [window],
    observe: async () => ({ window, tree: '[3] Edit Value\n' + 'x'.repeat(22000), focused: null }),
    click: async () => {}, setValue: async () => {}, typeText: async () => {}, close: async () => {} });
  await desktop.listWindows(signal); await desktop.select(owner, window, signal);
  expect(await desktop.observe(owner, signal)).toMatchObject({ ok: true, data: { truncated: true } });
});

test('closing the interactive connection during revalidation prevents later input', async () => {
  let observations = 0, clicks = 0, release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const observing = new Promise<void>(resolve => { started = resolve; });
  const desktop = createKimiDesktop({ listWindows: async () => [window], observe: async () => {
    if (++observations === 3) { started(); await blocked; }
    return { window, tree: '[3] Button Submit', focused: null };
  }, click: async () => { clicks++; }, setValue: async () => {}, typeText: async () => {}, close: async () => {} });
  await desktop.listWindows(signal); await desktop.select(owner, window, signal);
  const observed = await desktop.observe(owner, signal); if (!observed.ok) throw Error('observation failed');
  const proposed = action(observed.data.observationId);
  const target = await desktop.resolveTarget(owner, proposed, signal); if (!target.ok) throw Error('target failed');
  const dispatched = desktop.dispatch(owner, proposed, target.data, signal);
  await observing;
  const closing = desktop.close();
  release();
  expect(await dispatched).toMatchObject({ ok: false });
  await closing;
  expect(clicks).toBe(0);
});

test('a window selection cannot succeed after its desktop connection closes', async () => {
  let lists = 0;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const desktop = createKimiDesktop({ listWindows: async () => { if (++lists === 2) { entered.resolve(); await release.promise; } return [window]; },
    observe: async () => ({ window, tree: '[3] Button Submit', focused: null }), click: async () => {}, setValue: async () => {},
    typeText: async () => {}, close: async () => {} });
  await desktop.listWindows(signal);
  const selecting = desktop.select(owner, window, signal); await entered.promise;
  const closing = desktop.close(); release.resolve();
  expect(await selecting).toMatchObject({ ok: false });
  await closing;
});

test('typing is refused when the focused description could identify more than one control', async () => {
  let typed = 0;
  const desktop = createKimiDesktop({ listWindows: async () => [window],
    observe: async () => ({ window, tree: '[3] Edit Value\n[4] Edit Value', focused: 'Focused: Edit Value' }),
    click: async () => {}, setValue: async () => {}, typeText: async () => { typed++; }, close: async () => {} });
  await desktop.listWindows(signal); await desktop.select(owner, window, signal);
  const observed = await desktop.observe(owner, signal); if (!observed.ok) throw Error('observation failed');
  const proposed = { kind: 'type_text' as const, observationId: observed.data.observationId, elementIndex: 3, text: 'test' };
  const target = await desktop.resolveTarget(owner, proposed, signal); if (!target.ok) throw Error('target failed');
  expect(await desktop.dispatch(owner, proposed, target.data, signal)).toMatchObject({ ok: false });
  expect(typed).toBe(0);
});

test('typing is refused when the current accessibility tree was truncated', async () => {
  let typed = 0;
  const desktop = createKimiDesktop({ listWindows: async () => [window],
    observe: async () => ({ window, tree: '[3] Edit Value', focused: 'Focused: Edit Value', truncated: true }),
    click: async () => {}, setValue: async () => {}, typeText: async () => { typed++; }, close: async () => {} });
  await desktop.listWindows(signal); await desktop.select(owner, window, signal);
  const observed = await desktop.observe(owner, signal); if (!observed.ok) throw Error('observation failed');
  const proposed = { kind: 'type_text' as const, observationId: observed.data.observationId, elementIndex: 3, text: 'test' };
  const target = await desktop.resolveTarget(owner, proposed, signal); if (!target.ok) throw Error('target failed');
  expect(await desktop.dispatch(owner, proposed, target.data, signal)).toMatchObject({ ok: false });
  expect(typed).toBe(0);
});

test('revoking one invoice selection removes its observations', async () => {
  const f = fixture();
  await f.desktop.listWindows(signal); await f.desktop.select(owner, window, signal);
  const observed = await f.desktop.observe(owner, signal); if (!observed.ok) throw Error('observation failed');
  const revoke = Reflect.get(f.desktop, 'revoke');
  expect(typeof revoke).toBe('function');
  if (typeof revoke !== 'function') return;
  revoke(owner);
  expect(await f.desktop.resolveTarget(owner, action(observed.data.observationId), signal)).toMatchObject({ ok: false });
});
