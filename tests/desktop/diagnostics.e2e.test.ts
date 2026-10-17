import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, installReadGate, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);

test('safe partial diagnostics, explicit export and Host recheck preserve the original saved Run', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p17-diagnostics-')), destination = join(root, 'diagnostics.json');
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = root;
  let calls = 0;
  const server = await createHttpProvider(() => {
    calls++;
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p17-diagnostics',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'P17 saved diagnostic engineering answer.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  const launch = () => electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('out/main/index.js')], env });
  let app: ElectronApplication | null = await launch(), failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready)), { timeout: 25_000 }).toBe(true);
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p17-diagnostics', credentialRef: 'p17diagnostics00000000000000000001',
        name: 'P17 engineering', kind: 'custom', providerId: null, baseUrl, model: 'p17-synthetic', api: 'openai-completions',
        contextWindow: 64000, maxTokens: 16384, reasoning: false }], defaultModelId: 'p17-diagnostics' },
        { modelId: 'p17-diagnostics', apiKey: 'synthetic-p17-diagnostics-private-key' });
    }, `http://127.0.0.1:${server.port}/v1`)).toMatchObject({ ok: true });
    const accepted = await page.evaluate(async () => {
      const session = await window.flowmate.createSession({}); if (!session.ok) return session;
      return window.flowmate.submitInput({ mode: 'prompt', sessionId: session.data.sessionId, clientSequence: 1, modelId: 'p17-diagnostics',
        text: 'P17-PRIVATE-PROMPT must never appear in diagnostics.' });
    });
    expect(accepted.ok).toBe(true); if (!accepted.ok || !('runId' in accepted.data)) throw Error('Engineering Run not accepted');
    const runId = accepted.data.runId;
    await expect.poll(() => page.evaluate(id => window.flowmate.queryRun(id).then(value => value.ok ? value.data.status : value.error.code), runId), { timeout: 20_000 }).toBe('completed');
    const first = await page.evaluate(() => window.flowmate.queryDiagnostics());
    expect(first).toMatchObject({ ok: true, data: { host: { availability: 'available' }, configuration: { modelId: 'p17-diagnostics', credential: 'configured' } } });
    for (const value of [root, 'P17-PRIVATE-PROMPT', 'synthetic-p17-diagnostics-private-key']) expect(JSON.stringify(first)).not.toContain(value);
    expect(await page.evaluate(() => Reflect.apply(window.flowmate.queryDiagnostics, null, [{ path: 'forbidden' }]))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await page.evaluate(() => Reflect.apply(window.flowmate.exportDiagnostics, null, [{ path: 'forbidden' }]))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await page.evaluate(() => Reflect.apply(window.flowmate.restartHost, null, [{ executable: 'forbidden' }]))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await page.evaluate(() => window.flowmate.restartHost())).toMatchObject({ ok: false, error: { code: 'host_still_running' } });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.locator('.diagnostics-panel > summary').click();
    const refresh = page.getByRole('button', { name: 'Refresh diagnostics', exact: true });
    await refresh.focus(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('installation-diagnostics')).toContainText('Host diagnostics: available');
    await page.setViewportSize({ width: 800, height: 700 });
    expect(await page.getByTestId('installation-diagnostics').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Export diagnostics JSON', exact: true })).toBeInViewport();
    await installReadGate(app, root);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_diagnostics'));
    const started = Date.now(), timeout = await page.evaluate(() => window.flowmate.queryDiagnostics());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(timeout).toMatchObject({ ok: true, data: { host: { availability: 'timeout' }, gaps: ['host_query_timeout'] } });
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
    expect(await page.evaluate(() => window.flowmate.exportDiagnostics())).toEqual({ ok: true, data: { outcome: 'cancelled' } });
    expect(existsSync(destination)).toBe(false);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, join(root, 'missing-parent/diagnostics.json'));
    expect(await page.evaluate(() => window.flowmate.exportDiagnostics())).toMatchObject({ ok: false, error: { code: 'diagnostics_export_failed' } });
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    expect(await page.evaluate(() => window.flowmate.exportDiagnostics())).toEqual({ ok: true, data: { outcome: 'saved' } });
    const exported = readFileSync(destination, 'utf8');
    for (const value of [root, 'P17-PRIVATE-PROMPT', 'synthetic-p17-diagnostics-private-key']) expect(exported).not.toContain(value);
    await app.evaluate(({ safeStorage }) => {
      const original = safeStorage.isAsyncEncryptionAvailable;
      const gate: { held: boolean; release?: () => void } = { held: false };
      const pending = new Promise<void>(resolve => { gate.release = resolve; });
      Reflect.set(globalThis, 'diagnosticsCredentialGate', gate);
      safeStorage.isAsyncEncryptionAvailable = async () => {
        safeStorage.isAsyncEncryptionAvailable = original; gate.held = true;
        await pending; return original.call(safeStorage);
      };
    });
    await page.evaluate(() => { Reflect.set(window, 'pendingDiagnostics', window.flowmate.queryDiagnostics()); });
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'diagnosticsCredentialGate').held)).toBe(true);
    await app.evaluate(async (_electron, ownedRoot) => {
      const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
      const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
        && value.spawnargs.includes(ownedRoot)) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
      if (!child) throw Error('Owned Host missing');
      await new Promise<void>(done => { child.once('exit', () => done()); child.kill(); });
    }, root);
    expect(await page.evaluate(() => window.flowmate.queryDiagnostics())).toMatchObject({ ok: true, data: { host: { availability: 'source-unavailable' } } });
    const immediate = await page.evaluate(() => window.flowmate.restartHost());
    expect(immediate.ok).toBe(false);
    await expect.poll(() => page.evaluate(() => window.flowmate.queryDiagnostics().then(value => value.ok ? value.data.host.stderrTail : ''))).toContain('runtime_already_owned');
    await app.evaluate(() => Reflect.get(globalThis, 'diagnosticsCredentialGate').release());
    const late = await page.evaluate(() => Reflect.get(window, 'pendingDiagnostics'));
    const unavailable = await page.evaluate(() => window.flowmate.queryDiagnostics());
    // Exercise the existing lease's real stale policy; do not edit or remove its lock.
    await expect.poll(() => Date.now() - statSync(join(root, 'data/app.sqlite.lock')).mtimeMs,
      { timeout: 18_000, intervals: [250] }).toBeGreaterThan(15_100);
    const recheck = page.getByRole('button', { name: 'Recheck Host', exact: true });
    await expect(recheck).toBeEnabled(); await recheck.focus(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('installation-diagnostics')).toContainText('Host diagnostics: available');
    await expect.poll(() => page.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready))).toBe(true);
    expect(late).toMatchObject({ ok: true, data: { host: { availability: 'source-unavailable' },
      configuration: { modelId: null, credential: 'unavailable' }, gaps: expect.arrayContaining(['host_connection_changed', 'model_configuration_unavailable']) } });
    expect(unavailable).toMatchObject({ ok: true, data: {
      configuration: { modelId: null, credential: 'unavailable' }, gaps: expect.arrayContaining(['model_configuration_unavailable']) } });
    expect(await page.evaluate(id => window.flowmate.queryRun(id), runId)).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(calls).toBe(1);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('flowmate:query-diagnostics');
      ipcMain.handle('flowmate:query-diagnostics', () => ({ ok: true, data: { path: 'forged-private-path' } }));
      ipcMain.removeHandler('flowmate:export-diagnostics');
      ipcMain.handle('flowmate:export-diagnostics', () => ({ ok: true, data: { outcome: 'saved', path: 'forged-private-path' } }));
    });
    expect(await page.evaluate(() => window.flowmate.queryDiagnostics())).toMatchObject({ ok: false, error: { code: 'diagnostics_unavailable' } });
    expect(await page.evaluate(() => window.flowmate.exportDiagnostics())).toMatchObject({ ok: false, error: { code: 'diagnostics_export_failed' } });
    await closeDesktopFixture(app, root); app = await launch();
    const reopened = await app.firstWindow();
    await expect.poll(() => reopened.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready)), { timeout: 25_000 }).toBe(true);
    const clean = await reopened.evaluate(() => window.flowmate.queryDiagnostics());
    expect(clean.ok).toBe(true); expect(JSON.stringify(clean)).not.toContain('host_recheck_started');
    expect(await reopened.evaluate(id => window.flowmate.queryRun(id), runId)).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(calls).toBe(1);
  } catch (error) { failure = error instanceof Error ? error : Error(String(error)); throw error; }
  finally { try { if (app) await closeDesktopFixture(app, root, failure); } finally { await server.stop(); } }
  const database = new Database(join(root, 'data/app.sqlite'), { readonly: true });
  try { expect(database.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 }); }
  finally { database.close(); }
});

test('diagnostics export rejects navigation while its final collection is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p17-diagnostic-owner-')), destination = join(root, 'late-owner.json');
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = root;
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('out/main/index.js')], env });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.flowmate.getState().then(value => value.ok && value.data.ready)), { timeout: 25_000 }).toBe(true);
    await installReadGate(app, root);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => {
        Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_diagnostics');
        return { canceled: false, filePath };
      };
    }, destination);
    const pending = page.evaluate(() => window.flowmate.exportDiagnostics()).catch(() => null);
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    const original = page.url(); await page.goto('about:blank');
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await pending; await page.goto(original);
    expect(existsSync(destination)).toBe(false);
  } catch (error) { failure = error instanceof Error ? error : Error(String(error)); throw error; }
  finally { await closeDesktopFixture(app, root, failure); }
});
