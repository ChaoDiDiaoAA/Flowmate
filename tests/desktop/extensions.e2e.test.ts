import { _electron as electron } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, installReadGate, mkdtemp, Database } from '../support/resources.ts';

it.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
function environment() {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
const launch = (userData: string, sourceRoot?: string) => electron.launch({
  executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
  env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData,
    ...(sourceRoot ? { FLOWMATE_TEST_INVOICE_SOURCE_ROOT: sourceRoot } : {}) }, timeout: 30_000,
});

it('[F12-15/19/24/25] enables the extension, executes a real invoice tool, diagnoses, stops, releases and reads history after restart', async () => {
  it.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p12-ui-')), sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-p12-ui-source-'));
  const dir = join(sourceRoot, '000001'); mkdirSync(dir);
  const contents = { 'original.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'),
    'content.json': Buffer.from(JSON.stringify([{ type: 'text', text: 'Total 113.00', bbox: [0, 0, 1, 1], page_idx: 0 }])),
    'pages.json': Buffer.from(JSON.stringify([{ pageNumber: 1, text: 'Total 113.00', blockCount: 1 }])) };
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'p12-ui', datasetRevision: 'p12-ui-v1', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
    files: Object.entries(contents).map(([path, bytes]) => ({ path, bytes: bytes.length })) }));
  // Seed real imported material and a Session through Composition. No Run, result or SDK proof is fabricated.
  const script = `import { createApplication } from './apps/composition.ts'; import { resolveProductPaths } from '@flowmate/shared';
    const need=r=>{if(!r.ok)throw new Error(r.error.code);return r.data;}; const input=JSON.parse(await Bun.stdin.text());
    const app=need(await createApplication({paths:need(resolveProductPaths(input.userData)),invoiceSourceRoot:input.sourceRoot}));
    try {const doc=need(await app.importInvoiceMaterial(input.sourceRoot+'/000001'));const session=need(await app.createSession({title:'P12 invoice'}));
      const other=need(await app.createSession({title:'P12 empty'}));
      let w=need(await app.readWorkspace());w=need(await app.updateWorkspace({expectedRevision:w.revision,change:{kind:'session',sessionId:session.sessionId}}));
      need(await app.updateWorkspace({expectedRevision:w.revision,change:{kind:'document',documentId:doc.documentRef.id}}));
      const page=need(await app.readDocumentPage({documentId:doc.documentRef.id,page:1,afterBlockId:null,limit:10}));
      console.log(JSON.stringify({sessionId:session.sessionId,otherSessionId:other.sessionId,args:{documentId:doc.documentRef.id,sources:[{documentId:doc.documentRef.id,version:doc.documentRef.version,
        artifactId:doc.parsedArtifactId,page:1,blockId:page.blocks[0].id,quote:'Total 113.00'}]}}));
    } finally {need(await app.close());}`;
  const child = spawn('bun', ['--no-env-file', '--eval', script], { cwd: repository, env: environment(), windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  child.stdin.end(JSON.stringify({ userData, sourceRoot }));
  const exit = await new Promise<number | null>((resolveExit, reject) => { child.on('error', reject); child.on('exit', resolveExit); });
  expect(exit, stderr).toBe(0); const seed = JSON.parse(stdout.trim().split('\n').at(-1)!);
  const payloads: any[] = []; let unblock!: () => void;
  const barrier = new Promise<void>(resolveBarrier => { unblock = resolveBarrier; });
  const provider = await createHttpProvider(async request => {
    payloads.push(await request.json()); if (payloads.length === 3) await barrier;
    const tool = payloads.length === 1;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'p12-ui-source', type: 'function',
      function: { name: 'check_invoice_sources', arguments: JSON.stringify(seed.args) } }] } : { role: 'assistant', content: 'P12 controlled answer.' };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'p12-ui', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  let app = await launch(userData, sourceRoot), failure: Error | undefined;
  try {
    let page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    const saved = await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error(state.error.code);
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p12-ui', credentialRef: 'p12_ui_synthetic', name: 'P12 UI',
        kind: 'custom', providerId: null, baseUrl, model: 'p12-ui', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }],
        defaultModelId: 'p12-ui' }, { modelId: 'p12-ui', apiKey: 'synthetic-p12-ui-key' });
    }, `http://127.0.0.1:${provider.port}/v1`); expect(saved.ok).toBe(true);
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Extensions', exact: true })).toBeVisible();
    await page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Saved');
    await page.locator('details[aria-label="Session extension instance"]').evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await page.getByLabel('Extension Session', { exact: true }).selectOption(String(seed.sessionId));
    await expect(page.getByText('No instance recorded in this Host.', { exact: false })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Check the selected invoice');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(2);
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await expect(page.getByTestId('extension-instance')).toContainText('active · open');
    const actual = await page.evaluate(sessionId => window.flowmate.querySessionExtensions({ sessionId }), seed.sessionId);
    if (!actual.ok || !actual.data.instances[0]) throw new Error('Actual instance missing'); const firstId = actual.data.instances[0].instanceId;
    const runs = await page.evaluate(sessionId => window.flowmate.listSessionRuns({ sessionId }), seed.sessionId);
    if (!runs.ok || !runs.data.items[0]) throw new Error('Actual Run missing'); const runId = runs.data.items[0].runId;
    const feedback = payloads[1].messages.find((message: any) => message.role === 'tool'); expect(JSON.parse(feedback.content)).toMatchObject({ results: [{ status: 'valid' }] });
    await page.getByRole('button', { name: 'Run invoice-assist diagnostic', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(`Diagnostic confirmed for ${firstId}`); expect(payloads).toHaveLength(2);
    // A held S1 runtime response must not start an S1 read after the page has selected S2.
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_runtime_state'));
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_session_extensions'));
    await page.locator('details[aria-label="Session extension instance"]').evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await page.getByLabel('Extension Session', { exact: true }).selectOption(String(seed.otherSessionId));
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(2);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(1));
    await expect(page.getByTestId('extension-session-pending')).toHaveCount(0);
    await expect(page.getByTestId('extension-instance')).toHaveCount(0);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    await page.locator('details[aria-label="Session extension instance"]').evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await page.getByLabel('Extension Session', { exact: true }).selectOption(String(seed.sessionId));
    await expect(page.getByTestId('extension-instance')).toContainText(firstId);
    await page.locator('summary').filter({ hasText: /^History details$/ }).evaluate(node => { (node.parentElement as HTMLDetailsElement).open = true; });
    await page.getByLabel('Extension Run', { exact: true }).selectOption(String(runId)); await expect(page.getByText(`Assembly: ${firstId}`, { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('Run until stopped'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(3); await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Release Session extensions', exact: true })).toBeDisabled();
    await page.getByRole('switch', { name: 'Disable invoice-assist v1', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Saved');
    const active = await page.evaluate(() => window.flowmate.queryRuntimeState()); if (!active.ok || !active.data.active) throw new Error('Active Run missing');
    expect(await page.evaluate(owner => window.flowmate.queryRunExtensions(owner), { sessionId: seed.sessionId, runId: active.data.active.runId! }))
      .toMatchObject({ ok: true, data: { frozen: { included: [{ ref: { id: 'invoice-assist' } }] } } });
    await page.getByRole('button', { name: 'Stop current Run', exact: true }).click(); unblock();
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Release Session extensions', exact: true }).click();
    await expect(page.getByTestId('extension-instance')).toContainText('disposed · closed'); await expect(page.getByRole('status')).toContainText('Session resources released');
    await closeDesktopFixture(app, userData); app = await launch(userData, sourceRoot); page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 }); await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await page.locator('details[aria-label="Session extension instance"]').evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await page.getByLabel('Extension Session', { exact: true }).selectOption(String(seed.sessionId));
    await expect(page.getByTestId('extension-instance')).toHaveCount(0);
    await page.locator('summary').filter({ hasText: /^History details$/ }).evaluate(node => { (node.parentElement as HTMLDetailsElement).open = true; });
    await page.getByLabel('Extension Run', { exact: true }).selectOption(String(runId)); await expect(page.getByText(`Assembly: ${firstId}`, { exact: true })).toBeVisible();
    await page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true }).click();
    // P8 deliberately blocks the conversation whose request was interrupted. Releasing an extension cannot clear that fact.
    expect(await page.evaluate(sessionId => window.flowmate.querySession(sessionId), seed.sessionId)).toMatchObject({ ok: true, data: { availability: 'unusable' } });
    const nextSession = await page.evaluate(async () => {
      const session = await window.flowmate.createSession({ title: 'P12 after restart' }); if (!session.ok) throw new Error(session.error.code);
      const w = await window.flowmate.readWorkspace(); if (!w.ok) throw new Error(w.error.code);
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: w.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } });
      if (!selected.ok) throw new Error(selected.error.code); return session.data.sessionId;
    });
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor(); await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await page.locator('details[aria-label="Session extension instance"]').evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await page.getByLabel('Extension Session', { exact: true }).selectOption(String(nextSession));
    await page.getByRole('textbox', { name: 'Message to model', exact: true }).fill('New Host assembly'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(4);
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await expect(page.getByTestId('extension-instance')).toContainText('active · open'); await expect(page.getByTestId('extension-instance')).not.toContainText(firstId);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { unblock(); await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); await provider.stop(); }
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 3 });
    expect(db.query('SELECT status,result_json FROM tool_calls').all()).toEqual([expect.objectContaining({ status: 'succeeded', result_json: expect.stringContaining('parsed_quote_matched') })]); }
  finally { db.close(); }
});

it('[F12-03/24] confirms a lost save receipt by rereading real settings and ignores an older catalog response', async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p12-ui-order-')); const app = await launch(userData); let failure: Error | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20000 });
    await installReadGate(app, userData); await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true })).toBeVisible();
    // An older real catalog response cannot confirm a write whose receipt was lost.
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'list_extensions'));
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await app.evaluate(() => { const gate = Reflect.get(globalThis, 'contextReadGate'); gate.hold(100, 'get_state'); gate.fail(1, 'update_extension_selection'); });
    await page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true }).click();
    await expect(page.getByText('Refresh extensions to confirm the saved selection before trying again.', { exact: true })).toBeVisible();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(page.getByRole('button', { name: 'Clear extension selection', exact: true }).click({ timeout: 1000 })).rejects.toThrow(/Timeout/);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands.filter((command: { type: string }) => command.type === 'update_extension_selection').length)).toBe(1);
    await expect(page.getByText('Refresh extensions to confirm the saved selection before trying again.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.listExtensions())).toMatchObject({ ok: true, data: { revision: 1, selection: { enabledExtensions: [{ id: 'invoice-assist' }] } } });
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(0, 'get_state'));
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click(); await expect(page.getByRole('switch', { name: 'Disable invoice-assist v1', exact: true })).toBeEnabled();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore()); await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'list_extensions'));
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await page.getByRole('switch', { name: 'Disable invoice-assist v1', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Saved');
    await expect(page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true })).toBeVisible();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.listExtensions())).toMatchObject({ ok: true, data: { revision: 2, selection: { enabledExtensions: [] } } });
    expect(await page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    // The write really commits; unavailable catalog reads must still recover its original settings receipt.
    await app.evaluate(() => { const gate = Reflect.get(globalThis, 'contextReadGate'); gate.hold(0, 'update_extension_selection'); gate.fail(); gate.fail(100, 'list_extensions'); });
    await page.getByRole('button', { name: 'Clear extension selection', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'The extension operation could not be completed.' })).not.toHaveCount(0);
    await page.getByRole('button', { name: 'Refresh extensions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Clear extension selection', exact: true })).toBeEnabled();
    await expect(page.getByRole('switch', { name: 'Enable invoice-assist v1', exact: true })).toBeEnabled();
    await expect(page.getByText('Refresh extensions to confirm the saved selection before trying again.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'The extension operation could not be completed.' })).toHaveCount(2);
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { revision: 3, extensions: { enabledExtensions: [] } } } });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); }
});
