import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { closeDesktopFixture, Database } from '../support/resources.ts';

const executable = process.env.FLOWMATE_P17_INSTALLED_EXECUTABLE;
test('explicit installed executable uses standard data and preserves a session across normal exit', async () => {
  test.skip(!executable, 'Requires an explicitly installed executable in a dedicated Windows account or VM.');
  test.setTimeout(90_000);
  if (!executable || process.platform !== 'win32' || !isAbsolute(executable) || basename(executable) !== 'Flowmate.exe'
    || !existsSync(executable) || !process.env.APPDATA || !process.env.SystemRoot) throw Error('Installed Windows target is unavailable');
  const root = join(process.env.APPDATA, 'Flowmate'), program = dirname(executable);
  // The cold-install check must never open an existing account's business database.
  if (existsSync(join(root, 'data/app.sqlite'))) throw Error('Cold-install acceptance requires a fresh dedicated account data root');
  const env: Record<string, string> = { PATH: join(process.env.SystemRoot, 'System32') };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  const launch = () => electron.launch({ executablePath: executable, args: [], env });
  let app: ElectronApplication | null = await launch(), failure: Error | undefined;
  try {
    expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, root: app.getPath('userData') })))
      .toEqual({ packaged: true, root });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready)), { timeout: 25_000 }).toBe(true);
    expect(await page.evaluate(() => window.flowmate.queryDiagnostics())).toMatchObject({ ok: true,
      data: { host: { availability: 'available' }, runtime: { bunVersion: '1.4.4', sdkVersion: '1.4.0' }, configuration: { credential: 'missing' } } });
    expect(await page.evaluate(() => window.flowmate.queryEvaluationCatalog({ view: 'list' })))
      .toMatchObject({ ok: true, data: { items: [] } });
    const session = await page.evaluate(() => window.flowmate.createSession({ title: 'P17 installed acceptance' }));
    expect(session.ok).toBe(true); if (!session.ok) throw Error('Installed Session creation failed');
    expect(existsSync(join(program, 'data/app.sqlite'))).toBe(false);
    await closeDesktopFixture(app, root); app = await launch();
    const reopened = await app.firstWindow();
    await expect.poll(() => reopened.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready)), { timeout: 25_000 }).toBe(true);
    const sessions = await reopened.evaluate(() => window.flowmate.listSessions({}));
    expect(sessions.ok && sessions.data.items.some(item => item.sessionId === session.data.sessionId)).toBe(true);
    const release = JSON.parse(readFileSync(join(program, 'resources/flowmate-runtime/release.json'), 'utf8'));
    expect(JSON.parse(readFileSync(join(root, 'data/installed-release.json'), 'utf8')).releaseId).toBe(release.releaseId);
  } catch (error) { failure = error instanceof Error ? error : Error(String(error)); throw error; }
  finally { if (app) await closeDesktopFixture(app, root, failure); }
  const database = new Database(join(root, 'data/app.sqlite'), { readonly: true });
  try { expect(database.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 }); }
  finally { database.close(); }
});
