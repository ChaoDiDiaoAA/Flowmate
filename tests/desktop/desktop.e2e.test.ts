import { Database } from 'bun:sqlite';
import { _electron as electron } from 'playwright';
import { expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../support/resources.ts';

const electronPath = resolve(import.meta.dir, '../../node_modules/electron/dist/electron.exe');

it('desktop creates an Agent Session without a request, continues its in-process history and explains restart limits', async () => {
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
      const serialized = JSON.stringify(body);
      if (serialized.includes('hold for Stop while another Session is selected')) return new Promise<Response>(() => {});
      const content = serialized.includes('B_SESSION_ONLY') ? 'B session isolated response.' : 'Desktop connection verified.';
      const events = [
        { id: 'desktop-e2e-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
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
    await page.getByRole('button', { name: /New/ }).click();
    await page.getByRole('combobox', { name: 'Session' }).selectOption({ index: 1 });
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestCount).toBe(0);
    await page.locator('.chat-session-actions summary').click();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Session title' }).fill('A invoice session');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#agent-session-select option').filter({ hasText: 'A invoice session' }).waitFor({ state: 'attached', timeout: 10_000 });
    expect(requestCount).toBe(0);
    await page.getByLabel('Display name').fill('Controlled local model');
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await page.getByLabel('Model ID').fill('desktop-controlled-model');
    await page.getByLabel('API protocol').selectOption('openai-completions');
    await page.getByLabel(/API Key/).fill('synthetic-desktop-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Configuration saved'), null, { timeout: 10_000 });
    expect(requestCount).toBe(0);
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestCount).toBe(0);

    await page.getByRole('textbox', { name: 'Message to model' }).fill('Invoice summary: INV-2048, total 1060 CNY, issue date missing.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Desktop connection verified.' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('textbox', { name: 'Message to model' }).fill('What was the total on that invoice?');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.waitForFunction(() => {
      const turns = [...document.querySelectorAll('[data-testid="chat-turn"]')];
      return turns.length === 2 && turns.at(-1)?.querySelector('.chat-assistant-message')?.textContent?.includes('Desktop connection verified.');
    }, null, { timeout: 20_000 });
    expect(requestCount).toBe(2);
    expect(JSON.stringify(requestBodies[0])).toContain('Invoice summary: INV-2048');
    expect(JSON.stringify(requestBodies[1])).toContain('What was the total on that invoice?');
    expect(JSON.stringify(requestBodies[1])).toContain('Invoice summary: INV-2048');
    expect(JSON.stringify(requestBodies[1])).toContain('Desktop connection verified.');
    expect(requestBodies.every((body) => ((body as { tools?: unknown[] }).tools ?? []).length === 0)).toBe(true);
    expect(observedAuthorization).toBe('Bearer synthetic-desktop-key');

    const sessionSelect = page.getByRole('combobox', { name: 'Session' });
    const firstSessionId = Number(await sessionSelect.inputValue());
    await page.reload();
    await page.getByTestId('agent-chat-panel').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction((id) => {
      const selector = document.querySelector('select[aria-label="Session"]');
      return selector instanceof HTMLSelectElement && selector.value === String(id)
        && document.querySelectorAll('[data-testid="chat-turn"]').length === 2;
    }, firstSessionId, { timeout: 20_000 });
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('#agent-session-select option').filter({ hasText: 'A invoice session' }).waitFor({ state: 'attached', timeout: 10_000 });
    expect(requestCount).toBe(2);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Does the summary say when it was issued?');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.waitForFunction(() => {
      const turns = [...document.querySelectorAll('[data-testid="chat-turn"]')];
      return turns.length === 3 && turns.at(-1)?.querySelector('.chat-assistant-message')?.textContent?.includes('Desktop connection verified.');
    }, null, { timeout: 20_000 });
    expect(requestCount).toBe(3);
    expect(JSON.stringify(requestBodies[2])).toContain('Invoice summary: INV-2048');
    expect(JSON.stringify(requestBodies[2])).toContain('What was the total on that invoice?');
    expect(JSON.stringify(requestBodies[2])).toContain('Does the summary say when it was issued?');
    expect(JSON.stringify(requestBodies[2])).toContain('Desktop connection verified.');

    await page.getByRole('button', { name: /New/ }).click();
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    expect(await composer.isDisabled()).toBe(false);
    expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.type('B_SESSION_ONLY: a different invoice INV-B-77.');
    expect(await composer.inputValue()).toBe('B_SESSION_ONLY: a different invoice INV-B-77.');
    await page.waitForFunction((firstId) => {
      const selector = document.querySelector('select[aria-label="Session"]');
      return selector instanceof HTMLSelectElement && selector.value !== String(firstId);
    }, firstSessionId, { timeout: 10_000 });
    const secondSessionId = Number(await sessionSelect.inputValue());
    expect(secondSessionId).not.toBe(firstSessionId);
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'B session isolated response.' }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(requestCount).toBe(4);
    expect(JSON.stringify(requestBodies[3])).toContain('B_SESSION_ONLY');
    expect(JSON.stringify(requestBodies[3])).not.toContain('INV-2048');
    expect(JSON.stringify(requestBodies[3])).not.toContain('Desktop connection verified.');
    await page.getByRole('textbox', { name: 'Message to model' }).fill('B_SESSION_ONLY: follow up on the second invoice.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"]').length === 2
      && document.querySelectorAll('[data-testid="chat-turn"] .chat-assistant-message.completed').length === 2, null, { timeout: 20_000 });
    expect(requestCount).toBe(5);
    expect(JSON.stringify(requestBodies[4])).toContain('B_SESSION_ONLY: a different invoice INV-B-77.');
    expect(JSON.stringify(requestBodies[4])).toContain('B_SESSION_ONLY: follow up on the second invoice.');
    expect(JSON.stringify(requestBodies[4])).not.toContain('INV-2048');
    await sessionSelect.selectOption(String(firstSessionId));
    expect(await composer.isDisabled()).toBe(false);
    expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.type('A_SESSION_ONLY: continue after switching back.');
    expect(await composer.inputValue()).toBe('A_SESSION_ONLY: continue after switching back.');
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"]').length === 4
      && [...document.querySelectorAll('[data-testid="chat-turn"]')].at(-1)?.querySelector('.chat-assistant-message.completed'), null, { timeout: 20_000 });
    expect(requestCount).toBe(6);
    expect(JSON.stringify(requestBodies[5])).toContain('Invoice summary: INV-2048');
    expect(JSON.stringify(requestBodies[5])).not.toContain('B_SESSION_ONLY');
    await page.locator('.chat-session-actions summary').click();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    const renameInput = page.getByRole('textbox', { name: 'Session title' });
    expect(await renameInput.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('A invoice session renamed');
    expect(await renameInput.inputValue()).toBe('A invoice session renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#agent-session-select option').filter({ hasText: 'A invoice session renamed' }).waitFor({ state: 'attached', timeout: 10_000 });

    await sessionSelect.selectOption(String(secondSessionId));
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.chat-session-actions summary').click();
    const cancelDelete = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('New Session');
      expect(dialog.message()).toContain('only this Session');
      await dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Delete Session', exact: true }).click();
    await cancelDelete;
    expect(Number(await sessionSelect.inputValue())).toBe(secondSessionId);
    expect(await page.locator('[data-testid="chat-turn"]').count()).toBe(2);

    await sessionSelect.selectOption(String(firstSessionId));
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('textbox', { name: 'Message to model' }).fill('hold for Stop while another Session is selected');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.getByText('Waiting for the Agent Run to finish…', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await sessionSelect.selectOption(String(secondSessionId));
    await page.locator('.chat-session-actions summary').click();
    const deleteIdleSession = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('New Session');
      expect(dialog.message()).toContain('only this Session');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Delete Session', exact: true }).click();
    await deleteIdleSession;
    await page.waitForFunction((id) => {
      const selector = document.querySelector('select[aria-label="Session"]');
      return selector instanceof HTMLSelectElement && selector.value === String(id);
    }, firstSessionId, { timeout: 10_000 });
    await page.getByText('Waiting for the Agent Run to finish…', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestCount).toBe(7);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Run 7 continues in Session', { exact: false }).waitFor({ state: 'detached', timeout: 20_000 });
    await page.getByText('Request cancelled.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestCount).toBe(7);
    await page.locator('.chat-run-link').last().waitFor({ state: 'visible', timeout: 5_000 });
    const runIdText = await page.locator('.chat-run-link').nth(1).innerText();
    const runId = Number(runIdText.match(/(\d+)$/)?.[1]);
    expect(Number.isSafeInteger(runId)).toBe(true);
    await page.getByRole('button', { name: 'Profile' }).click();
    await page.locator('.chat-run-link').last().click();
    await page.getByText('PERSISTED AGENT RUN', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByText('TEMPORARY PROMPT TRACE', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByText('model_request', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('button', { name: 'Profile' }).click();

    await page.waitForFunction(() => document.querySelector('.desktop-shell')?.classList.contains('theme-system'));
    await page.getByLabel('Appearance').selectOption('dark');
    await page.waitForFunction(() => document.querySelector('.desktop-shell')?.classList.contains('theme-dark'), null, { timeout: 2_000 });
    expect(await page.locator('.workspace').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(11, 13, 18)');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Profile preferences saved'), null, { timeout: 10_000 });
    expect(await page.getByText('Flowmate 0.1.0', { exact: true }).count()).toBe(1);

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button').first().click();
    await page.getByLabel('Message', { exact: true }).fill('P1 diagnostic request stays independent from Agent history.');
    await page.getByRole('button', { name: /Test connection/ }).click();
    await page.getByText('PERSISTED PROVIDER RUN', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(requestCount).toBe(8);
    expect(JSON.stringify(requestBodies[7])).toContain('P1 diagnostic request stays independent');
    expect(JSON.stringify(requestBodies[7])).not.toContain('INV-2048');
    expect(JSON.stringify(requestBodies[7])).not.toContain('B_SESSION_ONLY');

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
      const row = database.query('SELECT id, kind, session_id, status, output_json FROM runs WHERE id=?').get(runId) as { id: number; kind: string; session_id: number | null; status: string; output_json: string } | null;
      expect(row).toMatchObject({ kind: 'agent', status: 'completed' });
      expect(Number.isSafeInteger(row?.session_id)).toBe(true);
      expect(row?.output_json).toContain('Desktop connection verified.');
      expect(database.query('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 1 });
      expect(database.query('SELECT title FROM sessions WHERE id=?').get(firstSessionId)).toEqual({ title: 'A invoice session renamed' });
      expect(database.query("SELECT count(*) AS count FROM runs WHERE kind='agent'").get()).toEqual({ count: 5 });
      expect(database.query("SELECT count(*) AS count FROM runs WHERE kind='provider'").get()).toEqual({ count: 1 });
    } finally { database.close(); }

    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [resolve(import.meta.dir, '../../out/main/index.js')],
      env,
      timeout: 30_000,
    });
    const restartedPage = await electronApp.firstWindow();
    await restartedPage.getByTestId('agent-chat-panel').waitFor({ state: 'visible', timeout: 20_000 });
    await restartedPage.getByText('History unavailable after restart', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await restartedPage.getByText("This session's conversation history is unavailable after restart. Create a new session to continue.", { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    expect(await restartedPage.getByRole('textbox', { name: 'Message to model' }).isDisabled()).toBe(true);
    expect(requestCount).toBe(8);
    await restartedPage.locator('.chat-run-link').last().click();
    await restartedPage.getByText('The Host process that owned this in-memory trace has exited.', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
    await restartedPage.locator('.chat-session-actions summary').click();
    const confirmDelete = restartedPage.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('A invoice session renamed');
      expect(dialog.message()).toContain('only this Session');
      await dialog.accept();
    });
    await restartedPage.getByRole('button', { name: 'Delete Session', exact: true }).click();
    await confirmDelete;
    await restartedPage.waitForFunction(() => {
      const selector = document.querySelector('select[aria-label="Session"]');
      return selector instanceof HTMLSelectElement && selector.value === '' && selector.options.length === 1;
    }, null, { timeout: 10_000 });
    expect(await restartedPage.locator('[data-testid="chat-turn"]').count()).toBe(0);
    expect(requestCount).toBe(8);
    await electronApp.close();
    electronApp = null;
    const afterDelete = new Database(databaseFile, { readonly: true });
    try {
      expect(afterDelete.query('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 });
      expect(afterDelete.query("SELECT count(*) AS count FROM runs WHERE kind='agent'").get()).toEqual({ count: 0 });
      expect(afterDelete.query("SELECT count(*) AS count FROM runs WHERE kind='provider'").get()).toEqual({ count: 1 });
    } finally { afterDelete.close(); }
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    server.stop(true);
  }
}, 120_000);
