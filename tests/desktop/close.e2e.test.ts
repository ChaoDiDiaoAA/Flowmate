import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { cleanupResources, closeDesktopFixture, Database, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
test.setTimeout(60_000);

async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-close-'));
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: root };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready)), { timeout: 25_000 }).toBe(true);
    expect(await page.evaluate(() => window.flowmate.createSession({ title: 'Saved before closing' }))).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.flowmate.queryEvaluationControl())).toMatchObject({ ok: true, data: { state: 'idle' } });
    const pids = await app.evaluate((_electron, ownedRoot) => (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles()
      .filter(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
        && (value.spawnargs.includes(ownedRoot) || value.spawnargs.some(arg => typeof arg === 'string' && /[\\/]desktop[\\/]worker\.ts$/.test(arg))))
      .map(value => (value as import('node:child_process').ChildProcess).pid!), root);
    expect(pids).toHaveLength(2);
    return { app, child: app.process(), page, root, pids };
  } catch (cause) {
    await closeDesktopFixture(app, root, cause instanceof Error ? cause : Error(String(cause)));
    throw cause;
  }
}

async function closeWindow(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0]!.close()); });
}

async function expectExited(child: ChildProcess, root: string, pids: number[]) {
  await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 10_000 }).toBe(true);
  for (const pid of pids) await expect.poll(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }).toBe(true);
  const db = new Database(join(root, 'data/app.sqlite'), { readonly: true });
  try {
    expect(db.query('SELECT title FROM sessions').all()).toEqual([{ title: 'Saved before closing' }]);
    expect(db.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
  } finally { db.close(); }
}

for (const crashed of [false, true]) test(`window close exits with an idle Worker${crashed ? ' after the Host has crashed' : ''}`, async () => {
  const { app, child, root, pids } = await launch();
  let failure: Error | undefined;
  try {
    if (crashed) await app.evaluate(async (_electron, ownedRoot) => {
      const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
      const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
        && value.spawnargs.includes(ownedRoot)) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
      if (!child) throw Error('Owned Host missing');
      await new Promise<void>(done => { child.once('exit', () => done()); child.kill(); });
    }, root);
    await closeWindow(app);
    await expectExited(child, root, pids);
    expect(child.exitCode).toBe(0);
  } catch (cause) { failure = cause instanceof Error ? cause : Error(String(cause)); throw failure; }
  finally {
    if (child.exitCode === null && child.signalCode === null) await closeDesktopFixture(app, root, failure);
    else await app.close();
  }
});

for (const force of [false, true]) test(`failed Worker cleanup allows ${force ? 'explicit exit without orphan processes' : 'keeping the window open and retrying'}`, async () => {
  const { app, child, page, root, pids } = await launch();
  let failure: Error | undefined;
  try {
    await app.evaluate(({ dialog }, response) => {
      const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
      const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
        && value.spawnargs.some(arg => typeof arg === 'string' && /[\\/]desktop[\\/]worker\.ts$/.test(arg))) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
      if (!child) throw Error('Owned Worker missing');
      const write = child.stdin.write, showMessageBox = dialog.showMessageBox;
      child.stdin.write = new Proxy(write, { apply(target, receiver, args) {
        const command = JSON.parse(String(args[0]));
        // Keep the real Worker alive and return a mismatched shutdown response.
        if (command.type === 'shutdown') args[0] = JSON.stringify({ ...command, type: 'query_evaluation_control' }) + '\n';
        return Reflect.apply(target, receiver, args);
      } });
      const prompts: unknown[] = [];
      dialog.showMessageBox = async (...args: unknown[]) => {
        prompts.push(args.at(-1)); return { response, checkboxChecked: false };
      };
      Reflect.set(globalThis, 'closeFailureGate', { prompts, restore() { child.stdin.write = write; dialog.showMessageBox = showMessageBox; } });
    }, force ? 1 : 0);
    await closeWindow(app);
    if (!force) {
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'closeFailureGate').prompts)).toMatchObject([
        { buttons: ['Keep open', 'Exit now'], defaultId: 0, cancelId: 0 },
      ]);
      expect(page.isClosed()).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(pids[1]!, 0)).not.toThrow();
      await app.evaluate(() => Reflect.get(globalThis, 'closeFailureGate').restore());
      await closeWindow(app);
    }
    await expectExited(child, root, pids);
  } catch (cause) { failure = cause instanceof Error ? cause : Error(String(cause)); throw failure; }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      await app.evaluate(() => Reflect.get(globalThis, 'closeFailureGate')?.restore()).catch(() => {});
      await closeDesktopFixture(app, root, failure);
    } else await app.close();
  }
});
