import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, installReadGate, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
async function launch() {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-ui-workbench-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
  return { app, page, userData };
}
const stream = (text: string) => new Response('data: ' + JSON.stringify({ id: 'ui-optimizer', choices: [{ index: 0,
  delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'ui-optimizer',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('keeps directory and settings usable while hiding technical composer controls', async () => {
  test.setTimeout(60_000);
  const { app, page, userData } = await launch(); let failure: Error | undefined;
  page.setDefaultTimeout(10_000);
  let checkpoint = 'directory and hidden controls';
  try {
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose directory', exact: true })).toBeVisible();
    await expect(page.getByText('Tools on this device', { exact: true })).toHaveCount(0);
    await expect(page.getByText('General conversation', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Required Skill for next input', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Next Run limits', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const name of ['General', 'LLM', 'Connections', 'Skills', 'Performance'])
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'General', exact: true }).focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Performance', exact: true })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Performance', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'General', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: 'LLM', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test connection', exact: true })).toBeVisible();
    await page.locator('summary').filter({ hasText: /^Business instructions$/ }).click();
    await expect(page.getByRole('button', { name: 'Use invoice v1', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Runtime status', exact: true })).toBeVisible();
    await page.getByLabel('Default model requests', { exact: true }).fill('9');
    await page.getByRole('button', { name: 'Save Run limits', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true,
      data: { settings: { runtime: { budget: { maxModelCalls: 9 } } } } });
    const savedLimits = await page.evaluate(() => window.flowmate.getState());
    await page.getByLabel('Default model requests', { exact: true }).fill('65');
    await page.getByRole('button', { name: 'Save Run limits', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Run limits must be whole numbers within the displayed ranges.' })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.getState())).toEqual(savedLimits);
    await page.getByLabel('Default model requests', { exact: true }).fill('9');
    await page.getByText('Diagnostics', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh tools', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
    await page.getByLabel('Original prompt', { exact: true }).fill('Keep this original prompt');
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    for (const name of ['All', 'Ready', 'Partial', 'Disabled']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true })).toBeVisible();
    for (const hooks of await page.getByText('Hooks:', { exact: false }).all()) await expect(hooks).toBeHidden();
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await expect(page.getByLabel('Original prompt', { exact: true })).toHaveValue('Keep this original prompt');
    expect(await page.evaluate(() => window.flowmate.listSessions())).toMatchObject({ ok: true, data: { items: [] } });
    for (const theme of ['light', 'dark']) {
      checkpoint = `${theme} appearance`;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'General', exact: true }).click();
      await page.getByLabel('Theme').selectOption(theme);
      await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
      await page.getByRole('button', { name: 'Prompts', exact: true }).click();
      await expect(page.locator('.desktop-shell')).toHaveClass(new RegExp(`theme-${theme}`));
      await page.screenshot({ path: test.info().outputPath(`prompts-${theme}.png`) });
      checkpoint = `${theme} narrow layout`;
      await page.setViewportSize({ width: 720, height: 860 });
      await expect(page.locator('.desktop-shell')).toHaveClass(/chat-is-collapsed/);
      await expect(page.getByRole('button', { name: 'Open Assistant', exact: true })).toBeVisible();
      await expect(page.getByLabel('Original prompt', { exact: true })).toBeVisible();
      expect(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`prompts-narrow-${theme}.png`) });
    }
    checkpoint = 'normal desktop close';
  } catch (error) { failure = new Error(`UI workbench checkpoint ${checkpoint}`, { cause: error }); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
});

test('optimizes through a real Provider run and copies or appends only to the chat draft', async () => {
  test.setTimeout(60_000);
  const payloads: unknown[] = [];
  const provider = await createHttpProvider(async request => { payloads.push(await request.json()); return stream('优化后的提示词：保留约束。'); });
  const { app, page, userData } = await launch(); let failure: Error | undefined;
  try {
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, defaultModelId: 'optimizer', models: [{ id: 'optimizer',
        credentialRef: 'optimizer_fixture_key', name: 'Optimizer fixture', kind: 'custom', providerId: null, baseUrl,
        model: 'optimizer', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }] },
        { modelId: 'optimizer', apiKey: 'synthetic-optimizer-key' });
    }, `http://127.0.0.1:${provider.port}/v1`)).toMatchObject({ ok: true });
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Existing draft');
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await page.getByLabel('Original prompt', { exact: true }).fill('请核对发票，不能猜测缺失值。');
    await page.getByLabel('Optimization requirements', { exact: true }).fill('更清楚地说明输出格式');
    expect(payloads).toHaveLength(0);
    await page.getByRole('button', { name: 'Optimize', exact: true }).click();
    await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('优化后的提示词：保留约束。', { timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads[0])).toContain('请核对发票');
    await page.getByLabel('Optimized prompt', { exact: true }).fill('Edited optimized prompt');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Copied optimized prompt.' })).toBeVisible();
    await expect.poll(() => app.evaluate(async ({ clipboard }) => await clipboard.readText())).toBe('Edited optimized prompt');
    await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message to model', exact: true })).toHaveValue('Existing draft\n\nEdited optimized prompt');
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('');
    await page.getByRole('button', { name: 'Use in chat', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message to model', exact: true })).toHaveValue('Edited optimized prompt');
    await expect(page.locator('.chat-transcript')).not.toContainText('优化后的提示词');
    expect(await page.evaluate(() => window.flowmate.listSessions())).toMatchObject({ ok: true, data: { items: [] } });
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await expect(page.getByText('Connection succeeded. Your model is ready.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Edited optimized prompt');
    await page.getByLabel('Original prompt', { exact: true }).fill('中'.repeat(22000));
    await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
    expect(payloads).toHaveLength(1);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); await provider.stop(); }
});

test('handles early completion, failure, stop and late results without losing prompt drafts', async () => {
  test.setTimeout(60_000);
  let calls = 0, mode = 'success', release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = await createHttpProvider(async () => {
    calls++;
    if (mode === 'failure') return new Response(JSON.stringify({ error: { message: 'Controlled optimization failure' } }), { status: 400 });
    if (mode === 'hold') await held;
    return stream('Saved optimization');
  });
  const { app, page, userData } = await launch(); let failure: Error | undefined;
  try {
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, defaultModelId: 'optimizer', models: [{ id: 'optimizer',
        credentialRef: 'optimizer_fixture_key', name: 'Optimizer fixture', kind: 'custom', providerId: null, baseUrl,
        model: 'optimizer', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }] },
        { modelId: 'optimizer', apiKey: 'synthetic-optimizer-key' });
    }, `http://127.0.0.1:${provider.port}/v1`)).toMatchObject({ ok: true });
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeDisabled();
    await page.getByLabel('Original prompt', { exact: true }).fill('Preserve my task and constraints');
    await page.getByLabel('Optimization requirements', { exact: true }).fill('Keep the language');
    await installReadGate(app, userData);
    // Delay only the accepted receipt from the actual Host, allowing completion to arrive first.
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'call_provider'));
    await page.getByRole('button', { name: 'Optimize', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    const accepted = await app.evaluate(() => JSON.parse(Reflect.get(globalThis, 'contextReadGate').held[0].toString()).value);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Saved optimization');
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    mode = 'failure';
    await page.getByRole('button', { name: 'Optimize', exact: true }).click();
    await expect(page.locator('.optimizer-feedback')).toContainText('Provider 未返回完整文本。');
    await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Saved optimization');
    mode = 'hold';
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'call_provider'));
    await page.getByRole('button', { name: 'Optimize', exact: true }).click();
    await expect.poll(() => calls).toBe(3);
    await app.evaluate(({ BrowserWindow }, accepted) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', {
      type: 'provider_finished', requestId: accepted.data.requestId, runId: accepted.data.runId,
      result: { ok: true, data: { runId: accepted.data.runId, status: 'completed', text: 'STALE result', error: null, stopped: true, cleanupErrors: [] } },
    }), accepted);
    // The Main receipt expires after 15s; correlated Host admission must recover Stop without resubmission.
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled({ timeout: 25_000 });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Optimize', exact: true })).toBeEnabled({ timeout: 20_000 });
    release();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await expect(page.getByLabel('Original prompt', { exact: true })).toHaveValue('Preserve my task and constraints');
    await expect(page.getByLabel('Optimization requirements', { exact: true })).toHaveValue('Keep the language');
    await expect(page.getByLabel('Optimized prompt', { exact: true })).toHaveValue('Saved optimization');
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    expect(calls).toBe(3);
    expect(await page.evaluate(() => window.flowmate.listSessions())).toMatchObject({ ok: true, data: { items: [] } });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { release(); await closeDesktopFixture(app, userData, failure); await provider.stop(); }
});
