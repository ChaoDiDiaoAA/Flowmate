import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import type { DocumentSnapshot } from '@flowmate/contracts';
import { configure, environment, root, seed, stream } from './support/personal-agent-desktop.ts';
import { cleanupResources, closeDesktopFixture, createHttpProvider } from '../../tests/support/resources.ts';
import { scenario } from './report.ts';
import { scenarios } from './scenarios.ts';

test.afterEach(cleanupResources);

test('Personal Agent shows committed progress, timing and the execution behind candidate feedback', scenario('desktop-progress', async ({ check, refs }) => {
  test.setTimeout(scenarios['desktop-progress'].timeoutMs);
  const userData = await seed();
  let document!: DocumentSnapshot;
  let calls = 0;
  const gate = Promise.withResolvers<void>();
  const provider = await createHttpProvider(async () => {
    if (++calls === 1) {
      await gate.promise;
      return stream({ document, id: calls });
    }
    return stream('Candidate saved.');
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
      args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30_000 });
    const page = await app.firstWindow();
    await configure(page, 'http://127.0.0.1:' + provider.port);
    const materials = await page.evaluate(() => window.flowmate.listDocuments({ limit: 10 }));
    if (!materials.ok || !materials.data.items[0]) throw Error('Synthetic invoice unavailable');
    document = materials.data.items[0];
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal', { exact: true }).fill('Save the synthetic invoice candidate.');
    await page.locator('.personal-create input[type=checkbox]').first().check();
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await page.getByRole('button', { name: 'Local workspace', exact: true }).click();
    await expect(page.getByText(/Attempt 1 · running/)).toBeVisible();
    await page.getByRole('tab', { name: 'Tasks' }).click();
    await expect(page.getByText(/Attempt 1: running/)).toBeVisible();
    check('calls-after-reload', 1, calls);
    gate.resolve();
    await expect(page.locator('.personal-work-detail > p').filter({ hasText: /Attempt 1 · completed/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Attempt 1: completed · stop confirmed/)).toBeVisible();
    await page.getByRole('tab', { name: 'Timeline' }).click();
    const candidate = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'candidate generated', exact: true }) });
    await candidate.getByText('Candidate feedback', { exact: true }).click();
    await candidate.getByRole('button', { name: 'Helpful', exact: true }).click();
    await candidate.getByRole('button', { name: 'View original execution' }).click();
    await expect(page.getByText(/Original execution: Attempt 1 · Phase \d+ · ToolCall \d+/)).toBeVisible();
    await expect(page.getByText('save_invoice_candidate · succeeded', { exact: false })).toBeVisible();
    const original = await page.getByText(/Original execution: Attempt 1 · Phase \d+ · ToolCall \d+/).innerText();
    const toolCall = /ToolCall (\d+)/.exec(original);
    if (toolCall) refs.toolCallId = Number(toolCall[1]);
    check('original-tool-call', true, refs.toolCallId > 0);
    await page.getByText('Model request diagnostics', { exact: true }).click();
    await expect(page.getByText(/HTTP 1: 200/).first()).toBeVisible();
    await expect(page.getByText(/First visible text:/).first()).toBeVisible();
    check('provider-calls', 2, calls);
  } finally {
    gate.resolve();
    try { if (app) await closeDesktopFixture(app, userData); }
    finally { await provider.stop(); }
  }
}));
