import { Database } from 'bun:sqlite';
import { _electron as electron } from 'playwright';
import { expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../support/resources.ts';

const electronPath = resolve(import.meta.dir, '../../node_modules/electron/dist/electron.exe');

async function waitForCompletedTurn(page: import('playwright').Page, marker: string): Promise<void> {
  await page.locator('[data-testid="chat-turn"]').filter({ hasText: marker })
    .locator('.chat-assistant-message.completed').waitFor({ state: 'visible', timeout: 20_000 });
}

it('desktop shares models across isolated Agent Sessions and keeps an Agent Session across model changes', async () => {
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E currently requires the Windows developer host');
  if (!existsSync(electronPath)) throw new Error('Electron runtime binary is not installed; run the Electron install script');

  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-e2e-'));
  let requestCount = 0;
  const observedAuthorizations: string[] = [];
  const requestBodies: unknown[] = [];
  const activeRunMarker = 'Session A active Run model snapshot.';
  let signalActiveRequest!: () => void;
  const activeRequestStarted = new Promise<void>((resolve) => { signalActiveRequest = resolve; });
  let releaseActiveResponse!: () => void;
  const activeResponseGate = new Promise<void>((resolve) => { releaseActiveResponse = resolve; });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requestCount += 1;
      observedAuthorizations.push(request.headers.get('authorization') ?? '');
      const body = await request.json() as { model?: string; messages?: Array<{ content?: unknown }> };
      requestBodies.push(body);
      if (JSON.stringify(body).includes(activeRunMarker)) {
        signalActiveRequest();
        await activeResponseGate;
      }
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

    const sessionPicker = page.getByLabel('Chat session');
    const originalModelId = await page.getByLabel('Model for next Run').inputValue();
    const sessionA = await sessionPicker.inputValue();
    await page.getByRole('textbox', { name: 'Message to model' }).fill('First independent desktop chat request.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await waitForCompletedTurn(page, 'First independent desktop chat request.');
    await page.getByRole('button', { name: /New/ }).click();
    expect(requestCount).toBe(1);
    await page.waitForFunction((previous) => document.querySelector<HTMLSelectElement>('[aria-label="Chat session"]')?.value !== previous, sessionA, { timeout: 10_000 });
    const sessionB = await sessionPicker.inputValue();
    expect(sessionB).not.toBe(sessionA);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Session B only context marker.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await waitForCompletedTurn(page, 'Session B only context marker.');
    await sessionPicker.selectOption(sessionA);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Session A follow-up marker.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await waitForCompletedTurn(page, 'Session A follow-up marker.');
    expect(requestCount).toBe(3);
    expect(JSON.stringify(requestBodies[0])).toContain('First independent desktop chat request.');
    expect(JSON.stringify(requestBodies[1])).toContain('Session B only context marker.');
    expect(JSON.stringify(requestBodies[1])).not.toContain('First independent desktop chat request.');
    expect(JSON.stringify(requestBodies[2])).toContain('First independent desktop chat request.');
    expect(JSON.stringify(requestBodies[2])).toContain('Session A follow-up marker.');
    expect(JSON.stringify(requestBodies[2])).not.toContain('Session B only context marker.');
    expect(requestBodies.map((value) => (value as { messages: Array<{ role: string }> }).messages.filter((message) => message.role !== 'system').length)).toEqual([1, 1, 3]);
    expect(observedAuthorizations).toEqual(['Bearer synthetic-desktop-key', 'Bearer synthetic-desktop-key', 'Bearer synthetic-desktop-key']);

    await page.getByLabel('Model ID').fill('desktop-controlled-model-updated');
    await page.getByLabel(/API Key/).fill('synthetic-desktop-key-updated');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Configuration saved'), null, { timeout: 10_000 });
    expect(requestCount).toBe(3);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Session A after model config edit.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await waitForCompletedTurn(page, 'Session A after model config edit.');
    expect(requestCount).toBe(4);
    expect((requestBodies[3] as { model: string }).model).toBe('desktop-controlled-model-updated');
    expect(observedAuthorizations[3]).toBe('Bearer synthetic-desktop-key-updated');
    expect(JSON.stringify(requestBodies[3])).toContain('First independent desktop chat request.');
    expect(JSON.stringify(requestBodies[3])).toContain('Session A follow-up marker.');
    expect(JSON.stringify(requestBodies[3])).not.toContain('Session B only context marker.');

    await sessionPicker.selectOption(sessionB);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Session B after model config edit.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await waitForCompletedTurn(page, 'Session B after model config edit.');
    expect(requestCount).toBe(5);
    expect(JSON.stringify(requestBodies[4])).toContain('Session B only context marker.');
    expect(JSON.stringify(requestBodies[4])).toContain('Session B after model config edit.');
    expect(JSON.stringify(requestBodies[4])).not.toContain('First independent desktop chat request.');
    expect(observedAuthorizations[4]).toBe('Bearer synthetic-desktop-key-updated');

    await sessionPicker.selectOption(sessionA);
    await page.getByRole('button', { name: '＋ Add' }).click();
    await page.getByLabel('Display name').fill('Second model route');
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v2`);
    await page.getByLabel('Model ID').fill('desktop-controlled-model-2');
    await page.getByLabel('API protocol').selectOption('openai-completions');
    await page.getByLabel(/API Key/).fill('synthetic-desktop-key-2');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Configuration saved'), null, { timeout: 10_000 });
    expect(requestCount).toBe(5);
    await page.getByRole('textbox', { name: 'Message to model' }).fill(activeRunMarker);
    await page.getByRole('button', { name: 'Send to model' }).click();
    await activeRequestStarted;
    expect(requestCount).toBe(6);
    await page.locator('.chat-run-model').filter({ hasText: 'desktop-controlled-model-2' }).waitFor({ state: 'visible' });
    await page.getByLabel('Model for next Run').selectOption(originalModelId);
    await page.getByText('The selected model will be used for the next Run.', { exact: true }).waitFor({ state: 'visible' });
    expect(await page.locator('.chat-run-model').innerText()).toContain('desktop-controlled-model-2');
    releaseActiveResponse();
    await waitForCompletedTurn(page, activeRunMarker);
    expect((requestBodies[5] as { model: string }).model).toBe('desktop-controlled-model-2');
    expect(observedAuthorizations[5]).toBe('Bearer synthetic-desktop-key-2');
    expect(JSON.stringify(requestBodies[5])).toContain('Session A after model config edit.');
    expect(JSON.stringify(requestBodies[5])).not.toContain('Session B only context marker.');
    const activeRunText = await page.locator('[data-testid="chat-turn"]').filter({ hasText: activeRunMarker }).locator('.chat-run-link').innerText();
    const activeRunId = Number(activeRunText.match(/(\d+)$/)?.[1]);
    expect(Number.isSafeInteger(activeRunId)).toBe(true);

    await page.getByRole('textbox', { name: 'Message to model' }).fill('Session A next Run uses selected model.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await waitForCompletedTurn(page, 'Session A next Run uses selected model.');
    expect(requestCount).toBe(7);
    expect((requestBodies[6] as { model: string }).model).toBe('desktop-controlled-model-updated');
    expect((requestBodies[6] as { messages: Array<{ role: string }> }).messages.filter((message) => message.role !== 'system')).toHaveLength(9);
    expect(JSON.stringify(requestBodies[6])).toContain(activeRunMarker);
    expect(JSON.stringify(requestBodies[6])).not.toContain('Session B only context marker.');
    expect(observedAuthorizations[6]).toBe('Bearer synthetic-desktop-key-updated');
    expect(JSON.stringify(requestBodies[5])).toContain('First independent desktop chat request.');
    expect(JSON.stringify(requestBodies[5])).not.toContain('Session B after model config edit.');
    await page.locator('.chat-run-link').last().waitFor({ state: 'visible', timeout: 5_000 });
    const runIdText = await page.locator('.chat-run-link').last().innerText();
    const runId = Number(runIdText.match(/(\d+)$/)?.[1]);
    expect(Number.isSafeInteger(runId)).toBe(true);
    await page.getByRole('button', { name: 'Profile' }).click();
    await page.locator('.chat-run-link').last().click();
    await page.getByText('PERSISTED AGENT RUN', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
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
      const row = database.query('SELECT id, kind, session_id, status, config_json, output_json FROM runs WHERE id=?').get(runId) as { id: number; kind: string; session_id: number; status: string; config_json: string; output_json: string } | null;
      expect(row?.status).toBe('completed');
      expect(row?.kind).toBe('agent');
      expect(row?.session_id).toBe(Number(sessionA));
      expect(row?.config_json).toContain('desktop-controlled-model-updated');
      const activeRow = database.query('SELECT config_json FROM runs WHERE id=?').get(activeRunId) as { config_json: string } | null;
      expect(activeRow?.config_json).toContain('desktop-controlled-model-2');
      expect(row?.output_json).toContain('Desktop connection verified.');
      expect(database.query('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 2 });
      expect(database.query("SELECT COUNT(*) AS count FROM runs WHERE kind='agent' AND status='completed'").get()).toEqual({ count: 7 });
    } finally { database.close(); }

    const restartEnv: Record<string, string> = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
      if (process.env[name]) restartEnv[name] = process.env[name];
    }
    restartEnv.FLOWMATE_TEST_MODE = '1';
    restartEnv.FLOWMATE_TEST_USER_DATA_ROOT = userData;
    electronApp = await electron.launch({ executablePath: electronPath, args: [resolve(import.meta.dir, '../../out/main/index.js')], env: restartEnv, timeout: 30_000 });
    const reopened = await electronApp.firstWindow();
    await reopened.getByTestId('agent-chat-panel').waitFor({ state: 'visible' });
    await reopened.getByText("This session's conversation history is unavailable after restart. Create a new session to continue.", { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await reopened.getByRole('button', { name: /New/ }).click();
    expect(requestCount).toBe(7);
    await reopened.getByRole('textbox', { name: 'Message to model' }).fill('New process session message.');
    expect(await reopened.getByRole('textbox', { name: 'Message to model' }).isEnabled()).toBe(true);
    await electronApp.close();
    electronApp = null;
  } finally {
    releaseActiveResponse();
    if (electronApp) await electronApp.close().catch(() => undefined);
    server.stop(true);
  }
});
