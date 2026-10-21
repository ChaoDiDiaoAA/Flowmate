import { expect, test as it } from '@playwright/test';
import { chromium, type Browser } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanupResources, Database, mkdtemp } from '../support/resources.ts';

it.afterEach(cleanupResources);

it('dev rebuilds Main and Preload only after stopping the real Host, and SIGINT closes its owned resources', async () => {
  it.setTimeout(90_000);
  const repo = resolve(import.meta.dirname, '../..');
  const root = await mkdtemp(join(tmpdir(), 'flowmate-dev-e2e-'));
  for (const path of ['apps', 'packages', 'scripts', 'agent-eval/src', 'package.json', 'electron.vite.config.ts']) {
    cpSync(join(repo, path), join(root, path), { recursive: true });
  }
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
  const mainFile = join(root, 'apps/desktop/main/index.ts');
  const preloadFile = join(root, 'apps/desktop/preload/index.ts');
  const mainSource = `${readFileSync(mainFile, 'utf8')}\napp.on('browser-window-created', (_event, window) => {\n  window.once('ready-to-show', () => setTimeout(() => console.log('[Flowmate test window] ' + JSON.stringify({ visible: window.isVisible() })), 100));\n});\n`;
  const preloadSource = readFileSync(preloadFile, 'utf8');
  writeFileSync(mainFile, `${mainSource}\nconst = ;\n`);
  writeFileSync(preloadFile, `${preloadSource}\nconst = ;\n`);
  writeFileSync(join(root, 'dev-driver.ts'), "import { runDev } from './scripts/dev.ts';\nprocess.on('message', value => { if (value === 'test-sigint') { process.emit('SIGINT'); process.emit('SIGINT'); } });\nawait runDev();\n");
  const reserved = createServer();
  reserved.listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  const address = reserved.address();
  if (!address || typeof address === 'string') throw new Error('Debugger fixture has no port');
  await new Promise<void>((resolveClosed) => reserved.close(() => resolveClosed()));
  let requests = 0;
  let disconnected = 0;
  const provider = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests += 1;
      response.on('close', () => { disconnected += 1; });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'dev-held', choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial' }, finish_reason: null }] })}\n\n`);
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('Provider fixture has no port');
  const userData = join(root, 'user-data');
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  Object.assign(env, { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData, REMOTE_DEBUGGING_PORT: String(address.port) });
  const child = spawn('node', ['--import', 'tsx', 'dev-driver.ts'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (condition()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Dev exited unexpectedly: ${output}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    throw new Error(`Dev condition was not reached: ${output}`);
  };
  const readyPids = () => [...output.matchAll(/\[Flowmate dev\] Ready (\d+)/g)].map((match) => Number(match[1]));
  const browserRef: { current: Browser | null } = { current: null };
  let rendererUrl = '';
  const connect = async () => {
    browserRef.current = await chromium.connectOverCDP(`http://127.0.0.1:${address.port}`);
    const page = browserRef.current.contexts()[0]!.pages()[0]!;
    await expect(page.getByRole('main', { name: 'Assistant', exact: true })).toBeVisible();
    const input = page.getByRole('textbox', { name: 'Message to model', exact: true });
    await input.click(); await expect(input).toBeFocused();
    await input.press('ControlOrMeta+A'); await input.press('Backspace');
    await input.pressSequentially('Dev home keyboard draft.');
    await expect(input).toHaveValue('Dev home keyboard draft.');
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    rendererUrl = new URL(page.url()).origin;
    return page;
  };
  const assertStopped = (runId: number) => {
    expect(existsSync(join(userData, 'data', 'app.sqlite.lock'))).toBe(false);
    const db = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
    try {
      const row = db.query('SELECT status,error_json,cleanup_json,stopped_at FROM runs WHERE id=?').get(runId) as {
        status: string; error_json: string; cleanup_json: string; stopped_at: string | null;
      };
      expect(row.status).toBe('failed');
      expect(JSON.parse(row.error_json)).toMatchObject({ code: 'runtime_shutdown' });
      expect(JSON.parse(row.cleanup_json)).toMatchObject({ stopped: true, errors: [], lateObservationRequired: false });
      expect(row.stopped_at).not.toBeNull();
    } finally { db.close(); }
  };
  try {
    await waitFor(() => output.includes('main build failed') && output.includes('preload build failed'));
    expect(readyPids()).toHaveLength(0);
    expect(existsSync(join(userData, 'data', 'app.sqlite'))).toBe(false);
    writeFileSync(mainFile, mainSource);
    await waitFor(() => output.includes('out/main/'));
    expect(readyPids()).toHaveLength(0);
    writeFileSync(preloadFile, preloadSource);
    await waitFor(() => readyPids().length === 1);
    let page = await connect();
    await waitFor(() => output.includes('[Flowmate test window]'));
    expect(output).toContain('[Flowmate test window] {"visible":true}');
    expect(requests).toBe(0);
    await page.locator('.rail').getByRole('button', { name: 'Settings', exact: true }).click();
    const theme = page.getByLabel('Theme');
    await theme.click();
    await page.waitForFunction(() => document.querySelector('.settings-appearance select')?.matches(':open'), undefined, { timeout: 3000 });
    await theme.getByRole('option', { name: 'Dark', exact: true }).click({ timeout: 3000 });
    expect(await theme.inputValue()).toBe('dark');
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await page.getByText('Profile preferences saved.', { exact: true }).waitFor();
    await theme.click();
    await page.waitForFunction(() => document.querySelector('.settings-appearance select')?.matches(':open'), undefined, { timeout: 3000 });
    expect(await theme.getByRole('option', { name: 'Light', exact: true }).isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(async (port) => {
      const state = await window.flowmate.getState();
      if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, defaultModelId: 'dev-model', models: [{
        id: 'dev-model', credentialRef: '00000000000000000000000000000011', name: 'Dev model', kind: 'custom', providerId: null,
        baseUrl: `http://127.0.0.1:${port}/v1`, model: 'dev-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false,
      }] }, { modelId: 'dev-model', apiKey: 'synthetic-dev-key' });
    }, providerAddress.port)).toMatchObject({ ok: true });
    for (const [index, path] of ['apps/desktop/main/index.ts', 'apps/desktop/preload/index.ts'].entries()) {
      const accepted = await page.evaluate(() => window.flowmate.callProvider({ modelId: 'dev-model', goal: 'Hold for rebuild', text: 'Wait.' }));
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) throw new Error('Provider was not accepted');
      await waitFor(() => requests === index + 1);
      const file = join(root, path);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n// Controlled rebuild ${index}\n`);
      await waitFor(() => disconnected === index + 1);
      await waitFor(() => readyPids().length === index + 2);
      expect(new Set(readyPids()).size).toBe(index + 2);
      // The new Host owns the lock again; query the original durable result through it.
      await browserRef.current?.close();
      page = await connect();
      expect(await page.evaluate((runId) => window.flowmate.queryRun(runId), accepted.data.runId))
        .toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'runtime_shutdown' }, cleanup: { stopped: true } } });
      expect(requests).toBe(index + 1);
    }
    const healthyMain = readFileSync(mainFile, 'utf8');
    writeFileSync(mainFile, `${healthyMain}\nconst = ;\n`);
    await waitFor(() => output.split('main build failed').length === 3);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    expect(readyPids()).toHaveLength(3);
    expect(requests).toBe(2);
    writeFileSync(mainFile, healthyMain);
    await waitFor(() => readyPids().length === 4);
    await browserRef.current?.close();
    page = await connect();
    const accepted = await page.evaluate(() => window.flowmate.callProvider({ modelId: 'dev-model', goal: 'Hold for SIGINT', text: 'Wait.' }));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('Provider was not accepted');
    await waitFor(() => requests === 3);
    child.send('test-sigint'); // Exercise the registered SIGINT handler; Windows kill(SIGINT) is a crash.
    const [code, signal] = await exited;
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(disconnected).toBe(3);
    assertStopped(accepted.data.runId);
    expect(requests).toBe(3);
    await expect(fetch(rendererUrl)).rejects.toThrow();
  } finally {
    await browserRef.current?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin!.end();
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    }
    provider.closeAllConnections();
    await new Promise<void>(resolveClosed => provider.close(() => resolveClosed()));
  }
});
