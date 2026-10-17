import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, deferCleanup, mkdtemp, Database } from '../support/resources.ts';

test.afterEach(cleanupResources);

test('takes the desktop instance lock before starting a second product controller', async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'flowmate-single-instance-'));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = root;
  const executable = resolve('node_modules/electron/dist/electron.exe'), entry = resolve('out/main/index.js');
  const app = await electron.launch({ executablePath: executable, args: [entry], env });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready)), { timeout: 25_000 }).toBe(true);
    const second = spawn(executable, [entry], { env, windowsHide: true, stdio: 'ignore' });
    deferCleanup(() => { if (second.exitCode === null && second.signalCode === null) second.kill(); });
    const exit = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => reject(Error('Second desktop did not exit')), 10_000);
      second.once('error', error => { clearTimeout(timer); reject(error); });
      second.once('exit', code => { clearTimeout(timer); done(code); });
    });
    expect(exit).toBe(0);
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { ready: true, userDataPath: root } });
    expect(await app.windows()).toHaveLength(1);
  } catch (error) { failure = error instanceof Error ? error : Error(String(error)); throw error; }
  finally { await closeDesktopFixture(app, root, failure); }
  const database = new Database(join(root, 'data/app.sqlite'), { readonly: true });
  try { expect(database.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 }); }
  finally { database.close(); }
});
