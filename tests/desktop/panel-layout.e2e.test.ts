import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, installReadGate, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
test('resizes and remembers panels without disturbing drafts, with keyboard, themes and narrow containers', async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-panel-layout-'));
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const launch = () => electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env, timeout: 30000 });
  let app = await launch(), failure: Error | undefined;
  try {
    let page = await app.firstWindow();
    const ready = async () => { await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 }); };
    await ready(); await page.setViewportSize({ width: 1500, height: 950 });
    const sidebar = () => page.getByRole('separator', { name: 'Resize navigation', exact: true });
    const assistant = () => page.getByRole('separator', { name: 'Resize Assistant', exact: true });
    const input = () => page.getByRole('textbox', { name: 'Message to model', exact: true });
    await expect(sidebar()).toBeVisible(); await expect(assistant()).toBeVisible();
    await input().fill('Draft retained while resizing.');
    const original = await input().elementHandle();
    await installReadGate(app, userData);
    async function drag(handle: ReturnType<typeof sidebar>, distance: number) {
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 240);
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + distance, box.y + 245, { steps: 8 }); await page.mouse.up();
    }
    await drag(sidebar(), 80); await expect(sidebar()).toHaveAttribute('aria-valuenow', '320');
    await drag(assistant(), -100); await expect(assistant()).toHaveAttribute('aria-valuenow', '480');
    await expect(input()).toHaveValue('Draft retained while resizing.');
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    const widths = await page.evaluate(() => ['.desktop-shell', 'main'].map(selector => document.querySelector(selector)!.getBoundingClientRect().width));
    expect(widths[1]).toBeCloseTo(widths[0]! - 320 - 480, 1);
    const cancelBox = (await sidebar().boundingBox())!;
    await page.mouse.move(cancelBox.x + 4, cancelBox.y + 100); await page.mouse.down();
    await expect(page.locator('.desktop-shell')).toHaveClass(/panels-resizing/);
    await sidebar().dispatchEvent('pointerdown', { pointerId: 2, isPrimary: false, button: 0 });
    await sidebar().dispatchEvent('pointerdown', { pointerId: 3, isPrimary: true, button: 0 });
    await sidebar().dispatchEvent('pointerup', { pointerId: 2 });
    await expect(page.locator('.desktop-shell')).toHaveClass(/panels-resizing/);
    await sidebar().dispatchEvent('pointercancel', { pointerId: 1 });
    await expect(page.locator('.desktop-shell')).not.toHaveClass(/panels-resizing/); await page.mouse.up();
    await sidebar().focus(); await page.keyboard.press('ArrowRight'); await expect(sidebar()).toHaveAttribute('aria-valuenow', '330');
    await page.keyboard.press('Shift+ArrowLeft'); await expect(sidebar()).toHaveAttribute('aria-valuenow', '280');
    await page.keyboard.press('Home'); await expect(sidebar()).toHaveAttribute('aria-valuenow', '240');
    await assistant().focus(); await page.keyboard.press('Shift+ArrowLeft'); await expect(assistant()).toHaveAttribute('aria-valuenow', '530');
    await assistant().dblclick(); await expect(assistant()).toHaveAttribute('aria-valuenow', '380');
    await drag(assistant(), -180); await expect(assistant()).toHaveAttribute('aria-valuenow', '560');
    await page.getByRole('button', { name: 'Close Assistant', exact: true }).click(); await expect(assistant()).toHaveCount(0);
    await sidebar().focus(); await sidebar().press('ArrowRight'); await expect(sidebar()).toHaveAttribute('aria-valuenow', '250');
    await sidebar().press('Home');
    await page.getByRole('button', { name: 'Open Assistant', exact: true }).click(); await expect(assistant()).toHaveAttribute('aria-valuenow', '560');
    await page.setViewportSize({ width: 1200, height: 950 }); await expect(assistant()).toHaveAttribute('aria-valuenow', '560');
    await drag(sidebar(), 5000); await expect(sidebar()).toHaveAttribute('aria-valuenow', '280');
    const centerWidth = await page.locator('main').evaluate(element => element.clientWidth);
    expect(centerWidth).toBeGreaterThanOrEqual(360); expect(centerWidth).toBeLessThanOrEqual(361);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const root = document.querySelector('.desktop-shell')!; root.classList.remove('theme-light', 'theme-dark', 'theme-system'); root.classList.add('theme-'+theme); }, theme);
      for (const name of ['Models', 'Prompts', 'Skills', 'Settings']) {
        await page.getByRole('button', { name, exact: true }).click();
        expect(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        if (name === 'Models') expect(await page.locator('.model-layout').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
        if (name === 'Prompts') expect(await page.locator('.prompt-editors').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
      }
      await page.screenshot({ path: test.info().outputPath('panel-layout-'+theme+'.png') });
    }
    // Window fitting must not overwrite the user's saved widths.
    await page.setViewportSize({ width: 1100, height: 950 }); await expect(sidebar()).toHaveCount(0); await expect(assistant()).toBeVisible();
    await assistant().focus(); await assistant().press('ArrowLeft'); await expect(assistant()).toHaveAttribute('aria-valuenow', '570');
    await page.setViewportSize({ width: 980, height: 950 }); await expect(assistant()).toHaveCount(0);
    await page.setViewportSize({ width: 1500, height: 950 }); await expect(sidebar()).toHaveAttribute('aria-valuenow', '280');
    await expect(assistant()).toHaveAttribute('aria-valuenow', '570');
    await assistant().focus(); await assistant().press('ArrowRight'); await expect(assistant()).toHaveAttribute('aria-valuenow', '560');
    expect(await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands.filter((command: { type: string }) =>
      ['submit_input', 'call_provider', 'start_run', 'start_agent_run'].includes(command.type)).length)).toBe(0);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await page.reload(); await ready(); await expect(sidebar()).toHaveAttribute('aria-valuenow', '280'); await expect(assistant()).toHaveAttribute('aria-valuenow', '560');
    await closeDesktopFixture(app, userData); app = await launch(); page = await app.firstWindow(); await ready();
    await page.setViewportSize({ width: 1500, height: 950 }); await expect(sidebar()).toHaveAttribute('aria-valuenow', '280'); await expect(assistant()).toHaveAttribute('aria-valuenow', '560');
    await page.evaluate(() => localStorage.setItem('flowmate.panel-widths', JSON.stringify({ sidebar: 500, assistant: 600 })));
    await page.setViewportSize({ width: 1200, height: 950 }); await page.reload(); await ready();
    await expect(sidebar()).toHaveAttribute('aria-valuenow', '500'); await expect(assistant()).toHaveAttribute('aria-valuenow', '340');
    await drag(sidebar(), -100); await expect(sidebar()).toHaveAttribute('aria-valuenow', '400');
    await expect(assistant()).toHaveAttribute('aria-valuenow', '340');
    await page.evaluate(() => localStorage.setItem('flowmate.panel-widths', '{broken')); await page.reload(); await ready();
    await expect(sidebar()).toHaveAttribute('aria-valuenow', '240'); await expect(assistant()).toHaveAttribute('aria-valuenow', '380');
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('Storage blocked'); };
      Storage.prototype.setItem = () => { throw new Error('Storage blocked'); };
    });
    await page.reload(); await ready(); await expect(sidebar()).toHaveAttribute('aria-valuenow', '240');
    await expect(assistant()).toHaveAttribute('aria-valuenow', '380');
    await sidebar().focus(); await page.keyboard.press('ArrowRight'); await expect(sidebar()).toHaveAttribute('aria-valuenow', '250');
    // Electron zoom exposes fractional CSS viewport widths at both responsive boundaries.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.25));
    for (const boundary of [1200, 1080]) {
      let found = false;
      for (let pixels = boundary * 1.25 - 3; pixels <= boundary * 1.25 + 3; pixels++) {
        await page.setViewportSize({ width: pixels, height: 950 });
        found = await page.evaluate(boundary => matchMedia(`(width > ${boundary - 1}px) and (width < ${boundary}px)`).matches, boundary);
        if (found) break;
      }
      expect(found).toBe(true);
      await expect(sidebar()).toHaveCount(0);
      if (boundary === 1200) {
        await expect(assistant()).toBeVisible();
        await expect(page.locator('.brand-wordmark')).toBeHidden();
      } else {
        await expect(assistant()).toHaveCount(0);
        expect(await page.locator('.agent-chat-panel').evaluate(element => getComputedStyle(element).position)).toBe('fixed');
      }
    }
  } catch (error) { failure = error as Error; throw error; }
  finally { await closeDesktopFixture(app, userData, failure); }
});
