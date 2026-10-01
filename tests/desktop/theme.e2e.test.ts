import { _electron as electron } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, mkdtemp, waitFor } from '../support/resources.ts';

it.setTimeout(30_000);
it.afterEach(cleanupResources);

it('desktop Theme opens on click and saves the chosen appearance', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-theme-'));
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const app = await electron.launch({
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000,
  });
  let checkpoint = 'first window';
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10_000);
    checkpoint = 'real Host readiness';
    await waitFor(() => page.evaluate(async () => {
      const state = await window.flowmate.getState();
      return state.ok && state.data.ready && state.data.host === 'ready';
    }));
    await page.locator('.rail').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.settings-appearance button')?.disabled === false);
    const theme = page.getByLabel('Theme');
    checkpoint = 'open Theme with click';
    await theme.click();
    await page.waitForFunction(() => document.querySelector('.settings-appearance select')?.matches(':open'), undefined, { timeout: 3000 });
    await theme.getByRole('option', { name: 'Light', exact: true }).click({ timeout: 3000 });
    expect(await theme.inputValue()).toBe('light');
    await theme.press('Space');
    await page.waitForFunction(() => document.querySelector('.settings-appearance select')?.matches(':open'), undefined, { timeout: 3000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await theme.inputValue()).toBe('dark');
    checkpoint = 'save dark appearance';
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await page.getByText('Profile preferences saved.', { exact: true }).waitFor();
    expect(JSON.parse(readFileSync(join(userData, 'data/settings.json'), 'utf8')).profile.theme).toBe('dark');
    checkpoint = 'reload saved appearance';
    await page.reload();
    await waitFor(() => page.evaluate(async () => {
      const state = await window.flowmate.getState();
      return state.ok && state.data.ready && state.data.host === 'ready';
    }));
    await page.locator('.rail').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('.settings-appearance select')?.value === 'dark');
    expect(await theme.inputValue()).toBe('dark');
    await theme.click();
    await page.waitForFunction(() => document.querySelector('.settings-appearance select')?.matches(':open'), undefined, { timeout: 3000 });
    expect(await theme.getByRole('option', { name: 'Follow system', exact: true }).isVisible()).toBe(true);
    expect(await theme.getByRole('option', { name: 'Light', exact: true }).isVisible()).toBe(true);
    expect(await theme.getByRole('option', { name: 'Dark', exact: true }).isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    expect(await theme.evaluate(element => element.matches(':open'))).toBe(false);
    expect(await theme.inputValue()).toBe('dark');
    await theme.click();
    await theme.getByRole('option', { name: 'Follow system', exact: true }).click();
    expect(await theme.inputValue()).toBe('system');
    checkpoint = 'save system appearance';
    await page.getByRole('button', { name: 'Save appearance' }).click();
    await page.getByText('Profile preferences saved.', { exact: true }).waitFor();
    expect(JSON.parse(readFileSync(join(userData, 'data/settings.json'), 'utf8')).profile.theme).toBe('system');
    checkpoint = 'normal desktop close';
  } catch (error) {
    failure = new Error(`Theme checkpoint ${checkpoint}`, { cause: error });
    throw failure;
  } finally { await closeDesktopFixture(app, userData, failure); }
});
