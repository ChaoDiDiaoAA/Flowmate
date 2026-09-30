import { Database } from 'bun:sqlite';
import { _electron as electron, type Page } from 'playwright';
import { expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../support/resources.ts';

const electronPath = resolve(import.meta.dir, '../../node_modules/electron/dist/electron.exe');
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');

function writeInvoiceSample(directory: string) {
  mkdirSync(directory, { recursive: true });
  const content = JSON.stringify([
    { type: 'header', text: 'Invoice number: INV-P3-1', bbox: [0, 0, 10, 10], page_idx: 0 },
    { type: 'table', table_body: '<tr><td>100.00</td><td>10.00</td><td>110.00</td></tr>', table_caption: 'Totals',
      bbox: [1, 2, 9, 8], page_idx: 0 },
  ]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Invoice number: INV-P3-1', blockCount: 2 }]);
  writeFileSync(join(directory, 'original.png'), onePixelPng);
  writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({
    schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'desktop-p3-invoice', datasetRevision: 'rev-1', qualityStatus: 'complete',
    allowedUsesClaim: ['local review'], licenseVerification: 'not_verified', files: [
      { path: 'original.png', bytes: onePixelPng.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) },
      { path: 'pages.json', bytes: Buffer.byteLength(pages) },
    ],
  }));
}

function streamToolCall(name: string, id: string, args: unknown): Response {
  return streamToolCalls([{ name, id, args }]);
}

function streamToolCalls(calls: Array<{ name: string; id: string; args: unknown }>): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: 'desktop-p3-tool-run', object: 'chat.completion.chunk', created: 1,
      model: 'desktop-p3-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const deltas = calls.map((call, index) => chunk({ tool_calls: [{ index, id: call.id, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
  return new Response(`${chunk({ role: 'assistant' })}${deltas.join('')}${chunk({}, 'tool_calls')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function streamText(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: 'desktop-p3-final', object: 'chat.completion.chunk', created: 1,
      model: 'desktop-p3-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  return new Response(`${chunk({ role: 'assistant', content: text })}${chunk({}, 'stop')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function captureDesktopViews(page: Page) {
  const root = process.env.FLOWMATE_SCREENSHOT_ROOT;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  expect(await page.locator('.rail .nav-item').count()).toBe(5);
  for (const name of ['Invoices', 'Processing History', 'Chats', 'Models', 'Settings']) {
    expect(await page.locator('.rail').getByRole('button', { name, exact: true }).count()).toBe(1);
  }
  for (const name of ['Connections', 'Activity', 'Workspace', 'Approved Results', 'Prompts', 'Skills', 'Extensions', 'Evaluation']) {
    expect(await page.locator('.rail').getByRole('button', { name, exact: true }).count()).toBe(0);
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.locator('.rail').getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption(theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [label, slug] of [['Chats', 'chats'], ['Settings', 'settings']] as const) {
      await page.locator('.rail').getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible' });
      await page.screenshot({ path: join(root, `1440x900-${theme}-${slug}.png`), fullPage: false });
    }
    for (const [width, height] of [[1440, 900], [1280, 800], [980, 720]] as const) {
      await page.setViewportSize({ width, height });
      await nav.getByRole('button', { name: 'Models' }).click();
      await page.getByRole('heading', { name: 'Models', exact: true }).waitFor({ state: 'visible' });
      const name = `${width}x${height}-${theme}`;
      await page.screenshot({ path: join(root, `${name}-models.png`), fullPage: false });
      await nav.getByRole('button', { name: 'Invoices' }).click();
      await page.getByRole('button', { name: 'Results', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(root, `${name}.png`), fullPage: false });
      if (width === 980) {
        await page.getByRole('button', { name: 'Open Assistant' }).click();
        expect(await page.getByRole('textbox', { name: 'Message to model' }).evaluate((element) => document.activeElement === element)).toBe(true);
        await page.screenshot({ path: join(root, `${name}-assistant.png`), fullPage: false });
        await page.keyboard.press('Escape');
        expect(await page.getByRole('button', { name: 'Open Assistant' }).evaluate((element) => document.activeElement === element)).toBe(true);
        await page.getByRole('button', { name: 'Open navigation' }).click();
        expect(await nav.getByRole('button', { name: 'Processing History' }).isVisible()).toBe(true);
        expect(await nav.getByRole('button', { name: 'Models' }).isVisible()).toBe(true);
        await page.screenshot({ path: join(root, `${name}-navigation.png`), fullPage: false });
        await page.keyboard.press('Escape');
        expect(await page.getByRole('button', { name: 'Open navigation' }).evaluate((element) => document.activeElement === element)).toBe(true);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function capturePiModelViews(page: Page) {
  const root = process.env.FLOWMATE_SCREENSHOT_ROOT;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  for (const theme of ['light', 'dark'] as const) {
    await page.locator('.rail').getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption(theme);
    await nav.getByRole('button', { name: 'Models' }).click();
    for (const [width, height] of [[1440, 900], [1280, 800], [980, 720]] as const) {
      await page.setViewportSize({ width, height });
      const name = `${width}x${height}-${theme}-pi-model`;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(root, `${name}.png`), fullPage: false });
      await page.getByRole('heading', { name: 'Connection check' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(root, `${name}-auth.png`), fullPage: false });
      await page.locator('.workspace').evaluate((element) => { element.scrollTop = 0; });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.rail').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Theme').selectOption('system');
  await nav.getByRole('button', { name: 'Models' }).click();
}

it('desktop sends directly, keeps drafts editable and restores native history after restart', async () => {
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E requires Windows');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-chat-e2e-'));
  const requestBodies: unknown[] = [];
  let releaseLiveText: (() => void) | null = null;
  let holdNextConnection = false;
  let connectionStarted: (() => void) | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const body = await request.json();
      requestBodies.push(body);
      if (holdNextConnection) {
        holdNextConnection = false;
        connectionStarted?.();
        return new Promise<Response>(() => {});
      }
      if (JSON.stringify(body).includes('B_HOLD')) return new Promise<Response>(() => {});
      if (JSON.stringify(body).includes('LIVE_TEXT')) {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
          `data: ${JSON.stringify({ id: 'live-text', object: 'chat.completion.chunk', created: 1,
            model: 'desktop-p3-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: 'Live preview' })));
            releaseLiveText = () => {
              controller.enqueue(encoder.encode(`${chunk({ content: ' complete' })}${chunk({}, 'stop')}data: [DONE]\n\n`));
              controller.close();
            };
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return streamText('Desktop connection verified.');
    },
  });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.FLOWMATE_TEST_MODE = '1';
  env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  env.DEEPSEEK_API_KEY = 'synthetic-ambient-key';
  const launch = () => electron.launch({ executablePath: electronPath,
    args: [resolve(import.meta.dir, '../../out/main/index.js')], env, timeout: 30_000 });
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    electronApp = await launch();
    let page = await electronApp.firstWindow();
    await page.getByRole('heading', { name: 'Invoices' }).waitFor({ state: 'visible', timeout: 20_000 });
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    expect(await composer.isDisabled()).toBe(false);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    const piKey = page.locator('.config-panel input[type="password"]');
    await piKey.fill('synthetic-before-provider');
    await page.getByLabel('Pi provider').selectOption('deepseek');
    expect(await piKey.inputValue()).toBe('synthetic-before-provider');
    const catalogModel = page.locator('.config-panel .form-grid select').nth(1);
    await catalogModel.selectOption('deepseek-v4-flash');
    await piKey.fill('');
    expect(await catalogModel.locator('option:checked').textContent()).toBe('DeepSeek V4 Flash');
    expect(await page.locator('.model-limit').allTextContents()).toEqual(['1,000,000 tokens', '384,000 tokens']);
    expect(await page.getByText('Context window', { exact: true }).count()).toBe(1);
    expect(await page.getByText('Maximum output', { exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: 'Refresh models' }).click();
    expect(await catalogModel.inputValue()).toBe('deepseek-v4-flash');
    expect(await page.getByLabel('Find provider').count()).toBe(0);
    expect(await page.getByLabel('Find model').count()).toBe(0);
    expect(await page.getByLabel('Service URL').count()).toBe(0);
    await page.getByRole('heading', { name: 'Authentication' }).waitFor({ state: 'visible' });
    expect(await piKey.isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/Configuration saved/).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('API key required before testing or sending.').waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    const missingKey = await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      if (!state.ok || !state.data.settings.defaultModelId) throw new Error('model_missing');
      return window.flowmate.callProvider({ goal: 'Check', text: 'OK', modelId: state.data.settings.defaultModelId });
    });
    expect(missingKey).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    const missingChatKey = await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      if (!state.ok || !state.data.settings.defaultModelId) throw new Error('model_missing');
      return window.flowmate.startRun({ sessionId: 1, text: 'Check', modelId: state.data.settings.defaultModelId, goalMode: 'answer' });
    });
    expect(missingChatKey).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    expect(requestBodies).toHaveLength(0);
    await piKey.fill('synthetic-pi-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('API key saved in system secure storage.').waitFor({ state: 'visible' });
    expect(await piKey.inputValue()).toBe('');
    expect(await page.getByRole('button', { name: 'Remove API key' }).isEnabled()).toBe(true);
    expect(requestBodies).toHaveLength(0);
    await capturePiModelViews(page);
    const oauthProvider = page.getByLabel('Pi provider').locator('option[value="openai-codex"]');
    expect(await oauthProvider.evaluate((option) => (option as HTMLOptionElement).disabled)).toBe(true);
    expect(await oauthProvider.textContent()).toContain('API key unavailable');
    expect(requestBodies).toHaveLength(0);
    await piKey.fill('synthetic-pi-key-replaced');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('API key saved in system secure storage.').waitFor({ state: 'visible' });
    expect(JSON.stringify(await page.evaluate(() => window.flowmate.getState()))).not.toContain('synthetic-pi-key-replaced');
    for (const path of [join(userData, 'data', 'settings.json'), join(userData, 'data', 'app.sqlite'),
      join(userData, 'data', 'app.sqlite-wal'), join(userData, 'logs', 'flowmate.log')]) {
      if (existsSync(path)) expect(readFileSync(path).includes('synthetic-pi-key-replaced')).toBe(false);
    }
    await page.getByLabel('Pi provider').selectOption('openai');
    expect(await piKey.getAttribute('placeholder')).toBe('Enter API Key');
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    await page.getByLabel('Pi provider').selectOption('deepseek');
    await catalogModel.selectOption('deepseek-v4-flash');
    expect(await piKey.getAttribute('placeholder')).toBe('Leave blank to keep the saved key');
    await page.getByRole('button', { name: 'Remove API key' }).click();
    await page.getByText('API key removed. Add a key before testing or sending.').waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    expect((await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      if (!state.ok || !state.data.settings.defaultModelId) throw new Error('model_missing');
      return window.flowmate.callProvider({ goal: 'Check', text: 'OK', modelId: state.data.settings.defaultModelId });
    }))).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    await page.getByRole('button', { name: 'Custom model' }).click();
    await page.getByLabel('Display name').first().fill('Controlled model');
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await page.getByLabel('Model ID').fill('desktop-controlled-model');
    await page.getByLabel('Pi API type').fill('openai-completions');
    await page.getByLabel('Context window').fill('64000');
    await page.getByLabel('Maximum output tokens').fill('16384');
    await page.getByLabel(/API Key/).fill('synthetic-desktop-key');
    expect(await composer.isDisabled()).toBe(false);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/Configuration saved/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestBodies).toHaveLength(0);
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/other`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('write only', { exact: true }).waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await page.getByLabel(/API Key/).fill('synthetic-desktop-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/Configuration saved/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestBodies).toHaveLength(0);

    await composer.fill('Invoice total is 1060 CNY.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Desktop connection verified.' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('[data-message-role="assistant"][data-persistence="saved"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.locator('[data-message-role="user"]').count()).toBe(1);
    expect(await page.locator('[data-message-role="assistant"]').count()).toBe(1);
    expect(await page.locator('[data-message-role="assistant"]').getByText('Saved', { exact: true }).count()).toBe(1);
    expect(requestBodies).toHaveLength(1);
    expect((requestBodies[0] as { tools?: unknown[] }).tools ?? []).toHaveLength(0);
    const firstSessionId = Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'));
    expect(firstSessionId).toBeGreaterThan(0);
    await composer.fill('What was the total?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"] .chat-assistant-message.completed').length === 2,
      null, { timeout: 20_000 });
    expect(JSON.stringify(requestBodies[1])).toContain('Invoice total is 1060 CNY.');
    expect(JSON.stringify(requestBodies[1])).toContain('Desktop connection verified.');

    await page.locator('.sidebar-new-chat').click();
    await page.waitForFunction((firstId) => {
      const selected = document.querySelector('.sidebar-chat.selected')?.getAttribute('data-session-id');
      return selected !== null && Number(selected) !== firstId;
    }, firstSessionId, { timeout: 10_000 });
    const secondSessionId = Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'));
    expect(secondSessionId).not.toBe(firstSessionId);
    await composer.fill('Draft for second conversation.');
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    await composer.fill('Draft for first conversation.');
    await page.locator(`.sidebar-chat[data-session-id="${secondSessionId}"]`).click();
    expect(await composer.inputValue()).toBe('Draft for second conversation.');
    await page.evaluate(() => {
      const current = window as unknown as { flowmate: { subscribe(listener: (event: unknown) => void): void }; testEvents: unknown[] };
      current.testEvents = [];
      current.flowmate.subscribe((event) => current.testEvents.push(event));
    });
    await composer.fill('LIVE_TEXT: show a preview.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.chat-assistant-message.sending').getByText('Live preview').waitFor({ state: 'visible', timeout: 10_000 });
    const liveRunId = await page.evaluate(() => {
      const events = (window as unknown as { testEvents: Array<{ type: string; runId?: number }> }).testEvents;
      return events.find((event) => event.type === 'text_delta')?.runId ?? null;
    });
    expect(liveRunId).toBeGreaterThan(0);
    await electronApp.evaluate(({ BrowserWindow }, input) => {
      const send = (event: Record<string, unknown>) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', event);
      send({ type: 'text_delta', runId: input.runId, sessionId: input.sessionId, sequence: 1, text: 'STALE TEXT' });
      send({ type: 'tool_progress', runId: input.runId, sessionId: input.sessionId, sequence: 1,
        toolName: 'stale_tool', label: 'STALE PROGRESS', phase: 'running' });
    }, { runId: liveRunId, sessionId: secondSessionId });
    await page.waitForFunction(() => (window as unknown as { testEvents: Array<{ type: string; text?: string; label?: string }> }).testEvents
      .some((event) => event.text === 'STALE TEXT')
      && (window as unknown as { testEvents: Array<{ label?: string }> }).testEvents.some((event) => event.label === 'STALE PROGRESS'));
    expect(await page.locator('.chat-assistant-message.sending').textContent()).not.toContain('STALE');
    const release = releaseLiveText as (() => void) | null;
    expect(release).not.toBeNull();
    release?.();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Live preview complete' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill('B_HOLD: wait for Stop.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.chat-pending').waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill('Next message drafted during response.');
    expect(await composer.isDisabled()).toBe(false);
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Request cancelled.', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(await composer.inputValue()).toBe('Next message drafted during response.');

    await electronApp.close();
    electronApp = null;
    const databaseFile = join(userData, 'data', 'app.sqlite');
    const database = new Database(databaseFile);
    const native = database.query('SELECT entry_count,leaf_id,header_json FROM session_native_history WHERE session_id=?')
      .get(firstSessionId) as { entry_count: number; leaf_id: string | null; header_json: string } | null;
    expect(native?.entry_count).toBeGreaterThan(2);
    expect(native?.leaf_id).toBeTruthy();
    expect(JSON.parse(native!.header_json).type).toBe('session');
    database.query('INSERT INTO sessions(native_session_id,title,created_at,updated_at) VALUES (?,?,?,?)')
      .run('old-native-without-history', 'Older chat', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
    const legacyId = Number((database.query("SELECT id FROM sessions WHERE title='Older chat'").get() as { id: number }).id);
    database.close();

    electronApp = await launch();
    page = await electronApp.firstWindow();
    await page.getByRole('heading', { name: 'Invoices' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    const restartedComposer = page.getByRole('textbox', { name: 'Message to model' });
    await restartedComposer.fill('Do you remember the total?');
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim().startsWith('Send'));
      return button instanceof HTMLButtonElement && !button.disabled;
    }, null, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"] .chat-assistant-message.completed').length === 3,
      null, { timeout: 20_000 });
    expect(JSON.stringify(requestBodies.at(-1))).toContain('Invoice total is 1060 CNY.');
    expect(JSON.stringify(requestBodies.at(-1))).toContain('What was the total?');

    await page.locator(`.sidebar-chat[data-session-id="${legacyId}"]`).click();
    await page.getByText('Read only · older conversation').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator(`.sidebar-chat[data-session-id="${legacyId}"]`).locator('..').getByRole('button', { name: /Rename chat/ }).click();
    await page.getByRole('textbox', { name: 'Chat title' }).fill('Renamed older chat');
    await page.locator('.sidebar-chat-edit').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Open chat Renamed older chat' }).waitFor({ state: 'visible', timeout: 10_000 });
    await restartedComposer.fill('Continue the older chat.');
    expect(await restartedComposer.isDisabled()).toBe(false);
    await page.getByRole('button', { name: 'New chat and send' }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Continue the older chat.' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    const currentSessionId = Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'));
    expect(currentSessionId).not.toBe(legacyId);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    const olderRow = page.locator(`.chat-directory-row[data-session-id="${legacyId}"]`);
    const cancelDelete = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Permanently delete this chat');
      await dialog.dismiss();
    });
    await olderRow.getByRole('button', { name: 'Delete' }).click();
    await cancelDelete;
    expect(await olderRow.count()).toBe(1);
    const confirmDelete = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await olderRow.getByRole('button', { name: 'Delete' }).click();
    await confirmDelete;
    await olderRow.waitFor({ state: 'detached', timeout: 10_000 });
    expect(Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'))).toBe(currentSessionId);
    await page.getByText('Chat deleted.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    const beforeCheck = requestBodies.length;
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    expect(requestBodies).toHaveLength(beforeCheck);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText('Connection succeeded. Your model is ready.').waitFor({ state: 'visible', timeout: 20_000 });
    expect(requestBodies).toHaveLength(beforeCheck + 1);
    const started = new Promise<void>((resolve) => { connectionStarted = resolve; });
    holdNextConnection = true;
    await page.getByRole('button', { name: 'Test connection' }).click();
    await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection test did not start')), 10_000))]);
    await page.getByRole('button', { name: 'Stop check' }).click();
    await page.getByText('Connection check stopped.').waitFor({ state: 'visible', timeout: 20_000 });
    expect(requestBodies).toHaveLength(beforeCheck + 2);
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    server.stop(true);
  }
}, 120_000);

it('keeps an ambient-only Pi provider visible but unavailable without API-key support', async () => {
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E requires Windows');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-ambient-e2e-'));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.FLOWMATE_TEST_MODE = '1';
  env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: electronPath,
    args: [resolve(import.meta.dir, '../../out/main/index.js')], env, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(async () => {
      const state = await window.flowmate.getState();
      return state.ok && state.data.ready;
    }, null, { timeout: 20_000 });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('flowmate:list-model-catalog');
      ipcMain.handle('flowmate:list-model-catalog', async () => ({ ok: false, error: {
        code: 'provider_catalog_unavailable', category: 'provider', message: 'Pi model catalog is unavailable.', retryable: true,
      } }));
    });


    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    expect(await page.getByRole('alert').filter({ hasText: 'Pi model catalog is unavailable.' }).isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Reload providers' }).isEnabled()).toBe(true);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('flowmate:list-model-catalog');
      ipcMain.handle('flowmate:list-model-catalog', async () => ({ ok: true, data: [{
        id: 'deepseek', name: 'DeepSeek', authMethods: ['ambient'], models: [{
          id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', api: 'openai-completions',
          endpoint: null, contextWindow: 128000, maxTokens: 32768, reasoning: false,
        }],
      }] }));
    });
    await page.getByRole('button', { name: 'Reload providers' }).click();
    const desktopState = await page.evaluate(() => window.flowmate.getState());
    expect(desktopState.ok ? { ready: desktopState.data.ready, host: desktopState.data.host }
      : { error: desktopState.error.code }).toEqual({ ready: true, host: 'ready' });
    const provider = page.getByLabel('Pi provider').locator('option[value="deepseek"]');
    await page.waitForFunction(() => document.querySelector<HTMLOptionElement>('.config-panel option[value="deepseek"]')?.disabled === true);
    expect(await provider.evaluate((option) => (option as HTMLOptionElement).disabled)).toBe(true);
    expect(await provider.textContent()).toContain('API key unavailable');
    expect(await page.getByLabel('Service URL').count()).toBe(0);
    expect(await page.locator('.config-panel input[type="password"]').count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
  } finally { await app.close(); }
}, 60_000);
it('reconciles Renderer messages from the public history IPC without replaying an input', async () => {
  if (process.platform !== 'win32') throw new Error('desktop E2E requires Windows');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-message-receipt-e2e-'));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  env.FLOWMATE_TEST_MODE = '1';
  env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: electronPath,
    args: [resolve(import.meta.dir, '../../out/main/index.js')], env, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    const desktop = await page.evaluate(() => window.flowmate.getState());
    if (!desktop.ok) throw new Error('desktop_state_missing');
    await app.evaluate(({ ipcMain }, data) => {
      const replace = (channel: string, value: unknown) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async () => ({ ok: true, data: value }));
      };
      const session = { sessionId: 12, nativeSessionId: 'renderer-native-s', title: 'Controlled receipt', status: 'active',
        createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', availability: 'ready',
        historyState: 'recoverable', activeRunId: null, modelUseBlocked: false, hasBusinessHistory: false };
      const otherSession = { ...session, sessionId: 13, nativeSessionId: 'renderer-native-t', title: 'Other receipt' };
      const user = { entryId: 'renderer-e1', runId: 101, liveOrdinal: 1, timestamp: 1790726400000,
        persistence: 'saved', truncated: false, role: 'user', blocks: [{ type: 'text', text: 'Controlled question' }],
        phase: 'ended', stopReason: null, toolCallId: null, toolName: null, isError: null, textOrigin: 'product-input' };
      replace('flowmate:get-state', { ...data, ready: true, host: 'ready' });
      replace('flowmate:list-model-catalog', []);
      replace('flowmate:read-workspace', { revision: 0, documentRef: null, jobId: null, candidateRef: null,
        sessionId: 12, activeView: 'original' });
      replace('flowmate:list-sessions', { items: [session, otherSession], next: null });
      ipcMain.removeHandler('flowmate:query-session');
      ipcMain.handle('flowmate:query-session', async (_event, id) => ({ ok: true, data: id === 13 ? otherSession : session }));
      const runPage = { items: [{ kind: 'agent', runId: 101, sessionId: 12, jobId: null,
        status: 'completed', input: { version: 1, goal: 'Chat', text: 'Controlled question', messageTimestamp: 1790726400000 },
        config: {}, output: { text: 'Run summary is separate' }, usage: { version: 1, source: 'unknown', reason: null,
          sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: '2026-09-30T00:00:00.000Z' },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        durationMs: 1, toolCallCount: 0, error: null, cleanup: {}, createdAt: '2026-09-30T00:00:00.000Z',
        startedAt: '2026-09-30T00:00:00.000Z', endedAt: '2026-09-30T00:00:00.000Z', cancelRequestedAt: null, stoppedAt: null,
        scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] } }], nextBeforeRunId: null };
      ipcMain.removeHandler('flowmate:list-session-runs');
      ipcMain.handle('flowmate:list-session-runs', async (_event, input) => ({ ok: true,
        data: input.sessionId === 13 ? { items: [], nextBeforeRunId: null } : runPage }));
      const receipt = { session, items: [user] as unknown[], historyCalls: 0, activeQueries: 0, maxQueries: 0,
        startCalls: 0, hold: false, failNext: false, release: null as (() => void) | null };
      (globalThis as unknown as { rendererReceipt: typeof receipt }).rendererReceipt = receipt;
      ipcMain.removeHandler('flowmate:list-session-messages');
      ipcMain.handle('flowmate:list-session-messages', async (_event, input) => {
        if (input.sessionId === 13) return { ok: true, data: { session: otherSession, leafId: 'renderer-t1', entryCount: 1,
          items: [{ ...user, entryId: 'renderer-t1', runId: null, liveOrdinal: null, textOrigin: 'native-content',
            blocks: [{ type: 'text', text: 'Other Session question' }] }], nextBeforeEntryId: null } };
        receipt.historyCalls += 1;
        receipt.activeQueries += 1;
        receipt.maxQueries = Math.max(receipt.maxQueries, receipt.activeQueries);
        const snapshot = structuredClone(receipt.items);
        try {
          if (receipt.hold) await new Promise<void>((resolve) => { receipt.release = resolve; });
          if (receipt.failNext) {
            receipt.failNext = false;
            return { ok: false, error: { code: 'storage_read_failed', category: 'storage', message: 'Controlled history unavailable.', retryable: true } };
          }
          return { ok: true, data: { session, leafId: 'renderer-e1', entryCount: snapshot.length,
            items: snapshot, nextBeforeEntryId: null } };
        } finally { receipt.activeQueries -= 1; }
      });
      ipcMain.removeHandler('flowmate:start-run');
      ipcMain.handle('flowmate:start-run', async () => { receipt.startCalls += 1; return { ok: false }; });
    }, desktop.data);
    await page.reload();
    await page.locator('[data-message-entry="renderer-e1"]').waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.locator('[data-message-role="user"]').textContent()).toContain('Controlled question');
    expect(await page.locator('[data-message-role="user"]').getByText('Saved', { exact: true }).count()).toBe(1);
    expect(await page.locator('.chat-user-message').count()).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', {
      type: 'run_progress', runId: 101, sessionId: 12, nativeSessionId: 'renderer-native-s', sequence: 99,
      at: '2026-09-30T00:00:00.000Z', phase: 'running',
    }));
    await page.waitForTimeout(50);
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).count()).toBe(0);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Draft stays editable');
    await app.evaluate(({ BrowserWindow }) => {
      type Receipt = { hold: boolean };
      (globalThis as unknown as { rendererReceipt: Receipt }).rendererReceipt.hold = true;
      const send = (value: unknown) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', value);
      const envelope = { runId: 102, sessionId: 12, nativeSessionId: 'renderer-native-s', at: '2026-09-30T00:00:00.000Z' };
      const view = { entryId: null, runId: 102, liveOrdinal: 1, timestamp: 1790726400001, persistence: 'pending',
        truncated: false, role: 'assistant', blocks: [{ type: 'text', text: 'AB' }], phase: 'streaming', stopReason: 'pending',
        toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' };
      send({ ...envelope, type: 'run_progress', sequence: 1, phase: 'running' });
      send({ ...envelope, type: 'message_upsert', sequence: 3, message: view });
      send({ ...envelope, type: 'message_upsert', sequence: 2, message: { ...view, liveOrdinal: 2,
        timestamp: 1790726400002, blocks: [{ type: 'text', text: 'Another message' }] } });
      send({ ...envelope, type: 'message_upsert', sequence: 2, message: { ...view, blocks: [{ type: 'text', text: 'A' }] } });
      send({ ...envelope, type: 'message_upsert', sequence: 3, message: view });
      send({ ...envelope, type: 'message_upsert', sequence: 3, message: { ...view, blocks: [{ type: 'text', text: 'CONFLICT' }] } });
    });
    await page.locator('[data-message-role="assistant"]').filter({ hasText: 'AB' }).waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-role="assistant"]').count()).toBe(2);
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('CONFLICT');
    await app.evaluate(({ BrowserWindow }) => {
      const send = (value: unknown) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', value);
      const envelope = { runId: 102, sessionId: 12, nativeSessionId: 'renderer-native-s', at: '2026-09-30T00:00:00.000Z' };
      send({ ...envelope, type: 'run_finished', sequence: 1, result: { ok: true, data: { runId: 102, sessionId: 12,
        nativeSessionId: 'renderer-native-s', status: 'completed', text: 'RUN TEXT IS NOT A MESSAGE', error: null,
        stopped: false, cleanupErrors: [] } } });
      send({ ...envelope, type: 'message_upsert', sequence: 4, message: { entryId: null, runId: 102, liveOrdinal: 1,
        timestamp: 1790726400001, persistence: 'pending', truncated: false, role: 'assistant',
        blocks: [{ type: 'text', text: 'LATE' }], phase: 'streaming', stopReason: 'pending', toolCallId: null,
        toolName: null, isError: null, textOrigin: 'native-content' } });
    });
    await page.getByText('2 messages have not been confirmed as saved.', { exact: false }).waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).count()).toBe(0);
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('LATE');
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('RUN TEXT IS NOT A MESSAGE');
    await app.evaluate(() => {
      type Receipt = { hold: boolean; items: unknown[]; release: (() => void) | null };
      const receipt = (globalThis as unknown as { rendererReceipt: Receipt }).rendererReceipt;
      const base = { runId: 102, persistence: 'saved', truncated: false, role: 'assistant', phase: 'ended', stopReason: 'stop',
        toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' };
      receipt.items.push({ ...base, entryId: 'renderer-e2', liveOrdinal: 1, timestamp: 1790726400001, blocks: [{ type: 'text', text: 'AB' }] },
        { ...base, entryId: 'renderer-e3', liveOrdinal: 2, timestamp: 1790726400002, blocks: [{ type: 'text', text: 'Another message' }] });
      receipt.hold = false;
      receipt.release?.();
    });
    await page.locator('[data-message-entry="renderer-e3"]').waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-role="assistant"][data-persistence="saved"]').count()).toBe(2);
    expect(await page.getByRole('textbox', { name: 'Message to model' }).inputValue()).toBe('Draft stays editable');
    const counts = await app.evaluate(() => {
      const receipt = (globalThis as unknown as { rendererReceipt: { historyCalls: number; maxQueries: number; startCalls: number } }).rendererReceipt;
      return { historyCalls: receipt.historyCalls, maxQueries: receipt.maxQueries, startCalls: receipt.startCalls };
    });
    expect(counts).toEqual({ historyCalls: 3, maxQueries: 1, startCalls: 0 });
    await app.evaluate(() => { (globalThis as unknown as { rendererReceipt: { failNext: boolean } }).rendererReceipt.failNext = true; });
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Controlled history unavailable.' }).waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-entry="renderer-e3"]').count()).toBe(1);
    await page.waitForTimeout(100);
    expect(await app.evaluate(() => (globalThis as unknown as { rendererReceipt: { historyCalls: number } }).rendererReceipt.historyCalls)).toBe(4);
    await app.evaluate(({ BrowserWindow }) => {
      const send = (value: unknown) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', value);
      const envelope = { sessionId: 12, nativeSessionId: 'renderer-native-s', at: '2026-09-30T00:00:00.000Z' };
      send({ ...envelope, type: 'run_progress', runId: 103, sequence: 1, phase: 'running' });
      send({ ...envelope, type: 'run_finished', runId: 102, sequence: 1, result: { ok: true, data: { runId: 102,
        sessionId: 12, nativeSessionId: 'renderer-native-s', status: 'completed', text: 'OLD RUN TEXT',
        error: null, stopped: false, cleanupErrors: [] } } });
    });
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'visible' });
    expect(await page.getByRole('textbox', { name: 'Message to model' }).inputValue()).toBe('Draft stays editable');
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('OLD RUN TEXT');
    await app.evaluate(() => { (globalThis as unknown as { rendererReceipt: { hold: boolean } }).rendererReceipt.hold = true; });
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await page.locator('.sidebar-chat[data-session-id="13"]').click();
    await page.locator('[data-message-entry="renderer-t1"]').waitFor({ state: 'visible' });
    await app.evaluate(({ BrowserWindow }) => {
      const receipt = (globalThis as unknown as { rendererReceipt: { hold: boolean; release: (() => void) | null } }).rendererReceipt;
      receipt.hold = false;
      receipt.release?.();
      BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', { type: 'message_upsert', runId: 103,
        sessionId: 12, nativeSessionId: 'renderer-native-s', sequence: 2, at: '2026-09-30T00:00:00.000Z',
        message: { entryId: null, runId: 103, liveOrdinal: 1, timestamp: 1790726400003, persistence: 'pending',
          truncated: false, role: 'assistant', blocks: [{ type: 'text', text: 'WRONG SESSION' }], phase: 'streaming',
          stopReason: 'pending', toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' } });
    });
    await page.waitForTimeout(100);
    expect(await page.locator('[data-message-entry="renderer-t1"]').count()).toBe(1);
    expect(await page.locator('[data-message-entry="renderer-e1"]').count()).toBe(0);
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('WRONG SESSION');
  } finally { await app.close(); }
}, 60_000);

it('desktop completes import, Start Task, Run, candidate source and Activity without leaving the local fixture', async () => {
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E currently requires the Windows developer host');
  if (!existsSync(electronPath)) throw new Error('Electron runtime binary is not installed; run the Electron install script');

  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p3-e2e-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p3-source-'));
  const sourceDirectory = join(sourceRoot, '000001');
  writeInvoiceSample(sourceDirectory);
  const digest = createHash('sha256');
  for (const name of ['original.png', 'content.json', 'pages.json', 'metadata.json']) {
    const bytes = readFileSync(join(sourceDirectory, name));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(length).update(bytes);
  }
  const source = { documentId: 1, version: `rev-1:parsed-v3:${digest.digest('hex')}`, artifactId: 2, page: 1, blockId: 'b1', quote: 'INV-P3-1' };
  const field = () => ({ raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] });
  const candidate = {
    fields: {
      invoiceNumber: { raw: 'INV-P3-1', normalized: 'INV-P3-1', state: 'present', alternatives: [], sources: [source] },
      issueDate: field(), sellerName: field(), sellerTaxId: field(), buyerName: field(), buyerTaxId: field(),
      currency: field(), netAmount: field(), taxAmount: field(), totalAmount: field(),
    }, lines: [], notes: [],
  };
  const toolBatch = [
    ['list_invoice_pages', { documentId: 1 }],
    ['read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 }],
    ['search_invoice_document', { documentId: 1, query: 'INV-P3-1', page: null, afterBlockId: null, limit: 10 }],
    ['list_invoice_tables', { documentId: 1, page: null, afterBlockId: null, limit: 10 }],
    ['read_invoice_evidence', { documentId: 1, page: 1, kind: 'parsed', blockId: 'b1' }],
    ['check_invoice_sources', { documentId: 1, sources: [source] }],
    ['normalize_invoice_values', { items: [{ kind: 'decimal', raw: '100.00' }, { kind: 'date', raw: '2026-02-28' }] }],
    ['calculate_invoice_amounts', { operation: 'sum', values: ['100.00', '10.00'], scale: 2 }],
    ['validate_invoice_candidate', { documentId: 1, candidate }],
    ['list_invoice_candidates', { beforeSequence: null, limit: 10 }],
    ['get_invoice_candidate', { candidateId: 1 }],
    ['compare_invoice_candidates', { leftCandidateId: 1, rightCandidateId: 1, afterPath: null, limit: 10 }],
  ] as const;
  const requests: Array<{ body: { tools?: unknown[]; messages?: unknown[] }; authorization: string | null }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      requests.push({ body: await request.json(), authorization: request.headers.get('authorization') });
      if (requests.length === 1) {
        return streamToolCall('save_invoice_candidate', 'desktop-p3-save-1', { documentId: 1, candidate });
      }
      if (requests.length === 2) return streamToolCalls(toolBatch.map(([name, args], index) => ({
        name, args, id: `desktop-p3-parallel-${index + 1}`,
      })));
      if (requests.length === 4) return streamToolCall('validate_invoice_candidate',
        'desktop-p3-validate-only-1', { documentId: 1, candidate });
      return streamText('Candidate saved from the imported invoice and all twelve read tools returned results.');
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
    env.FLOWMATE_TEST_INVOICE_SOURCE_ROOT = sourceRoot;
    electronApp = await electron.launch({ executablePath: electronPath, args: [resolve(import.meta.dir, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await electronApp.firstWindow();
    await page.getByRole('heading', { name: 'Invoices' }).waitFor({ state: 'visible', timeout: 20_000 });

    await electronApp.evaluate(({ dialog }, selectedDirectory) => {
      const testDialog = dialog as unknown as {
        showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
        __selectedDefaultPath?: string;
      };
      testDialog.showOpenDialog = async (...args) => {
        const options = args.find((value) => value !== null && typeof value === 'object' && 'defaultPath' in value);
        testDialog.__selectedDefaultPath = (options as { defaultPath?: string } | undefined)?.defaultPath;
        return { canceled: false, filePaths: [selectedDirectory] };
      };
    }, sourceDirectory);
    await page.getByRole('button', { name: /Import invoice/ }).click();
    const selectedDefaultPath = await electronApp.evaluate(({ dialog }) =>
      (dialog as unknown as { __selectedDefaultPath?: string }).__selectedDefaultPath);
    expect(selectedDefaultPath).toBe(join(resolve(import.meta.dir, '../..'), 'data', 'invoices', 'agent-input'));
    await page.getByRole('heading', { name: 'Invoice 000001' }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('img[alt="Original invoice document page 1"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Parsed', exact: true }).click();
    await page.getByText('Text · Page 1').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Process this invoice', exact: true }).click();
    await page.getByText(/Ready to process/).waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    await page.getByRole('button', { name: 'Custom model' }).click();
    await page.getByLabel('Display name').first().fill('P3 controlled invoice model');
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await page.getByLabel('Model ID').fill('desktop-p3-model');
    await page.getByLabel('Pi API type').fill('openai-completions');
    await page.getByLabel('Context window').fill('64000');
    await page.getByLabel('Maximum output tokens').fill('16384');
    await page.getByLabel(/API Key/).fill('synthetic-desktop-p3-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Configuration saved'), null, { timeout: 10_000 });
    expect(requests).toHaveLength(0);
    await page.evaluate(() => {
      const current = window as unknown as { flowmate: { subscribe(listener: (event: unknown) => void): void }; toolEvents: unknown[] };
      current.toolEvents = [];
      current.flowmate.subscribe((event) => {
        if ((event as { type?: string }).type === 'tool_progress') current.toolEvents.push(event);
      });
    });

    const composer = page.getByRole('textbox', { name: 'Message to model' });
    await composer.fill('Review this invoice and prepare a candidate with sources.');
    const changedBehindThePage = await page.evaluate(async () => {
      const api = (window as unknown as { flowmate: {
        readWorkspace(): Promise<{ ok: boolean; data?: { revision: number; activeView: string } }>;
        updateWorkspace(input: { expectedRevision: number; change: { kind: 'view'; view: 'original' | 'parsed' } }): Promise<{ ok: boolean; data?: { revision: number } }>;
      } }).flowmate;
      const current = await api.readWorkspace();
      if (!current.ok || !current.data) return false;
      const changed = await api.updateWorkspace({ expectedRevision: current.data.revision,
        change: { kind: 'view', view: current.data.activeView === 'original' ? 'parsed' : 'original' } });
      return changed.ok && changed.data?.revision === current.data.revision + 1;
    });
    expect(changedBehindThePage).toBe(true);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Invoice context changed. Review it and press Send again; your message is preserved.')
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(await composer.inputValue()).toBe('Review this invoice and prepare a candidate with sources.');
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'all twelve read tools returned results' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-message-role="toolResult"][data-persistence="saved"]').length === 13,
      null, { timeout: 10_000 });
    expect(await page.locator('[data-message-role="assistant"]').count()).toBe(3);
    expect(await page.locator('.chat-tool-call').count()).toBe(13);
    const messageEntryIds = await page.locator('[data-message-entry]').evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-message-entry')));
    expect(new Set(messageEntryIds).size).toBe(messageEntryIds.length);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ authorization }) => authorization === 'Bearer synthetic-desktop-p3-key')).toBe(true);
    const toolNames = (requests[0]?.body.tools ?? []).map((tool) => (tool as { function?: { name?: string } }).function?.name ?? '').sort();
    expect(toolNames).toHaveLength(13);
    expect(toolNames).not.toContain('');
    expect(toolNames).toContain('get_invoice_candidate');
    expect(toolNames).toContain('save_invoice_candidate');
    const toolEvents = await page.evaluate(() =>
      (window as unknown as { toolEvents: Array<{ toolName: string; phase: string; [key: string]: unknown }> }).toolEvents);
    expect(toolEvents.filter((event) => event.phase === 'running').map((event) => event.toolName).sort()).toEqual(toolNames);
    expect(toolEvents.every((event) => !('args' in event) && !('input' in event))).toBe(true);
    expect(JSON.stringify(requests[1]?.body.messages)).toContain('desktop-p3-save-1');
    const saveResult = ((requests[1]?.body.messages ?? []) as Array<{ role?: string; content?: unknown }>).find((message) => message.role === 'tool');
    const parsedSaveContent = Array.isArray(saveResult?.content)
      ? saveResult.content.find((part) => typeof part === 'object' && part !== null && 'text' in part)?.text
      : saveResult?.content;
    expect(JSON.parse(String(parsedSaveContent))).toMatchObject({ candidateId: 1, jobId: 1, sequence: 1 });
    const parallelMessages = (requests[2]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: unknown }>;
    const parallelOutput = (index: number): unknown => {
      const message = parallelMessages.find((item) => item.role === 'tool' && item.tool_call_id === `desktop-p3-parallel-${index}`);
      if (typeof message?.content === 'string') {
        try { return JSON.parse(message.content); } catch { return message.content; }
      }
      const textPart = Array.isArray(message?.content) ? message.content.find((part) => typeof part === 'object' && part !== null && 'text' in part) : null;
      if (!textPart || typeof textPart !== 'object' || !('text' in textPart)) return null;
      try { return JSON.parse(String(textPart.text)); } catch { return textPart.text; }
    };
    expect(parallelMessages.filter((message) => message.role === 'tool' && message.tool_call_id?.startsWith('desktop-p3-parallel-'))).toHaveLength(12);
    expect(parallelOutput(1)).toMatchObject({ pageCount: 1, pages: [{ page: 1 }] });
    expect(parallelOutput(2)).toMatchObject({ blocks: [{ id: 'b1' }, { id: 'b2' }] });
    expect(parallelOutput(3)).toMatchObject({ matches: [{ blockId: 'b1', source: { quote: 'INV-P3-1' } }] });
    expect(parallelOutput(4)).toMatchObject({ tables: [{ blockId: 'b2' }] });
    expect(parallelOutput(5)).toMatchObject({ kind: 'parsed', source: { blockId: 'b1' }, text: 'Invoice number: INV-P3-1' });
    expect(parallelOutput(6)).toMatchObject({ results: [{ status: 'valid', code: 'parsed_quote_matched' }] });
    expect(parallelOutput(7)).toMatchObject({ items: [{ status: 'normalized' }, { status: 'normalized' }] });
    expect(parallelOutput(8)).toMatchObject({ operation: 'sum', exact: '110', rounded: '110.00' });
    expect(parallelOutput(9)).toMatchObject({ documentRef: { id: 1 }, saveable: true });
    expect(parallelOutput(10)).toMatchObject({ candidates: [{ candidateId: 1, sequence: 1 }] });
    expect(parallelOutput(11)).toMatchObject({ candidate: { fields: { invoiceNumber: { raw: 'INV-P3-1' } } } });
    expect(parallelOutput(12)).toMatchObject({ leftCandidateId: 1, rightCandidateId: 1, differences: [], complete: true });

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Processing History' }).click();
    await page.getByText('Result 1 · generated').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByText(/Page 1 · “INV-P3-1”/).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('Result prepared', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await captureDesktopViews(page);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    expect(await page.locator('.chat-directory-row.selected').getByRole('button', { name: 'Delete' }).isEnabled()).toBe(true);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices' }).click();
    await page.getByRole('button', { name: 'Generate result', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Generate result for next message' }).getAttribute('aria-pressed')).toBe('true');
    await composer.fill('Save another result.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('No result was saved. Ask the assistant to generate and save a result.')
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(requests).toHaveLength(5);
    const validationMessage = ((requests[4]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: unknown }>)
      .find((message) => message.role === 'tool' && message.tool_call_id === 'desktop-p3-validate-only-1');
    expect(JSON.parse(String(validationMessage?.content))).toMatchObject({ saveable: true });
    expect(await page.getByRole('button', { name: 'Generate result', exact: true }).getAttribute('aria-pressed')).toBe('false');
    await page.getByText('Material access').click();
    const confirmRevocation = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Any active response will stop');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Revoke model access', exact: true }).click();
    await confirmRevocation;
    await page.getByText(/Model access was revoked for 1 chat/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices' }).click();
    await page.setViewportSize({ width: 980, height: 720 });
    const invoiceRow = page.locator('.invoice-context .route-row').filter({ hasText: 'Invoice 000001' });
    const invoiceDelete = page.locator('.invoice-heading-delete');
    await invoiceDelete.focus();
    expect(await invoiceDelete.evaluate((element) => document.activeElement === element)).toBe(true);
    const cancelInvoiceDelete = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Processing history and saved results will remain');
      await dialog.dismiss();
    });
    await page.keyboard.press('Enter');
    await cancelInvoiceDelete;
    expect(await invoiceRow.count()).toBe(1);
    const confirmInvoiceDelete = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await invoiceDelete.focus();
    await page.keyboard.press('Enter');
    await confirmInvoiceDelete;
    await page.getByText(/Invoice removed from All invoices/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(await invoiceRow.count()).toBe(0);
    expect(await page.getByRole('option', { name: 'Invoice 000001' }).count()).toBe(0);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Processing History' }).click();
    await page.getByRole('button', { name: 'Invoice 000001' }).click();
    await page.getByText('Read only', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('Result 1 · generated').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByText(/Page 1 · “INV-P3-1”/).waitFor({ state: 'visible', timeout: 10_000 });
    const hidePrompt = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await hidePrompt;
    await page.getByText('No processing yet').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    const selectedChat = page.locator('.chat-directory-row.selected');
    const selectedChatId = Number(await selectedChat.getAttribute('data-session-id'));
    const cancelChatDelete = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('invoice history and saved results will remain');
      await dialog.dismiss();
    });
    await selectedChat.getByRole('button', { name: 'Delete' }).click();
    await cancelChatDelete;
    expect(await selectedChat.count()).toBe(1);
    const confirmChatDelete = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    const chatDelete = selectedChat.getByRole('button', { name: 'Delete' });
    await chatDelete.focus();
    expect(await chatDelete.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press('Enter');
    await confirmChatDelete;
    await page.locator(`.chat-directory-row[data-session-id="${selectedChatId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
    expect(await page.locator('.chats-page .notice').textContent()).toContain('Chat removed from Conversations');

    await electronApp.close();
    electronApp = null;
    const database = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
    try {
      const job = database.query('SELECT id,current_candidate_id FROM jobs').get() as { id: number; current_candidate_id: number | null };
      expect(job).toEqual({ id: 1, current_candidate_id: null });
      expect(database.query('SELECT hidden_at IS NOT NULL AS hidden FROM jobs WHERE id=1').get()).toEqual({ hidden: 1 });
      expect(database.query('SELECT hidden_at IS NOT NULL AS hidden FROM documents WHERE id=1').get()).toEqual({ hidden: 1 });
      expect(database.query('SELECT hidden_at IS NOT NULL AS hidden FROM sessions WHERE id=?').get(selectedChatId)).toEqual({ hidden: 1 });
      expect(database.query('SELECT id,job_id,run_id,status FROM invoice_candidates').get())
        .toMatchObject({ id: 1, job_id: 1, run_id: expect.any(Number), status: 'generated' });
      expect(database.query('SELECT kind,status,job_id,tool_call_count FROM runs WHERE job_id=1 ORDER BY id ASC LIMIT 1').get())
        .toMatchObject({ kind: 'agent', status: 'completed', job_id: 1, tool_call_count: 13 });
      expect(database.query("SELECT status,tool_call_count,json_extract(error_json,'$.code') AS error FROM runs WHERE job_id=1 ORDER BY id DESC LIMIT 1").get())
        .toEqual({ status: 'failed', tool_call_count: 1, error: 'agent_goal_not_met' });
      expect(database.query('SELECT tool_name,status FROM tool_calls WHERE run_id=(SELECT id FROM runs WHERE job_id=1 ORDER BY id DESC LIMIT 1)').get())
        .toEqual({ tool_name: 'validate_invoice_candidate', status: 'succeeded' });
      const calls = database.query('SELECT tool_name,status FROM tool_calls WHERE run_id=(SELECT id FROM runs WHERE job_id=1 ORDER BY id ASC LIMIT 1) ORDER BY id').all() as Array<{ tool_name: string; status: string }>;
      expect(calls).toHaveLength(13);
      expect(calls.map((call) => call.tool_name).sort()).toEqual([
        'calculate_invoice_amounts', 'check_invoice_sources', 'compare_invoice_candidates', 'get_invoice_candidate',
        'list_invoice_candidates', 'list_invoice_pages', 'list_invoice_tables', 'normalize_invoice_values',
        'read_invoice_document', 'read_invoice_evidence', 'save_invoice_candidate', 'search_invoice_document',
        'validate_invoice_candidate',
      ].sort());
      expect(calls.every((call) => call.status === 'succeeded')).toBe(true);
      const modelBody = JSON.stringify(requests.map((request) => request.body.messages));
      expect(modelBody).not.toContain('"type":"image"');
      expect(modelBody).not.toContain(onePixelPng.toString('base64'));
      expect(database.query("SELECT tool_name,status,json_extract(delivery_json,'$.state') AS delivery FROM tool_calls WHERE tool_name='save_invoice_candidate'").get())
        .toEqual({ tool_name: 'save_invoice_candidate', status: 'succeeded', delivery: 'request_observed' });
      expect(database.query("SELECT tool_name,status,json_extract(delivery_json,'$.state') AS delivery FROM tool_calls WHERE tool_name='read_invoice_evidence'").get())
        .toEqual({ tool_name: 'read_invoice_evidence', status: 'succeeded', delivery: 'request_observed' });
      expect(database.query("SELECT count(*) AS count FROM business_events WHERE job_id=1 AND type='candidate_generated' AND result='succeeded'").get())
        .toEqual({ count: 1 });
      expect(JSON.parse(String(database.query('SELECT metadata_json FROM sessions WHERE id=(SELECT session_id FROM runs WHERE job_id=1)').get()
        && (database.query('SELECT metadata_json FROM sessions WHERE id=(SELECT session_id FROM runs WHERE job_id=1)').get() as { metadata_json: string }).metadata_json)))
        .toMatchObject({ model_use_blocked: { documentIds: [1], reason: 'document_use_revoked' } });
    } finally { database.close(); }
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    server.stop(true);
  }
}, 120_000);
