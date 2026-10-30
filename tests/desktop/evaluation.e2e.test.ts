import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp } from '../support/resources.ts';
import { manifest, tasks, material } from '../../agent-eval/tests/fixtures/minimal-dataset.ts';
import { observationRowsFromOtlp } from '../../agent-eval/tests/langfuse/otlp-fixture.ts';
import { require as loadTypeScript } from 'tsx/cjs/api';
import type { LocalReport } from '../../agent-eval/src/reports/store.ts';

// Match the Worker's TypeScript/JSON loader when fixtures call its source services from Node.
const { createCurationService } = loadTypeScript('../../agent-eval/src/curation/index.ts', import.meta.url) as typeof import('../../agent-eval/src/curation/index.ts');
const { candidateFile, readTraceState, traceFile, updateTraceState } = loadTypeScript('../../agent-eval/src/curation/store.ts', import.meta.url) as typeof import('../../agent-eval/src/curation/store.ts');
const { readFeedbackRecords } = loadTypeScript('../../agent-eval/src/review/local.ts', import.meta.url) as typeof import('../../agent-eval/src/review/local.ts');
const { createArchive, archiveReference, writeArchivePart } = loadTypeScript('../../agent-eval/src/reports/archive.ts', import.meta.url) as typeof import('../../agent-eval/src/reports/archive.ts');
const { readReport, reportPath, saveReport } = loadTypeScript('../../agent-eval/src/reports/store.ts', import.meta.url) as typeof import('../../agent-eval/src/reports/store.ts');

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
function savedEvaluationTrace(root: string, traceId: string) {
  const archive = createArchive(root, { selection: 'case' }), executionId = 'controlled-execution';
  const report: LocalReport = { contract: 'flowmate-agent-run/v1', executionId, dataset: { id: 'facility-test', version: 1, subject: 'agent' },
    selection: 'case', environment: 'controlled-ui', startedAt: '2026-10-28T00:00:00.000Z', endedAt: null, repeat: 1,
    executionComplete: false, scoring: 'pending', manualReview: 'none', formalAcceptance: 'not-assessed', scoringConfiguration: { version: 1, judgeMode: 'off' },
    export: { backend: 'local', status: 'disabled' }, trials: [{ caseId: 'test-lines', caseVersion: 1, caseName: 'Small controlled copy', category: 'task',
      partition: 'full', repetition: 1, trialId: 'controlled-trial', traceId: traceId.replaceAll('-', ''), status: 'NOT_RUN', reason: 'Controlled original fixture',
      counts: {}, execution: null, scores: [], judgeCalls: [], feedback: 'none' }] };
  saveReport(archiveReference(archive.file, 'executions', executionId), report);
  writeArchivePart(archiveReference(archive.file, 'snapshots', executionId), { dataset: 'facility-test', version: 1,
    cases: [{ id: 'test-lines', version: 1 }], materials: [] });
}

test('Evaluation loop persists opt-in switches and saves Trace feedback without running models', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-evaluation-loop-')), root = evaluationFixture(userData);
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Evaluation loop', exact: true })).toBeVisible();
    const capture = page.getByLabel('Capture product traces', { exact: true });
    await expect(capture).not.toBeChecked();
    await expect(page.getByLabel('Upload captured traces', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Automatically mine candidates', { exact: true })).not.toBeChecked();
    await capture.check(); await page.getByRole('button', { name: 'Save trace switches', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh loop configuration', exact: true }).click();
    await expect(capture).toBeChecked();
    await expect(page.getByLabel('Upload captured traces', { exact: true })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Mine selected trace', exact: true })).toBeDisabled();
    const traceId = '00000000-0000-4000-8000-000000000005', curation = createCurationService(root);
    curation.saveTrace({ id: traceId, revision: 1, source: { kind: 'product', runId: 'synthetic-ui-run' }, entry: 'chats',
      startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:01.000Z', input: { prompt: 'Synthetic original input' }, output: 'Synthetic original answer',
      status: 'completed', complete: true, gaps: [], configuration: {}, events: [], facts: {}, materials: [] });
    await page.getByRole('button', { name: 'Refresh traces', exact: true }).click();
    await page.getByRole('button', { name: traceId, exact: true }).click();
    await page.getByLabel('Loop reviewer', { exact: true }).fill('synthetic-trace-reviewer');
    await page.getByLabel('Loop feedback note', { exact: true }).fill('Synthetic successful answer review.');
    await page.getByLabel('Trace feedback verdict', { exact: true }).selectOption('good');
    await page.getByRole('button', { name: 'Save trace feedback', exact: true }).click();
    const target = { kind: 'trace-feedback', id: traceId, revision: 1 };
    await expect.poll(() => curation.listFeedback(target).length).toBe(1);
    expect(curation.listFeedback(target)[0])
      .toMatchObject({ target: { kind: 'trace-feedback', id: traceId, revision: 1 }, source: 'human', verdict: 'good', reviewer: 'synthetic-trace-reviewer' });
    await page.getByRole('button', { name: 'Candidates', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh candidates', exact: true }).click();
    await expect(page.getByText('No candidate drafts.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Experiments', exact: true }).click();
    expect(JSON.parse(await page.getByLabel('Experiment plan JSON').inputValue()).repeats).toBe(1);
    await expect(page.getByRole('button', { name: 'Run declared experiment', exact: true })).toBeDisabled();
    expect(existsSync(join(root, 'agent-eval/runs'))).toBe(false);
    expect(existsSync(join(root, 'agent-eval/src/datasets/gold-candidates'))).toBe(false);
  } catch (error) { failure = error as Error; }
  finally { await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
});

test('Loop exposes the installed repository restriction and disables writes while retaining saved reads', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-loop-unavailable-')), root = evaluationFixture(userData);
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Evaluation', exact: true }).waitFor({ timeout: 20_000 });
    // Controlled IPC fixture presents the installed service's availability contract; no DOM or saved data is changed.
    await app.evaluate(({ ipcMain }) => {
      const channel = 'flowmate:evaluation-workflow';
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<any>>;
      const original = handlers.get(channel); if (!original) throw Error('Workflow handler unavailable');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, input) => {
        const reply = await original(event, input);
        if ((input as { action: string }).action === 'settings.get' && reply.ok)
          reply.data.data.workspace = { available: false, reason: 'Controlled installed boundary: explicit repository workspace is unavailable.' };
        return reply;
      });
    });
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('explicit repository workspace is unavailable');
    for (const label of ['Capture product traces', 'Upload captured traces', 'Automatically mine candidates'])
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save trace switches', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Mine selected trace', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refresh traces', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Candidates', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Publish approved candidate snapshot', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refresh candidates', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Experiments', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run declared experiment', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'List Baselines', exact: true })).toBeEnabled();
    expect(existsSync(join(root, 'agent-eval/configs/observability.json'))).toBe(false);
    expect(existsSync(join(root, 'agent-eval/src/datasets/gold-candidates'))).toBe(false);
  } catch (error) { failure = error as Error; }
  finally { await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
});

test('large candidate originals must fully load before editing and saved platform evidence stays separate', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-large-record-ui-')), root = evaluationFixture(userData);
  const traceId = '00000000-0000-4000-8000-000000000041', candidateId = '00000000-0000-4000-8000-000000000042';
  const curation = createCurationService(root);
  const originalMaterial = '原始资料\n' + 'x'.repeat(5 * 1024 * 1024) + '\n资料结尾';
  const trace = curation.saveTrace({ id: traceId, revision: 1, source: { kind: 'product', runId: 'controlled-run' }, entry: 'chats',
    startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:01.000Z', input: { prompt: originalMaterial }, output: 'Local original answer',
    status: 'completed', complete: true, gaps: [], configuration: {}, events: [], facts: {}, materials: [] });
  const evaluationTraceId = '00000000-0000-4000-8000-000000000043', importedTraceId = '00000000-0000-4000-8000-000000000044';
  savedEvaluationTrace(root, evaluationTraceId);
  curation.saveTrace({ ...trace, id: importedTraceId, source: { kind: 'product' }, facts: { langfuseObservations: [] }, input: { prompt: 'Small controlled copy' } });
  updateTraceState(root, traceId, state => { state.platformSnapshot = { readAt: '2026-10-28T00:00:02.000Z', trace: { ...trace, output: 'Separate platform answer' } }; });
  const platformSnapshot = readTraceState(root, traceId).platformSnapshot!, platformText = JSON.stringify(platformSnapshot, null, 2) + '\n';
  const originalTrace = readFileSync(traceFile(root, traceId), 'utf8');
  curation.saveCandidate({ contract: 'flowmate-evaluation-candidate/v1', id: candidateId, revision: 1,
    kind: 'bad', status: 'draft', traceRef: { id: traceId, revision: 1 }, sourceLabels: ['controlled-ui-proof'], reason: 'Original controlled reason',
    review: { originalMaterial }, bindings: [], controlBindings: [] });
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    await page.getByRole('button', { name: evaluationTraceId, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Upload selected trace', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Open saved Benchmark Execution', exact: true })).toBeVisible();
    await page.getByRole('button', { name: importedTraceId, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Upload selected trace', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: traceId, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Saved platform snapshot', exact: true })).toContainText('2026-10-28T00:00:02.000Z');
    await page.getByRole('button', { name: 'Read saved platform snapshot JSON', exact: true }).click();
    await expect(page.getByLabel('Original JSON chunk', { exact: true })).toContainText('"readAt"');
    await page.getByLabel('Original character offset', { exact: true }).fill(String(platformText.indexOf('Separate platform answer') - 20));
    await page.getByRole('button', { name: 'Read original offset', exact: true }).click();
    await expect(page.getByLabel('Original JSON chunk', { exact: true })).toContainText('Separate platform answer');
    await page.getByRole('button', { name: 'Candidates', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh candidates', exact: true }).click();
    await page.getByRole('button', { name: candidateId, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save candidate revision', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Load complete candidate for editing', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save candidate revision', exact: true })).toBeEnabled({ timeout: 45_000 });
    await page.getByLabel('Candidate edit JSON', { exact: true }).fill('{"reason":"Updated controlled reason"}');
    await page.getByRole('button', { name: 'Save candidate revision', exact: true }).click();
    await expect(page.getByRole('heading', { name: `${candidateId} · revision 2 · draft`, exact: true })).toBeVisible();
    const saved = curation.readCandidate(candidateId);
    expect(saved.reason).toBe('Updated controlled reason'); expect(saved.review?.originalMaterial).toBe(originalMaterial);
    expect(readFileSync(traceFile(root, traceId), 'utf8')).toBe(originalTrace);
    expect(readTraceState(root, traceId).platformSnapshot).toEqual(platformSnapshot);
    expect(existsSync(candidateFile(root, candidateId))).toBe(true);
  } catch (error) { failure = error as Error; }
  finally { await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
});

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
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
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
    await expect(page.getByRole('region', { name: 'Evaluation preview', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Preview evaluation', exact: true })).toBeEnabled();
    await expect(page.getByText('Members, scoring and run conditions', { exact: true })).toBeVisible();
    await expect(page.getByText('评测Agent未配置或凭据不可用。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start evaluation', exact: true })).toBeDisabled();
    await page.getByText('Members, scoring and run conditions', { exact: true }).click();
    await expect(page.getByText(/"environment": "synthetic-local"/)).toBeVisible();
    expect(readFeedbackRecords(root)[0])
      .toMatchObject({ reviewer: 'synthetic-page-reviewer', caseId: 'test-lines' });
    expect(existsSync(join(root, 'agent-eval/runs'))).toBe(false);
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
  const batches: string[][] = [], observations: Array<{ id: string; traceId: string; parentObservationId?: string | null; metadata: { localObservationId: string } }> = [];
  const scores: Array<{ id: string; traceId: string; name: string; value: number; source: string }> = [];
  let observationReads = 0;
  const platform = await createHttpProvider(async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/projects')) {
      projectQueries++;
      return Response.json({ data: [{ id: 'synthetic-ui-project', name: 'Synthetic', organization: { id: 'synthetic-org', name: 'Synthetic' }, metadata: {} }] });
    }
    if (url.pathname.endsWith('/v2/observations')) {
      observationReads++; return Response.json({ data: partial ? observations.filter(row => !row.parentObservationId) : observations, meta: {} });
    }
    if (url.pathname.endsWith('/v3/scores')) return Response.json({ data: partial ? [] : scores.map(score => ({ ...score, subject: { kind: 'trace', id: score.traceId } })), meta: {} });
    if (url.pathname.endsWith('/scores') && request.method === 'POST') {
      const score = await request.json() as typeof scores[number]; scores.push(score); return Response.json({ id: score.id });
    }
    if (!url.pathname.endsWith('/otel/v1/traces')) return new Response(null, { status: 404 });
    expect(request.headers.get('x-langfuse-ingestion-version')).toBe('4');
    const body = await request.json() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ spanId: string; traceId: string;
      attributes: Array<{ key: string; value: { stringValue: string } }> }> }> }> };
    const target = readReport(reportPath(root, uploadExecution)).export.target;
    expect(target).toMatchObject({ projectId: 'synthetic-ui-project' });
    const rows = observationRowsFromOtlp(body);
    const ids = rows.map(row => { expect(row.metadata.executionId).toBe(uploadExecution); return row.metadata.localObservationId as string; });
    observations.push(...rows);
    batches.push(ids);
    if (batches.length === 1) await uploadHeld;
    return Response.json({});
  });
  mkdirSync(join(root, 'agent-eval/configs'), { recursive: true });
  writeFileSync(join(root, 'agent-eval/configs/.env'), [`LANGFUSE_BASE_URL=http://127.0.0.1:${platform.port}`,
    'LANGFUSE_PUBLIC_KEY=synthetic-ui-platform-public', 'LANGFUSE_SECRET_KEY=synthetic-ui-platform-secret', ''].join('\n'));
  let app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 });
  let failure: Error | undefined, closed = false;
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
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
    await expect(page.getByText('1 Cases · 1 Trials · Judge calls: at most 0', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Start evaluation', exact: true }).click({ trial: true });
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
    await app.evaluate(() => {
      const schedule = globalThis.setTimeout; let remaining = 1;
      Reflect.set(globalThis, 'restoreEvaluationUploadTimer', () => { globalThis.setTimeout = schedule; });
      globalThis.setTimeout = new Proxy(schedule, { apply(target, receiver, args) {
        return Reflect.apply(target, receiver, args[1] === 10_000 && remaining-- > 0 ? [args[0], 100, ...args.slice(2)] : args);
      } });
    });
    await result.getByRole('button', { name: 'Upload / resend saved report', exact: true }).click();
    await expect(result.getByText(/评测响应未知/)).toBeVisible({ timeout: 15_000 });
    await app.evaluate(() => Reflect.get(globalThis, 'restoreEvaluationUploadTimer')());
    await expect(result.getByRole('button', { name: 'Upload / resend saved report', exact: true })).toBeDisabled();
    await expect.poll(() => batches.length).toBe(1); expect(requests).toBe(1);
    releaseUpload();
    await expect.poll(() => readReport(reportPath(root, executionId)).export.status).toBe('partial');
    await result.getByRole('button', { name: 'Refresh saved result', exact: true }).click();
    await expect(result.getByText('Export: partial', { exact: true })).toBeVisible();
    const firstBatches = batches.length, originalIds = new Set(batches.flat()), firstReads = observationReads; partial = false;
    await failNextDesktopRead(app, 'flowmate:query-evaluation-result', 'Synthetic saved receipt refresh failed.');
    await result.getByRole('button', { name: 'Upload / resend saved report', exact: true }).click();
    await expect(result.getByText('Synthetic saved receipt refresh failed.', { exact: true })).toBeVisible();
    await expect(result.getByRole('button', { name: 'Upload / resend saved report', exact: true })).toBeDisabled();
    await result.getByRole('button', { name: 'Refresh saved result', exact: true }).click();
    await expect(result.getByText('Export: complete', { exact: true })).toBeVisible();
    expect(batches.slice(firstBatches)).toEqual([]);
    expect(observationReads).toBeGreaterThan(firstReads);
    expect(observations.every(row => originalIds.has(row.metadata.localObservationId))).toBe(true);
    expect(scores.length).toBeGreaterThan(0);
    expect(scores.every(score => score.source === 'API' && observations.some(row => row.traceId === score.traceId) && Number.isFinite(score.value))).toBe(true);
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
    const originalReport = JSON.stringify(readReport(reportPath(root, executionId)));
    await killOwnedEvaluationWorker(app, root);
    await page.getByLabel('Dataset', { exact: true }).selectOption('facility-test');
    await page.getByLabel('Selection', { exact: true }).selectOption('case');
    await page.getByLabel('Case', { exact: true }).selectOption('test-lines');
    await page.getByRole('button', { name: 'Preview evaluation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start evaluation', exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText('Members, scoring and run conditions', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Global evaluation control' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start evaluation', exact: true }).click();
    await expect.poll(() => requests, { timeout: 30_000 }).toBe(3);
    const quitting = await page.evaluate(() => window.flowmate.queryEvaluationControl());
    if (!quitting.ok) throw Error('Synthetic active control unavailable');
    const quitExecution = quitting.data.executionIds[0]!;
    await closeDesktopFixture(app, userData); closed = true;
    const quitReport = readReport(reportPath(root, quitExecution));
    expect(quitReport.endedAt).not.toBeNull();
    expect(quitReport.trials[0]!.execution?.evidence.cleanup).toMatchObject({ present: true, actual: { closed: true, stopped: true } });
    app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
      args: [join(repository, 'out/main/index.js')], env: desktopEnvironment(userData), timeout: 30_000 }); closed = false;
    const reopened = await app.firstWindow(); await reopened.getByRole('button', { name: 'Invoices', exact: true }).click(); await reopened.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await reopened.getByRole('button', { name: 'Evaluation', exact: true }).click();
    const restored = await reopened.evaluate(executionId => window.flowmate.queryEvaluationResult({ executionId, view: 'summary' }), quitExecution);
    expect(restored).toMatchObject({ ok: true, data: { summary: { executionComplete: false } } });
    expect(await reopened.evaluate(() => window.flowmate.queryEvaluationControl())).toMatchObject({ ok: true, data: { state: 'idle', executionIds: [] } });
    expect(requests).toBe(3); expect(batches).toHaveLength(completedBatches);
    expect(JSON.stringify(readReport(reportPath(root, executionId)))).toBe(originalReport);
  } catch (error) {
    failure = error as Error;
    if (!closed) console.log('Synthetic evaluation control:', await (await app.firstWindow()).evaluate(() => window.flowmate.queryEvaluationControl()));
    if (!closed) console.log('Synthetic visible status:', await (await app.firstWindow()).getByRole('status').allTextContents());
    if (uploadExecution) {
      const saved = readReport(reportPath(root, uploadExecution)).export;
      console.log('Synthetic export progress:', { observationReads, postedScores: scores.length, batches: batches.length, status: saved.status, error: saved.error });
    }
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
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
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
    const original = JSON.stringify(readReport(reportPath(root, executionId)));
    const result = await page.evaluate(executionId => window.flowmate.queryEvaluationResult({ executionId, view: 'summary' }), executionId);
    expect(result).toMatchObject({ ok: true, data: { summary: { executionComplete: false, scoring: 'pending' } } });
    expect(await page.evaluate(() => window.flowmate.queryEvaluationControl())).toEqual(interrupted);
    expect(await page.evaluate(() => window.flowmate.startEvaluation({ previewId: 'synthetic-unaccepted-preview', requestId: 'synthetic-after-crash' })))
      .toMatchObject({ ok: false, error: { code: 'evaluation_busy' } });
    expect(requests).toBe(1); expect(JSON.stringify(readReport(reportPath(root, executionId)))).toBe(original);
    // The fixture forces only its own process out after verifying that normal product quit remains unconfirmed.
    await expect(closeDesktopFixture(app, userData)).rejects.toThrow('Desktop fixture normal close'); closed = true;
    expect(JSON.stringify(readReport(reportPath(root, executionId)))).toBe(original);
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
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
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
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
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
    expect(readFeedbackRecords(root)).toHaveLength(1);
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
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
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
    if (saved.ok) {
      const judgeProfile = saved.data.settings.evaluation?.judge;
      expect(judgeProfile && 'credentialRef' in judgeProfile).toBe(true);
      if (judgeProfile && 'credentialRef' in judgeProfile)
        expect(saved.data.settings.evaluation?.agent?.credentialRef).not.toBe(judgeProfile.credentialRef);
    }
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
