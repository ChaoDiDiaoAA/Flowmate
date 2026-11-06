import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { appError, fail, ok, type DesktopActionView } from '@flowmate/contracts';
import { CloudDesktopRelay } from '../../apps/cloud-desktop-relay.ts';
import { createCloudDesktopHandler } from '../../apps/cloud-desktop-gateway.ts';
import { runCloudDesktopBridge } from '../../apps/cloud-desktop-bridge.ts';
import { CloudSshSession } from '../../apps/desktop/main/cloud-ssh-session.ts';
import { CloudDesktopController } from '../../apps/desktop/main/cloud-desktop-controller.ts';
import { connectKimiMcp } from '../../apps/desktop/main/kimi-mcp.ts';
import { createKimiDesktop, handleKimiDesktopRequest } from '../../apps/desktop/main/kimi-desktop.ts';

const root = process.env.FLOWMATE_KIMICU_PLUGIN_ROOT, runtime = process.env.KIMI_CU_WINDOWS_EXE;
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = '2026-11-06T00:00:00.000Z';

test.skipIf(process.platform !== 'win32' || !root || !runtime)('a cloud request changes the real Windows sample only after its local approval', async () => {
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('tests/desktop/fixtures/kimi-sample.cjs')] });
  const kimi = await connectKimiMcp(root!, runtime!).catch(async error => { await app.close(); throw error; });
  const desktop = createKimiDesktop(kimi.api), relay = new CloudDesktopRelay();
  let proposed: DesktopActionView | null = null;
  const gateway = createCloudDesktopHandler({ workspaceId, authorize: async () => ok(undefined), desktopRelay: relay,
    dispatch: async command => command.type === 'invoice_work_desktop_list' ? ok({ workId: 1, itemId: 2, items: proposed ? [proposed] : [], nextAfterProposalId: null })
      : command.type === 'invoice_work_desktop_decide' ? ok({ ...command.input, revision: command.input.expectedRevision + 1, receivedAt: at }) : ok(undefined) });
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => { stdin.end(); return true; } });
  const transport = runCloudDesktopBridge(stdin, stdout, async envelope => ok(await gateway(envelope)));
  void transport.then(() => child.emit('close', 0, null));
  const session = new CloudSshSession(child as unknown as ChildProcessWithoutNullStreams, workspaceId);
  const controller = new CloudDesktopController({ connect: async () => ok(session), upload: async () => { throw Error('unused'); }, desktop: {
    execute: (cloud, request, signal) => handleKimiDesktopRequest(desktop, { workspaceId: cloud, workId: request.workId, itemId: request.itemId }, request, signal),
    verify: async (cloud, action, signal) => {
      const result = await desktop.resolveTarget({ workspaceId: cloud, workId: action.workId, itemId: action.itemId }, action.action, signal);
      return result.ok && isDeepStrictEqual(result.data, action.target) ? ok(undefined) : fail(appError('desktop_target_changed', 'runtime', 'Target changed.'));
    },
  } });
  try {
    const page = await app.firstWindow(); await page.locator('#amount').waitFor();
    expect(await controller.connect({ workspaceId, target: { host: '127.0.0.1', port: 22, username: 'flowmate',
      privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\hosts' } })).toMatchObject({ ok: true });
    const signal = new AbortController().signal, owner = { workspaceId, workId: 1, itemId: 2 };
    const windows = await desktop.listWindows(signal); if (!windows.ok) throw Error(windows.error.code);
    const selected = windows.data.find(window => window.title === 'Flowmate KimiCU Controlled Sample'); if (!selected) throw Error('Sample window is unavailable.');
    expect(await desktop.select(owner, selected, signal)).toEqual(ok(undefined));
    let observed = await relay.request({ kind: 'observe', workId: 1, itemId: 2 }, signal);
    if (!observed.ok || observed.data.kind !== 'observe') throw Error('Sample observation is unavailable.');
    let index = observed.data.tree.split('\n').find(line => /\[\d+\].*编辑.*sample amount/i.test(line))?.match(/\[(\d+)\]/)?.[1];
    for (let attempt = 0; !index && attempt < 5; attempt++) {
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      observed = await relay.request({ kind: 'observe', workId: 1, itemId: 2 }, signal);
      if (!observed.ok || observed.data.kind !== 'observe') throw Error('Sample observation is unavailable.');
      index = observed.data.tree.split('\n').find(line => /\[\d+\].*编辑.*sample amount/i.test(line))?.match(/\[(\d+)\]/)?.[1];
    }
    if (!index) throw Error('Sample control is unavailable.');
    const action = { kind: 'set_value' as const, observationId: observed.data.observationId, elementIndex: Number(index), value: '113.00' };
    const resolved = await relay.request({ kind: 'resolve', workId: 1, itemId: 2, action }, signal);
    if (!resolved.ok || resolved.data.kind !== 'resolve') throw Error('Sample target is unavailable.');
    proposed = { proposalId: 9, workId: 1, itemId: 2, proposalToolCallId: 10, status: 'waiting', canDecide: true, canReject: true,
      executionToolCallId: null, createdAt: at, updatedAt: at, action, target: resolved.data.target };
    const request = { kind: 'dispatch' as const, workId: 1, itemId: 2, proposalId: 9, action, target: resolved.data.target };
    expect(await relay.request(request, signal)).toMatchObject({ ok: false });
    expect(await page.locator('#amount').inputValue()).toBe('0.00');
    const decision = { workId: 1, itemId: 2, proposalId: 9, expectedRevision: 4, requestId: 'approve-cloud-sample', decision: 'approve' as const,
      confirmedAction: action, confirmedTarget: resolved.data.target };
    expect(await controller.request({ workspaceId, command: { type: 'invoice_work_desktop_decide', input: decision } })).toMatchObject({ ok: true });
    expect(await relay.request(request, signal)).toEqual(ok({ kind: 'dispatch' }));
    expect(await page.locator('#amount').inputValue()).toBe('113.00');
    expect(await relay.request(request, signal)).toMatchObject({ ok: false });
  } finally { await controller.close(); relay.close(); await desktop.close(); await app.close(); }
}, 30000);
