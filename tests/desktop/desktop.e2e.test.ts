import { Database } from 'bun:sqlite';
import { _electron as electron } from 'playwright';
import { expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../support/resources.ts';

const electronPath = resolve(import.meta.dir, '../../node_modules/electron/dist/electron.exe');

it('desktop saves an encrypted model profile and persists a real controlled provider Run', async () => {
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E currently requires the Windows developer host');
  if (!existsSync(electronPath)) throw new Error('Electron runtime binary is not installed; run the Electron install script');

  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-e2e-'));
  let requestCount = 0;
  let observedAuthorization = '';
  const requestBodies: unknown[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requestCount += 1;
      observedAuthorization = request.headers.get('authorization') ?? '';
      const body = await request.json() as { model?: string };
      requestBodies.push(body);
      const events = [
        { id: 'desktop-e2e-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Desktop connection verified.' }, finish_reason: null }] },
        { id: 'desktop-e2e-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
      ];
      const stream = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.FLOWMATE_TEST_MODE = '1';
    env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [resolve(import.meta.dir, '../../out/main/index.js')],
      env,
      timeout: 30_000,
    });
    const page = await electronApp.firstWindow();
    await page.getByRole('heading', { name: 'Connect a model.' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByTestId('workspace-sidebar').waitFor({ state: 'visible' });
    await page.getByTestId('main-content').waitFor({ state: 'visible' });
    await page.getByTestId('agent-chat-panel').waitFor({ state: 'visible' });
    expect(await page.getByText('Output token budget').count()).toBe(0);
    await page.getByLabel('Display name').fill('Controlled local model');
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await page.getByLabel('Model ID').fill('desktop-controlled-model');
    await page.getByLabel('API protocol').selectOption('openai-completions');
    await page.getByLabel(/API Key/).fill('synthetic-desktop-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Configuration saved'), null, { timeout: 10_000 });
    expect(requestCount).toBe(0);

    await page.getByRole('textbox', { name: 'Message to model' }).fill('First independent desktop chat request.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Desktop connection verified.' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Second independent desktop chat request.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.waitForFunction(() => {
      const turns = [...document.querySelectorAll('[data-testid="chat-turn"]')];
      return turns.length === 2 && turns.at(-1)?.querySelector('.chat-assistant-message')?.textContent?.includes('Desktop connection verified.');
    }, null, { timeout: 20_000 });
    expect(requestCount).toBe(2);
    expect(JSON.stringify(requestBodies[0])).toContain('First independent desktop chat request.');
    expect(JSON.stringify(requestBodies[1])).toContain('Second independent desktop chat request.');
    expect(JSON.stringify(requestBodies[1])).not.toContain('First independent desktop chat request.');
    expect(observedAuthorization).toBe('Bearer synthetic-desktop-key');
    await page.locator('.chat-run-link').last().waitFor({ state: 'visible', timeout: 5_000 });
    const runIdText = await page.locator('.chat-run-link').last().innerText();
    const runId = Number(runIdText.match(/(\d+)$/)?.[1]);
    expect(Number.isSafeInteger(runId)).toBe(true);
    await page.getByRole('button', { name: 'Profile' }).click();
    await page.locator('.chat-run-link').last().click();
    await page.getByText('PERSISTED PROVIDER RUN', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('button', { name: 'Profile' }).click();
    await page.waitForFunction(() => document.querySelector('.desktop-shell')?.classList.contains('theme-system'));
    await page.getByLabel('Appearance').selectOption('dark');
    await page.waitForFunction(() => document.querySelector('.desktop-shell')?.classList.contains('theme-dark'), null, { timeout: 2_000 });
    expect(await page.locator('.workspace').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(11, 13, 18)');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Profile preferences saved'), null, { timeout: 10_000 });
    expect(await page.getByText('Flowmate 0.1.0', { exact: true }).count()).toBe(1);

    await electronApp.close();
    electronApp = null;
    const databaseFile = join(userData, 'data', 'app.sqlite');
    const settingsFile = join(userData, 'data', 'settings.json');
    expect(existsSync(databaseFile)).toBe(true);
    const settingsText = readFileSync(settingsFile, 'utf8');
    expect(settingsText).not.toContain('synthetic-desktop-key');
    expect(JSON.parse(settingsText).profile.theme).toBe('dark');
    const database = new Database(databaseFile, { readonly: true });
    try {
      const row = database.query('SELECT id, status, output_json FROM runs WHERE id=?').get(runId) as { id: number; status: string; output_json: string } | null;
      expect(row?.status).toBe('completed');
      expect(row?.output_json).toContain('Desktop connection verified.');
    } finally { database.close(); }
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    server.stop(true);
  }
});
