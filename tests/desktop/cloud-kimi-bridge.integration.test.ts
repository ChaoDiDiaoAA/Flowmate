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
