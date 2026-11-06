import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { appError, fail, ok } from '@flowmate/contracts';
import { CloudDesktopRelay } from '../../apps/cloud-desktop-relay.ts';
import { runCloudDesktopBridge } from '../../apps/cloud-desktop-bridge.ts';
import { createCloudDesktopHandler } from '../../apps/cloud-desktop-gateway.ts';
import { CloudDesktopController } from '../../apps/desktop/main/cloud-desktop-controller.ts';
import { CloudSshSession } from '../../apps/desktop/main/cloud-ssh-session.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = '2026-11-06T00:00:00.000Z';
const action = { proposalId: 9, workId: 1, itemId: 2, proposalToolCallId: 10, status: 'waiting' as const,
  canDecide: true, canReject: true, executionToolCallId: null, createdAt: at, updatedAt: at,
  action: { kind: 'click' as const, observationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', elementIndex: 4 },
  target: { connectionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', window: { id: 3, app: 'Controlled', title: 'Sample' }, element: '[4] Button' } };
const browser = { proposalId: 11, workId: 1, itemId: 2, proposalToolCallId: 12, status: 'waiting' as const,
  canDecide: true, canReject: true, canRevoke: false, executionToolCallId: null, createdAt: at, updatedAt: at,
  target: { connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', origin: 'https://example.test' } };

test('the cloud bridge reads only a locally approved matching browser target once', async () => {
  const module = await import('../../apps/desktop/main/cloud-kimi-bridge.ts');
  const relay = new CloudDesktopRelay();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(undefined), desktopRelay: relay });
  const session = { request: (command: unknown) => handler({ version: 1, workspaceId, requestId: randomUUID(), command }) };
  let reads = 0;
  const bridge = new module.CloudKimiBridge(session, workspaceId, { verify: async () => ok(undefined), verifyBrowser: async () => ok(undefined),
    execute: async request => request.kind === 'browser_read' ? (reads++, ok({ kind: 'browser_read' as const,
      page: { url: 'https://example.test/page', title: 'Example', text: 'page', truncated: false } })) : fail(appError('desktop_unavailable', 'runtime', 'Unavailable.')) });
  expect(await bridge.start()).toMatchObject({ ok: true });
  try {
    const request = { kind: 'browser_read' as const, workId: browser.workId, itemId: browser.itemId, proposalId: browser.proposalId, target: browser.target };
    expect(await relay.request(request, new AbortController().signal)).toMatchObject({ ok: false });
    const approve = Reflect.get(bridge, 'approveBrowser');
    expect(typeof approve).toBe('function'); if (typeof approve !== 'function') return;
    expect(await approve.call(bridge, browser)).toMatchObject({ ok: true });
    expect(await relay.request({ ...request, target: { ...request.target, bindingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }, new AbortController().signal)).toMatchObject({ ok: false });
    expect(await relay.request(request, new AbortController().signal)).toMatchObject({ ok: true, data: { page: { text: 'page' } } });
    expect(await relay.request(request, new AbortController().signal)).toMatchObject({ ok: false });
    expect(reads).toBe(1);
  } finally { await bridge.close(); relay.close(); }
});

test('revoking while local browser approval is checked prevents a late approval', async () => {
  const module = await import('../../apps/desktop/main/cloud-kimi-bridge.ts');
  const relay = new CloudDesktopRelay(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(undefined), desktopRelay: relay });
  const session = { request: (command: unknown) => handler({ version: 1, workspaceId, requestId: randomUUID(), command }) };
  let reads = 0;
  const bridge = new module.CloudKimiBridge(session, workspaceId, { verify: async () => ok(undefined),
    verifyBrowser: async () => { entered.resolve(); await release.promise; return ok(undefined); },
    execute: async () => { reads++; return ok({ kind: 'browser_read' as const, page: { url: 'https://example.test/page', title: 'Page', text: 'secret', truncated: false } }); } });
  expect(await bridge.start()).toMatchObject({ ok: true });
  try {
    const approval = bridge.approveBrowser(browser); await entered.promise;
    bridge.revokeBrowser(browser.workId, browser.itemId, browser.proposalId); release.resolve();
    expect(await approval).toMatchObject({ ok: false });
    expect(await relay.request({ kind: 'browser_read', workId: browser.workId, itemId: browser.itemId,
      proposalId: browser.proposalId, target: browser.target }, new AbortController().signal)).toMatchObject({ ok: false });
    expect(reads).toBe(0);
  } finally { release.resolve(); await bridge.close(); relay.close(); }
});

test('stopping a Work revokes its pending browser approval without affecting another Work', async () => {
  const module = await import('../../apps/desktop/main/cloud-kimi-bridge.ts');
  const relay = new CloudDesktopRelay(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(undefined), desktopRelay: relay });
  const session = { request: (command: unknown) => handler({ version: 1, workspaceId, requestId: randomUUID(), command }) };
  const bridge = new module.CloudKimiBridge(session, workspaceId, { verify: async () => ok(undefined), verifyBrowser: async () => ok(undefined),
    execute: async request => { if (request.workId === browser.workId) { entered.resolve(); await release.promise; }
      return ok({ kind: 'browser_read' as const, page: { url: 'https://example.test/page', title: 'Page', text: 'secret', truncated: false } }); } });
  expect(await bridge.start()).toMatchObject({ ok: true });
  try {
    expect(await bridge.approveBrowser(browser)).toMatchObject({ ok: true });
    expect(await bridge.approveBrowser({ ...browser, workId: 2 })).toMatchObject({ ok: true });
    const request = { kind: 'browser_read' as const, workId: browser.workId, itemId: browser.itemId, proposalId: browser.proposalId, target: browser.target };
    const pending = relay.request(request, new AbortController().signal); await entered.promise;
    const revokeWork = Reflect.get(bridge, 'revokeBrowserWork');
    expect(typeof revokeWork).toBe('function'); if (typeof revokeWork !== 'function') return;
    revokeWork.call(bridge, browser.workId); release.resolve();
    expect(await pending).toMatchObject({ ok: false });
    expect(await relay.request({ ...request, workId: 2 }, new AbortController().signal)).toMatchObject({ ok: true });
  } finally { release.resolve(); await bridge.close(); relay.close(); }
});

test('an unexpected cloud desktop disconnect invalidates local browser bindings', async () => {
  const module = await import('../../apps/desktop/main/cloud-kimi-bridge.ts');
  const relay = new CloudDesktopRelay();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(undefined), desktopRelay: relay });
  const session = { request: (command: unknown) => handler({ version: 1, workspaceId, requestId: randomUUID(), command }) };
  let invalidated = false;
  const options = { verify: async () => ok(undefined), execute: async () => fail(appError('desktop_unavailable', 'runtime', 'Unavailable.')),
    onClosed: () => { invalidated = true; } };
  const bridge = new module.CloudKimiBridge(session, workspaceId, options);
  expect(await bridge.start()).toMatchObject({ ok: true });
  try {
    relay.close();
    for (let i = 0; i < 20 && bridge.isReady(); i++) await Bun.sleep(5);
    expect(bridge.isReady()).toBe(false);
    expect(invalidated).toBe(true);
  } finally { await bridge.close(); }
});

test('a cloud browser decision requires the local target and a revocation suppresses a late result', async () => {
  const relay = new CloudDesktopRelay(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let decisions = 0, reads = 0, verified = false;
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), desktopRelay: relay,
    dispatch: async command => command.type === 'invoice_work_browser_list'
      ? ok({ workId: browser.workId, itemId: browser.itemId, items: [browser], nextAfterProposalId: null })
      : command.type === 'invoice_work_browser_decide' ? (decisions++, ok({ ...command.input, revision: command.input.expectedRevision + 1, receivedAt: at }))
      : command.type === 'invoice_work_browser_revoke' ? ok({ ...browser, status: 'unknown', canDecide: false,
        canReject: false, canRevoke: false, executionToolCallId: 15 }) : ok(undefined) });
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
  const transport = runCloudDesktopBridge(stdin, stdout, async envelope => ok(await handler(envelope)));
  void transport.then(() => child.emit('close', 0, null));
  const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); },
    desktop: { verify: async () => ok(undefined), verifyBrowser: async () => verified ? ok(undefined) : fail(appError('browser_unavailable', 'runtime', 'Target changed.')),
      execute: async (_workspace, request) => {
        if (request.kind !== 'browser_read') return fail(appError('desktop_unavailable', 'runtime', 'Unavailable.'));
        reads++; entered.resolve(); await release.promise;
        return ok({ kind: 'browser_read' as const, page: { url: 'https://example.test/page', title: 'Page', text: 'late secret', truncated: false } });
      } } });
  const profile = { workspaceId, target: { host: '127.0.0.1', port: 22, username: 'flowmate', privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\hosts' } };
  expect(await controller.connect(profile)).toMatchObject({ ok: true });
  try {
    const input = { workId: 1, itemId: 2, proposalId: 11, expectedRevision: 4, requestId: 'browser-approved', decision: 'approve' as const, confirmedTarget: browser.target };
    expect(await controller.request({ workspaceId, command: { type: 'invoice_work_browser_decide', input } })).toMatchObject({ ok: false });
    expect(decisions).toBe(0); verified = true;
    expect(await controller.request({ workspaceId, command: { type: 'invoice_work_browser_decide', input } })).toMatchObject({ ok: true });
    const pending = relay.request({ kind: 'browser_read', workId: 1, itemId: 2, proposalId: 11, target: browser.target }, new AbortController().signal);
    await entered.promise;
    expect(await controller.request({ workspaceId, command: { type: 'invoice_work_browser_revoke', input: { workId: 1, itemId: 2, proposalId: 11 } } })).toMatchObject({ ok: true });
    release.resolve();
    const result = await pending; expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('late secret'); expect(reads).toBe(1); expect(decisions).toBe(1);
  } finally { release.resolve(); await controller.close(); relay.close(); }
});

test('a cloud Work cancellation revokes a browser read already in flight on Windows', async () => {
  const relay = new CloudDesktopRelay(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), desktopRelay: relay,
    dispatch: async command => command.type === 'invoice_work_browser_list'
      ? ok({ workId: browser.workId, itemId: browser.itemId, items: [browser], nextAfterProposalId: null })
      : command.type === 'invoice_work_browser_decide' ? ok({ ...command.input, revision: command.input.expectedRevision + 1, receivedAt: at })
      : fail(appError('state_conflict', 'input', 'The Work changed.')) });
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
  const transport = runCloudDesktopBridge(stdin, stdout, async envelope => ok(await handler(envelope)));
  void transport.then(() => child.emit('close', 0, null));
  const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); },
    desktop: { verify: async () => ok(undefined), verifyBrowser: async () => ok(undefined), execute: async () => {
      entered.resolve(); await release.promise;
      return ok({ kind: 'browser_read' as const, page: { url: 'https://example.test/page', title: 'Page', text: 'late secret', truncated: false } });
    } } });
  const profile = { workspaceId, target: { host: '127.0.0.1', port: 22, username: 'flowmate', privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\hosts' } };
  expect(await controller.connect(profile)).toMatchObject({ ok: true });
  try {
    const approval = { workId: 1, itemId: 2, proposalId: 11, expectedRevision: 4, requestId: 'browser-approved', decision: 'approve' as const, confirmedTarget: browser.target };
    expect(await controller.request({ workspaceId, command: { type: 'invoice_work_browser_decide', input: approval } })).toMatchObject({ ok: true });
    const pending = relay.request({ kind: 'browser_read', workId: 1, itemId: 2, proposalId: 11, target: browser.target }, new AbortController().signal);
    await entered.promise;
    await controller.request({ workspaceId, command: { type: 'invoice_work_cancel', input: { workId: 1, expectedRevision: 5, requestId: 'cancel-work' } } });
    release.resolve();
    expect(await pending).toMatchObject({ ok: false });
  } finally { release.resolve(); await controller.close(); relay.close(); }
});

test('the local desktop dispatches only the exact approved cloud action once', async () => {
  const module = await import('../../apps/desktop/main/cloud-kimi-bridge.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) return;
  const relay = new CloudDesktopRelay();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(undefined), desktopRelay: relay });
  const session = { request: (command: unknown) => handler({ version: 1, workspaceId, requestId: randomUUID(), command }) };
  let inputs = 0;
  const bridge = new module.CloudKimiBridge(session, workspaceId, {
    verify: async () => ok(undefined), execute: async request => { if (request.kind === 'dispatch') inputs++; return ok({ kind: 'dispatch' as const }); },
  });
  expect(await bridge.start()).toMatchObject({ ok: true });
  try {
    const request = { kind: 'dispatch' as const, workId: action.workId, itemId: action.itemId, proposalId: action.proposalId,
      action: action.action, target: action.target };
    expect(await relay.request(request, new AbortController().signal)).toMatchObject({ ok: false });
    expect(inputs).toBe(0);
    expect(await bridge.approve(action)).toMatchObject({ ok: true });
    expect(await relay.request({ ...request, action: { ...request.action, elementIndex: 5 } }, new AbortController().signal)).toMatchObject({ ok: false });
    expect(inputs).toBe(0);
    expect(await relay.request(request, new AbortController().signal)).toEqual(ok({ kind: 'dispatch' }));
    expect(await relay.request(request, new AbortController().signal)).toMatchObject({ ok: false });
    expect(inputs).toBe(1);
  } finally { await bridge.close(); relay.close(); }
});

test('a user decision binds the cloud proposal to the connected Windows receiver before continuing', async () => {
  const relay = new CloudDesktopRelay(); let inputs = 0, decisions = 0;
  let remoteAction = { ...action, action: { ...action.action, elementIndex: 5 }, target: { ...action.target, element: '[5] Button' } };
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), desktopRelay: relay,
    dispatch: async command => command.type === 'invoice_work_desktop_list'
      ? ok({ workId: action.workId, itemId: action.itemId, items: [remoteAction], nextAfterProposalId: null })
      : command.type === 'invoice_work_desktop_decide'
        ? (decisions++, ok({ ...command.input, revision: command.input.expectedRevision + 1, receivedAt: at })) : ok(undefined) });
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
  const transport = runCloudDesktopBridge(stdin, stdout, async envelope => ok(await handler(envelope)));
  void transport.then(() => child.emit('close', 0, null));
  const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); },
    desktop: { verify: async () => ok(undefined), execute: async (_workspace, request) => { if (request.kind === 'dispatch') inputs++; return ok({ kind: 'dispatch' as const }); } } });
  const profile = { workspaceId, target: { host: '127.0.0.1', port: 22, username: 'flowmate', privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\hosts' } };
  expect(await controller.connect(profile)).toMatchObject({ ok: true });
  try {
    const input = { workId: 1, itemId: 2, proposalId: 9, expectedRevision: 4, requestId: 'approve-original', decision: 'approve' as const,
      confirmedAction: action.action, confirmedTarget: action.target };
    expect(await controller.request({ workspaceId, command: { type: 'invoice_work_desktop_decide', input } })).toMatchObject({ ok: false });
    expect(decisions).toBe(0); expect(inputs).toBe(0);
    remoteAction = action;
    expect(await controller.request({ workspaceId, command: { type: 'invoice_work_desktop_decide', input } })).toMatchObject({ ok: true, data: { ...input, revision: 5 } });
    expect(decisions).toBe(1);
    expect(await relay.request({ kind: 'dispatch', workId: 1, itemId: 2, proposalId: 9, action: action.action, target: action.target }, new AbortController().signal))
      .toEqual(ok({ kind: 'dispatch' }));
    expect(inputs).toBe(1);
  } finally { await controller.close(); relay.close(); }
});

test('cloud cancellation aborts the original local input and never replays it', async () => {
  const module = await import('../../apps/desktop/main/cloud-kimi-bridge.ts');
  const relay = new CloudDesktopRelay(), entered = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const handler = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), dispatch: async () => ok(undefined), desktopRelay: relay });
  const session = { request: (command: unknown) => handler({ version: 1, workspaceId, requestId: randomUUID(), command }) };
  let started = 0;
  const bridge = new module.CloudKimiBridge(session, workspaceId, { verify: async () => ok(undefined),
    execute: async (_request, signal) => new Promise(resolve => {
      started++; entered.resolve();
      signal.addEventListener('abort', () => { stopped.resolve(); resolve(fail(appError('agent_cancelled', 'runtime', 'Cancelled.'))); }, { once: true });
    }) });
  expect(await bridge.start()).toMatchObject({ ok: true });
  try {
    expect(await bridge.approve(action)).toMatchObject({ ok: true });
    const controller = new AbortController();
    const request = { kind: 'dispatch' as const, workId: action.workId, itemId: action.itemId, proposalId: action.proposalId,
      action: action.action, target: action.target };
    const pending = relay.request(request, controller.signal); await entered.promise;
    controller.abort(); expect(await pending).toMatchObject({ ok: false }); await stopped.promise;
    expect(await relay.request(request, new AbortController().signal)).toMatchObject({ ok: false });
    expect(started).toBe(1);
  } finally { await bridge.close(); relay.close(); }
});
