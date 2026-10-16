import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp } from '../support/resources.ts';
import { manifest, tasks, material } from '../../agent-eval/tests/fixtures/minimal-dataset.ts';

test.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
function evaluationFixture(userData: string) {
  const root = join(userData, 'evaluation-fixture'), dataset = join(root, 'agent-eval/src/datasets/facility-test');
  mkdirSync(join(dataset, 'cases'), { recursive: true });
  writeFileSync(join(dataset, 'dataset.json'), JSON.stringify(manifest));
  for (const task of tasks) writeFileSync(join(dataset, 'cases', task.id + '.json'), JSON.stringify(task));
  const source = join(root, 'data/invoices/voxel51/000001'); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'content.md'), material); writeFileSync(join(source, 'metadata.json'), '{}');
  return root;
}
function desktopEnvironment(userData: string) {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
}

async function failNextDesktopRead(app: ElectronApplication, channel: 'flowmate:get-state' | 'flowmate:query-evaluation-result', message: string) {
  await app.evaluate(({ ipcMain }, fault) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>;
    const original = handlers.get(fault.channel); if (!original) throw Error('Actual read handler is unavailable');
    let remaining = 1; ipcMain.removeHandler(fault.channel);
    ipcMain.handle(fault.channel, (event, input) => remaining-- > 0
      ? { ok: false, error: { code: 'synthetic_read_failed', category: 'storage', retryable: true, message: fault.message } }
      : original(event, input));
  }, { channel, message });
}

async function killOwnedEvaluationWorker(app: ElectronApplication, root: string) {
  await app.evaluate(async (_electron, root) => {
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
      && value.spawnargs.includes(root) && value.spawnargs.some(argument => typeof argument === 'string'
        && argument.replaceAll('\\', '/').endsWith('/agent-eval/src/desktop/worker.ts'))) as import('node:child_process').ChildProcess | undefined;
    if (!child) throw Error('Actual owned Evaluation Worker is missing');
    const exited = new Promise<void>(done => child.once('exit', () => done())); child.kill(); await exited;
  }, root);
}

test('Evaluation opens the registered catalog and reviews a Case without running a model or creating an Execution', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p16-page-')), root = evaluationFixture(userData);
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Evaluation', exact: true }).focus();
    await page.getByRole('button', { name: 'Evaluation', exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Evaluation', exact: true })).toBeVisible();
    await expect(page.getByText('No saved executions yet.', { exact: true })).toBeVisible();
    await page.getByLabel('Dataset', { exact: true }).selectOption('facility-test');
    await page.getByLabel('Selection', { exact: true }).selectOption('case');
    await page.getByLabel('Case', { exact: true }).selectOption('test-lines');
    await page.getByRole('button', { name: 'Inspect Case', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Synthetic row task', exact: true })).toBeVisible();
    await page.getByLabel('Reviewer', { exact: true }).fill('synthetic-page-reviewer');
    await page.getByLabel('Feedback note', { exact: true }).fill('Synthetic UI review, not formal acceptance.');
    await page.getByRole('button', { name: 'Save Case feedback', exact: true }).click();
    await expect(page.getByText('Feedback saved.', { exact: true })).toBeVisible();
    await page.getByLabel('Environment', { exact: true }).fill('synthetic-local');
    await page.getByRole('button', { name: 'Preview evaluation', exact: true }).click();
    await expect(page.getByText('评测Agent未配置或凭据不可用。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start evaluation', exact: true })).toBeDisabled();
    await page.getByText('Members, scoring and run conditions', { exact: true }).click();
    await expect(page.getByText(/"environment": "synthetic-local"/)).toBeVisible();
    expect(JSON.parse(readFileSync(join(root, 'agent-eval/runs/case-reviews/review.json'), 'utf8')).records[0])
      .toMatchObject({ reviewer: 'synthetic-page-reviewer', caseId: 'test-lines' });
    expect(existsSync(join(root, 'agent-eval/runs/business'))).toBe(false);
    await page.setViewportSize({ width: 980, height: 760 });
    const size = await page.locator('.workspace').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    expect(size.content).toBeLessThanOrEqual(size.width + 1);
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await page.locator('.evaluation-page .panel').first().evaluate(element => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => page.locator('.evaluation-page .panel').first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(light);
    await page.screenshot({ path: testInfo.outputPath('evaluation-case.png') });
  } catch (error) { failure = error as Error; }
  finally { await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('SELECT count(*) AS count FROM runs').get()).toMatchObject({ count: 0 }); } finally { db.close(); }
});

test('Evaluation runs the real isolated Agent with zero Judge and keeps global control while another page is open', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p16-run-')), root = evaluationFixture(userData);
  // This independent deterministic fixture retains every required check and has no semantic requirement.
  writeFileSync(join(root, 'agent-eval/src/datasets/facility-test/dataset.json'), JSON.stringify({ ...manifest, scoring: { ...manifest.scoring, judges: [] } }));
  let requests = 0, release!: () => void, releaseSecond!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const secondHeld = new Promise<void>(done => { releaseSecond = done; });
  const server = await createHttpProvider(async () => {
    requests++; await (requests === 1 ? held : secondHeld);
    const chunk = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'synthetic-evaluation-reply',
      object: 'chat.completion.chunk', created: 1, model: 'openai/gpt-4o-mini', choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'one 2.00; two 3.00' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  let partial = true, projectQueries = 0, uploadExecution = '', releaseUpload!: () => void;
  const uploadHeld = new Promise<void>(done => { releaseUpload = done; });
  const batches: string[][] = [], acceptedFirst = new Set<string>();
  const platform = await createHttpProvider(async request => {
    if (new URL(request.url).pathname.endsWith('/projects')) {
      projectQueries++;
      return Response.json({ data: [{ id: 'synthetic-ui-project', name: 'Synthetic', organization: { id: 'synthetic-org', name: 'Synthetic' }, metadata: {} }] });
    }
    if (!new URL(request.url).pathname.endsWith('/ingestion')) return new Response(null, { status: 404 });
    const body = await request.json() as { batch: Array<{ id: string }> };
    const target = JSON.parse(readFileSync(join(root, 'agent-eval/runs/business', uploadExecution, 'export.json'), 'utf8')).target;
    expect(target).toMatchObject({ projectId: 'synthetic-ui-project' });
    batches.push(body.batch.map(event => event.id));
    if (batches.length === 1) await uploadHeld;
    const successes = body.batch.filter((_, index) => !partial || index === 0).map(event => ({ id: event.id, status: 201 }));
    if (partial) successes.forEach(event => acceptedFirst.add(event.id));
    return Response.json({ successes, errors: partial ? body.batch.slice(1).map(event => ({ id: event.id, status: 500, message: 'Synthetic partial receipt' })) : [] });
  });
  mkdirSync(join(root, 'agent-eval/configs'), { recursive: true });
  writeFileSync(join(root, 'agent-eval/configs/.env'), [`LANGFUSE_BASE_URL=http://127.0.0.1:${platform.port}`,
    'LANGFUSE_PUBLIC_KEY=synthetic-ui-platform-public', 'LANGFUSE_SECRET_KEY=synthetic-ui-platform-secret', ''].join('\n'));
  let app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined, closed = false;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    const form = page.getByRole('form', { name: 'Evaluation Agent settings' });
    await form.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${server.port}/v1`);
    await form.getByLabel('Model ID', { exact: true }).fill('openai/gpt-4o-mini');
    await form.getByLabel('API key', { exact: true }).fill('synthetic-run-agent-key');
    await form.getByRole('button', { name: 'Save evaluation Agent', exact: true }).click();
    await expect(form.getByText('API key saved in secure storage.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByLabel('Dataset', { exact: true }).selectOption('facility-test');
    await page.getByLabel('Selection', { exact: true }).selectOption('case');
    await page.getByLabel('Case', { exact: true }).selectOption('test-lines');
    await page.getByRole('button', { name: 'Preview evaluation', exact: true }).click();
    await expect(page.getByText('1 Cases · 1 Trials · Judge calls: at most 0', { exact: true })).toBeVisible();
    const updated = await page.evaluate(async () => {
      const state = await window.flowmate.getState(); if (!state.ok || !state.data.settings.evaluation?.agent) throw Error('Synthetic Agent config unavailable');
      const { credentialRef, ...connection } = state.data.settings.evaluation.agent;
      const saved = await window.flowmate.saveEvaluationSettings({ expectedRevision: state.data.settings.revision, role: 'agent', connection });
      if (!saved.ok) throw Error(saved.error.message); return window.flowmate.getState();
    });
    if (!updated.ok) throw Error('Updated synthetic settings unavailable');
    await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', { type: 'host_state', state }), updated.data);
    await expect(page.getByText('Evaluation model settings changed. Preview again.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start evaluation', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Preview evaluation', exact: true }).click();
    await app.evaluate(({ ipcMain }) => {
      const channel = 'flowmate:start-evaluation';
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>;
      const original = handlers.get(channel); if (!original) throw Error('Actual start handler is unavailable');
      let release!: () => void, held = false, remaining = 1;
      const barrier = new Promise<void>(done => { release = done; });
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, input) => {
        const result = await original(event, input);
        if (remaining) { remaining--; held = true; await barrier; }
        return result;
      });
      Reflect.set(globalThis, 'evaluationStartReplyGate', { release, held: () => held });
    });
    await page.getByRole('button', { name: 'Start evaluation', exact: true }).click();
    await expect.poll(() => requests, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'evaluationStartReplyGate').held())).toBe(true);
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Global evaluation control' }).getByRole('button', { name: 'Stop evaluation', exact: true })).toBeEnabled();
    release();
    await expect(page.getByRole('button', { name: 'Evaluation: finished', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    const control = await page.evaluate(() => window.flowmate.queryEvaluationControl());
    expect(control).toMatchObject({ ok: true, data: { state: 'finished', stop: 'confirmed', executionIds: [expect.any(String)] } });
    if (!control.ok) throw Error('Synthetic control unavailable');
    const executionId = control.data.executionIds[0]!;
    await app.evaluate(({ BrowserWindow }, control) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', {
      type: 'evaluation_event', value: { version: 1, sessionId: control.sessionId, sequence: 1_000_000,
        control: { ...control, state: 'interrupted', errors: ['Unexpected injected event'] }, apiKey: 'synthetic-invalid-event-key' },
    }), control.data);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(page.getByRole('button', { name: 'Evaluation: finished', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Open ${executionId}`, exact: true }).click();
    const result = page.getByRole('region', { name: 'Saved execution' });
    await expect(result.getByText('Scoring: complete', { exact: true })).toBeVisible();
    await expect(result.getByRole('cell', { name: 'completed', exact: true })).toBeVisible();
    await expect(result.getByRole('cell', { name: '0', exact: true })).toBeVisible();
    await result.getByLabel('Trial', { exact: true }).selectOption(await page.evaluate(async executionId => {
      const report = await window.flowmate.queryEvaluationResult({ executionId, view: 'summary' });
      if (!report.ok) throw Error('Synthetic report unavailable'); return report.data.trials[0]!.trialId;
    }, executionId));
    await result.getByLabel('Reviewer', { exact: true }).fill('synthetic-run-reviewer');
    await result.getByLabel('Feedback note', { exact: true }).fill('The synthetic task executed; automatic quality remains independent.');
    await result.getByRole('button', { name: 'Save Trial feedback', exact: true }).click();
    await expect(result.getByText('Feedback saved.', { exact: true })).toBeVisible();
    await result.getByRole('button', { name: 'Refresh saved result', exact: true }).click();
    expect(requests).toBe(1);
    expect(projectQueries).toBe(0); expect(batches).toEqual([]);
    uploadExecution = executionId;
    await result.getByText('Platform receipt', { exact: true }).click();
    await result.getByRole('button', { name: 'Upload / resend saved report', exact: true }).click();
    await expect(result.getByText(/评测响应未知/)).toBeVisible({ timeout: 15_000 });
    await expect(result.getByRole('button', { name: 'Upload / resend saved report', exact: true })).toBeDisabled();
    expect(batches).toHaveLength(1); expect(requests).toBe(1);
    releaseUpload();
    await expect.poll(() => JSON.parse(readFileSync(join(root, 'agent-eval/runs/business', executionId, 'export.json'), 'utf8')).status).toBe('partial');
    await result.getByRole('button', { name: 'Refresh saved result', exact: true }).click();
    await expect(result.getByText('Export: partial', { exact: true })).toBeVisible();
    const firstBatches = batches.length, originalIds = new Set(batches.flat()); partial = false;
    await failNextDesktopRead(app, 'flowmate:query-evaluation-result', 'Synthetic saved receipt refresh failed.');
    await result.getByRole('button', { name: 'Upload / resend saved report', exact: true }).click();
    await expect(result.getByText('Synthetic saved receipt refresh failed.', { exact: true })).toBeVisible();
    await expect(result.getByRole('button', { name: 'Upload / resend saved report', exact: true })).toBeDisabled();
    await result.getByRole('button', { name: 'Refresh saved result', exact: true }).click();
    await expect(result.getByText('Export: complete', { exact: true })).toBeVisible();
    const resent = batches.slice(firstBatches).flat(); expect(resent.length).toBeGreaterThan(0);
    expect(resent.every(eventId => originalIds.has(eventId) && !acceptedFirst.has(eventId))).toBe(true);
    const completedBatches = batches.length;
    await result.getByRole('button', { name: 'Upload / resend saved report', exact: true }).click();
    await expect.poll(() => projectQueries).toBe(3); expect(batches).toHaveLength(completedBatches); expect(requests).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('evaluation-result.png') });
    await page.getByLabel('Dataset', { exact: true }).selectOption('facility-test');
    await page.getByLabel('Selection', { exact: true }).selectOption('case');
    await page.getByLabel('Case', { exact: true }).selectOption('test-lines');
    await page.getByLabel('Repetitions per Case', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Preview evaluation', exact: true }).click();
    await page.getByRole('button', { name: 'Start evaluation', exact: true }).click();
    await expect.poll(() => requests, { timeout: 30_000 }).toBe(2);
    await app.evaluate(() => Reflect.get(globalThis, 'evaluationStartReplyGate').release());
    await page.evaluate(async () => { await window.flowmate.getState(); await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
    await expect(page.getByRole('button', { name: 'Evaluation: running', exact: true })).toBeVisible();
    const scrolled = await page.locator('.workspace').evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
    expect(scrolled).toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: 'Global evaluation control' }).getByRole('button', { name: 'Stop evaluation', exact: true })).toBeInViewport();
    await page.getByRole('region', { name: 'Global evaluation control' }).getByRole('button', { name: 'Stop evaluation', exact: true }).focus();
    await expect(page.getByRole('region', { name: 'Global evaluation control' }).getByRole('button', { name: 'Stop evaluation', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    await page.getByRole('region', { name: 'Global evaluation control' }).getByRole('button', { name: 'Stop evaluation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Evaluation: finished', exact: true })).toBeVisible({ timeout: 30_000 });
    const stopped = await page.evaluate(() => window.flowmate.queryEvaluationControl());
    expect(stopped).toMatchObject({ ok: true, data: { outcome: 'cancelled', stop: 'confirmed', executionIds: [expect.any(String)] } });
    if (!stopped.ok) throw Error('Synthetic cancellation unavailable');
    const cancelledId = stopped.data.executionIds[0]!; expect(cancelledId).not.toBe(executionId);
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('button', { name: `Open ${cancelledId}`, exact: true }).click();
    const cancelled = await page.evaluate(executionId => window.flowmate.queryEvaluationResult({ executionId, view: 'summary' }), cancelledId);
    expect(cancelled).toMatchObject({ ok: true, data: { summary: { executionComplete: false }, trials: [expect.anything(), { executionStatus: 'not-started', judgeGenerations: 0 }] } });
    await page.getByText('Compare saved executions', { exact: true }).click();
    await page.getByLabel('Before Execution', { exact: true }).selectOption(executionId);
    await page.getByLabel('After Execution', { exact: true }).selectOption(cancelledId);
    await page.getByRole('button', { name: 'Compare conditions and results', exact: true }).click();
    await expect(page.getByText(/Different conditions can be viewed side by side/)).toBeVisible();
    expect(requests).toBe(2); expect(batches).toHaveLength(completedBatches);
    const originalReport = readFileSync(join(root, 'agent-eval/runs/business', executionId, 'report.json'), 'utf8');
    await killOwnedEvaluationWorker(app, root);
    await page.getByLabel('Dataset', { exact: true }).selectOption('facility-test');
    await page.getByLabel('Selection', { exact: true }).selectOption('case');
    await page.getByLabel('Case', { exact: true }).selectOption('test-lines');
    await page.getByRole('button', { name: 'Preview evaluation', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Global evaluation control' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start evaluation', exact: true }).click();
    await expect.poll(() => requests, { timeout: 30_000 }).toBe(3);
    const quitting = await page.evaluate(() => window.flowmate.queryEvaluationControl());
    if (!quitting.ok) throw Error('Synthetic active control unavailable');
    const quitExecution = quitting.data.executionIds[0]!;
    await closeDesktopFixture(app, userData); closed = true;
    const quitReport = JSON.parse(readFileSync(join(root, 'agent-eval/runs/business', quitExecution, 'report.json'), 'utf8'));
    expect(quitReport.endedAt).not.toBeNull();
    const observation = JSON.parse(readFileSync(join(root, 'agent-eval/runs/business', quitExecution, quitReport.trials[0].evidence.observation), 'utf8'));
    expect(observation.evidence.cleanup).toMatchObject({ present: true, actual: { closed: true, stopped: true } });
    app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
      args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 }); closed = false;
    const reopened = await app.firstWindow(); await reopened.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await reopened.getByRole('button', { name: 'Evaluation', exact: true }).click();
    const restored = await reopened.evaluate(executionId => window.flowmate.queryEvaluationResult({ executionId, view: 'summary' }), quitExecution);
    expect(restored).toMatchObject({ ok: true, data: { summary: { executionComplete: false } } });
    expect(await reopened.evaluate(() => window.flowmate.queryEvaluationControl())).toMatchObject({ ok: true, data: { state: 'idle', executionIds: [] } });
    expect(requests).toBe(3); expect(batches).toHaveLength(completedBatches);
    expect(readFileSync(join(root, 'agent-eval/runs/business', executionId, 'report.json'), 'utf8')).toBe(originalReport);
  } catch (error) {
    failure = error as Error;
    if (!closed) console.log('Synthetic evaluation control:', await (await app.firstWindow()).evaluate(() => window.flowmate.queryEvaluationControl()));
  }
  finally { release(); releaseSecond(); releaseUpload(); if (!closed) await closeDesktopFixture(app, userData, failure); await server.stop(); await platform.stop(); }
  if (failure) throw failure;
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('SELECT count(*) AS count FROM runs').get()).toMatchObject({ count: 0 }); } finally { db.close(); }
});

test('an active Worker crash preserves partial evidence and stopping uncertainty across a read-only channel recovery', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p16-crash-')), root = evaluationFixture(userData);
  writeFileSync(join(root, 'agent-eval/src/datasets/facility-test/dataset.json'), JSON.stringify({ ...manifest, scoring: { ...manifest.scoring, judges: [] } }));
  let release!: () => void, requests = 0;
  const held = new Promise<void>(done => { release = done; });
  const server = await createHttpProvider(async () => { requests++; await held; return Response.json({ error: 'Synthetic interrupted request' }, { status: 503 }); });
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined, closed = false;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await expect.poll(async () => { const state = await page.evaluate(() => window.flowmate.getState()); return state.ok && state.data.ready; }).toBe(true);
    const configured = await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw Error('Synthetic desktop not ready');
      return window.flowmate.saveEvaluationSettings({ expectedRevision: state.data.settings.revision, role: 'agent',
        connection: { api: 'openai-completions', baseUrl, model: 'openai/gpt-4o-mini' }, apiKey: 'synthetic-crash-agent-key' });
    }, `http://127.0.0.1:${server.port}/v1`);
    expect(configured.ok).toBe(true);
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByLabel('Dataset', { exact: true }).selectOption('facility-test');
    await page.getByLabel('Selection', { exact: true }).selectOption('case');
    await page.getByLabel('Case', { exact: true }).selectOption('test-lines');
    await page.getByRole('button', { name: 'Preview evaluation', exact: true }).click();
    await page.getByRole('button', { name: 'Start evaluation', exact: true }).click();
    await expect.poll(() => requests, { timeout: 30_000 }).toBe(1);
    const active = await page.evaluate(() => window.flowmate.queryEvaluationControl()); if (!active.ok) throw Error('Synthetic active control missing');
    const executionId = active.data.executionIds[0]!;
    await killOwnedEvaluationWorker(app, root);
    await expect(page.getByRole('button', { name: 'Evaluation: interrupted', exact: true })).toBeVisible();
    const interrupted = await page.evaluate(() => window.flowmate.queryEvaluationControl());
    expect(interrupted).toMatchObject({ ok: true, data: { batchId: active.data.batchId, state: 'interrupted', stop: 'unconfirmed' } });
    const file = join(root, 'agent-eval/runs/business', executionId, 'report.json'), original = readFileSync(file, 'utf8');
    const result = await page.evaluate(executionId => window.flowmate.queryEvaluationResult({ executionId, view: 'summary' }), executionId);
    expect(result).toMatchObject({ ok: true, data: { summary: { executionComplete: false, scoring: 'pending' } } });
    expect(await page.evaluate(() => window.flowmate.queryEvaluationControl())).toEqual(interrupted);
    expect(await page.evaluate(() => window.flowmate.startEvaluation({ previewId: 'synthetic-unaccepted-preview', requestId: 'synthetic-after-crash' })))
      .toMatchObject({ ok: false, error: { code: 'evaluation_busy' } });
    expect(requests).toBe(1); expect(readFileSync(file, 'utf8')).toBe(original);
    // The fixture forces only its own process out after verifying that normal product quit remains unconfirmed.
    await expect(closeDesktopFixture(app, userData)).rejects.toThrow('Desktop fixture normal close'); closed = true;
    expect(readFileSync(file, 'utf8')).toBe(original);
  } catch (error) { failure = error as Error; throw error; }
  finally { release(); if (!closed) await closeDesktopFixture(app, userData, failure); await server.stop(); }
});

test('P16 Main and Preload save dedicated credentials without model calls and retain them through business settings saves', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p16-desktop-')); let requests = 0;
  evaluationFixture(userData);
  const server = await createHttpProvider(() => { requests++; return Response.json({ error: 'Synthetic unexpected call' }, { status: 500 }); });
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate(() => typeof Reflect.get(window.flowmate, 'saveEvaluationSettings'))).toBe('function');
    const result = await page.evaluate(async ({ baseUrl, missingId }) => {
      const original = await window.flowmate.getState(); if (!original.ok) return original;
      const saved = await window.flowmate.saveEvaluationSettings({ expectedRevision: original.data.settings.revision,
        role: 'agent', connection: { api: 'openai-completions', baseUrl, model: 'synthetic-desktop-model' }, apiKey: 'synthetic-p16-desktop-key' });
      if (!saved.ok) return saved;
      const configured = await window.flowmate.getState(); if (!configured.ok) return configured;
      const { evaluation: omitted, ...business } = configured.data.settings;
      const changed = await window.flowmate.saveSettings({ ...business, profile: { ...business.profile, displayName: 'Synthetic P16 user' } });
      const control = await window.flowmate.queryEvaluationControl();
      const missing = await window.flowmate.queryEvaluationResult({ executionId: missingId, view: 'summary' });
      const compared = await window.flowmate.compareEvaluation({ left: missingId, right: missingId });
      const invalidList = await window.flowmate.listEvaluationExecutions({ offset: -1 });
      return { original, saved, configured, changed, control, missing, compared, invalidList };
    }, { baseUrl: `http://127.0.0.1:${server.port}/v1`, missingId: 'synthetic-p16-missing-' + randomUUID() });
    expect(result).toMatchObject({ saved: { ok: true, data: { role: 'agent', credentials: { agent: 'configured', judge: 'missing' } } },
      configured: { ok: true, data: { evaluationCredentials: { agent: 'configured', judge: 'missing' } } },
      changed: { ok: true, data: { defaultModelId: null, evaluation: { agent: { model: 'synthetic-desktop-model' }, judge: null } } },
      control: { ok: true, data: { state: 'idle', executionIds: [] } },
      missing: { ok: false, error: { code: 'evaluation_report_invalid' } },
      compared: { ok: false, error: { code: 'evaluation_not_comparable' } },
      invalidList: { ok: false, error: { code: 'input_invalid' } } });
    expect(JSON.stringify(result)).not.toContain('synthetic-p16-desktop-key');
    expect(readFileSync(join(userData, 'data/settings.json'), 'utf8')).not.toContain('synthetic-p16-desktop-key');
    expect(requests).toBe(0);
  } catch (error) { failure = error as Error; throw error; }
  finally { await closeDesktopFixture(app, userData, failure); await server.stop(); }
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('SELECT count(*) AS count FROM runs').get()).toMatchObject({ count: 0 }); } finally { db.close(); }
});

test('P16 public desktop operations inspect and review an isolated Case while missing-report upload performs no platform writes', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p16-case-desktop-')), root = evaluationFixture(userData);
  unlinkSync(join(root, 'data/invoices/voxel51/000001/content.md'));
  let requests = 0;
  const server = await createHttpProvider(() => { requests++; return Response.json({ error: 'Synthetic unexpected platform request' }, { status: 500 }); });
  mkdirSync(join(root, 'agent-eval/configs'), { recursive: true });
  writeFileSync(join(root, 'agent-eval/configs/.env'), [
    `LANGFUSE_BASE_URL=http://127.0.0.1:${server.port}`, 'LANGFUSE_PUBLIC_KEY=synthetic-electron-platform-public',
    'LANGFUSE_SECRET_KEY=synthetic-electron-platform-secret', '',
  ].join('\n'));
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    const result = await page.evaluate(async () => {
      const catalog = await window.flowmate.queryEvaluationCatalog({ view: 'list' });
      if (!catalog.ok || catalog.data.view !== 'list' || catalog.data.page.total !== 3) return { catalog };
      const selected = await window.flowmate.queryEvaluationCatalog({ view: 'case', datasetId: 'facility-test', caseId: 'test-fields', limit: 500 });
      if (!selected.ok || selected.data.view !== 'case') return { catalog, selected };
      const target = { kind: 'case-quality' as const, datasetId: 'facility-test', caseId: 'test-fields', caseViewId: selected.data.caseViewId };
      const saved = await window.flowmate.addEvaluationFeedback({ target, operationId: 'synthetic-electron-feedback',
        reviewer: 'synthetic-reviewer', verdict: 'bad', note: 'Synthetic material is missing.' });
      const feedback = await window.flowmate.queryEvaluationFeedback({ target: { kind: target.kind, datasetId: target.datasetId, caseId: target.caseId },
        operationId: 'synthetic-electron-feedback' });
      const uploaded = await window.flowmate.exportEvaluation({ executionId: 'synthetic-missing-report', operationId: 'synthetic-electron-upload' });
      const control = await window.flowmate.queryEvaluationControl();
      return { catalog, selected, saved, feedback, uploaded, control };
    });
    expect(result).toMatchObject({ catalog: { ok: true, data: { view: 'list', page: { total: 3 } } },
      selected: { ok: true, data: { caseId: 'test-fields', gaps: [{ path: 'voxel51/000001/content.md', reason: 'missing' }] } },
      saved: { ok: true, data: { operationId: 'synthetic-electron-feedback', record: { reviewer: 'synthetic-reviewer' } } },
      feedback: { ok: true, data: { operation: { id: 'synthetic-electron-feedback', validity: 'current' }, formalAcceptance: 'pending' } },
      uploaded: { ok: false, error: { code: 'evaluation_export_failed' } }, control: { ok: true, data: { state: 'idle', executionIds: [] } } });
    expect(requests).toBe(0); expect(JSON.stringify(result)).not.toContain('synthetic-electron-platform-secret');
    expect(JSON.parse(readFileSync(join(root, 'agent-eval/runs/case-reviews/review.json'), 'utf8')).records).toHaveLength(1);
  } catch (error) { failure = error as Error; throw error; }
  finally { await closeDesktopFixture(app, userData, failure); await server.stop(); }
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('SELECT count(*) AS count FROM runs').get()).toMatchObject({ count: 0 }); } finally { db.close(); }
});

test('Models configures independent Evaluation Agent and Judge credentials without contacting either model', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p16-models-ui-')); evaluationFixture(userData);
  let requests = 0;
  const server = await createHttpProvider(() => { requests++; return Response.json({ error: 'Synthetic unexpected model request' }, { status: 500 }); });
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    const originalState = await page.evaluate(() => window.flowmate.getState()); expect(originalState.ok).toBe(true);
    const agent = page.getByRole('form', { name: 'Evaluation Agent settings' }), judge = page.getByRole('form', { name: 'Evaluation Judge settings' });
    await expect(agent).toBeVisible({ timeout: 5000 }); await expect(judge).toBeVisible();
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    await agent.getByLabel('Base URL', { exact: true }).fill(baseUrl);
    await agent.getByLabel('Model ID', { exact: true }).fill('gpt-4o-mini');
    await agent.getByLabel('API key', { exact: true }).fill('synthetic-p16-agent-ui-key');
    await agent.getByRole('button', { name: 'Save evaluation Agent', exact: true }).click();
    await expect(agent.getByText('API key saved in secure storage.', { exact: true })).toBeVisible();
    await expect(agent.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(judge.getByLabel('Timeout (ms)', { exact: true })).toHaveValue('180000');
    await judge.getByLabel('Base URL', { exact: true }).fill(baseUrl);
    await judge.getByLabel('Model ID', { exact: true }).fill('gpt-4o-mini');
    await judge.getByLabel('API key', { exact: true }).fill('synthetic-p16-judge-ui-key');
    await judge.getByRole('button', { name: 'Save evaluation Judge', exact: true }).click();
    await expect(judge.getByText('API key saved in secure storage.', { exact: true })).toBeVisible();
    await failNextDesktopRead(app, 'flowmate:get-state', 'Synthetic saved settings refresh failed.');
    await judge.getByRole('button', { name: 'Refresh saved Judge', exact: true }).click();
    await expect(judge.getByText('Saved settings could not be refreshed.', { exact: true })).toBeVisible();
    const saved = await page.evaluate(() => window.flowmate.getState());
    expect(saved).toMatchObject({ ok: true, data: { settings: { defaultModelId: null, models: [], evaluation: {
      agent: { model: 'gpt-4o-mini' }, judge: { model: 'gpt-4o-mini', timeoutMs: 180000 } } },
      evaluationCredentials: { agent: 'configured', judge: 'configured' } } });
    if (saved.ok) expect(saved.data.settings.evaluation?.agent?.credentialRef).not.toBe(saved.data.settings.evaluation?.judge?.credentialRef);
    expect(JSON.stringify(saved)).not.toContain('synthetic-p16-agent-ui-key');
    expect(JSON.stringify(saved)).not.toContain('synthetic-p16-judge-ui-key');
    await expect(judge.getByRole('button', { name: 'Save evaluation Judge', exact: true })).toBeEnabled();
    if (originalState.ok && saved.ok) {
      await app.evaluate(({ BrowserWindow }, previous) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', { type: 'host_state', state: { ...previous, ready: false } });
      }, originalState.data);
      await expect(page.getByText('The application Host is not ready. No model request can be sent until its data store opens successfully.', { exact: true })).toBeVisible();
      await expect(agent.getByText('API key saved in secure storage.', { exact: true })).toBeVisible();
      await expect(judge.getByText('API key saved in secure storage.', { exact: true })).toBeVisible();
      await app.evaluate(({ BrowserWindow }, current) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', { type: 'host_state', state: current });
      }, saved.data);
    }
    await agent.getByLabel('Base URL', { exact: true }).fill(baseUrl + '/changed-target');
    await agent.getByRole('button', { name: 'Save evaluation Agent', exact: true }).click();
    await expect(agent.getByText('API key required for this role.', { exact: true })).toBeVisible();
    await expect(judge.getByText('API key saved in secure storage.', { exact: true })).toBeVisible();
    await agent.getByRole('button', { name: 'Clear Agent', exact: true }).click();
    await expect(agent.getByText('No connection saved.', { exact: true })).toBeVisible();
    const cleared = await page.evaluate(() => window.flowmate.getState());
    expect(cleared).toMatchObject({ ok: true, data: { settings: { defaultModelId: null, evaluation: { agent: null, judge: { model: 'gpt-4o-mini' } } },
      evaluationCredentials: { agent: 'missing', judge: 'configured' } } });
    expect(requests).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('models.png') });
  } catch (error) { failure = error as Error; throw error; }
  finally { await closeDesktopFixture(app, userData, failure); await server.stop(); }
});
