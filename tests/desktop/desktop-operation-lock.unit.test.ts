import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok } from '@flowmate/contracts';
import { mkdtempSync } from '../support/resources.ts';
import { createDesktopOperationLock } from '../../apps/desktop/main/desktop-operation-lock.ts';
import { createKimiMcpApi } from '../../apps/desktop/main/kimi-mcp.ts';

test('two desktop owners cannot overlap observation and input on the same user desktop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-kimi-lock-'));
  const first = createDesktopOperationLock(join(root, 'desktop')), second = createDesktopOperationLock(join(root, 'desktop'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), signal = new AbortController().signal;
  const held = first(signal, async () => { entered.resolve(); await release.promise; return ok('first'); });
  await entered.promise;
  let overlapped = false;
  expect(await second(signal, async () => { overlapped = true; return ok('second'); })).toMatchObject({ ok: false });
  expect(overlapped).toBe(false);
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', `
    import { createDesktopOperationLock } from './apps/desktop/main/desktop-operation-lock.ts';
    import { ok } from '@flowmate/contracts';
    const result = await createDesktopOperationLock(process.env.FLOWMATE_TEST_DESKTOP_LOCK)(new AbortController().signal, async () => ok('entered'));
    console.log(result.ok ? 'entered' : result.error.code);
  `], { cwd: process.cwd(), env: { ...process.env, FLOWMATE_TEST_DESKTOP_LOCK: join(root, 'desktop') }, stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.trim()).toBe('desktop_busy');
  release.resolve(); expect(await held).toEqual(ok('first'));
  expect(await second(signal, async () => ok('second'))).toEqual(ok('second'));
});

test('a cancelled MCP operation keeps the desktop lock until its connection closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-kimi-close-lock-'));
  const first = createDesktopOperationLock(join(root, 'desktop')), second = createDesktopOperationLock(join(root, 'desktop'));
  const entered = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const api = createKimiMcpApi({ callTool: async (_name, _args, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); entered.resolve();
  }), close: async () => { closing.resolve(); await release.promise; } });
  const controller = new AbortController();
  const pending = first(controller.signal, async () => {
    try { await api.listWindows(controller.signal); return ok('unexpected'); }
    catch { return fail(appError('desktop_unavailable', 'runtime', 'The connection stopped.')); }
  });
  await entered.promise; controller.abort(); await closing.promise;
  expect(await second(new AbortController().signal, async () => ok('unexpected'))).toMatchObject({ ok: false, error: { code: 'desktop_busy' } });
  release.resolve(); expect(await pending).toMatchObject({ ok: false });
  expect(await second(new AbortController().signal, async () => ok('ready'))).toEqual(ok('ready'));
});
