import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, installReadGate, mkdtemp, Database } from '../support/resources.ts';

test.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
function environment() {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
const launch = (userData: string, sourceRoot: string) => electron.launch({
  executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
  env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData, FLOWMATE_TEST_INVOICE_SOURCE_ROOT: sourceRoot }, timeout: 30_000,
});

for (const scenario of ['cancel', 'interrupted', 'child-terminal', 'parent-result'] as const) {
test(`[F13-10/16/18/19/23/24/25] genuine child ${scenario}, saved facts and cold Host zero replay`, async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p13-ui-')), sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-p13-ui-source-'));
  const dir = join(sourceRoot, '000001'); mkdirSync(dir);
  const files = { 'original.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'),
    'content.json': Buffer.from(JSON.stringify([{ type: 'text', text: 'Total 113.00', bbox: [0, 0, 1, 1], page_idx: 0 }])),
    'pages.json': Buffer.from(JSON.stringify([{ pageNumber: 1, text: 'Total 113.00', blockCount: 1 }])) };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'p13-ui', datasetRevision: 'p13-ui-v1', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length })) }));
  const script = `import { createApplication } from './apps/composition.ts'; import { resolveProductPaths } from '@flowmate/shared';
    const need=r=>{if(!r.ok)throw new Error(r.error.code);return r.data;};const input=JSON.parse(await Bun.stdin.text());
    const app=need(await createApplication({paths:need(resolveProductPaths(input.userData)),invoiceSourceRoot:input.sourceRoot}));
    try {const doc=need(await app.importInvoiceMaterial(input.sourceRoot+'/000001'));const session=need(await app.createSession({title:'P13 invoice'}));
      const other=need(await app.createSession({title:'P13 empty'}));let w=need(await app.readWorkspace());
      w=need(await app.updateWorkspace({expectedRevision:w.revision,change:{kind:'session',sessionId:session.sessionId}}));
      w=need(await app.updateWorkspace({expectedRevision:w.revision,change:{kind:'document',documentId:doc.documentRef.id}}));
      need(await app.startTask({clientSequence:1,expectedRevision:w.revision,documentRef:doc.documentRef,goal:'Verify invoice total'}));
      console.log(JSON.stringify({sessionId:session.sessionId,otherSessionId:other.sessionId,documentId:doc.documentRef.id}));
    }finally{need(await app.close());}
    if(input.scenario==='child-terminal'||input.scenario==='parent-result'){
      const {Database}=await import('bun:sqlite');const db=new Database(input.userData+'/data/app.sqlite');
      try{db.exec(input.scenario==='child-terminal'?
        "CREATE TRIGGER p13_test_fault BEFORE UPDATE OF status ON runs WHEN OLD.kind='subagent' AND NEW.status IN('completed','failed','cancelled') BEGIN SELECT RAISE(ABORT,'p13_child_terminal_fault'); END":
        "CREATE TRIGGER p13_test_fault BEFORE UPDATE OF result_json ON tool_calls WHEN OLD.tool_name='Agent' AND NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'p13_parent_result_fault'); END");
      }finally{db.close();}}
    `;
  const seedProcess = spawn('bun', ['--no-env-file', '--eval', script], { cwd: repository, env: environment(), windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = ''; seedProcess.stdout.on('data', value => stdout += value); seedProcess.stderr.on('data', value => stderr += value);
  seedProcess.stdin.end(JSON.stringify({ userData, sourceRoot, scenario }));
  const exit = await new Promise<number | null>((done, reject) => { seedProcess.on('error', reject); seedProcess.on('exit', done); });
  expect(exit, stderr).toBe(0); const seed = JSON.parse(stdout.trim().split('\n').at(-1)!);
  const payloads: any[] = []; let release!: () => void;
  const barrier = new Promise<void>(done => release = done);
  let parentRequests = 0, childRequests = 0;
  const provider = await createHttpProvider(async request => {
    const payload = await request.json(); payloads.push(payload);
    const child = payload.messages[0]?.content.startsWith('Verify invoice evidence');
    const ordinal = child ? ++childRequests : ++parentRequests;
    if (child && ordinal === 2 && (scenario === 'cancel' || scenario === 'interrupted')) await barrier;
    const tool = (name: string, args: unknown, id: string) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const delta = !child && ordinal === 1 ? tool('Agent', { prompt: 'Verify the invoice total.', description: 'Check invoice total', subagent_type: 'invoice-evidence-checker' }, 'p13-parent')
      : child && ordinal === 1 ? tool('read_invoice_document', { documentId: seed.documentId, page: 1, afterBlockId: null, limit: 10 }, 'p13-child-read')
      : { role: 'assistant', content: child ? 'Child evidence text.' : 'Parent handled the child result.' };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'p13-ui', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  let app = await launch(userData, sourceRoot), failure: Error | undefined;
  try {
    app.process().stderr?.on('data', value => console.error(String(value)));
    let page = await app.firstWindow(); page.on('pageerror', error => console.error(error.stack));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error(state.error.code);
      const saved = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p13-ui', credentialRef: 'p13_ui_synthetic', name: 'P13 UI',
        kind: 'custom', providerId: null, baseUrl, model: 'p13-ui', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }], defaultModelId: 'p13-ui' },
        { modelId: 'p13-ui', apiKey: 'synthetic-p13-ui-key' });
      if (!saved.ok) return saved;
      const catalog = await window.flowmate.listExtensions(); if (!catalog.ok) return catalog;
      return window.flowmate.updateExtensionSelection({ expectedRevision: saved.data.revision, selection: { enabledExtensions: catalog.data.items.map(item => item.ref) } });
    }, `http://127.0.0.1:${provider.port}/v1`)).toMatchObject({ ok: true });
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await expect(page.getByRole('button', { name: 'Refresh history', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Verify invoice total');
    await expect(page.getByRole('textbox', { name: 'Message to model', exact: true })).toHaveValue('Verify invoice total');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled().catch(async error => { console.error(await page.locator('body').innerText()); throw error; });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(3);
    const roots = await page.evaluate(sessionId => window.flowmate.listSessionRuns({ sessionId }), seed.sessionId);
    if (!roots.ok || !roots.data.items[0]) throw new Error('Root missing'); const rootId = roots.data.items[0].runId;
    if (scenario !== 'cancel') {
      if (scenario !== 'interrupted') await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { blocked: true } });
      const listed = await page.evaluate(input => window.flowmate.listSubagents(input), { parentRunId: rootId, parentSessionId: seed.sessionId });
      if (!listed.ok || !listed.data.items[0]) { console.error(JSON.stringify({ listed, root: await page.evaluate(id => window.flowmate.queryRun(id), rootId) })); throw new Error('Saved child missing'); } const child = listed.data.items[0];
      const before = await page.evaluate(input => window.flowmate.querySubagent(input), { parentRunId: rootId, parentSessionId: seed.sessionId, childRunId: child.childRunId });
      if (!before.ok) { console.error(JSON.stringify({ before, run: await page.evaluate(id => window.flowmate.queryRun(id), child.childRunId),
        session: await page.evaluate(id => window.flowmate.querySession(id), child.childSessionId), history: await page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), child.childSessionId) })); throw new Error(before.error.code); }
      expect(before.data.status).toBe(scenario === 'parent-result' ? 'completed' : 'running');
      if (scenario === 'parent-result') expect(before.data.output?.text).toBe('Child evidence text.');
      expect(before.data.delivery.state).not.toBe('request_observed'); expect(payloads).toHaveLength(3);
      // Kill only the owned fixture Host. This is the real interruption/required-save-failure recovery boundary.
      await app.evaluate(async (_electron, root) => {
        const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
        const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
          && value.spawnargs.includes(root) && value.spawnargs.includes('apps/host/main.ts')) as import('node:child_process').ChildProcess;
        if (!child) throw new Error('Owned Host missing');
        await new Promise<void>(done => { child.once('exit', () => done()); child.kill('SIGKILL'); });
      }, userData);
      const exited = once(app.process(), 'exit'); await app.evaluate(({ app }) => { setImmediate(() => app.exit(0)); }).catch(() => {}); await exited; await app.close();
      release();
      const db = new Database(join(userData, 'data/app.sqlite'));
      try {
        if (scenario !== 'interrupted') db.query('DROP TRIGGER p13_test_fault').run();
        expect(db.query("SELECT COUNT(*) n FROM runtime_events WHERE run_id=? AND type='run_completed'").get(child.childRunId))
          .toEqual({ n: scenario === 'parent-result' ? 1 : 0 });
      } finally { db.close(); }
      // As in the existing process-loss history fixture, wait for the actual controller lease to expire.
      await expect.poll(async () => { try { return Date.now() - (await stat(join(userData, 'data/app.sqlite.lock'))).mtimeMs > 15_000; } catch { return true; } }, { timeout: 20_000 }).toBe(true);
      app = await launch(userData, sourceRoot); page = await app.firstWindow();
      await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
      await expect.poll(() => page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { ready: true, host: 'ready' } });
      const after = await page.evaluate(input => window.flowmate.querySubagent(input), { parentRunId: rootId, parentSessionId: seed.sessionId, childRunId: child.childRunId });
      if (!after.ok) { console.error(JSON.stringify({ after, run: await page.evaluate(id => window.flowmate.queryRun(id), child.childRunId),
        session: await page.evaluate(id => window.flowmate.querySession(id), child.childSessionId), history: await page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), child.childSessionId) })); throw new Error(after.error.code); }
      expect(after.data.status).toBe(scenario === 'parent-result' ? 'completed' : 'failed');
      if (scenario === 'parent-result') expect(after.data.output).toEqual(before.data.output);
      else { expect(after.data.output).toBeNull(); expect(after.data.historyUsable).toBe(false); }
      const root = await page.evaluate(id => window.flowmate.queryRun(id), rootId); expect(root).toMatchObject({ ok: true, data: { status: 'failed' } });
      expect(await page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null, blocked: true } });
      const history = await page.evaluate(sessionId => window.flowmate.querySessionHistory({ sessionId }), child.childSessionId);
      expect(history.ok).toBe(true); expect(payloads).toHaveLength(3);
      await page.getByRole('button', { name: 'Activity', exact: true }).click(); await page.getByLabel('Conversation', { exact: true }).selectOption(String(seed.sessionId));
      await page.getByLabel('Processing request', { exact: true }).selectOption(String(rootId));
      const panel = page.getByTestId('activity-page').getByTestId('subagents-panel');
      await panel.getByRole('button', { name: 'Check invoice total', exact: false }).click();
      await expect(panel.getByTestId('subagent-detail')).toContainText(scenario === 'parent-result' ? 'completed' : 'failed');
      await expect(panel.getByTestId('subagent-detail')).toContainText('Parent receipt not confirmed');
      expect(payloads).toHaveLength(3); return;
    }
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Conversation', { exact: true }).selectOption(String(seed.sessionId));
    await page.getByLabel('Processing request', { exact: true }).selectOption(String(rootId));
    const panel = page.getByTestId('activity-page').getByTestId('subagents-panel'); await expect(panel).toBeVisible();
    await expect(panel.getByTestId('subagent-total')).toContainText('Partial');
    await expect(panel.getByTestId('subagent-total')).toContainText('Unknown');
    await panel.getByRole('button', { name: 'Check invoice total', exact: false }).click();
    await expect(panel.getByTestId('subagent-detail')).toContainText('read_invoice_document');
    await expect(panel.getByTestId('subagent-detail')).toContainText('Read-only');
    await panel.getByRole('button', { name: 'View child events', exact: true }).click();
    await expect(page.getByTestId('processing-details')).toContainText('Read invoice document');
    const stopping = await page.evaluate(owner => window.flowmate.listSubagents(owner), { parentRunId: rootId, parentSessionId: seed.sessionId });
    if (!stopping.ok || !stopping.data.items[0]) throw new Error('Stopping child missing');
    await panel.getByRole('button', { name: 'Stop child', exact: true }).click();
    await expect.poll(() => page.evaluate(owner => window.flowmate.querySubagent(owner), {
      parentRunId: rootId, parentSessionId: seed.sessionId, childRunId: stopping.data.items[0].childRunId,
    })).toMatchObject({ ok: true, data: { cancelRequestedAt: expect.any(String) } });
    release();
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    await panel.getByRole('button', { name: 'Refresh subagents', exact: true }).click();
    await expect(panel.getByTestId('subagent-detail')).toContainText('cancelled');
    await expect(panel.getByTestId('subagent-detail')).toContainText('Confirmed');
    await panel.getByRole('button', { name: 'View parent events', exact: true }).click();
    await expect(page.getByTestId('processing-details')).toContainText('completed');
    expect(payloads).toHaveLength(4); expect(payloads.at(-1).messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'p13-parent')).toBe(true);
    await panel.getByRole('button', { name: 'Browse child history', exact: true }).click();
    await expect(panel.getByTestId('subagent-history')).toContainText('Total 113.00');
    await expect(panel.getByTestId('subagent-history')).toContainText('Model use is blocked');
    const childPage = await page.evaluate(async owner => {
      const listed = await window.flowmate.listSubagents(owner); if (!listed.ok || !listed.data.items[0]) throw new Error('Child missing');
      const saved = await window.flowmate.querySessionHistory({ sessionId: listed.data.items[0].childSessionId }); if (!saved.ok) throw new Error(saved.error.code);
      return saved.data;
    }, { parentRunId: rootId, parentSessionId: seed.sessionId });
    const resultEntry = childPage.items.find(item => item.preview.startsWith('{"documentRef"')); expect(resultEntry).toBeDefined();
    await panel.getByTestId(`history-entry-${resultEntry!.entryId}`).click();
    await expect(panel.getByRole('region', { name: 'History entry', exact: true })).toContainText('read_invoice_document');
    await expect(panel.getByTestId('history-text')).toContainText('Total 113.00');
    await expect(panel.getByRole('button', { name: 'Continue here', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Fork chat', exact: true })).toHaveCount(0);
    await installReadGate(app, userData); await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_subagent'));
    await panel.getByRole('button', { name: 'Refresh subagents', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await page.getByLabel('Conversation', { exact: true }).selectOption(String(seed.otherSessionId));
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(panel).toHaveCount(0); await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await closeDesktopFixture(app, userData); app = await launch(userData, sourceRoot); page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 }); await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Conversation', { exact: true }).selectOption(String(seed.sessionId)); await page.getByLabel('Processing request', { exact: true }).selectOption(String(rootId));
    const restoredPanel = page.getByTestId('activity-page').getByTestId('subagents-panel');
    await restoredPanel.getByRole('button', { name: 'Check invoice total', exact: false }).click();
    await expect(restoredPanel.getByTestId('subagent-detail')).toContainText('cancelled');
    await restoredPanel.getByRole('button', { name: 'Browse child history', exact: true }).click(); await expect(restoredPanel.getByTestId('subagent-history')).toContainText('Total 113.00');
    expect(payloads).toHaveLength(4);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally {
    release(); await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {});
    if (failure && scenario !== 'cancel' && app.process().exitCode === null && app.process().signalCode === null) {
      await app.evaluate(async (_electron, root) => {
        const child = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles().find(value => value && typeof value === 'object'
          && 'spawnargs' in value && Array.isArray(value.spawnargs) && value.spawnargs.includes(root) && value.spawnargs.includes('apps/host/main.ts')) as import('node:child_process').ChildProcess | undefined;
        if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(done => { child.once('exit', () => done()); child.kill('SIGKILL'); });
      }, userData).catch(() => {});
      const exited = once(app.process(), 'exit'); await app.evaluate(({ app }) => { setImmediate(() => app.exit(1)); }).catch(() => {}); await exited; await app.close();
    } else await closeDesktopFixture(app, userData, failure);
    await provider.stop();
  }
});
}
