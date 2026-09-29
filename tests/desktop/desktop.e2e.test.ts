import { Database } from 'bun:sqlite';
import { _electron as electron, type Page } from 'playwright';
import { expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const pages = JSON.stringify({ pageNumber: 1, text: 'Invoice number: INV-P3-1', blockCount: 2 });
  writeFileSync(join(directory, 'original.png'), onePixelPng);
  writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({
    sourceRecordId: 'desktop-p3-invoice', datasetRevision: 'rev-1', parserKey: 'fixture-parser-v1', qualityStatus: 'complete',
    allowedUsesClaim: ['local review'], licenseVerification: 'not_verified', files: [
      { path: 'original.png', bytes: onePixelPng.length, sha256: 'fixture-only' },
      { path: 'content.json', bytes: Buffer.byteLength(content), sha256: 'fixture-only' },
      { path: 'pages.json', bytes: Buffer.byteLength(pages), sha256: 'fixture-only' },
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

async function confirmWorkspace(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const workspaceTab = nav.getByRole('button', { name: /Workspace/ });
  if (await workspaceTab.getAttribute('aria-current') !== 'page') await workspaceTab.click();
  const button = page.locator('.page-content').getByRole('button', { name: /Confirm Workspace|Reconfirm Workspace/ });
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
  await nav.getByRole('button', { name: /Model/ }).click();
  await page.getByRole('textbox', { name: 'Message to model' }).focus();
}

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
    await page.getByRole('heading', { name: 'Workspace.' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('button', { name: /Model/ }).click();
    await page.getByTestId('workspace-sidebar').waitFor({ state: 'visible' });
    await page.getByTestId('main-content').waitFor({ state: 'visible' });
    await page.getByTestId('agent-chat-panel').waitFor({ state: 'visible' });
    expect(await page.getByText('Output token budget').count()).toBe(0);
    await page.getByRole('button', { name: /New/ }).click();
    await page.getByRole('combobox', { name: 'Session' }).selectOption({ index: 1 });
    await confirmWorkspace(page);
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
    expect(requestBodies.every((body) => ((body as { tools?: unknown[] }).tools ?? []).length === 2)).toBe(true);
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
    await confirmWorkspace(page);
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
    await confirmWorkspace(page);
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
    await confirmWorkspace(page);
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
    await confirmWorkspace(page);
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

    await page.getByRole('button', { name: /Model/ }).click();
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

it('desktop completes import, Start Task, Run, candidate source and Activity without leaving the local fixture', async () => {
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E currently requires the Windows developer host');
  if (!existsSync(electronPath)) throw new Error('Electron runtime binary is not installed; run the Electron install script');

  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p3-e2e-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p3-source-'));
  const sourceDirectory = join(sourceRoot, 'fixture-source');
  writeInvoiceSample(sourceDirectory);
  const source = { documentId: 1, version: 'rev-1:fixture-parser-v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'INV-P3-1' };
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
    ['read_invoice_evidence', { documentId: 1, page: 1, kind: 'original', blockId: null }],
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
    electronApp = await electron.launch({ executablePath: electronPath, args: [resolve(import.meta.dir, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await electronApp.firstWindow();
    await page.getByRole('heading', { name: 'Workspace.' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('button', { name: /New/ }).click();
    await page.getByText('Ready for another Run').waitFor({ state: 'visible', timeout: 10_000 });

    await electronApp.evaluate(({ dialog }, selectedDirectory) => {
      const testDialog = dialog as unknown as { showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }> };
      testDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedDirectory] });
    }, sourceDirectory);
    await page.getByRole('button', { name: /Choose and import/ }).click();
    await page.getByText('Document #1', { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Parsed', exact: true }).click();
    await page.getByText('b1 · text').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Start Task', exact: true }).click();
    await page.getByRole('heading', { name: 'Tasks.' }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('Job #1 · pending').waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: /Model/ }).click();
    await page.getByLabel('Display name').fill('P3 controlled invoice model');
    await page.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await page.getByLabel('Model ID').fill('desktop-p3-model');
    await page.getByLabel('API protocol').selectOption('openai-completions');
    await page.getByLabel(/API Key/).fill('synthetic-desktop-p3-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Configuration saved'), null, { timeout: 10_000 });
    expect(requests).toHaveLength(0);

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: /Tasks/ }).click();
    await page.getByRole('button', { name: 'Confirm Workspace', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    await composer.fill('Review this invoice and prepare a candidate with sources.');
    await page.getByRole('button', { name: 'Send to model' }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'all twelve read tools returned results' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    expect(requests).toHaveLength(3);
    expect(requests.every(({ authorization }) => authorization === 'Bearer synthetic-desktop-p3-key')).toBe(true);
    const toolNames = (requests[0]?.body.tools ?? []).map((tool) => (tool as { function?: { name?: string } }).function?.name).sort();
    expect(toolNames).toHaveLength(13);
    expect(toolNames).toContain('get_invoice_candidate');
    expect(toolNames).toContain('save_invoice_candidate');
    expect(JSON.stringify(requests[1]?.body.messages)).toContain('desktop-p3-save-1');
    const saveResult = ((requests[1]?.body.messages ?? []) as Array<{ role?: string; content?: unknown }>).find((message) => message.role === 'tool');
    expect(JSON.parse(String(saveResult?.content))).toMatchObject({ candidateId: 1, jobId: 1, sequence: 1 });
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
    expect(String(parallelOutput(5))).toContain('original');
    expect(String(parallelOutput(5))).toContain('image/png');
    expect(parallelOutput(6)).toMatchObject({ results: [{ status: 'valid', code: 'parsed_quote_matched' }] });
    expect(parallelOutput(7)).toMatchObject({ items: [{ status: 'normalized' }, { status: 'normalized' }] });
    expect(parallelOutput(8)).toMatchObject({ operation: 'sum', exact: '110', rounded: '110.00' });
    expect(parallelOutput(9)).toMatchObject({ documentRef: { id: 1 }, saveable: true });
    expect(parallelOutput(10)).toMatchObject({ candidates: [{ candidateId: 1, sequence: 1 }] });
    expect(parallelOutput(11)).toMatchObject({ candidate: { fields: { invoiceNumber: { raw: 'INV-P3-1' } } } });
    expect(parallelOutput(12)).toMatchObject({ leftCandidateId: 1, rightCandidateId: 1, differences: [], complete: true });

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: /Tasks/ }).click();
    await page.getByText('Candidate #1 · generated').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByText(/Document #1 · artifact #2 · page 1 · b1 · “INV-P3-1”/).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('candidate_generated', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.chat-session-actions summary').click();
    expect(await page.getByRole('button', { name: 'Delete Session', exact: true }).isDisabled()).toBe(true);
    await page.getByText('This Session contains invoice history and cannot be deleted.', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: /Workspace/ }).click();
    const confirmRevocation = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Active Runs will be stopped');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Revoke model access', exact: true }).click();
    await confirmRevocation;
    await page.getByText('Model access was revoked for 1 Session(s).', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.getByRole('button', { name: 'Send to model', exact: true }).isDisabled()).toBe(true);

    await electronApp.close();
    electronApp = null;
    const database = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
    try {
      const job = database.query('SELECT id,current_candidate_id FROM jobs').get() as { id: number; current_candidate_id: number | null };
      expect(job).toEqual({ id: 1, current_candidate_id: null });
      expect(database.query('SELECT id,job_id,run_id,status FROM invoice_candidates').get())
        .toMatchObject({ id: 1, job_id: 1, run_id: expect.any(Number), status: 'generated' });
      expect(database.query('SELECT kind,status,job_id,tool_call_count FROM runs WHERE job_id=1').get())
        .toMatchObject({ kind: 'agent', status: 'completed', job_id: 1, tool_call_count: 13 });
      const calls = database.query('SELECT tool_name,status FROM tool_calls WHERE run_id=(SELECT id FROM runs WHERE job_id=1) ORDER BY id').all() as Array<{ tool_name: string; status: string }>;
      expect(calls).toHaveLength(13);
      expect(calls.map((call) => call.tool_name).sort()).toEqual([
        'calculate_invoice_amounts', 'check_invoice_sources', 'compare_invoice_candidates', 'get_invoice_candidate',
        'list_invoice_candidates', 'list_invoice_pages', 'list_invoice_tables', 'normalize_invoice_values',
        'read_invoice_document', 'read_invoice_evidence', 'save_invoice_candidate', 'search_invoice_document',
        'validate_invoice_candidate',
      ].sort());
      expect(calls.every((call) => call.status === 'succeeded')).toBe(true);
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
