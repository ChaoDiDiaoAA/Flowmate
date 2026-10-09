import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { cleanupResources, closeDesktopFixture, createHttpProvider, installReadGate, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
function environment() {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

test('four command groups, keyboard and IME, role overrides, themes and real concurrent Assistant cards', async () => {
  test.setTimeout(90000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-input-ui-'));
  const pictures = join(repository, '.superpowers/sdd/skills-input-subagent/ui'); mkdirSync(pictures, { recursive: true });
  const payloads: any[] = []; let parent = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => release = resolve);
  const provider = await createHttpProvider(async request => {
    const payload = await request.json(); payloads.push(payload);
    const child = payload.messages[0]?.content.startsWith('Analyze the task');
    if (child) await barrier;
    const delta = !child && ++parent === 1 ? { role: 'assistant', tool_calls: [0, 1].map(index => ({ index, id: 'ui-child-'+index,
      type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'general-analyst',
        prompt: 'Independent issue '+index, description: 'UI check '+index }) } })) } : { role: 'assistant', content: child ? 'Independent UI finding.' : 'Both checks returned.' };
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'ui', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null)+chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop')+'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    const seed = await page.evaluate(async baseUrl => {
      const need = (r: any) => { if (!r.ok) throw Error(r.error.code); return r.data; };
      const state = need(await window.flowmate.getState());
      const settings = need(await window.flowmate.saveSettings({ ...state.settings, models: [{ id: 'input-ui', credentialRef: 'input_ui_synthetic',
        name: 'Input UI', kind: 'custom', providerId: null, baseUrl, model: 'input-ui', api: 'openai-completions',
        contextWindow: 64000, maxTokens: 16000, reasoning: false }], defaultModelId: 'input-ui' }, { modelId: 'input-ui', apiKey: 'synthetic-ui-only' }));
      const extensions = need(await window.flowmate.listExtensions());
      need(await window.flowmate.updateExtensionSelection({ expectedRevision: settings.revision,
        selection: { enabledExtensions: extensions.items.filter((item: any) => item.ref.id === 'subagents').map((item: any) => item.ref) } }));
      const session = need(await window.flowmate.createSession({ title: 'Input UI conversation' }));
      const workspace = need(await window.flowmate.readWorkspace());
      need(await window.flowmate.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'session', sessionId: session.sessionId } }));
      const resources = need(await window.flowmate.listResources());
      need(await window.flowmate.updateResourceSelection({ expectedRevision: resources.settingsRevision,
        selection: { prompt: null, enabledSkills: [resources.items.find((item: any) => item.ref.id === 'invoice' && item.ref.kind === 'skill').ref] } }));
      return session;
    }, `http://127.0.0.1:${provider.port}/v1`);
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: 'Message to model', exact: true });
    await input.fill('/'); const menu = page.getByRole('listbox', { name: 'Input commands' });
    await expect(menu).toBeVisible();
    const skillOptions = menu.getByRole('option').filter({ hasText: /^\/skill:/ });
    await expect(skillOptions).toHaveCount(16);
    for (const option of await skillOptions.all()) {
      const description = await option.locator('span').innerText();
      expect(description).not.toMatch(/[\u3400-\u9fff]/u);
      expect(await option.getAttribute('title')).toContain(description);
    }
    await expect(skillOptions.first().locator('span')).toContainText('Organize fields');
    await page.screenshot({ path: test.info().outputPath('skill-command-menu-english.png') });
    for (const name of ['Skills', 'Subagents', 'Prompt Templates', 'Extension Commands']) await expect(menu.getByRole('heading', { name, exact: true })).toBeVisible();
    await input.press('ArrowDown'); await expect(input).toHaveAttribute('aria-activedescendant', 'input-command-1');
    await input.dispatchEvent('compositionstart'); await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await expect(input).toHaveValue('/'); expect(payloads).toHaveLength(0);
    await input.dispatchEvent('compositionend'); await input.press('Escape'); await expect(menu).toHaveCount(0);
    await input.fill('/subagent general'); await expect(menu).toHaveCount(0);
    await input.fill('/general'); await expect(menu.getByRole('option')).toHaveCount(1);
    await input.press('Enter'); await expect(input).toHaveValue('/subagent general-analyst ');
    expect(payloads).toHaveLength(0);
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    const plugin = page.locator('.plugin-row').filter({ has: page.getByRole('heading', { name: 'subagents v1', exact: true }) });
    await plugin.locator('summary').filter({ hasText: /^Manage agents$/ }).click();
    await page.getByRole('button', { name: 'New agent', exact: true }).click();
    await page.getByRole('textbox', { name: 'Agent ID', exact: true }).fill('ui-reviewer');
    await page.getByRole('textbox', { name: 'Agent Markdown', exact: true }).fill('---\nname: ui-reviewer\ndescription: Independent UI review\ntools: []\n---\nReview the assigned issue independently.');
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').fail(1, 'save_subagent_definition'));
    await page.getByRole('button', { name: 'Save agent', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The save was not confirmed.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save agent', exact: true })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Agent Markdown', exact: true })).toContainText('Independent UI review');
    await page.getByRole('button', { name: 'Check saved definition', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The original save is confirmed.' })).toBeVisible();
    expect(await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands
      .filter((command: { type: string }) => command.type === 'save_subagent_definition').length)).toBe(1);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await expect(page.getByRole('textbox', { name: 'Agent ID', exact: true })).toBeDisabled();
    expect(payloads).toHaveLength(0);
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(async theme => { const state = await window.flowmate.getState(); if (!state.ok) throw Error(state.error.code);
        const saved = await window.flowmate.saveSettings({ ...state.data.settings, profile: { ...state.data.settings.profile, theme } });
        if (!saved.ok) throw Error(saved.error.code); }, theme);
      await page.setViewportSize({ width: theme === 'light' ? 920 : 1450, height: 950 });
      await page.screenshot({ path: join(pictures, 'input-agents-'+theme+'.png') });
    }
    // Remove author resources for this ordinary-chat Run; no invoice scope is granted.
    await page.evaluate(async () => { const catalog = await window.flowmate.listResources(); if (!catalog.ok) throw Error(catalog.error.code);
      const saved = await window.flowmate.updateResourceSelection({ expectedRevision: catalog.data.settingsRevision, selection: { prompt: null, enabledSkills: [] } });
      if (!saved.ok) throw Error(saved.error.code); });
    await input.fill('Run two independent checks.'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => payloads.filter(p => p.messages[0]?.content.startsWith('Analyze the task')).length).toBe(2);
    const cards = page.locator('.agent-chat-panel .subagent-card'); await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('general-analyst');
    await input.fill('Draft during parallel execution.'); const activeComposer = await input.elementHandle();
    const requestCount = payloads.length;
    const resize = page.getByRole('separator', { name: 'Resize Assistant', exact: true });
    const previousWidth = Number(await resize.getAttribute('aria-valuenow'));
    await resize.focus(); await resize.press('ArrowLeft');
    await expect(resize).toHaveAttribute('aria-valuenow', String(previousWidth + 10));
    await expect(input).toHaveValue('Draft during parallel execution.');
    expect(await activeComposer!.evaluate(element => element.isConnected)).toBe(true);
    await expect(cards).toHaveCount(2); expect(payloads).toHaveLength(requestCount);
    await page.screenshot({ path: join(pictures, 'assistant-parallel.png') });
    release(); await expect(cards.first()).toContainText('completed', { timeout: 20000 });
    await expect(cards.first()).toContainText('Independent UI finding.');
    const children = await page.evaluate(async sessionId => { const roots = await window.flowmate.listSessionRuns({ sessionId });
      if (!roots.ok) throw Error(roots.error.code); return window.flowmate.listSubagents({ parentRunId: roots.data.items[0]!.runId, parentSessionId: sessionId }); }, seed.sessionId);
    expect(children).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ stoppedAt: expect.any(String) }), expect.objectContaining({ stoppedAt: expect.any(String) })] } });
    const fork = await page.evaluate(async sessionId => {
      const history = await window.flowmate.querySessionHistory({ sessionId });
      if (!history.ok) throw Error(history.error.code);
      return window.flowmate.forkSession({ sourceSessionId: sessionId, expected: history.data.commit,
        targetEntryId: history.data.commit.leafId!, title: 'Fork without owned delegation', clientOperationId: '774cf46c-c3c6-4389-8f72-aee95c5a32d3' });
    }, seed.sessionId);
    if (!fork.ok) throw Error(fork.error.code);
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await page.evaluate(async sessionId => { const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw Error(workspace.error.code);
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision,
        change: { kind: 'session', sessionId } }); if (!selected.ok) throw Error(selected.error.code); }, fork.data.session.sessionId);
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await expect(page.locator('.agent-chat-panel')).toContainText('Both checks returned.');
    await expect(page.locator('.agent-chat-panel .chat-subagents')).toHaveCount(0);
    await expect(page.locator('.agent-chat-panel')).not.toContainText('subagent_identity_conflict');
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { release(); await closeDesktopFixture(app, userData, failure); await provider.stop(); }
});
