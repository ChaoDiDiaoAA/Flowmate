import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, deferCleanup, mkdtemp } from '../support/resources.ts';

it.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
function cleanEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function fixture(withSteer = false, live = false) {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p8-context-ui-'));
  let requests = 0;
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolveRelease => { release = resolveRelease; });
  const firstEntered = new Promise<void>(resolveEntered => { entered = resolveEntered; });
  const provider = await createHttpProvider(async () => {
    requests++;
    if (withSteer && requests === 1) { entered(); await barrier; }
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'context-ui-answer',
      choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'Actual Context UI answer.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'context-ui-response' } });
  });
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: { ...cleanEnvironment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  const page = await app.firstWindow();
  try {
  await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
  const seed = await page.evaluate(async baseUrl => {
    const state = await window.flowmate.getState(); if (!state.ok) throw new Error(state.error.code);
    const settings = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'context-ui', credentialRef: 'context_ui_controlled_key', name: 'Context UI',
      kind: 'custom', providerId: null, baseUrl, model: 'context-ui', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }],
      defaultModelId: 'context-ui' }, { modelId: 'context-ui', apiKey: 'synthetic-context-ui-key' });
    if (!settings.ok) throw new Error(settings.error.code);
    const session = await window.flowmate.createSession({ title: 'Original Context UI' }); if (!session.ok) throw new Error(session.error.code);
    const current = await window.flowmate.readWorkspace(); if (!current.ok) throw new Error(current.error.code);
    const selected = await window.flowmate.updateWorkspace({ expectedRevision: current.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } });
    if (!selected.ok) throw new Error(selected.error.code);
    const run = await window.flowmate.submitInput({ sessionId: session.data.sessionId, clientSequence: 1, mode: 'prompt', text: 'Original user context', modelId: 'context-ui' });
    if (!run.ok) throw new Error(run.error.code);
    return { sessionId: session.data.sessionId, runId: run.data.runId };
  }, `http://127.0.0.1:${provider.port}/v1`);
  if (withSteer && !live) { await firstEntered;
    const extra = await page.evaluate(seed => window.flowmate.submitInput({ sessionId: seed.sessionId, runId: seed.runId,
      clientSequence: 2, mode: 'steer', text: 'Second snapshot context' }), seed);
    if (!extra.ok) throw new Error(extra.error.code); release(); }
  if (!live) await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
  await page.reload();
  await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
  return { app, page, userData, seed, provider, requests: () => requests, release };
  } catch (error) { const failure = error instanceof Error ? error : new Error(String(error));
    release(); await provider.stop(); await closeDesktopFixture(app, userData, failure); throw failure; }
}

it('opens the original Session Context through the real public chain without execution', async () => {
  const f = await fixture(); let failure: Error | undefined;
  try {
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace());
    expect(f.requests()).toBe(1);
    const entry = f.page.getByRole('button', { name: 'Session details', exact: true });
    await expect(entry).toHaveCount(1, { timeout: 3000 });
    await entry.focus(); await f.page.keyboard.press('Enter');
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Context', exact: true })).toBeVisible();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Input consumed');
    const request = panel.getByTestId('context-request').first();
    for (const label of ['Request context observed', 'Payload observed', 'Transport call observed', 'Response observed']) await expect(request).toContainText(label);
    await expect(request).toContainText('context-ui-response');
    await panel.getByRole('button', { name: 'Close details', exact: true }).focus();
    await f.page.keyboard.press('Shift+Tab');
    expect(await panel.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await f.page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Close details', exact: true })).toBeFocused();
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await f.page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
    await expect(entry).toBeFocused();
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(baseline);
    expect(f.requests()).toBe(1);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
  const db = new Database(join(f.userData, 'data/app.sqlite'), { readonly: true });
  try { for (const table of ['runs', 'session_inputs', 'context_snapshots']) expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    expect(db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({ count: 0 }); }
  finally { db.close(); }
});

async function installReadGate(app: ElectronApplication, userData: string) {
  await app.evaluate((_electron, root) => {
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
      && value.spawnargs.includes(root) && value.spawnargs.includes('apps/host/main.ts')) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    if (!child?.stdin || !child.stdout) throw new Error('Actual owned Host pipe is missing.');
    const input = child.stdin, output = child.stdout, write = input.write, emit = output.emit;
    const commands: Array<{ type: string; requestId: string; input?: { runId?: number; snapshotId?: number } }> = [];
    const kinds = new Map<string, string>(); let buffer = Buffer.alloc(0), remaining = 0, fault = false, heldType = 'query_context_snapshot', closeGate = false;
    const held: Buffer[] = [], closeReplies: Buffer[] = []; let heldEnd: unknown[] | null = null;
    child.stdin.write = function (this: typeof input, ...args: Parameters<typeof write>) {
      try { const command = JSON.parse(String(args[0])); commands.push(command); kinds.set(command.requestId, command.type); } catch { /* Forward unchanged. */ }
      return Reflect.apply(write, this, args);
    } as typeof write;
    child.stdout.emit = function (this: typeof output, event: string | symbol, ...args: unknown[]) {
      if (closeGate && event === 'end') { heldEnd = args; return true; }
      if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
      buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
        let line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        try { const packet = JSON.parse(line.toString());
          if (closeGate && packet.type === 'response' && kinds.get(packet.requestId) === 'close') { closeReplies.push(Buffer.from(line)); continue; }
          if (packet.type === 'response' && kinds.get(packet.requestId) === heldType) {
            if (fault) { packet.value = { ok: false, error: { code: 'internal_error', category: 'internal', retryable: false, message: 'Context query could not be completed.' } };
              line = Buffer.from(JSON.stringify(packet) + '\n'); fault = false; }
            if (remaining > 0) { held.push(Buffer.from(line)); remaining--; continue; }
          }
        } catch { /* Production parser receives original malformed bytes. */ }
        forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    function finishClose() { closeGate = false; for (const line of closeReplies.splice(0)) Reflect.apply(emit, output, ['data', line]);
      if (heldEnd) { Reflect.apply(emit, output, ['end', ...heldEnd]); heldEnd = null; } }
    Reflect.set(globalThis, 'contextReadGate', { commands, held, closeReplies,
      hold(count: number, type = 'query_context_snapshot') { remaining = count; heldType = type; }, fail() { fault = true; },
      holdHostClose() { closeGate = true; }, finishClose,
      release(index: number) { const line = held[index]; if (line) { Reflect.apply(emit, child.stdout, ['data', line]); held[index] = Buffer.alloc(0); } },
      restore() { for (const line of held) if (line.length) Reflect.apply(emit, child.stdout, ['data', line]); finishClose(); child.stdin.write = write; child.stdout.emit = emit; } });
  }, userData);
}

it('rejects late original Host replies without clearing the new Run and retains same-object errors', async () => {
  const f = await fixture(); let failure: Error | undefined;
  try {
    const second = await f.page.evaluate(sessionId => window.flowmate.submitInput({ sessionId, clientSequence: 2, mode: 'prompt', text: 'Second Run context', modelId: 'context-ui' }), f.seed.sessionId);
    if (!second.ok) throw new Error(second.error.code);
    await expect.poll(() => f.page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    await f.page.reload(); await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Second Run context');
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace());
    await installReadGate(f.app, f.userData);
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(2));
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await panel.getByLabel('Historical Run', { exact: true }).selectOption(String(f.seed.runId));
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(2);
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(panel.getByTestId('context-snapshot-detail')).toHaveCount(0);
    await expect(panel.getByRole('status')).toContainText('Loading context');
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(1));
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await expect(panel).not.toContainText('Second Run context');
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').fail());
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Context query could not be completed');
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').fail());
    await panel.getByLabel('Historical Run', { exact: true }).selectOption(String(second.data.runId));
    await expect(panel.getByRole('alert')).toContainText('Context query could not be completed');
    await expect(panel.getByTestId('context-snapshot-detail')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Second Run context');
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(baseline);
    expect(f.requests()).toBe(2);
    const commands = await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands);
    expect(commands.filter((command: { type: string }) => ['update_workspace', 'submit_session_input', 'start_run', 'select_candidate', 'start_task'].includes(command.type))).toEqual([]);
    await it.info().attach('actual-context-read-commands', { body: Buffer.from(JSON.stringify(commands)), contentType: 'application/json' });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {});
    await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
});

async function denseFixture() {
  const started = Date.now();
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p8-context-dense-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-p8-context-material-'));
  for (const sampleId of ['000001', '000002']) {
    const dir = join(sourceRoot, sampleId); mkdirSync(dir);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
    const content = JSON.stringify([{ type: 'text', text: `Original invoice ${sampleId} ` + 'tax evidence '.repeat(1000), page_idx: 0, bbox: [0, 0, 10, 10] }]);
    const pages = JSON.stringify([{ pageNumber: 1, text: 'Original invoice', blockCount: 1 }]);
    writeFileSync(join(dir, 'original.png'), png); writeFileSync(join(dir, 'content.json'), content); writeFileSync(join(dir, 'pages.json'), pages);
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId, datasetId: 'voxel51-hq-invoice-ocr', sourceRecordId: `context-ui-${sampleId}`,
      datasetRevision: 'controlled-v1', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
      files: [{ path: 'original.png', bytes: png.length }, { path: 'content.json', bytes: Buffer.byteLength(content) }, { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
  }
  let requests = 0;
  const provider = await createHttpProvider(() => {
    const ordinal = ++requests;
    if (ordinal === 1 || ordinal % 5 === 0) process.stderr.write(`Dense actual HTTP ${ordinal} at ${Date.now() - started}ms\n`);
    const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
    const names = ['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount'];
    const tool = ordinal === 1 ? { name: 'save_invoice_candidate', args: { documentId: 1, candidate: { fields: Object.fromEntries(names.map(name => [name, missing])), lines: [], notes: [] } } }
      : ordinal <= 21 ? { name: 'calculate_invoice_amounts', args: { operation: 'sum', values: ['1', '2'], scale: 2 } } : null;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `context-dense-${ordinal}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: 'assistant', content: 'Original dense answer.' };
    const chunk = (value: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'context-dense', choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const script = `
    import { createApplication } from './apps/composition.ts';
    import { PiAgentAdapter } from './packages/runtime-pi/src/session.ts';
    import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
    import { resolveProductPaths } from '@flowmate/shared';
    import { invoiceHeaderFields, invoiceFieldDisplayValue } from '@flowmate/contracts';
    import * as contracts from '@flowmate/contracts';
    import { join } from 'node:path';
    const validationProfile={};
    for(const name of ['ContextObservationsSchema','ContextSnapshotJsonSchema','NativeSessionHistorySchema','NativeHistoryRecoveryBundleSchema']) {
      const schema=contracts[name];
      for(const method of ['parse','safeParse']) {
        const original=schema[method].bind(schema), key=name+'.'+method;
        validationProfile[key]={count:0,ms:0,firstStack:null};
        schema[method]=(...args)=>{const start=performance.now();try{return original(...args);}finally{
          const item=validationProfile[key];item.count++;item.ms+=performance.now()-start;
          item.firstStack??=new Error().stack;}};
      }
    }
    const need=value=>{if(!value.ok)throw new Error(value.error.code+': '+value.error.message);return value.data;};
    const input=JSON.parse(await Bun.stdin.text()); const paths=need(resolveProductPaths(input.userData));
    let enter;const entered=new Promise(resolve=>enter=resolve);let release;const barrier=new Promise(resolve=>release=resolve);
    const app=need(await createApplication({paths,invoiceSourceRoot:input.sourceRoot,logger:{write(){},async close(){}},
      agentFactory:tools=>new PiAgentAdapter({cwd:paths.runtimeDir,agentDir:paths.runtimeDir,tools,credentials:new InMemoryCredentialStore(),runtimeApiKey:'synthetic-context-seed',
        sessionSetup(session){session.agent.beforeToolCall=async context=>{if(context.toolCall.id==='context-dense-1'){enter();await barrier;}};}})}));
    try {
      const document=need(await app.importInvoiceMaterial(join(input.sourceRoot,'000001')));
      const secondDocument=need(await app.importInvoiceMaterial(join(input.sourceRoot,'000002')));
      const session=need(await app.createSession({title:'Dense original invoice'}));
      let workspace=need(await app.readWorkspace());workspace=need(await app.updateWorkspace({expectedRevision:workspace.revision,change:{kind:'session',sessionId:session.sessionId}}));
      workspace=need(await app.updateWorkspace({expectedRevision:workspace.revision,change:{kind:'document',documentId:document.documentRef.id}}));
      const task=need(await app.startTask({clientSequence:workspace.nextTaskSequence,expectedRevision:workspace.revision,documentRef:document.documentRef,goal:'Review original invoice'}));
      const expected={revision:task.workspace.revision,sessionId:session.sessionId,documentRef:document.documentRef,jobId:task.job.jobId,candidateRef:null};
      const config={version:1,name:'Dense seed',revision:1,modelRef:{provider:'context-seed',model:'context-seed'},native:{authPath:join(input.userData,'unused.json'),modelsPath:null},
        connection:{baseUrl:input.baseUrl,api:'openai-completions',contextWindow:128000,maxTokens:16384},parameters:{maxRetries:0,maxRetryDelayMs:100}};
      let done;const terminal=new Promise(resolve=>done=resolve);
      const accepted=need(await app.submitInput({sessionId:session.sessionId,clientSequence:1,mode:'prompt',text:'Original invoice request',goalMode:'save-candidate',workspace:expected,
        config,budget:{maxModelCalls:64,maxToolCalls:32},timeoutMs:60000,stopGraceMs:1000},{onEvent(event){if(event.type==='run_finished')done(event);}}));
      console.error('Dense seed: accepted'); await entered; console.error('Dense seed: first tool entered');
      for(let sequence=2;sequence<=22;sequence++)need(await app.submitInput({sessionId:session.sessionId,clientSequence:sequence,mode:'steer',runId:accepted.runId,text:'Original steer '+sequence,workspace:expected}));
      console.error('Dense seed: 22 snapshots accepted'); release();const end=await terminal;if(!end.result.ok||end.result.data.status!=='completed')throw new Error('Dense run did not complete: '+JSON.stringify(end));
      console.error('Dense seed: original run completed');
      const model=need(await app.listJobCandidates({jobId:task.job.jobId})).items[0];if(!model)throw new Error('Actual model candidate missing');
      const original=need(await app.queryJobCandidate({jobId:task.job.jobId,candidateId:model.candidateId})).candidate;
      const selected=need(await app.selectCandidate({jobId:task.job.jobId,candidateId:model.candidateId,expectedCandidateId:null,expectedRevision:need(await app.readWorkspace()).revision}));
      const human=need(await app.saveInvoiceCandidate({operationRef:'context-human',jobId:task.job.jobId,basedOnCandidateId:model.candidateId,expectedCandidateId:model.candidateId,
        expectedRevision:selected.workspace.revision,draft:{fields:Object.fromEntries(invoiceHeaderFields.map(name=>[name,invoiceFieldDisplayValue(name,original.fields[name])])),lines:[],notes:['Human review']}}));
      const b=need(await app.createSession({title:'Current other invoice'}));
      let bdone;const bterminal=new Promise(resolve=>bdone=resolve);const br=need(await app.submitInput({sessionId:b.sessionId,clientSequence:1,mode:'prompt',text:'Other current context',config,
        timeoutMs:10000,stopGraceMs:1000},{onEvent(event){if(event.type==='run_finished')bdone(event);}}));await bterminal;
      workspace=need(await app.readWorkspace());workspace=need(await app.updateWorkspace({expectedRevision:workspace.revision,change:{kind:'session',sessionId:b.sessionId}}));
      workspace=need(await app.updateWorkspace({expectedRevision:workspace.revision,change:{kind:'document',documentId:secondDocument.documentRef.id}}));
      need(await app.hideJob(task.job.jobId)); console.error('Dense seed: ready for desktop');
      console.log(JSON.stringify({sessionId:session.sessionId,runId:accepted.runId,otherSessionId:b.sessionId,otherRunId:br.runId,jobId:task.job.jobId,candidateId:model.candidateId,humanId:human.candidate.candidateId,originalContext:original.context}));
    } finally {release();need(await app.close());console.error('T08 dense validation profile '+JSON.stringify(validationProfile));}
  `;
  let stdout = '', stderr = '';
  const child = spawn(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', '--eval', script], { cwd: repository, env: cleanEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); process.stderr.write(String(chunk)); });
  child.stdin.end(JSON.stringify({ userData, sourceRoot, baseUrl: `http://127.0.0.1:${provider.port}/v1` }));
  const exited = new Promise<number | null>((resolveExit, reject) => { child.on('error', reject); child.on('exit', resolveExit); });
  // Closing the real Provider lets an interrupted real Run settle and releases its SQLite handle before owned temp cleanup.
  deferCleanup(async () => { await provider.stop(); await exited; });
  const exit = await exited;
  if (exit !== 0) { await provider.stop(); throw new Error(`Actual dense seed failed (${exit}): ${stderr}\n${stdout}`); }
  const seed: { sessionId: number; runId: number; otherSessionId: number; otherRunId: number; jobId: number; candidateId: number; humanId: number;
    originalContext: { snapshotId: number; requestSequence: number } } = JSON.parse(stdout.trim().split('\n').at(-1)!);
  const tables = ['runs', 'session_inputs', 'context_snapshots', 'tool_calls', 'invoice_candidates', 'business_events'];
  const db = new Database(join(userData, 'data/app.sqlite'), { readonly: true });
  const rows = Object.fromEntries(tables.map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY id`).all()])); db.close();
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
    env: { ...cleanEnvironment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData, FLOWMATE_TEST_INVOICE_SOURCE_ROOT: sourceRoot }, timeout: 30_000 });
  const desktopProcess = app.process();
  deferCleanup(async () => { if (desktopProcess.exitCode === null && desktopProcess.signalCode === null) {
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData); } });
  const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
  return { app, page, userData, seed, provider, requests: () => requests, rows, tables };
}

it('P9 T08 forks through History while preserving real invoice Job candidates and original evidence bytes', async () => {
  it.setTimeout(90_000);
  const f = await denseFixture(); let failure: Error | undefined;
  try {
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace()); if (!baseline.ok) throw new Error(baseline.error.code);
    const requests = f.requests();
    await f.page.getByRole('textbox', { name: 'Message to model' }).fill('Keep the current invoice draft');
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true }); await panel.getByRole('button', { name: 'Browse history' }).click();
    const history = await f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.otherSessionId);
    if (!history.ok) throw new Error(history.error.code);
    const entry = history.data.items.find(item => item.canSelect && item.isLeaf)!;
    await panel.getByTestId(`history-entry-${entry.entryId}`).click(); await panel.getByRole('button', { name: 'Fork chat', exact: true }).click();
    await panel.getByLabel('Fork title').fill('Independent invoice chat'); await panel.getByRole('button', { name: 'Confirm fork' }).click();
    await expect(panel).toHaveCount(0);
    await expect(f.page.getByRole('textbox', { name: 'Message to model' })).toHaveValue('');
    const workspace = await f.page.evaluate(() => window.flowmate.readWorkspace()); if (!workspace.ok) throw new Error(workspace.error.code);
    expect(workspace.data.sessionId).not.toBe(f.seed.otherSessionId);
    expect(workspace.data).toEqual({ ...baseline.data, sessionId: workspace.data.sessionId, revision: baseline.data.revision + 1, updatedAt: workspace.data.updatedAt });
    expect(f.requests()).toBe(requests);
    await it.info().attach('fork-preserved-invoice-workspace', { body: Buffer.from(JSON.stringify({ before: baseline.data, after: workspace.data, requests })), contentType: 'application/json' });
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
  const db = new Database(join(f.userData, 'data/app.sqlite'), { readonly: true });
  try { for (const table of f.tables) expect(db.query(`SELECT * FROM ${table} ORDER BY id`).all()).toEqual(f.rows[table]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); }
  finally { db.close(); }
});

it('starts a new snapshot refresh while the previous snapshot refresh is still pending', async () => {
  const f = await fixture(true); let failure: Error | undefined;
  try {
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace());
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Second snapshot context');
    const snapshots = await f.page.evaluate(seed => window.flowmate.listContextSnapshots({ sessionId: seed.sessionId, runId: seed.runId }), f.seed);
    if (!snapshots.ok || snapshots.data.items.length !== 2) throw new Error('Two real snapshot inputs are required.');
    const original = snapshots.data.items[1]!;
    await installReadGate(f.app, f.userData); await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(3));
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await panel.getByRole('button', { name: `Snapshot ${original.id} · prompt`, exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(2);
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(3);
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(panel.getByTestId('context-snapshot-detail')).toHaveCount(0);
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(1));
    await expect(panel.getByTestId('context-snapshot-detail')).toHaveCount(0);
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(2));
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(baseline); expect(f.requests()).toBe(2);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {});
    await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
});

it('keeps an explicit original request snapshot when its first summary reply arrives late', async () => {
  const f = await fixture(true); let failure: Error | undefined;
  try {
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace());
    const summaries = await f.page.evaluate(seed => window.flowmate.listContextSnapshots({ sessionId: seed.sessionId, runId: seed.runId }), f.seed);
    if (!summaries.ok || summaries.data.items.length !== 2) throw new Error('Two actual input snapshots are required.');
    const original = summaries.data.items[1]!;
    await installReadGate(f.app, f.userData);
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'list_context_snapshots'));
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await panel.locator('[data-request-sequence="1"] .context-bindings > button').click();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(panel.locator('.context-snapshots button')).toHaveCount(2);
    await expect(panel.locator('.context-snapshots').getByRole('button', { name: `Snapshot ${original.id} · prompt`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(baseline); expect(f.requests()).toBe(2);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {});
    await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
});

it('refreshes selected Context after newly applied real P6 Input and terminal facts without another user action', async () => {
  const f = await fixture(true, true); let failure: Error | undefined;
  try {
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace());
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await expect(panel.getByTestId('context-request')).toHaveCount(1);
    const extra = await f.page.evaluate(seed => window.flowmate.submitInput({ sessionId: seed.sessionId, runId: seed.runId,
      clientSequence: 2, mode: 'steer', text: 'P6 later context' }), f.seed);
    if (!extra.ok) throw new Error(extra.error.code);
    f.release();
    await expect(panel.getByRole('button', { name: /^Snapshot \d+ ·/ })).toHaveCount(2);
    await expect(panel.getByTestId('context-request')).toHaveCount(2);
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(baseline); expect(f.requests()).toBe(2);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { f.release(); await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
});

it('invalidates Context during real Host exit and reads the same saved facts after a normal desktop relaunch', async () => {
  const f = await fixture(); let failure: Error | undefined, firstClosed = false;
  let relaunched: ElectronApplication | undefined;
  try {
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace());
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await installReadGate(f.app, f.userData);
    await f.app.evaluate(() => { const gate = Reflect.get(globalThis, 'contextReadGate'); gate.hold(1); gate.holdHostClose(); });
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    // Main performs its normal Host close. Only the original close acknowledgement and stdout end are delayed;
    // the actual child exit and Main's unavailable broadcast occur through the production lifecycle.
    await f.app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').closeReplies.length)).toBe(1);
    await expect(panel.getByRole('alert')).toContainText('Host is unavailable');
    await expect(panel.getByTestId('context-snapshot-detail')).toHaveCount(0);
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(panel.getByTestId('context-snapshot-detail')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    expect(f.requests()).toBe(1);
    const closed = new Promise<void>(resolveExit => f.app.process().once('exit', () => resolveExit()));
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').finishClose());
    await closed; await f.app.close(); firstClosed = true;
    relaunched = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
      env: { ...cleanEnvironment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: f.userData }, timeout: 30_000 });
    const page = await relaunched.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    await expect(page.getByTestId('context-snapshot-detail')).toContainText('Original user context');
    await expect(page.getByTestId('context-request')).toContainText('context-ui-response');
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(baseline);
    expect(f.requests()).toBe(1);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await f.provider.stop();
    if (!firstClosed) { await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {}); await closeDesktopFixture(f.app, f.userData, failure); }
    if (relaunched) await closeDesktopFixture(relaunched, f.userData, failure); }
  const db = new Database(join(f.userData, 'data/app.sqlite'), { readonly: true });
  try { for (const table of ['runs', 'session_inputs', 'context_snapshots']) expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 }); }
  finally { db.close(); }
});

it('pages real original snapshots requests and Tool model human bases without changing the current other invoice', async () => {
  it.setTimeout(60_000); // This new journey creates 22 real inputs and >20 real SDK requests before its read-only UI steps.
  const f = await denseFixture(); let failure: Error | undefined;
  try {
    const baseline = await f.page.evaluate(() => window.flowmate.readWorkspace()), http = f.requests();
    await installReadGate(f.app, f.userData);
    await f.page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Activity', exact: true }).click();
    await f.page.getByLabel('Conversation', { exact: true }).selectOption(String(f.seed.sessionId));
    await f.page.getByLabel('Processing request', { exact: true }).selectOption(String(f.seed.runId));
    await f.page.getByRole('button', { name: 'Save invoice candidate', exact: false }).click();
    await f.page.getByRole('button', { name: 'View original context basis', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original invoice request');
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original invoice 000001');
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Truncated');
    await expect(panel.locator(`[data-request-sequence="${f.seed.originalContext.requestSequence}"]`)).toContainText('Request context observed');
    await expect(panel.getByRole('button', { name: /^Snapshot \d+ ·/ })).toHaveCount(20);
    await panel.getByRole('button', { name: 'Earlier snapshots', exact: true }).click();
    await expect(panel.getByRole('button', { name: /^Snapshot \d+ ·/ })).toHaveCount(22);
    const page = await f.page.evaluate(seed => window.flowmate.listContextRequests({ sessionId: seed.sessionId, runId: seed.runId }), f.seed);
    if (!page.ok || !page.data.items[0]) throw new Error('Actual original Run request page is required.');
    const newest = page.data.items[0].binding, tool = newest.includedToolResults.find(item => item.nativeToolCallId === 'context-dense-2');
    if (!tool?.context || tool.originRunId !== f.seed.runId) throw new Error('Actual original calculator result context is required.');
    await f.page.evaluate(() => { const scroll = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (options) { Reflect.set(window, 'contextScrolledTo', this.id); Reflect.apply(scroll, this, [options]); }; });
    const currentRequest = panel.locator(`[data-request-sequence="${newest.requestSequence}"]`);
    await f.page.evaluate(() => Reflect.set(window, 'contextScrolledTo', null));
    await currentRequest.locator('.context-bindings > button').click();
    await expect.configure({ soft: true }).poll(() => f.page.evaluate(() => String(Reflect.get(window, 'contextScrolledTo') ?? ''))).toMatch(new RegExp(`-${newest.requestSequence}$`));
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original steer 22');
    // A manual snapshot selection clears the request pin; Refresh therefore reads only its first real page.
    await panel.getByRole('button', { name: `Snapshot ${newest.snapshotId} · steer`, exact: true }).click();
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(panel.getByTestId('context-request')).toHaveCount(20);
    await expect(panel.locator(`[data-request-sequence="${tool.context.requestSequence}"]`)).toHaveCount(0);
    await f.page.evaluate(() => Reflect.set(window, 'contextScrolledTo', null));
    await currentRequest.getByRole('button', { name: `Snapshot ${tool.context.snapshotId} / Request ${tool.context.requestSequence}`, exact: true }).click();
    await expect.configure({ soft: true }).poll(() => f.page.evaluate(() => String(Reflect.get(window, 'contextScrolledTo') ?? ''))).toMatch(new RegExp(`-${tool.context.requestSequence}$`));
    await expect(panel.getByTestId('context-request')).toHaveCount(22);
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original steer 2');
    await panel.getByRole('button', { name: 'Close details', exact: true }).click();
    // This original Job was hidden through the public seed API; existing saved-result navigation therefore reads the historical Job without selecting it.
    await f.page.getByTestId('processing-details').getByRole('button', { name: 'View saved result', exact: true }).first().click();
    await f.page.locator('.route-row').filter({ hasText: 'Result 1' }).getByRole('button', { name: 'View', exact: true }).click();
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_run'));
    await f.page.getByRole('button', { name: 'View original context basis', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Other current context');
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(panel.getByLabel('Historical Run', { exact: true })).toHaveValue(String(f.seed.otherRunId));
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Other current context');
    await panel.getByRole('button', { name: 'Close details', exact: true }).click();
    await f.page.getByRole('button', { name: 'View original context basis', exact: true }).click();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original invoice request');
    await panel.getByRole('button', { name: 'Close details', exact: true }).click();
    await f.page.locator('.route-row').filter({ hasText: 'Result 2' }).getByRole('button', { name: 'View', exact: true }).click();
    await f.app.evaluate(() => { const gate = Reflect.get(globalThis, 'contextReadGate'); gate.hold(1, 'query_job_candidate'); gate.fail(); });
    await f.page.getByRole('button', { name: 'View original context basis', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(2);
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Other current context');
    await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(1));
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByLabel('Historical Run', { exact: true })).toHaveValue(String(f.seed.otherRunId));
    await panel.getByRole('button', { name: 'Close details', exact: true }).click();
    await f.page.getByRole('button', { name: 'View original context basis', exact: true }).click();
    await expect(panel.getByTestId('context-snapshot-detail')).toContainText('Original invoice request');
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(baseline);
    expect(f.requests()).toBe(http);
    const commands = await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands);
    expect(commands.filter((command: { type: string }) => ['update_workspace', 'submit_session_input', 'start_run', 'select_candidate', 'start_task'].includes(command.type))).toEqual([]);
    await it.info().attach('actual-dense-context-commands', { body: Buffer.from(JSON.stringify(commands)), contentType: 'application/json' });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {});
    await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
  const db = new Database(join(f.userData, 'data/app.sqlite'), { readonly: true });
  try { expect(Object.fromEntries(f.tables.map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY id`).all()]))).toEqual(f.rows); }
  finally { db.close(); }
});
