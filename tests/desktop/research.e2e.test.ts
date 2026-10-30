import { _electron as electron, type Page } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, installReadGate, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
const root = resolve(import.meta.dirname, '../..');
function environment(userData: string) {
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}

test('research restores unfinished steps after relaunch and acquires them only after Continue', async () => {
  test.setTimeout(90000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-research-checkpoint-ui-'));
  let requests = 0, artifactId = 0;
  const policy = () => ({ web: false, domains: [], artifactIds: [artifactId], documentIds: [] });
  const provider = await createHttpProvider(async () => {
    const index = ++requests;
    const execution = { budget: { maxModelCalls: 8, maxToolCalls: 16, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 };
    const tool = index === 1 ? { name: 'save_research_plan', args: { question: 'Restore the local policy research.', scope: 'Selected local policy only.',
      dimensions: [{ id: 'policy', title: 'Policy', questions: [{ id: 'local', question: 'What does the policy require?', evidenceNeeded: ['Selected policy'] }] }],
      sourcePolicy: policy(), stopConditions: ['Policy is cited or an explicit gap is saved.'], execution,
      steps: [{ id: 'policy-source', questionIds: ['local'], tool: 'read_research_local', input: { artifactId, documentId: null } }] } }
      : index === 3 || index === 6 ? { name: 'read_research_local', args: { artifactId, documentId: null, stepId: index === 3 ? 'wrong-step' : 'policy-source' } }
      : index === 4 ? { name: 'save_research_report', args: { answer: 'The source still needs acquisition.', completeness: 'partial',
        sections: [{ title: 'Evidence gap', text: 'The planned source has not been acquired.', claimIds: [] }], conflicts: [],
        limitations: ['Acquisition was rejected because it used the wrong step.'], unresolvedQuestions: ['What does the policy require?'],
        coverage: [{ questionId: 'local', claimIds: [], status: 'gap', reason: 'Acquire the confirmed source step.' }] } } : null;
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `checkpoint-${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: 'assistant', content: 'Saved checkpoint. Continue explicitly when ready.' };
    return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    const launch = () => electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
      args: [join(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    app = await launch(); let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Deep Research', exact: true }).waitFor({ timeout: 20000 });
    const created = await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw Error(state.error.code);
      const saved = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'checkpoint-ui', credentialRef: '00000000000000000000000000000031',
        name: 'Checkpoint fixture', kind: 'custom', providerId: null, baseUrl: `${baseUrl}/v1`, model: 'checkpoint-ui', api: 'openai-completions',
        contextWindow: 64000, maxTokens: 4096, reasoning: false }], defaultModelId: 'checkpoint-ui' }, { modelId: 'checkpoint-ui', apiKey: 'synthetic-checkpoint-key' });
      if (!saved.ok) throw Error(saved.error.code);
      const material = await window.flowmate.importResearchMaterial({ title: 'Checkpoint policy.md', format: 'markdown', text: 'The selected policy requires local execution.' });
      if (!material.ok) throw Error(material.error.code);
      const session = await window.flowmate.createSession({ title: 'Checkpoint research' }); if (!session.ok) throw Error(session.error.code);
      const task = await window.flowmate.createResearchTask({ sessionId: session.data.sessionId, title: 'Checkpoint research',
        sourcePolicy: { web: false, domains: [], artifactIds: [material.data.artifactId], documentIds: [] } });
      if (!task.ok) throw Error(task.error.code);
      return { task: task.data, artifactId: material.data.artifactId };
    }, `http://127.0.0.1:${provider.port}`);
    artifactId = created.artifactId;
    await page.getByRole('button', { name: 'Deep Research', exact: true }).click();
    await page.getByRole('complementary', { name: 'Research list', exact: true }).getByRole('button', { name: 'Checkpoint research', exact: false }).first().click();
    const expand = page.getByRole('button', { name: 'Open Assistant', exact: true }); if (await expand.isVisible()) await expand.click();
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Plan the selected local policy research.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm plan version 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue research', exact: true })).toBeEnabled();
    await expect.poll(() => requests).toBe(5);
    const count = requests;
    await closeDesktopFixture(app, userData); app = null;
    app = await launch(); page = await app.firstWindow();
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_research_task'));
    await page.reload();
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const independentDraft = 'Keep this new conversation independent of restored research.';
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill(independentDraft);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('flowmate.workspace-focus.v1') ?? '{}').page)).toBe('conversation');
    await expect(page.getByRole('textbox', { name: 'Message to model', exact: true })).toHaveValue(independentDraft);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await page.getByRole('button', { name: 'Deep Research', exact: true }).click();
    await page.getByRole('complementary', { name: 'Research list', exact: true }).getByRole('button', { name: 'Checkpoint research', exact: false }).first().click();
    await expect(page.getByRole('heading', { name: 'Deep Research', exact: true })).toBeVisible({ timeout: 20000 });
    const resume = page.getByRole('button', { name: 'Continue research', exact: true });
    await expect(resume).toBeEnabled({ timeout: 20000 });
    expect(requests).toBe(count);
    await resume.click();
    await expect(page.getByRole('region', { name: 'Research steps', exact: true })).toContainText('1 / 1 sources acquired');
    await expect.poll(() => requests).toBe(7);
    const sources = await page.evaluate(id => window.flowmate.listResearchSources({ researchId: id }), created.task.researchId);
    expect(sources).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ artifactId })] } });
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').fail(1, 'restore_workspace'));
    await page.reload();
    await expect(page.getByRole('region', { name: 'Research steps', exact: true })).toContainText('1 / 1 sources acquired', { timeout: 20000 });
    expect(requests).toBe(7);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
  } finally { if (app) await closeDesktopFixture(app, userData); }
});

test('research desktop creates and confirms a plan, reads local evidence, exports and reopens without replay', async () => {
  test.setTimeout(90000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p15-ui-')), text = 'Team policy: deployments must run locally.';
  let page!: Page, requests = 0, holdNext = false, releaseHeld: () => void = () => {};
  const provider = await createHttpProvider(async request => {
    const body = await request.json() as { tools?: Array<{ function: { name: string } }> };
    const index = ++requests;
    if (holdNext) { holdNext = false; await new Promise<void>(resolve => { releaseHeld = resolve; }); }
    let tool: { name: string; arguments: unknown } | null = null;
    if (index === 1 || index === 3) {
      expect(body.tools?.some(item => item.function.name.includes('search_research'))).toBe(false);
      const task = await page.evaluate(async () => { const r = await window.flowmate.listResearchTasks(); if (!r.ok) throw new Error(r.error.code); return r.data.items[0]!; });
      tool = { name: 'save_research_plan', arguments: { question: task.title, scope: 'Use only selected team policy.',
        dimensions: [{ id: 'deployment', title: 'Deployment constraints', questions: [{ id: 'local', question: 'Where must deployment run?', evidenceNeeded: ['Team policy'] }] }],
        sourcePolicy: task.sourcePolicy, stopConditions: ['The deployment constraint has evidence or an explicit gap.'],
        steps: [{ id: 'team-policy', questionIds: ['local'], tool: 'read_research_local', input: { artifactId: task.sourcePolicy.artifactIds[0], documentId: null } }],
        execution: { budget: { maxModelCalls: 8, maxToolCalls: 16, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 } } };
    } else if (index === 5) {
      const material = await page.evaluate(async () => { const r = await window.flowmate.listResearchMaterials(); if (!r.ok) throw new Error(r.error.code); return r.data.items[0]!; });
      tool = { name: 'read_research_local', arguments: { artifactId: material.artifactId, documentId: null, stepId: 'team-policy' } };
    } else if (index === 6) {
      const facts = await page.evaluate(async () => { const tasks = await window.flowmate.listResearchTasks(); if (!tasks.ok) throw new Error(tasks.error.code); const task = tasks.data.items[0]!;
        const plan = await window.flowmate.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! });
        const sources = await window.flowmate.listResearchSources({ researchId: task.researchId }); if (!plan.ok || !sources.ok) throw new Error('Saved evidence missing');
        return { task, plan: plan.data, source: sources.data.items[0]! }; });
      tool = { name: 'save_research_claim', arguments: { questionId: 'local', text: 'Deployment must run locally.', dependencies: [],
        evidence: [{ relation: 'supports', ref: { researchId: facts.task.researchId, planId: facts.plan.planId, revision: facts.plan.revision,
          runId: facts.source.runId, toolCallId: facts.source.toolCallId, sourceSnapshotId: facts.source.sourceSnapshotId,
          locator: { start: 0, end: text.length, quote: text } } }], verification: { status: 'supported', reasons: ['The selected team policy explicitly requires local deployment.'] } } };
    } else if (index === 7 || index === 9) {
      const claimIds = await page.evaluate(async () => { const tasks = await window.flowmate.listResearchTasks(); if (!tasks.ok) throw new Error(tasks.error.code); const task = tasks.data.items[0]!;
        const claims = await window.flowmate.listResearchClaims({ researchId: task.researchId, planId: task.currentPlanId! }); if (!claims.ok) throw new Error(claims.error.code); return claims.data.items.map(item => item.claimId); });
      tool = { name: 'save_research_report', arguments: { answer: index === 9 ? 'Updated report: deployment must run locally.' : 'Deployment must run locally.', sections: [{ title: 'Deployment constraint', text, claimIds }],
        completeness: index === 9 ? 'partial' : 'full', conflicts: [], limitations: ['Engineering fixture; no product recommendation is validated.'], unresolvedQuestions: [],
        coverage: [{ questionId: 'local', claimIds, status: 'covered', reason: 'The selected policy supports the deployment constraint.' }] } };
    }
    const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'p15-ui', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `research-${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: index === 2 || index === 4 ? 'The plan is saved. Confirm it to investigate.' : index >= 9 ? 'Explicit follow-up completed.' : 'The research report is saved.' };
    return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    expect(await page.evaluate(async baseUrl => { const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'research-ui', credentialRef: '00000000000000000000000000000030', name: 'Research fixture', kind: 'custom', providerId: null,
        baseUrl: `${baseUrl}/v1`, model: 'research-ui', api: 'openai-completions', contextWindow: 64000, maxTokens: 4096, reasoning: false }], defaultModelId: 'research-ui' },
      { modelId: 'research-ui', apiKey: 'synthetic-research-model-key' }); }, `http://127.0.0.1:${provider.port}`)).toMatchObject({ ok: true });
    const before = await page.evaluate(() => window.flowmate.readWorkspace());
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'Research preferences', exact: true }).fill('Compare evidence dates and retain conflicting statements.');
    await page.getByRole('button', { name: 'Save research preferences', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Research preferences saved');
    await page.getByRole('button', { name: 'Deep Research', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Deep Research', exact: true })).toBeVisible();
    await expect(page.getByText('Search service settings', { exact: true })).toHaveCount(0);
    await expect(page.getByText('No research yet. Create a question to begin.', { exact: true })).toBeVisible();
    expect(await page.evaluate(async () => {
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh research')!.click();
      await Promise.resolve(); return document.querySelector('.research-detail')?.getAttribute('aria-busy');
    })).toBe('true');
    await expect(page.locator('.research-detail')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Open Assistant', exact: true }).click();
    await expect(page.locator('.chat-empty')).toContainText('Explore your research question');
    const newResearch = page.getByRole('button', { name: 'New research', exact: true }); await newResearch.focus(); await newResearch.press('Enter');
    await expect(page.getByRole('button', { name: 'Open Assistant', exact: true })).toBeVisible();
    await expect(page.getByLabel('Research question', { exact: true })).toBeFocused();
    await expect(page.getByRole('complementary', { name: 'Research list', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create research', exact: true })).toBeDisabled();
    await page.getByLabel('Research question', { exact: true }).fill('Compare Agent deployments using team constraints');
    await page.locator('.research-scope > summary').click();
    await page.getByLabel('Research scope and constraints', { exact: true }).fill('Use the selected local team policy.');
    await page.getByLabel('Import text or Markdown', { exact: true }).setInputFiles({ name: 'too-large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2_000_001, 'x') });
    await expect(page.getByRole('alert')).toContainText('Choose a UTF-8 text file no larger than 2 MB.'); expect(requests).toBe(0);
    await page.getByLabel('Import text or Markdown', { exact: true }).setInputFiles({ name: 'team-policy.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
    await expect(page.getByLabel('team-policy.md', { exact: false })).toBeChecked().catch(async failure => {
      const diagnostic = await page.evaluate(async text => window.flowmate.importResearchMaterial({ title: 'team-policy.md', format: 'markdown', text }), text);
      throw new Error(`${String(failure)}\nImport receipt: ${JSON.stringify(diagnostic)}`);
    });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.locator('.research-scope > summary').click();
    await page.screenshot({ path: join(root, '.superpowers/sdd/research-ui-refinement/new-research.png') });
    await page.getByRole('button', { name: 'Create research', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close Assistant', exact: true })).toBeVisible();
    const send = page.getByRole('button', { name: 'Send', exact: true }); await expect(send).toBeEnabled(); await send.click();
    const initialConfirm = page.getByRole('button', { name: 'Confirm plan version 1', exact: true }); await expect(initialConfirm).toBeEnabled({ timeout: 20000 });
    expect(requests).toBe(2);
    const firstPlan = await page.evaluate(async () => { const tasks = await window.flowmate.listResearchTasks(); if (!tasks.ok) throw new Error(tasks.error.code); const task = tasks.data.items[0]!;
      const plan = await window.flowmate.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }); if (!plan.ok) throw new Error(plan.error.code); return plan.data; });
    await page.getByLabel('Plan changes', { exact: true }).fill('Make the local deployment constraint explicit before investigating.');
    await page.getByRole('button', { name: 'Revise plan', exact: true }).click();
    const confirm = page.getByRole('button', { name: 'Confirm plan version 2', exact: true }); await expect(confirm).toBeEnabled({ timeout: 20000 }); expect(requests).toBe(4);
    expect(await page.evaluate(async plan => { const task = await window.flowmate.queryResearchTask(plan.researchId); if (!task.ok) throw new Error(task.error.code);
      return window.flowmate.submitInput({ sessionId: task.data.sessionId, clientSequence: 3, mode: 'prompt', text: 'Old confirmation must fail.', modelId: 'research-ui',
        research: { researchId: plan.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } } }); }, firstPlan)).toMatchObject({ ok: false, error: { code: 'research_plan_stale' } });
    await confirm.click();
    await expect(page.locator('.chat-transcript')).toContainText('The research report is saved.', { timeout: 20000 });
    await page.getByRole('button', { name: 'Report', exact: true }).click(); await expect(page.locator('.research-detail')).toContainText('Deployment must run locally.');
    await expect(page.getByRole('button', { name: 'Open Assistant', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Inspect claim 1', exact: true }).click();
    await expect(page.locator('.research-detail')).toContainText('Claim 1 · supported');
    await page.getByRole('button', { name: 'Inspect evidence for claim 1 / source 1', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Saved source text', exact: true })).toContainText(text);
    await page.getByRole('button', { name: 'Report', exact: true }).click();
    const output = join(userData, 'research-report.md');
    await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as typeof dialog.showSaveDialog; }, output);
    await page.locator('.research-report-footer').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Save report', exact: true }).click(); await expect(page.getByRole('status')).toContainText(output);
    await expect(page.getByRole('status')).toBeInViewport();
    expect(readFileSync(output, 'utf8')).toContain(text); expect(readFileSync(output, 'utf8')).toContain('ToolCall');
    await page.screenshot({ path: join(root, '.superpowers/sdd/research-ui-refinement/research-report.png') });
    // The existing no-overwrite publication failure must preserve both reports and external content.
    const conflictPath = join(userData, 'different-content.md'); writeFileSync(conflictPath, 'Keep my existing file.');
    await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as typeof dialog.showSaveDialog; }, conflictPath);
    await page.getByRole('button', { name: 'Save report', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(readFileSync(conflictPath, 'utf8')).toBe('Keep my existing file.');
    await expect(page.locator('.research-report-body')).toContainText(text);
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = (async () => ({ canceled: true, filePath: '' })) as typeof dialog.showSaveDialog; });
    await page.getByRole('button', { name: 'Save report', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Save cancelled.');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ask follow-up', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close Assistant', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Save an updated partial report using the existing evidence.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.chat-transcript')).toContainText('Explicit follow-up completed.', { timeout: 20000 });
    await expect(page.getByLabel('Saved report', { exact: true }).locator('option')).toHaveCount(2).catch(async error => {
      throw new Error(String(error) + '\nResearch UI: ' + (await page.locator('.research-page').innerText()).slice(0, 3500));
    });
    await page.getByLabel('Saved report', { exact: true }).selectOption({ index: 1 });
    const chosenVersion = await page.getByLabel('Saved report', { exact: true }).inputValue();
    await page.getByRole('button', { name: 'Refresh research', exact: true }).click();
    await expect(page.locator('.research-detail')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByLabel('Saved report', { exact: true })).toHaveValue(chosenVersion);
    await expect(page.getByRole('button', { name: 'Close Assistant', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close Assistant', exact: true }).click();
    // Two synchronous clicks must open only one native save dialog.
    await app.evaluate(({ dialog }, destination) => {
      const probe = dialog as typeof dialog & { researchSaveCalls: number }; probe.researchSaveCalls = 0;
      dialog.showSaveDialog = (async () => { probe.researchSaveCalls++; await new Promise(resolve => setTimeout(resolve, 150)); return { canceled: false, filePath: destination }; }) as typeof dialog.showSaveDialog;
    }, join(userData, 'chosen-version.md'));
    await page.getByRole('button', { name: 'Save report', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.getByRole('status')).toContainText('chosen-version.md');
    expect(await app.evaluate(({ dialog }) => (dialog as typeof dialog & { researchSaveCalls: number }).researchSaveCalls)).toBe(1);
    expect(readFileSync(join(userData, 'chosen-version.md'), 'utf8')).toContain('report ' + chosenVersion + ';');
    for (const theme of ['light', 'dark', 'system']) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'General', exact: true }).click();
      await page.getByLabel('Theme').selectOption(theme);
      await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
      await page.getByRole('button', { name: 'Deep Research', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Report', exact: true })).toHaveAttribute('aria-pressed', 'true');
      for (const width of [800, 1280, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        if (theme === 'system') await page.emulateMedia({ colorScheme: width === 800 ? 'dark' : 'light' });
        await expect(page.locator('.research-report-toolbar')).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: join(root, '.superpowers/sdd/research-ui-refinement/report-' + theme + '-' + width + '.png') });
        if (width === 800) {
          await page.getByRole('button', { name: 'New research', exact: true }).click();
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          await expect(page.getByRole('button', { name: 'Create research', exact: true })).toBeVisible();
          await page.screenshot({ path: join(root, '.superpowers/sdd/research-ui-refinement/new-narrow-' + theme + '.png') });
          await page.getByRole('button', { name: 'Cancel', exact: true }).click();
          await expect(page.getByRole('button', { name: 'New research', exact: true })).toBeFocused();
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: 'New research', exact: true }).click();
      await expect(page.locator('.research-scope')).not.toHaveAttribute('open');
      await expect(page.getByLabel('Research question', { exact: true })).toBeFocused();
      await page.screenshot({ path: join(root, '.superpowers/sdd/research-ui-refinement/new-' + theme + '.png') });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(before); const count = requests;
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close Assistant', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Deep Research', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh research', exact: true }).click(); expect(requests).toBe(count);
    await page.setViewportSize({ width: 800, height: 700 }); await expect(page.getByRole('heading', { name: 'Deep Research', exact: true })).toBeVisible();
    await page.screenshot({ path: join(root, '.superpowers/sdd/research-ui-refinement/research-narrow.png') });
    const task = await page.evaluate(async () => { const result = await window.flowmate.listResearchTasks(); if (!result.ok) throw new Error(result.error.code); return result.data.items[0]!; });
    await closeDesktopFixture(app, userData); app = null;
    app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Deep Research', exact: true }).waitFor({ timeout: 20000 }).catch(async failure => {
      throw new Error(`${String(failure)}\nReopen URL: ${page.url()}\nVisible text: ${await page.locator('body').innerText()}`);
    });
    await page.getByRole('button', { name: 'Deep Research', exact: true }).click();
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'list_research_reports'));
    await page.getByRole('button', { name: 'Refresh research', exact: true }).click();
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await page.getByRole('button', { name: 'Open Assistant', exact: true }).click();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(page.getByRole('button', { name: 'Report', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Close Assistant', exact: true })).toBeVisible();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await expect(page.locator('.research-detail')).toContainText(text);
    expect(requests).toBe(count);
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    const expandAgain = page.getByRole('button', { name: 'Open Assistant', exact: true }); if (await expandAgain.isVisible()) await expandAgain.click();
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Summarize saved constraints without changing the plan.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => requests, { timeout: 10000 }).toBe(count + 1);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.locator('.chat-transcript')).toContainText('Explicit follow-up completed.', { timeout: 20000 });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    const disposable = page.locator('.chat-directory-row.selected');
    await expect(disposable).not.toHaveAttribute('data-session-id', String(task.sessionId));
    page.once('dialog', dialog => dialog.accept());
    await disposable.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.chat-directory-row.selected')).toHaveAttribute('data-session-id', String(task.sessionId));
    await expect.poll(async () => {
      const result = await page.evaluate(() => window.flowmate.readWorkspace()); return result.ok ? result.data.sessionId : 'unavailable';
    }).not.toBe(task.sessionId);
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Continue the saved research after deleting a separate chat.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => requests, { timeout: 5000 }).toBe(count + 2);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Deep Research', exact: true }).click();
    await page.getByRole('button', { name: 'Ask follow-up', exact: true }).click();
    holdNext = true;
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Investigate one more detail.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => requests).toBe(count + 3);
    await page.getByRole('button', { name: 'Close Assistant', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Assistant', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop research', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'New research', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Stop research', exact: true }).click();
    await expect.poll(async () => {
      const result = await page.evaluate(async researchId => {
        const current = await window.flowmate.queryResearchTask(researchId);
        return current.ok && current.data.currentRunId ? window.flowmate.queryRun(current.data.currentRunId) : current;
      }, task.researchId);
      return result.ok ? result.data.status : 'unknown';
    }, { timeout: 15000 }).toBe('cancelled');
  } finally { try { releaseHeld(); if (app) await closeDesktopFixture(app, userData); } finally { await provider.stop(); } }
});
