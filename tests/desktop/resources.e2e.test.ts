import { _electron as electron } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { ResourceCatalog } from '@flowmate/contracts';
import { cleanupResources, closeDesktopFixture, installReadGate, createHttpProvider, mkdtemp, Database } from '../support/resources.ts';

it.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
it('displays Core readiness independently of enablement and adapts both Skills entry points', async () => {
  it.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-skills-display-'));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'flowmate-skills-catalog-'));
  const catalogs: Record<'full' | 'partial' | 'zero' | 'invalid' | 'updated', ResourceCatalog> = JSON.parse(execFileSync('bun',
    ['--no-env-file', join(repository, 'tests/support/skill-ui-catalog.ts'), fixtureRoot], { encoding: 'utf8' }));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await page.getByRole('switch', { name: 'Enable invoice v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect(page.locator('.skill-row').filter({ has: page.getByRole('button', { name: 'View invoice v1', exact: true }) }).locator('.skill-row-copy p')).toContainText('Organize fields');
    await installReadGate(app, userData);
    let held = 0;
    async function display(catalog: ResourceCatalog) {
      await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'list_resources'));
      await page.getByRole('button', { name: 'Refresh resources', exact: true }).click();
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(held + 1);
      await app.evaluate((_electron, input) => {
        const gate = Reflect.get(globalThis, 'contextReadGate'), packet = JSON.parse(gate.held[input.index].toString());
        packet.value.data = { ...input.catalog, settingsRevision: packet.value.data.settingsRevision };
        gate.held[input.index] = Buffer.from(JSON.stringify(packet) + '\n'); gate.release(input.index);
      }, { catalog, index: held++ });
      await expect(page.getByRole('button', { name: 'Refresh resources', exact: true })).toBeEnabled();
    }
    const row = (id: string) => page.locator('.skill-row').filter({ has: page.getByRole('button', { name: `View ${id} v1`, exact: true }) });
    await display(catalogs.zero);
    await expect(row('invoice').getByText('0/5 capabilities', { exact: true })).toBeVisible();
    await expect(row('invoice').locator('.skill-capability-mark')).toHaveClass(/empty/);
    await expect(row('invoice').getByRole('switch')).toBeEnabled();
    await expect(row('invoice-source-audit').getByRole('switch')).toBeDisabled();
    await display(catalogs.partial);
    await expect(row('invoice').getByText('1/5 capabilities', { exact: true })).toBeVisible();
    await expect(row('invoice').locator('.skill-capability-mark')).toHaveClass(/partial/);
    await expect(row('invoice').getByRole('button', { name: 'read_invoice_evidence', exact: true })).toHaveAttribute('title', /unavailable/);
    await expect(row('invoice').locator('.skill-missing button')).toHaveCount(4);
    await row('invoice').getByRole('button', { name: 'read_invoice_evidence', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Resource details' })).toContainText('A declared tool is unavailable');
    await page.screenshot({ path: it.info().outputPath('skills-partial.png') });
    await page.getByRole('button', { name: 'Partial', exact: true }).click(); await expect(page.getByRole('switch')).toHaveCount(1);
    await page.getByRole('button', { name: 'Disabled', exact: true }).click(); await expect(row('invoice')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ready', exact: true }).click(); await expect(page.getByRole('switch')).toHaveCount(0);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(row('ui-no-requirements').getByText('No requirements', { exact: true })).toBeVisible();
    await expect(row('ui-no-requirements').getByRole('switch')).toBeEnabled();
    const mismatchedName = 'ui-skill-with-a-long-mismatched-name-preserved-for-accessibility';
    await expect(page.getByRole('button', { name: `View ${mismatchedName} (ui-name-mismatch v1)`, exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enable ui-name-mismatch v1', exact: true })).toBeDisabled();
    await display(catalogs.updated);
    await expect(row('invoice').locator('.skill-row-copy p')).toHaveText('同一名称的新介绍不应套用旧译文。');
    await expect(row('invoice').locator('.skill-row-copy p')).toHaveAttribute('title', '同一名称的新介绍不应套用旧译文。');
    await display(catalogs.invalid);
    await expect(row('invoice-source-audit').getByText('4/4 capabilities', { exact: true })).toBeVisible();
    await expect(row('invoice-source-audit').getByText('Unavailable', { exact: true })).toBeVisible();
    await expect(row('invoice-source-audit').getByRole('switch')).toBeDisabled();
    await display(catalogs.partial);
    await row('invoice').getByRole('switch').click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.listResources())).toMatchObject({ ok: true, data: { selection: { enabledSkills: [] } } });
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    // Recovery clears both the Prompt and Skill selection in one real save.
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'LLM', exact: true }).click();
    await page.locator('summary').filter({ hasText: /^Business instructions$/ }).click(); await page.getByRole('button', { name: 'Use invoice v1', exact: true }).click();
    await page.getByRole('button', { name: 'Skills', exact: true }).click(); await page.getByRole('switch', { name: 'Enable invoice v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.locator('summary').filter({ hasText: /^Resource recovery$/ }).focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Clear all resource selections', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.listResources())).toMatchObject({ ok: true, data: { selection: { prompt: null, enabledSkills: [] } } });
    await page.getByRole('button', { name: 'Close Assistant', exact: true }).click();
    await installReadGate(app, userData); held = 0;
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'General', exact: true }).click();
      await page.getByLabel('Theme').selectOption(theme); await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
      await page.getByRole('button', { name: 'Skills', exact: true }).click();
      await expect(page.locator('.desktop-shell')).toHaveClass(new RegExp(`theme-${theme}`));
      const name = row('invoice').getByRole('button', { name: 'View invoice v1', exact: true });
      await name.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('region', { name: 'Resource details' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Refresh resources', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Refresh resources', exact: true }).focus(); await expect(page.getByRole('button', { name: 'Refresh resources', exact: true })).toBeFocused();
      const copy = await row('invoice').locator('.skill-row-copy').boundingBox(), readiness = await row('invoice').locator('.skill-readiness').boundingBox();
      expect(readiness!.y).toBeLessThan(copy!.y + copy!.height);
      await page.screenshot({ path: it.info().outputPath(`skills-${theme}.png`) });
      await page.setViewportSize({ width: 850, height: 900 });
      const narrowCopy = await row('invoice').locator('.skill-row-copy').boundingBox(), narrowCount = await row('invoice').locator('.skill-readiness').boundingBox();
      expect(narrowCount!.y).toBeGreaterThanOrEqual(narrowCopy!.y + narrowCopy!.height);
      expect(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: it.info().outputPath(`skills-narrow-${theme}.png`) });
      await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Skills', exact: true }).click();
      await expect(page.locator('.embedded-resources .skill-controls')).toBeVisible(); await expect(row('invoice').getByText('5/5 capabilities', { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.locator('.embedded-resources').evaluate(node => { (node as HTMLElement).style.maxWidth = '650px'; });
      const embeddedCopy = await row('invoice').locator('.skill-row-copy').boundingBox(), embeddedCount = await row('invoice').locator('.skill-readiness').boundingBox();
      expect(embeddedCount!.y).toBeGreaterThanOrEqual(embeddedCopy!.y + embeddedCopy!.height);
      expect(await row('invoice').locator('.skill-row-copy p').evaluate(node => getComputedStyle(node).whiteSpace)).toBe('nowrap');
      await page.screenshot({ path: it.info().outputPath(`settings-skills-${theme}.png`) });
      await display(catalogs.zero);
      await expect(row('invoice').locator('.skill-missing button')).toHaveCount(5);
      expect(await row('invoice').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      for (const tag of await row('invoice').locator('.skill-missing button').all())
        await expect(tag).toHaveAttribute('title', /unavailable/);
      await page.screenshot({ path: it.info().outputPath(`settings-skills-missing-${theme}.png`) });
      await display(catalogs.full);
      await page.getByRole('button', { name: 'Skills', exact: true }).click();
    }
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { for (const table of ['runs', 'tool_calls', 'session_inputs']) expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 }); }
  finally { db.close(); }
});
it('manages fixed Prompt and Skill versions through real IPC without model or tool execution', async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p11-resources-ui-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    const original = await page.evaluate(() => window.flowmate.readWorkspace());
    await expect(page.getByRole('button', { name: 'Prompts', exact: true })).toHaveCount(1, { timeout: 3000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'LLM', exact: true }).click(); await page.locator('summary').filter({ hasText: /^Business instructions$/ }).click();
    await page.getByRole('button', { name: 'View invoice v1', exact: true }).click();
    await expect(page.getByTestId('resource-file')).toContainText('缺失');
    await page.getByRole('button', { name: 'Use invoice v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.listResources())).toMatchObject({ ok: true, data: { selection: { prompt: { id: 'invoice', version: 'v1' } } } });
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(17);
    const introductions = await page.locator('.skill-row-copy p').allTextContents();
    expect(introductions).toHaveLength(17);
    expect(introductions.every(text => text.length > 0 && !/[\u3400-\u9fff]/.test(text))).toBe(true);
    for (const description of await page.locator('.skill-row-copy p').all())
      await expect(description).toHaveAttribute('title', await description.textContent() ?? '');
    await page.getByLabel('Search skills').fill('explicitly requests saving');
    await expect(page.getByRole('switch', { name: 'Enable invoice-candidate-save v1', exact: true })).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(1);
    await page.getByLabel('Search skills').fill('无法辨认');
    await expect(page.getByRole('button', { name: 'View invoice v1', exact: true })).toBeVisible();
    await page.getByLabel('Search skills').fill('');
    await expect(page.locator('.skill-controls').getByRole('button', { name: 'Refresh resources', exact: true })).toBeVisible();
    await expect(page.locator('.skill-row').filter({ has: page.getByRole('button', { name: 'View invoice v1', exact: true }) }).getByText('5/5 capabilities', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear all resource selections', exact: true })).toBeHidden();
    await page.locator('summary').filter({ hasText: /^Resource recovery$/ }).click();
    await expect(page.getByRole('button', { name: 'Clear all resource selections', exact: true })).toBeVisible();
    await page.locator('summary').filter({ hasText: /^Resource recovery$/ }).click();
    const library = await page.evaluate(() => window.flowmate.listResources());
    expect(library).toMatchObject({ ok: true, data: { selection: { enabledSkills: [] } } });
    if (!library.ok) throw new Error(library.error.code);
    expect(library.data.items.filter(item => item.ref.kind === 'skill')).toHaveLength(17);
    await page.getByLabel('Search skills').fill('invoice-source-audit');
    await expect(page.getByRole('switch')).toHaveCount(1);
    await page.getByRole('switch', { name: 'Enable invoice-source-audit v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.getByRole('button', { name: 'View invoice-source-audit v1', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Resource details' })).toContainText('Verify source identities');
    await expect(page.getByTestId('resource-file')).toContainText('check_invoice_sources');
    await page.getByRole('combobox', { name: 'Resource file', exact: true }).selectOption('references/guide.md');
    await expect(page.getByTestId('resource-file')).toContainText('来源');
    const savedSelection = await page.evaluate(() => window.flowmate.listResources());
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Skills', exact: true }).click();
    await expect(page.locator('.embedded-resources .skill-row')).toHaveCount(17);
    const embeddedIntroductions = await page.locator('.embedded-resources .skill-row-copy p').allTextContents();
    expect(embeddedIntroductions).toEqual(introductions);
    expect(await page.evaluate(() => window.flowmate.listResources())).toEqual(savedSelection);
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await page.getByLabel('Search skills').fill('invoice-source-audit');
    await page.getByRole('switch', { name: 'Disable invoice-source-audit v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.getByLabel('Search skills').fill('invoice');
    await page.getByRole('button', { name: 'Disabled', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Enable invoice v1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Partial', exact: true }).click();
    await expect(page.getByText('No matching resources.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('switch', { name: 'Enable invoice v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await page.getByRole('button', { name: 'View invoice v1', exact: true }).click();
    await expect(page.getByTestId('resource-file')).toContainText('发票');
    await page.getByRole('switch', { name: 'Disable invoice v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh resources', exact: true }).click();
    expect(await page.evaluate(() => window.flowmate.listResources())).toMatchObject({ ok: true, data: { selection: { enabledSkills: [] } } });
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'read_resource_file'));
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'LLM', exact: true }).click(); await page.locator('summary').filter({ hasText: /^Business instructions$/ }).click(); await page.getByRole('button', { name: 'View invoice v1', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await page.getByRole('button', { name: 'Skills', exact: true }).click(); await page.getByRole('button', { name: 'View invoice v1', exact: true }).click();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(page.getByTestId('resource-file')).toHaveCount(0); await expect(page.getByText('Enable this Skill to read its files.', { exact: true })).toBeVisible();
    await app.evaluate(() => { const gate = Reflect.get(globalThis, 'contextReadGate'); gate.hold(0, 'update_resource_selection'); gate.fail(); });
    await page.getByRole('switch', { name: 'Enable invoice v1', exact: true }).click();
    await expect(page.getByText('Refresh resources to confirm the saved selection before trying again.', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Enable invoice v1', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.flowmate.listResources())).toMatchObject({ ok: true, data: { selection: { enabledSkills: [{ id: 'invoice', version: 'v1' }] } } });
    await page.getByRole('button', { name: 'Refresh resources', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Disable invoice v1', exact: true })).toBeEnabled();
    expect(await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands.filter((command: { type: string }) => command.type === 'update_resource_selection').length)).toBe(1);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(original);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { for (const table of ['runs', 'tool_calls', 'session_inputs']) expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 }); }
  finally { db.close(); }
});

it('atomically clears multiple unavailable selected resources through visible controls without a Run or model request', async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p11-resource-recovery-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const launch = () => electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
    env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  let app = await launch(), failure: Error | undefined;
  try {
    let page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    const saved = await page.evaluate(async () => {
      const state = await window.flowmate.getState(), catalog = await window.flowmate.listResources();
      if (!state.ok || !catalog.ok) throw new Error('Fixture settings unavailable');
      const prompt = catalog.data.items.find(item => item.ref.kind === 'prompt' && item.ref.id === 'invoice')!.ref,
        skill = catalog.data.items.find(item => item.ref.kind === 'skill' && item.ref.id === 'invoice')!.ref;
      return { ...state.data.settings, revision: state.data.settings.revision + 1,
        resources: { prompt: { ...prompt, version: 'missing-prompt' }, enabledSkills: [{ ...skill, version: 'missing-skill' }] } };
    });
    await app.close();
    // Seed an isolated restart whose previously saved author versions are now unavailable. Recovery uses only real controls/IPC.
    await writeFile(join(userData, 'data', 'settings.json'), JSON.stringify(saved)); app = await launch();
    page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'LLM', exact: true }).click(); await page.locator('summary').filter({ hasText: /^Business instructions$/ }).click();
    await expect(page.getByText('Missing enabled version: invoice missing-skill', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear all resource selections', exact: true })).toHaveCount(1, { timeout: 3000 });
    await page.getByRole('button', { name: 'Use no business Prompt', exact: true }).click();
    await expect(page.getByText('Refresh resources to confirm the saved selection before trying again.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.listResources())).toMatchObject({ ok: true, data: { selection: saved.resources } });
    await page.getByRole('button', { name: 'Refresh resources', exact: true }).click();
    await page.getByRole('button', { name: 'Clear all resource selections', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.listResources())).toMatchObject({ ok: true, data: { selection: { prompt: null, enabledSkills: [] } } });
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { models: saved.models, revision: saved.revision + 1 } } });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { for (const table of ['runs', 'tool_calls', 'session_inputs']) expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 }); }
  finally { db.close(); }
});


it('uses the desktop Prompt in real SDK and HTTP requests, rejects unavailable necessary Skill without losing the draft, and queries fixed history without replay', async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p11-request-ui-'));
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const provider = await createHttpProvider(async request => {
    payloads.push(await request.json());
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p11-ui', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'P11 controlled answer' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    const sessionId = await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error(state.error.code);
      const settings = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p11-ui', credentialRef: 'p11_ui_controlled_key', name: 'P11 UI',
        kind: 'custom', providerId: null, baseUrl, model: 'p11-ui', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }],
        defaultModelId: 'p11-ui' }, { modelId: 'p11-ui', apiKey: 'synthetic-p11-ui-key' });
      if (!settings.ok) throw new Error(settings.error.code);
      const session = await window.flowmate.createSession({ title: 'P11 real desktop request' }); if (!session.ok) throw new Error(session.error.code);
      const current = await window.flowmate.readWorkspace(); if (!current.ok) throw new Error(current.error.code);
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: current.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } });
      if (!selected.ok) throw new Error(selected.error.code); return session.data.sessionId;
    }, `http://127.0.0.1:${provider.port}/v1`);
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'LLM', exact: true }).click(); await page.locator('summary').filter({ hasText: /^Business instructions$/ }).click(); await page.getByRole('button', { name: 'Use invoice v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.getByRole('button', { name: 'Skills', exact: true }).click(); await page.getByRole('switch', { name: 'Enable invoice v1', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    const message = page.getByRole('textbox', { name: 'Message to model', exact: true }); await message.fill('/skill:invoice Keep my original P11 input');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'A declared tool is unavailable in this scope.' })).toBeVisible();
    await expect(message).toHaveValue('/skill:invoice Keep my original P11 input');
    await expect.poll(() => page.evaluate(sessionId => window.flowmate.listSessionRuns({ sessionId }), sessionId)).toMatchObject({ ok: true, data: { items: [] } });
    expect(payloads).toHaveLength(0);
    await message.fill('Keep my original P11 input'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    const runs = await page.evaluate(sessionId => window.flowmate.listSessionRuns({ sessionId }), sessionId);
    if (!runs.ok || !runs.data.items[0]) throw new Error('No saved Run'); const runId = runs.data.items[0].runId;
    expect(payloads[0].messages.find(item => item.role === 'system')?.content).toContain('缺失');
    expect(await page.evaluate(owner => window.flowmate.queryRunResources(owner), { sessionId, runId }))
      .toMatchObject({ ok: true, data: { frozen: { prompt: { id: 'invoice', version: 'v1' }, discoveredSkills: [] }, evidence: { requests: [
        { contentChecks: [{ scope: 'business-prompt', sdkInclusion: 'confirmed', wireInclusion: 'confirmed' },
          { scope: 'skill-readiness', ref: { id: 'invoice' }, sdkInclusion: 'confirmed', wireInclusion: 'confirmed' }] }] } } });
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel.getByRole('heading', { name: 'Run resources', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'View fixed invoice v1', exact: true }).click(); await expect(panel.getByTestId('resource-file')).toContainText('缺失');
    await panel.getByRole('button', { name: 'Refresh Run resources', exact: true }).click(); expect(payloads).toHaveLength(1);
    expect(await page.evaluate(() => window.flowmate.queryRunResources({ sessionId: 1, runId: 1, secret: 'forged' } as never)))
      .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(payloads).toHaveLength(1);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); await provider.stop(); }
});
