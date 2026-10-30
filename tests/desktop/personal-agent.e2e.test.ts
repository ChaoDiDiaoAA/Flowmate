import { _electron as electron, type Page } from 'playwright';
import { expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CandidateDraftSchema, InvoiceFormTargetSchema, InvoiceWorkWorkingContextSchema, PersonalTaskGetResultSchema, WorkspaceContextSchema,
  invoiceHeaderFields, type DocumentSnapshot, type PersonalAgentConfiguration, type Result } from '@flowmate/contracts';
import { ServiceClient } from '../../apps/desktop/main/service-client.ts';
import { ServiceInstallationSchema } from '../../packages/shared/src/service-layout.ts';
import type { ChildStopSnapshot, ChildStopTarget } from '../support/owner-child-stop-fixture.ts';
import { cleanupResources, closeDesktopFixture, createHttpProvider, installReadGate, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
const root = resolve(import.meta.dirname, '../..');
function environment(userData: string) {
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
function mixedInvoiceBlocks(index: number) {
  const buyer = index <= 7 ? 'Buyer Example ' + index : index <= 10 ? 'Buyer name unreadable in the controlled source' : 'Buyer Alpha';
  return ['Invoice MIX-' + index, 'Issued 2026-10-29', 'Seller Example Seller ' + index, buyer, 'Currency CNY', 'Net 100.00', 'Tax 13.00', 'Total 113.00',
    ...(index > 10 ? ['Buyer Beta'] : [])].map((text, offset) => ({ id: 'b' + (offset + 1), kind: 'text', text, sourceIndex: offset, sourceType: 'controlled', bbox: null }));
}
async function seed(mixed = false) {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-personal-ui-'));
  const processResult = spawnSync(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', '-e', `
    import { createFileStore,openDatabase } from '@flowmate/core'; import { resolveProductPaths } from '@flowmate/shared';
    const input=JSON.parse(await Bun.stdin.text()), paths=resolveProductPaths(input.root); if(!paths.ok) throw Error(paths.error.code);
    const opened=openDatabase(paths.data); if(!opened.ok) throw Error(opened.error.code);
    try { const files=createFileStore(paths.data,opened.data), at='2026-10-29T00:00:00.000Z';
      for(let index=1;index<=input.count;index++) { const blocks=input.mixedBlocks?.[index-1]??[{id:'b1',kind:'text',text:'Total 113.00',sourceIndex:0,sourceType:'controlled',bbox:null}];
        const parsed={formatVersion:2,pages:[{page:1,blocks}],completeness:{status:'complete',checks:[],warnings:[]}};
        const published=await files.publish({sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p18-ui-'+index,sourceVersion:'p18-ui-v'+index,at,
          original:{kind:'original',primaryName:'original.png',files:[{name:'original.png',bytes:Buffer.from(input.png,'base64'),mimeType:'image/png'}]},
          parsed:{kind:'parsed',primaryName:'parsed.json',files:[{name:'parsed.json',bytes:Buffer.from(JSON.stringify(parsed)),mimeType:'application/json'}]}});
        if(!published.ok) throw Error(published.error.code);
        const registered=await opened.data.transaction(scope=>scope.documents.register({documentId:published.data.documentId,sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p18-ui-'+index,version:'p18-ui-v'+index,
          originalArtifact:published.data.original,parsedArtifact:published.data.parsed,status:'available',metadata:{version:2,sampleId:String(index).padStart(6,'0'),pageCount:1,warnings:[],allowedUsesClaim:['local review'],licenseVerification:'not_verified',unavailableReason:null},createdAt:at,updatedAt:at}));
        if(!registered.ok) throw Error(registered.error.code);
      }
    } finally { await opened.data.close(); }
  `], { cwd: root, input: JSON.stringify({ root: userData, count: mixed ? 12 : 2,
    mixedBlocks: mixed ? Array.from({ length: 12 }, (_, index) => mixedInvoiceBlocks(index + 1)) : null,
    png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=' }),
    encoding: 'utf8', windowsHide: true });
  if (processResult.status !== 0) throw Error('Isolated invoice seed failed: ' + processResult.stderr);
  return userData;
}
function stream(value: string | { document: DocumentSnapshot; id: number; candidate?: ReturnType<typeof CandidateDraftSchema.parse> }) {
  const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  const draft = typeof value === 'string' ? null : value.candidate ?? CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(key => [key, missing])),
    totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{ documentId: value.document.documentRef.id,
      version: value.document.documentRef.version, artifactId: value.document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' }] } }, lines: [], notes: [] });
  const delta = typeof value === 'string' ? { role: 'assistant', content: value } : { role: 'assistant', tool_calls: [{ index: 0, id: 'p18-ui-call-' + value.id,
    type: 'function', function: { name: 'save_invoice_candidate', arguments: JSON.stringify({ documentId: value.document.documentRef.id, candidate: draft }) } }] };
  return new Response('data: ' + JSON.stringify({ id: 'p18-ui-response', object: 'chat.completion.chunk', created: 1, model: 'personal-ui-model',
    choices: [{ index: 0, delta, finish_reason: typeof value === 'string' ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function mixedCandidate(document: DocumentSnapshot, index: number) {
  const blocks = mixedInvoiceBlocks(index), missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  const source = (offset: number) => ({ documentId: document.documentRef.id, version: document.documentRef.version,
    artifactId: document.parsedArtifactId, page: 1, blockId: blocks[offset]!.id, quote: blocks[offset]!.text });
  const present = (raw: string, offset: number) => ({ raw, normalized: raw, state: 'present', alternatives: [], sources: [source(offset)] });
  const buyer = index <= 7 ? present('Buyer Example ' + index, 3) : index <= 10 ? { ...missing, sources: [source(3)] }
    : { raw: 'Buyer Alpha / Buyer Beta', normalized: null, state: 'ambiguous', alternatives: ['Buyer Alpha', 'Buyer Beta'], sources: [source(3), source(8)] };
  return CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])),
    invoiceNumber: present('MIX-' + index, 0), issueDate: present('2026-10-29', 1), sellerName: present('Example Seller ' + index, 2), buyerName: buyer,
    currency: present('CNY', 4), netAmount: present('100.00', 5), taxAmount: present('13.00', 6), totalAmount: present('113.00', 7) }, lines: [], notes: [] });
}

test('the original service UI separates queued Work, active children, observed reports and a real unknown child stop without scheduling on refresh or reconnect', async () => {
  test.setTimeout(180000);
  const prepared = spawnSync(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', '-e', `
    import {installOwnerFixture} from './tests/service/owner-fixture.ts';
    const input=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify(await installOwnerFixture(input.runtimeRoot)));
  `], { cwd: root, env: environment(''), input: JSON.stringify({ runtimeRoot: join(root, 'out/package/win-unpacked/resources/flowmate-runtime') }),
    encoding: 'utf8', windowsHide: true });
  if (prepared.status !== 0) throw Error('Existing service fixture installation failed: ' + prepared.stderr);
  const installation = ServiceInstallationSchema.parse(JSON.parse(prepared.stdout.trim().split(/\r?\n/).at(-1)!));
  const userData = realpathSync(installation.dataRoot), inside = relative(realpathSync(tmpdir()), userData);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !basename(userData).startsWith('flowmate-service-data-'))
    throw Error('Expected the existing fixture owned temporary data root.');
  const owner = spawn(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', 'tests/support/owner-child-stop-fixture.ts', '--run',
    join(userData, 'service-installation.json'), installation.runtimeRoot],
  { cwd: root, env: environment(userData), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const ownerExit = once(owner, 'close'), lines = createInterface({ input: owner.stdout });
  type Frame = { type: string; id?: number; value?: unknown; error?: string; taskId?: number; code?: string; message?: string };
  const frames: Frame[] = []; let stderr = '', controlId = 0;
  owner.stderr.on('data', bytes => { stderr += String(bytes); });
  lines.on('line', line => { try { frames.push(JSON.parse(line)); } catch { /* Fixture text is never product state. */ } });
  const client = new ServiceClient(), held = Promise.withResolvers<void>();
  const desktops: ChildProcess[] = [];
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined;
  const report = 'UI_CHILD_REPORT: the original controlled total is 113.00; human review remains required.';
  const wires: Array<ReturnType<typeof InvoiceWorkWorkingContextSchema.parse>> = [];
  const successfulGoal = 'Retain the original successful child report for human review.', stoppedGoal = 'Retain the original active child until its stop is proved.';
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-personal-ui-key');
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: string }> };
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content));
    wires.push(context);
    let tool: { name: string; arguments: unknown } | null = null, text = '';
    if (context.delegation) {
      if (context.work.goal === stoppedGoal) await held.promise;
      if (body.messages.every(message => message.role !== 'tool')) tool = { name: 'read_invoice_document',
        arguments: { documentId: context.item.documentRef.id, page: 1, afterBlockId: null, limit: 10 } };
      else text = report;
    } else if (body.messages.every(message => message.role !== 'tool')) tool = { name: 'Agent', arguments: {
      subagent_type: 'invoice-evidence-checker', run_in_background: false, description: 'Check the original invoice evidence',
      prompt: 'Read the original invoice total with read-only tools and report remaining uncertainty.' } };
    else { expect(body.messages.some(message => message.role === 'tool' && message.content.includes(report))).toBe(true);
      text = 'The original child report remains a model report, not an accepted invoice.'; }
    if (!tool) return stream(text);
    return new Response('data: ' + JSON.stringify({ id: 'ui-child-response-' + wires.length, object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'ui-child-call-' + wires.length,
        type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: 'tool_calls' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const need = <T>(result: Result<T>) => { if (!result.ok) throw Error(result.error.code); return result.data; };
  async function rpc<T>(command: Parameters<ServiceClient['request']>[0]) { return need(await client.request(command) as Result<T>); }
  async function control<T>(command: { type: 'arm'; workId: number; attemptId: number; childRunId: number } | { type: 'snapshot' }) {
    const id = ++controlId; owner.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    await expect.poll(() => { if (owner.exitCode !== null) throw Error(stderr); return frames.some(frame => frame.id === id); },
      { timeout: 20000 }).toBe(true);
    const result = frames.find(frame => frame.id === id)!; if (result.type === 'fixture_control_error') throw Error(result.error);
    return result.value as T;
  }
  const task = async (workId: number, attemptId: number) => PersonalTaskGetResultSchema.parse(await rpc({ type: 'personal_task_get',
    input: { workId, attemptId, limit: 20 } }));
  async function select(page: Page, workId: number) {
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    await page.getByRole('button', { name: new RegExp('^Open Work ' + workId + ':') }).click();
    await expect(page.getByRole('heading', { name: 'Work ' + workId, exact: true })).toBeVisible();
  }
  async function showTask(page: Page, workId: number, attemptId: number) {
    await select(page, workId); await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: new RegExp('^Attempt ' + attemptId + ' ·') }).click();
  }
  async function create(page: Page, goal: string) {
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal', { exact: true }).fill(goal);
    await page.locator('.personal-create input[type=checkbox]').first().check();
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    const original = await page.evaluate(async goal => {
      const agent = await window.flowmate.personalAgent.get(); if (!agent.ok) throw Error(agent.error.code);
      const works = await window.flowmate.invoiceWorks.list({ personalAgentId: agent.data.personalAgentId, limit: 20 });
      if (!works.ok) throw Error(works.error.code); const selected = works.data.items.find(work => work.goal === goal);
      if (!selected?.execution.attempt) throw Error('The original UI Work attempt is unavailable.');
      return { workId: selected.workId, attemptId: selected.execution.attempt.attemptId };
    }, goal);
    await expect(page.getByRole('heading', { name: 'Work ' + original.workId, exact: true })).toBeVisible(); return original;
  }
  try {
    await expect.poll(() => { if (owner.exitCode !== null) throw Error(stderr); return frames.some(frame => frame.type === 'fixture_ready'); },
      { timeout: 20000 }).toBe(true);
    expect(await client.connect(installation)).toMatchObject({ ok: true });
    await rpc({ type: 'import_prepared_invoice_material', input: { contract: 'flowmate-prepared-invoice/v1', sample: 'ui-real-child-evidence',
      sourceText: 'Total 113.00', original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] } });
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')],
      env: environment(userData), timeout: 30000 }); desktops.push(app.process()); let page = await app.firstWindow();
    await configure(page, 'http://127.0.0.1:' + provider.port);
    const successful = await create(page, successfulGoal);
    await expect.poll(async () => (await task(successful.workId, successful.attemptId)).task.stoppedAt, { timeout: 20000 }).not.toBeNull();
    const complete = await task(successful.workId, successful.attemptId); expect(complete.children).toHaveLength(1);
    expect(complete.children[0]).toMatchObject({ resultRecorded: true, stopConfirmed: true, delivery: { state: 'message_observed' },
      parentModelReceivedAt: expect.any(String) });
    await showTask(page, successful.workId, successful.attemptId);
    const successfulChild = page.locator('.personal-child'); await expect(successfulChild).toContainText('report saved · returned to Master observed');
    await expect(successfulChild).toContainText('Report delivery and source references do not prove that its conclusions are correct.');
    await page.getByRole('button', { name: 'Read child report ' + complete.children[0]!.childRunId, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Work execution attempts', exact: true }).locator('pre')).toContainText(report);
    await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Work evidence timeline', exact: true })).toContainText('returned to Master observed · Master received observed');
    const successfulCalls = wires.length, originalTimeline = await rpc({ type: 'invoice_work_timeline', input: { workId: successful.workId, limit: 100 } });
    await page.reload(); await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await select(page, successful.workId);
    expect(await task(successful.workId, successful.attemptId)).toEqual(complete);
    expect(await rpc({ type: 'invoice_work_timeline', input: { workId: successful.workId, limit: 100 } })).toEqual(originalTimeline);
    expect(wires).toHaveLength(successfulCalls);

    const active = await create(page, stoppedGoal);
    await expect.poll(() => wires.some(value => value.work.workId === active.workId && value.delegation), { timeout: 20000 }).toBe(true);
    const activeTask = await task(active.workId, active.attemptId); expect(activeTask.children).toHaveLength(1);
    const queued = await create(page, 'Wait behind the original active child without replacing its ownership.');
    expect((await task(queued.workId, queued.attemptId)).task).toMatchObject({ queued: true, attempt: { runId: null } });
    await expect(page.locator('.personal-work-detail')).toContainText('queued');
    const target = await control<ChildStopTarget>({ type: 'arm', ...active, childRunId: activeTask.children[0]!.childRunId });
    await showTask(page, active.workId, active.attemptId);
    await expect(page.locator('.personal-work-detail')).toContainText('1 owned child executions');
    await expect(page.locator('.personal-child')).toContainText('running · report not confirmed · returned to Master not confirmed · Master received not confirmed');
    await expect(page.getByText('Actual stop is not confirmed. Original ownership and results are retained.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop current attempt', exact: true }).click();
    await expect.poll(() => frames.some(frame => frame.type === 'fixture_native_commit_failed'), { timeout: 20000 }).toBe(true);
    const failed = frames.find(frame => frame.type === 'fixture_native_commit_failed')!;
    expect(failed).toMatchObject({ taskId: target.nativeTaskId, code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(failed.message).toContain('controlled_original_child_terminal_commit_failure');
    await expect.poll(() => frames.some(frame => frame.type === 'fixture_native_storage_closed' && frame.value === target.nativeTaskId),
      { timeout: 20000 }).toBe(true);
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    await expect(page.getByText('Actual stop is not confirmed. Original ownership and results are retained.', { exact: true })).toBeVisible();
    await expect(page.locator('.personal-work-detail header')).toContainText('open');
    const beforeQueries = await control<ChildStopSnapshot>({ type: 'snapshot' }), beforeCalls = wires.length;
    expect(beforeQueries.task).toMatchObject({ id: target.nativeTaskId, abort_requested: 1 });
    expect(beforeQueries.task.status).not.toBe('terminal'); expect(beforeQueries.attempt.stopped_at).toBeNull();
    for (let query = 0; query < 2; query++) {
      await select(page, queued.workId); await expect(page.locator('.personal-work-detail')).toContainText('queued');
      await showTask(page, active.workId, active.attemptId);
      await expect(page.locator('.personal-child')).toContainText('returned to Master not confirmed · Master received not confirmed · stop not confirmed');
      await expect(page.locator('.personal-child')).toContainText('Report delivery and source references do not prove that its conclusions are correct.');
      await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Work evidence timeline', exact: true })).toBeVisible();
    }
    await closeDesktopFixture(app, userData); app = null;
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')],
      env: environment(userData), timeout: 30000 }); desktops.push(app.process()); page = await app.firstWindow();
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await showTask(page, active.workId, active.attemptId);
    await expect(page.getByText('Actual stop is not confirmed. Original ownership and results are retained.', { exact: true })).toBeVisible();
    await expect(page.locator('.personal-child')).toContainText('stop not confirmed');
    expect(await control<ChildStopSnapshot>({ type: 'snapshot' })).toEqual(beforeQueries);
    expect((await task(queued.workId, queued.attemptId)).task).toMatchObject({ queued: true, attempt: { runId: null } });
    expect(wires).toHaveLength(beforeCalls); expect(wires.filter(value => value.work.workId === queued.workId)).toHaveLength(0);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally {
    held.resolve(); client.disconnect();
    try { if (app) await closeDesktopFixture(app, userData, failure); }
    finally {
      const pid = owner.pid;
      if (!pid || !Number.isSafeInteger(pid) || pid === process.pid) throw Error('Expected the exact owned fixture process.');
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); // Fixture cleanup never confirms a business stop.
      await ownerExit; lines.close(); await provider.stop();
      if ((owner.exitCode !== null || owner.signalCode !== null) && desktops.every(desktop => desktop.exitCode !== null || desktop.signalCode !== null))
        rmSync(userData, { recursive: true, force: true });
    }
  }
  if (failure) throw failure;
});

test('a twelve-invoice Work shows seven reviews, three material requests and two field conflicts from real saved candidates and recovers without more model requests', async () => {
  test.setTimeout(180000);
  const userData = await seed(true); let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined;
  const documents: DocumentSnapshot[] = [], perInvoice = new Map<number, number>(); let requests = 0;
  type Body = { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-personal-ui-key');
    const body = await request.json() as Body;
    const message = body.messages.slice().reverse().find(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('{'));
    if (!message || typeof message.content !== 'string') throw Error('The original Durable invoice phase is missing.');
    const context = JSON.parse(message.content) as { item: { documentRef: { id: number; version: string } } };
    const document = documents.find(document => document.documentRef.id === context.item.documentRef.id && document.documentRef.version === context.item.documentRef.version);
    if (!document) throw Error('The phase does not identify one of the twelve original invoices.');
    const index = Number(document.displayName.replace('Invoice ', '')), readFirst = [1, 8, 11].includes(index);
    requests++; const count = (perInvoice.get(index) ?? 0) + 1; perInvoice.set(index, count);
    if (readFirst && count === 1) return new Response('data: ' + JSON.stringify({ id: 'mixed-read-response-' + index,
      object: 'chat.completion.chunk', created: 1, model: 'personal-ui-model', choices: [{ index: 0, delta: { role: 'assistant',
        tool_calls: [{ index: 0, id: 'mixed-read-' + index, type: 'function', function: { name: 'read_invoice_document',
          arguments: JSON.stringify({ documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 20 }) } }] }, finish_reason: 'tool_calls' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (count === (readFirst ? 2 : 1)) {
      if (readFirst) expect(JSON.stringify(body.messages.find(message => message.tool_call_id === 'mixed-read-' + index))).toContain(document.documentRef.version);
      return stream({ document, id: requests, candidate: mixedCandidate(document, index) });
    }
    if (count === (readFirst ? 3 : 2)) return stream('The original candidate is saved for human review and clarification.');
    throw Error('This bounded fixture does not authorize another model phase for the invoice.');
  });
  try {
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    let page = await app.firstWindow();
    const material = await page.evaluate(() => window.flowmate.listDocuments({ limit: 50 })); if (!material.ok) throw Error(material.error.code);
    documents.push(...material.data.items); expect(documents).toHaveLength(12);
    await configure(page, 'http://127.0.0.1:' + provider.port);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByLabel('Default model requests', { exact: true }).fill('32');
    await page.getByLabel('Default tool calls', { exact: true }).fill('100');
    await page.getByLabel('Default Run timeout (ms)', { exact: true }).fill('300000');
    await page.getByRole('button', { name: 'Save Run limits', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true,
      data: { settings: { runtime: { budget: { maxModelCalls: 32, maxToolCalls: 100 }, timeoutMs: 300000 } } } });
    expect(requests).toBe(0);
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal', { exact: true }).fill('Review twelve controlled original invoices; preserve missing buyer information and conflicting buyer evidence for human decisions.');
    const choices = page.locator('.personal-create input[type=checkbox]'); await expect(choices).toHaveCount(12);
    for (let index = 0; index < 12; index++) await choices.nth(index).check();
    expect(requests).toBe(0);
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => { const tasks = await window.flowmate.personalTasks.list({ workId: 1, limit: 10 });
      return tasks.ok && tasks.data.items.length === 1 && tasks.data.items[0]!.stoppedAt !== null; }), { timeout: 45000 }).toBe(true);
    const original = await page.evaluate(async () => {
      const [saved, tasks, history] = await Promise.all([window.flowmate.invoiceWorks.get({ view: 'work', workId: 1, limit: 50 }),
        window.flowmate.personalTasks.list({ workId: 1, limit: 10 }), window.flowmate.personalTasks.history({ target: { workId: 1 }, limit: 100 })]);
      if (!saved.ok || saved.data.view !== 'work' || !tasks.ok || !history.ok || tasks.data.items.length !== 1) throw Error('The original Work and actual attempt are unavailable.');
      const runId = tasks.data.items[0]!.attempt.runId; if (runId === null) throw Error('Expected an actual Durable Run.');
      const [run, tools] = await Promise.all([window.flowmate.queryRun(runId), window.flowmate.listRunToolCalls({ runId, sessionId: saved.data.work.sessionId, limit: 50 })]);
      if (!run.ok || !tools.ok) throw Error('The original Run and real tool receipts are unavailable.');
      const details = await Promise.all(saved.data.items.map(async item => {
        if (!item.jobId || !item.candidateRef) throw Error('Every original invoice must have its real saved candidate.');
        const [detail, candidate] = await Promise.all([window.flowmate.invoiceWorks.get({ view: 'item', workId: 1, itemId: item.itemId, limit: 50 }),
          window.flowmate.queryJobCandidate({ jobId: item.jobId, candidateId: item.candidateRef.id })]);
        if (!detail.ok || detail.data.view !== 'item' || !candidate.ok) throw Error('The original candidate and its Todo could not be read.');
        return { detail: detail.data, candidate: candidate.data.candidate };
      }));
      return { saved: saved.data, tasks: tasks.data, history: history.data, run: run.data, tools: tools.data, details };
    });
    expect(original.run.config).toMatchObject({ runtimeBudget: { maxModelCalls: 32, maxToolCalls: 100 }, limits: { timeoutMs: 300000 } });
    expect(original.tasks.items[0]).toMatchObject({ runStatus: 'completed' });
    expect(original.saved.work).toMatchObject({ runtimeKind: 'durable', status: 'open', counts: { total: 12, unresolved: 12, accepted: 0, rejected: 0, excluded: 0 } });
    expect(original.saved.items).toHaveLength(12); expect(requests).toBe(27);
    expect([...perInvoice.values()].reduce((total, count) => total + count, 0)).toBe(27);
    expect(original.tools.items.filter(tool => tool.toolName === 'save_invoice_candidate')).toHaveLength(12);
    expect(original.tools.items.filter(tool => tool.toolName === 'read_invoice_document')).toHaveLength(3);
    expect(original.tools.items.every(tool => tool.status === 'succeeded')).toBe(true);
    const groups = { review: 0, supplement: 0, conflict: 0 };
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click(); await expect(page.locator('.personal-items button')).toHaveCount(12);
    for (const saved of original.details) {
      const item = saved.detail.item, document = documents.find(document => document.documentRef.id === item.documentRef.id)!;
      const index = Number(document.displayName.replace('Invoice ', '')), category = index <= 7 ? 'review' : index <= 10 ? 'supplement' : 'conflict'; groups[category]++;
      expect(saved.candidate).toMatchObject({ status: 'generated', notes: [], candidateId: item.candidateRef!.id, sequence: item.candidateRef!.sequence });
      expect(saved.candidate.issues.some(issue => issue.code === 'model_note')).toBe(false);
      expect(saved.candidate.checks.find(check => check.rule === 'source-reference')?.status).toBe('passed');
      expect(saved.detail.todos).toHaveLength(1); const todo = saved.detail.todos[0]!;
      expect(todo).toMatchObject({ actor: 'user', applicable: true, action: category === 'supplement' ? 'supplement' : 'review',
        fieldPath: category === 'review' ? null : 'fields.buyerName', basis: { origin: 'rule', documentRefs: [document.documentRef], candidateRef: item.candidateRef } });
      if (category === 'review') expect(saved.candidate.checks.find(check => check.rule === 'required-header')?.status).toBe('passed');
      else {
        expect(saved.candidate.checks.find(check => check.rule === 'required-header')?.status).toBe('failed');
        expect(saved.candidate.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: category === 'supplement' ? 'required_header_missing' : 'required_header_ambiguous', fieldPaths: ['/fields/buyerName'] })]));
        expect(todo.basis.sourceRefs.map(source => source.blockId)).toEqual(category === 'supplement' ? ['b4'] : ['b4', 'b9']);
        expect(todo.problem).toMatch(category === 'supplement' ? /missing|unreadable/i : /ambiguous|conflict/i);
      }
      await page.locator('.personal-items button').filter({ hasText: document.displayName }).click();
      const selected = page.getByRole('region', { name: 'Selected Work invoice', exact: true });
      await expect(selected.getByRole('heading', { name: document.displayName, exact: true })).toBeVisible();
      await expect(selected.locator('.personal-todo')).toHaveCount(1);
      for (const text of [todo.problem, 'Needed: ' + todo.needed, 'Satisfied by: ' + todo.satisfiedBy, 'Basis: rule; ' + document.documentRef.id + '/' + document.documentRef.version])
        await expect(selected).toContainText(text);
      if (category !== 'review') await expect(selected).toContainText('fields.buyerName · user · ' + (category === 'supplement' ? 'supplement' : 'review'));
      for (const source of todo.basis.sourceRefs) await expect(selected).toContainText('page ' + source.page + ', ' + source.blockId + ', version ' + source.version);
      await selected.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Personal Agent invoice review', exact: true })).toContainText('Original invoice item ' + item.itemId + ' · Personal Agent Work 1.');
      await expect.poll(() => page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { documentRef: item.documentRef, jobId: item.jobId, candidateRef: item.candidateRef } });
      await page.getByRole('button', { name: 'Return to Personal Agent Work 1', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible(); expect(requests).toBe(27);
    }
    expect(groups).toEqual({ review: 7, supplement: 3, conflict: 2 });
    await closeDesktopFixture(app, userData); app = null;
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    page = await app.firstWindow(); await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click(); await expect(page.locator('.personal-items button')).toHaveCount(12);
    expect(await page.evaluate(() => window.flowmate.invoiceWorks.get({ view: 'work', workId: 1, limit: 50 }))).toEqual({ ok: true, data: original.saved });
    expect(await page.evaluate(() => window.flowmate.personalTasks.list({ workId: 1, limit: 10 }))).toEqual({ ok: true, data: original.tasks });
    expect(await page.evaluate(() => window.flowmate.personalTasks.history({ target: { workId: 1 }, limit: 100 }))).toEqual({ ok: true, data: original.history });
    expect(requests).toBe(27);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await provider.stop(); } }
  if (failure) throw failure;
});
async function configure(page: Page, baseUrl: string) {
  expect(await page.evaluate(async baseUrl => {
    const current = await window.flowmate.getState(); if (!current.ok) return current;
    return window.flowmate.saveSettings({ ...current.data.settings, models: [{ id: 'personal-ui', credentialRef: '00000000000000000000000000000091',
      name: 'Personal fixture', kind: 'custom', providerId: null, baseUrl: baseUrl + '/v1', model: 'personal-ui-model',
      api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'personal-ui' },
    { modelId: 'personal-ui', apiKey: 'synthetic-personal-ui-key' });
  }, baseUrl)).toMatchObject({ ok: true });
  await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal Agent', exact: true })).toBeVisible();
  const personal = await page.evaluate(() => window.flowmate.personalAgent.get());
  expect(personal, JSON.stringify(personal)).toMatchObject({ ok: true });
  await page.locator('.personal-configuration > summary').click();
  await expect(page.getByLabel('Personal Agent model', { exact: true })).toBeVisible({ timeout: 5000 }).catch(async cause => {
    throw Error(String(cause) + '\nPersonal page: ' + await page.locator('.personal-agent-page').innerText());
  });
  await page.getByLabel('Personal Agent model', { exact: true }).selectOption('personal-ui');
  await page.getByRole('button', { name: 'Save assistant configuration', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Assistant configuration saved');
  await page.locator('.personal-configuration > summary').click();
}

test('Personal Agent creates only from its own module, recovers a lost receipt, reviews and explicitly disposes original invoices', async () => {
  test.setTimeout(120000);
  const userData = await seed(); let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined;
  const documents: DocumentSnapshot[] = [], perInvoice = new Map<number, number>(); let requests = 0;
  const provider = await createHttpProvider(async request => {
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    const context = JSON.parse(body.messages.find(message => message.role === 'user' && message.content.startsWith('{'))!.content) as { item: { documentRef: { id: number } } };
    requests++; const count = perInvoice.get(context.item.documentRef.id) ?? 0; perInvoice.set(context.item.documentRef.id, count + 1);
    return count % 2 === 0 ? stream({ document: documents.find(document => document.documentRef.id === context.item.documentRef.id)!, id: requests }) : stream('Saved the original candidate for human review.');
  });
  try {
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Invoices', exact: true })).toBeVisible();
    const material = await page.evaluate(() => window.flowmate.listDocuments({ limit: 10 })); if (!material.ok) throw Error(material.error.code); documents.push(...material.data.items);
    expect(documents).toHaveLength(2); await expect(page.getByRole('button', { name: 'New invoice work', exact: true })).toHaveCount(0);
    const workspaceBefore = await page.evaluate(() => window.flowmate.readWorkspace());
    await configure(page, 'http://127.0.0.1:' + provider.port); expect(requests).toBe(0);
    await expect(page.getByRole('textbox', { name: 'Message to model', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Object.hasOwn(window.flowmate.personalTasks, 'resume'))).toBe(false);
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await expect(page.getByLabel('Invoice work goal', { exact: true })).toBeFocused();
    await page.getByLabel('Invoice work goal', { exact: true }).fill('Review the two original invoices.');
    const choices = page.locator('.personal-create input[type=checkbox]'); await expect(choices).toHaveCount(2); await choices.nth(0).check(); await choices.nth(1).check();
    expect(requests).toBe(0); expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(workspaceBefore);
    await installReadGate(app, userData); await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').fail(1, 'invoice_work_create'));
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Original request awaiting confirmation', exact: true })).toBeVisible();
    await page.reload(); await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved receipt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check saved receipt', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => { const result = await window.flowmate.personalTasks.list({ workId: 1, limit: 10 }); return result.ok && result.data.items[0]?.stoppedAt !== null; })).toBe(true);
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    await expect(page.locator('.personal-work-detail')).toContainText('0 accepted'); expect(requests).toBe(4);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands.filter((command: { type: string }) => command.type === 'invoice_work_create').length)).toBe(1);
    const getsBefore = await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands.filter((command: { type: string }) => command.type === 'invoice_work_get').length);
    expect(await page.evaluate(() => window.flowmate.invoiceWorks.get({ view: 'work', workId: 1, nativeTaskId: 7 } as never))).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').commands.filter((command: { type: string }) => command.type === 'invoice_work_get').length)).toBe(getsBefore);
    await page.getByRole('tab', { name: 'History', exact: true }).click(); await expect(page.getByRole('region', { name: 'Durable history', exact: true })).toBeVisible();
    await expect(page.getByText('Saved Entry watermark', { exact: false })).toBeVisible();
    await page.getByRole('tab', { name: 'Timeline', exact: true }).click(); await expect(page.getByRole('region', { name: 'Work evidence timeline', exact: true })).toBeVisible();
    expect(requests).toBe(4);
    await page.getByRole('tab', { name: 'Invoices', exact: true }).click(); await page.locator('.personal-items button').first().click();
    await expect(page.getByRole('region', { name: 'Selected Work invoice', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Personal Agent invoice review', exact: true })).toBeVisible();
    const selected = await page.evaluate(async () => { const saved = await window.flowmate.invoiceWorks.get({ view: 'work', workId: 1 }); return saved.ok && saved.data.view === 'work' ? saved.data.items[0] : null; });
    if (!selected) throw Error('Expected the original Work invoice.');
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true,
      data: { documentRef: selected.documentRef, jobId: selected.jobId, candidateRef: selected.candidateRef } });
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    await page.getByRole('button', { name: 'Edit result', exact: true }).click(); await expect(page.getByRole('button', { name: 'Accept result', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Accept result', exact: true }).click();
    await page.getByRole('button', { name: 'Return to Personal Agent Work 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Attach confirmed acceptance', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Attach confirmed acceptance', exact: true }).click();
    await expect(page.locator('.personal-work-detail')).toContainText('1 accepted');
    await page.locator('.personal-items button').nth(1).click(); await page.getByLabel('Disposition reason', { exact: true }).fill('Explicitly excluded after review.');
    await page.getByRole('button', { name: 'Exclude invoice from this work', exact: true }).click();
    await expect(page.locator('.personal-work-detail')).toContainText('1 excluded'); await expect(page.locator('.personal-work-detail header')).toContainText('completed');
    expect(requests).toBe(4);
    await page.getByRole('button', { name: 'Create related work', exact: true }).click(); expect(requests).toBe(4);
    await expect(page.getByRole('heading', { name: 'Create related invoice work', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Work 2', exact: true })).toBeVisible();
    await expect(page.locator('.personal-work-detail')).toContainText('2 unresolved');
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'invoice_work_get'));
    const refresh = page.getByRole('button', { name: 'Refresh saved work', exact: true }); await refresh.click();
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await page.locator('.personal-work-list > button').last().click(); await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await expect(page.locator('.personal-work-detail header')).toContainText('completed');
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await provider.stop(); } }
  if (failure) throw failure;
});

test('a finished Work releases only a confirmed original acceptance and another Work can open invoice review', async () => {
  test.setTimeout(90000);
  const userData = await seed(); let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined;
  let requests = 0, document: DocumentSnapshot | undefined;
  const provider = await createHttpProvider(async () => {
    requests++;
    return requests % 2 === 1 ? stream({ document: document!, id: requests }) : stream('The original candidate is ready for human review.');
  });
  try {
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    const materials = await page.evaluate(() => window.flowmate.listDocuments({ limit: 10 })); if (!materials.ok) throw Error(materials.error.code);
    document = materials.data.items[0]; if (!document) throw Error('Expected an original invoice.');
    await configure(page, 'http://127.0.0.1:' + provider.port);
    for (const workId of [1, 2]) {
      await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
      await page.getByLabel('Invoice work goal', { exact: true }).fill('Review the original invoice for Work ' + workId).catch(async cause => {
        throw Error('Creating Work ' + workId + ': ' + String(cause) + '\n' + await page.locator('.personal-agent-page').innerText());
      });
      await page.locator('.personal-create input[type=checkbox]').first().check();
      await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Work ' + workId, exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(async workId => { const saved = await window.flowmate.personalTasks.list({ workId, limit: 10 });
        return saved.ok && saved.data.items.some(item => item.stoppedAt !== null); }, workId)).toBe(true);
      await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    }
    await page.locator('.personal-work-list > button').last().click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await page.locator('.personal-items button').first().click();
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Personal Agent invoice review', exact: true })).toContainText('Work 1');
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    await page.getByRole('button', { name: 'Edit result', exact: true }).click();
    await page.getByRole('button', { name: 'Accept result', exact: true }).click();
    await page.getByRole('button', { name: 'Return to Personal Agent Work 1', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel entire work', exact: true }).click();
    await expect(page.locator('.personal-work-detail header')).toContainText('cancelled');
    await installReadGate(app, userData); await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').fail(1, 'query_invoice_candidate_operation'));
    const release = page.getByRole('button', { name: 'Check original acceptance', exact: true });
    await expect(release).toBeVisible(); await release.click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('flowmate.personal-agent.draft.v1')!).review.acceptRequest !== null)).toBe(true);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'invoice_work_get'));
    await release.click();
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal', { exact: true }).fill('A newer draft must survive the previous page response.');
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    await page.evaluate(() => window.flowmate.invoiceWorks.get({ view: 'work', workId: 1 }));
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('flowmate.personal-agent.draft.v1')!).goal))
      .toBe('A newer draft must survive the previous page response.');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('flowmate.personal-agent.draft.v1')!).review.acceptRequest !== null)).toBe(true);
    await page.getByRole('button', { name: 'Keep draft and close', exact: true }).click();
    await page.getByRole('button', { name: 'Check original acceptance', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Original acceptance confirmed. The finished Work review link was released.');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('flowmate.personal-agent.draft.v1')!).review)).toBeNull();
    await page.locator('.personal-work-list > button').first().click();
    await expect(page.getByRole('heading', { name: 'Work 2', exact: true })).toBeVisible();
    await page.locator('.personal-items button').first().click();
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Personal Agent invoice review', exact: true })).toContainText('Work 2');
    expect(requests).toBe(4);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await provider.stop(); } }
  if (failure) throw failure;
});

test('Personal Agent saves a stopped invoice supplement without execution and distinguishes attempt stop from Work cancellation', async () => {
  test.setTimeout(90000);
  const userData = await seed(); let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined;
  let requests = 0, release = () => {};
  const provider = await createHttpProvider(async request => {
    requests++;
    if (requests > 1) await new Promise<void>(resolveHeld => { release = resolveHeld; request.signal.addEventListener('abort', () => resolveHeld(), { once: true }); });
    return stream('Review the original invoice and provide clarification before preparing a candidate.');
  });
  try {
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    await configure(page, 'http://127.0.0.1:' + provider.port);
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal', { exact: true }).fill('Retain the original invoice clarification and review.');
    await page.locator('.personal-create input[type=checkbox]').first().check(); await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => { const tasks = await window.flowmate.personalTasks.list({ workId: 1, limit: 10 }); return tasks.ok && tasks.data.items[0]?.stoppedAt !== null; })).toBe(true);
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click(); await page.locator('.personal-items button').first().click();
    await expect(page.locator('.personal-todo form textarea')).toBeVisible();
    await page.locator('.personal-todo form textarea').fill('First clarification authorizes this invoice to continue.');
    await page.getByRole('button', { name: /^Save supplement for Todo / }).click(); await expect.poll(() => requests).toBe(2);
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    const stop = page.getByRole('button', { name: 'Stop current attempt', exact: true }); await expect(stop).toBeEnabled(); await stop.click();
    await expect(page.locator('.personal-work-detail')).toContainText('Execution was stopped or failed.');
    await expect(page.locator('.personal-work-detail header')).toContainText('open');
    await page.locator('.personal-todo form textarea').fill('Second clarification is saved while stopped.');
    await page.getByRole('button', { name: /^Save supplement for Todo / }).click();
    await expect(page.locator('.personal-agent-page > .notice[role=status]')).toContainText('Supplement saved.'); expect(requests).toBe(2);
    await page.getByRole('button', { name: 'Continue work', exact: true }).click(); await expect.poll(() => requests).toBe(3);
    await page.getByRole('button', { name: 'Cancel entire work', exact: true }).click();
    await expect(page.locator('.personal-work-detail header')).toContainText('cancelled');
    expect(await page.evaluate(async () => { const result = await window.flowmate.invoiceWorks.get({ view: 'work', workId: 1 }); return result.ok ? result.data.work.status : result.error.code; })).toBe('cancelled');
    expect(requests).toBe(3);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { release(); if (app) await closeDesktopFixture(app, userData, failure); } finally { await provider.stop(); } }
  if (failure) throw failure;
});

test('Personal Agent configuration keeps explicit resource versions, failed drafts and accepted Work configuration', async () => {
  test.setTimeout(90000);
  const userData = await seed(); let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined;
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }> = [];
  const provider = await createHttpProvider(async request => { requests.push(await request.json()); return stream('The original invoice needs human clarification.'); });
  try {
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    const page = await app.firstWindow();
    await configure(page, 'http://127.0.0.1:' + provider.port);
    const original = await page.evaluate(() => window.flowmate.personalAgent.get()); if (!original.ok) throw Error(original.error.code);
    const create = async (id: number) => {
      await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
      await page.getByLabel('Invoice work goal', { exact: true }).fill('Keep accepted configuration for Work ' + id);
      await page.locator('.personal-create input[type=checkbox]').first().check();
      await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Work ' + id, exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(async workId => { const tasks = await window.flowmate.personalTasks.list({ workId, limit: 10 });
        return tasks.ok && tasks.data.items.some(task => task.stoppedAt !== null); }, id)).toBe(true);
    };
    await create(1); expect(requests).toHaveLength(1);
    await page.locator('.personal-configuration > summary').click();
    const prompt = page.getByLabel('Personal Agent Prompt', { exact: true });
    await expect(prompt).toBeVisible();
    const edit = async () => {
      await prompt.selectOption(JSON.stringify(['prompt', 'invoice', 'v1']));
      await page.getByLabel('Enable Skill invoice-header-extraction v1', { exact: true }).check();
      await page.getByLabel('Enable Personal Agent tool Agent', { exact: true }).uncheck();
      await page.getByLabel('Personal Agent working directory', { exact: true }).fill(userData);
      await page.getByLabel('Assistant preferences', { exact: true }).fill('Use the explicitly selected invoice guidance.');
    };
    await edit();
    await expect(page.getByLabel('Enable Skill deep-research v1', { exact: true })).toBeDisabled();
    await expect(page.getByRole('group', { name: 'Personal Agent extensions', exact: true })).toContainText('No Durable phase adapter');
    await expect(page.getByLabel('Enable Personal Agent tool bash', { exact: true })).toHaveCount(0);
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').fail(1, 'personal_agent_get'));
    await page.getByRole('button', { name: 'Reload saved configuration', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Assistant preferences', { exact: true })).toHaveValue('Use the explicitly selected invoice guidance.');
    expect(await page.evaluate(async initial => window.flowmate.personalAgent.update({ personalAgentId: initial.personalAgentId,
      expectedRevision: initial.revision, configuration: { ...initial.configuration, preferences: 'A concurrent saved choice.' } }), original.data)).toMatchObject({ ok: true });
    await page.getByRole('button', { name: 'Save assistant configuration', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(prompt).toHaveValue(JSON.stringify(['prompt', 'invoice', 'v1']));
    await expect(page.getByLabel('Assistant preferences', { exact: true })).toHaveValue('Use the explicitly selected invoice guidance.');
    expect(await page.evaluate(() => window.flowmate.personalAgent.get())).toMatchObject({ ok: true, data: { configuration: { preferences: 'A concurrent saved choice.' } } });
    await page.getByRole('button', { name: 'Reload saved configuration', exact: true }).click();
    await expect(page.getByLabel('Assistant preferences', { exact: true })).toHaveValue('A concurrent saved choice.');
    await edit();
    await page.getByRole('button', { name: 'Save assistant configuration', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Assistant configuration saved');
    const saved = await page.evaluate(() => window.flowmate.personalAgent.get()); if (!saved.ok) throw Error(saved.error.code);
    expect(saved.data.configuration).toMatchObject({ resources: { prompt: { kind: 'prompt', id: 'invoice', version: 'v1' },
      enabledSkills: [{ kind: 'skill', id: 'invoice-header-extraction', version: 'v1' }] }, workingDirectory: userData,
      preferences: 'Use the explicitly selected invoice guidance.', extensions: { enabledExtensions: [] } });
    expect(saved.data.configuration.tools).not.toContain('Agent'); expect(requests).toHaveLength(1);
    await page.locator('.personal-configuration > summary').click();
    await create(2); expect(requests).toHaveLength(2);
    const instructions = (index: number) => JSON.parse(requests[index]!.messages.find(message => message.role === 'system')!.content.split('Frozen phase instructions:\n').at(-1)!);
    expect(instructions(0)).toMatchObject({ preferences: original.data.configuration.preferences, resources: null });
    expect(instructions(1)).toMatchObject({ preferences: saved.data.configuration.preferences, resources: {
      prompt: { ref: saved.data.configuration.resources.prompt }, skills: [{ ref: saved.data.configuration.resources.enabledSkills[0] }] } });
    expect(requests[0]!.tools.some(tool => tool.function.name === 'Agent')).toBe(true);
    expect(requests[1]!.tools.some(tool => tool.function.name === 'Agent')).toBe(false);
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Durable history', exact: true })).toBeVisible();
    expect(requests).toHaveLength(2);
    await closeDesktopFixture(app, userData); app = null;
    const stored = spawnSync(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', '-e', `
      import { Database } from 'bun:sqlite'; const input=JSON.parse(await Bun.stdin.text());
      const db=new Database(input.path,{readonly:true}); try { console.log(JSON.stringify(db.query('SELECT id,configuration_json FROM invoice_works ORDER BY id').all())); } finally { db.close(); }
    `], { cwd: root, input: JSON.stringify({ path: join(userData, 'data/app.sqlite') }), encoding: 'utf8', windowsHide: true });
    if (stored.status !== 0) throw Error('Original configuration read failed: ' + stored.stderr);
    const configurations = (JSON.parse(stored.stdout) as Array<{ id: number; configuration_json: string }>).map(row => JSON.parse(row.configuration_json) as PersonalAgentConfiguration);
    expect(configurations).toEqual([original.data.configuration, saved.data.configuration]);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await provider.stop(); } }
  if (failure) throw failure;
});

test('a Personal Agent candidate uses an explicitly selected AgentSession for the original Fill bridge without changing its Durable Work', async () => {
  test.setTimeout(120000);
  const userData = await seed(); let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined;
  type Body = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
  const requests: Body[] = [], documents: DocumentSnapshot[] = []; let candidateId: number | null = null, personalRequests = 0;
  const provider = await createHttpProvider(async request => {
    const body = await request.json() as Body; requests.push(body);
    if (body.tools?.some(tool => tool.function.name === 'fill_invoice_form')) {
      if (body.messages.some(message => message.tool_call_id === 'personal-original-fill')) return stream('The original candidate is applied to the form for human review.');
      if (candidateId === null) throw Error('Fill must use the original saved candidate.');
      return new Response('data: ' + JSON.stringify({ id: 'personal-fill-response', object: 'chat.completion.chunk', created: 1, model: 'personal-ui-model',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'personal-original-fill', type: 'function',
          function: { name: 'fill_invoice_form', arguments: JSON.stringify({ candidateId }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }
    personalRequests++;
    if (personalRequests === 2) return stream('The original candidate is saved for explicit human review.');
    const message = body.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('{'));
    if (!message || typeof message.content !== 'string') throw Error('Expected the original Durable invoice phase.');
    const context = JSON.parse(message.content) as { item: { documentRef: { id: number } } };
    const document = documents.find(document => document.documentRef.id === context.item.documentRef.id);
    if (!document) throw Error('Expected the selected original invoice.');
    return stream({ document, id: personalRequests });
  });
  try {
    app = await electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
    const page = await app.firstWindow();
    const material = await page.evaluate(() => window.flowmate.listDocuments({ limit: 10 })); if (!material.ok) throw Error(material.error.code); documents.push(...material.data.items);
    await configure(page, 'http://127.0.0.1:' + provider.port); expect(requests).toHaveLength(0);
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { sessionId: null } });
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal', { exact: true }).fill('Prepare this original invoice for explicit foreground form review.');
    await page.locator('.personal-create input[type=checkbox]').first().check();
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => { const tasks = await window.flowmate.personalTasks.list({ workId: 1, limit: 10 });
      return tasks.ok && tasks.data.items.some(task => task.runStatus === 'completed' && task.stoppedAt !== null); })).toBe(true);
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    const original = await page.evaluate(async () => {
      const [work, conversation, tasks, history, sessions] = await Promise.all([window.flowmate.invoiceWorks.get({ view: 'work', workId: 1, limit: 10 }),
        window.flowmate.personalAgent.openConversation({ workId: 1 }), window.flowmate.personalTasks.list({ workId: 1, limit: 10 }),
        window.flowmate.personalTasks.history({ target: { workId: 1 }, limit: 100 }), window.flowmate.listSessions()]);
      if (!work.ok || work.data.view !== 'work' || !conversation.ok || !tasks.ok || !history.ok || !sessions.ok) throw Error('Original Durable Work facts are unavailable.');
      return { work: work.data, conversation: conversation.data, tasks: tasks.data, history: history.data, sessions: sessions.data };
    });
    expect(original.sessions.items).toEqual([]); expect(original.conversation).toMatchObject({ runtimeKind: 'durable', sessionId: original.work.work.sessionId });
    expect(original.tasks.items).toHaveLength(1); expect(original.history.nextBeforeEntryId).toBeNull();
    const item = original.work.items[0]; if (!item?.candidateRef || item.jobId === null) throw Error('Expected the actual Personal Agent candidate.');
    candidateId = item.candidateRef.id; expect(requests).toHaveLength(2);
    await page.locator('.personal-items button').first().click();
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Personal Agent invoice review', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    const fill = page.getByRole('button', { name: 'Fill form', exact: true }); await expect(fill).toBeDisabled();
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true,
      data: { sessionId: null, jobId: item.jobId, candidateRef: item.candidateRef, documentRef: item.documentRef } });
    expect(await page.evaluate(() => window.flowmate.listSessions())).toEqual({ ok: true, data: original.sessions }); expect(requests).toHaveLength(2);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => { const workspace = await window.flowmate.readWorkspace(); return workspace.ok && workspace.data.sessionId !== null; })).toBe(true);
    const selected = await page.evaluate(async () => { const workspace = await window.flowmate.readWorkspace();
      if (!workspace.ok || workspace.data.sessionId === null) throw Error('Expected an explicitly created foreground Session.');
      const session = await window.flowmate.querySession(workspace.data.sessionId); if (!session.ok) throw Error(session.error.code); return session.data; });
    expect(selected).toMatchObject({ runtimeKind: 'agent_session', availability: 'ready' }); expect(selected.sessionId).not.toBe(original.conversation.sessionId); expect(requests).toHaveLength(2);
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible(); await page.locator('.personal-items button').first().click();
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Personal Agent invoice review', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    await expect(fill).toBeEnabled(); expect(requests).toHaveLength(2); await fill.click();
    await expect(page.getByRole('region', { name: 'Invoice form', exact: true })).toContainText('Revision 1');
    await expect(page.getByLabel('Total amount', { exact: true })).toHaveValue('113.00');
    await expect.poll(() => page.evaluate(async () => { const state = await window.flowmate.queryRuntimeState(); return state.ok && state.data.active === null && !state.data.blocked; })).toBe(true);
    const applied = await page.evaluate(async ({ sessionId, jobId, candidateId }) => {
      const runs = await window.flowmate.listSessionRuns({ sessionId }); if (!runs.ok || runs.data.items.length !== 1) throw Error('Expected one original foreground Fill Run.');
      const run = await window.flowmate.queryRun(runs.data.items[0]!.runId); if (!run.ok) throw Error(run.error.code);
      const tools = await window.flowmate.listRunToolCalls({ runId: run.data.runId, sessionId }); if (!tools.ok || tools.data.items.length !== 1) throw Error('Expected the actual original Fill tool call.');
      return { run: run.data, tools: tools.data.items, receipt: await window.flowmate.queryInvoiceFormApplication({ runId: run.data.runId, toolCallId: tools.data.items[0]!.toolCallId }),
        candidate: await window.flowmate.queryJobCandidate({ jobId, candidateId }) };
    }, { sessionId: selected.sessionId, jobId: item.jobId, candidateId: item.candidateRef.id });
    expect(applied.run).toMatchObject({ kind: 'agent', sessionId: selected.sessionId, jobId: item.jobId, status: 'completed' });
    expect('runtimeKind' in applied.run && applied.run.runtimeKind === 'durable').toBe(false);
    const target = InvoiceFormTargetSchema.parse(applied.run.config.formTarget), frozen = WorkspaceContextSchema.parse(applied.run.config.workspaceContext);
    expect(frozen).toMatchObject({ sessionId: selected.sessionId, documentRef: item.documentRef, jobId: item.jobId, candidateRef: item.candidateRef });
    expect(applied.tools).toMatchObject([{ toolName: 'fill_invoice_form', status: 'succeeded', formApplicationOutcome: 'applied' }]);
    expect(applied.receipt).toMatchObject({ ok: true, data: { outcome: 'applied', runId: applied.run.runId, toolCallId: applied.tools[0]!.toolCallId,
      formInstanceId: target.formInstanceId, candidateId: item.candidateRef.id, candidateSequence: item.candidateRef.sequence, appliedRevision: target.expectedRevision + 1 } });
    expect(applied.candidate).toMatchObject({ ok: true, data: { candidate: { candidateId: item.candidateRef.id, sequence: item.candidateRef.sequence, status: 'generated' } } });
    const after = await page.evaluate(async () => ({ work: await window.flowmate.invoiceWorks.get({ view: 'work', workId: 1, limit: 10 }),
      conversation: await window.flowmate.personalAgent.openConversation({ workId: 1 }), tasks: await window.flowmate.personalTasks.list({ workId: 1, limit: 10 }),
      history: await window.flowmate.personalTasks.history({ target: { workId: 1 }, limit: 100 }) }));
    expect(after.conversation).toEqual({ ok: true, data: original.conversation }); expect(after.tasks).toEqual({ ok: true, data: original.tasks }); expect(after.history).toEqual({ ok: true, data: original.history });
    expect(after.work).toMatchObject({ ok: true, data: { work: { sessionId: original.work.work.sessionId, runtimeKind: 'durable', status: 'open',
      execution: { attempt: original.work.work.execution.attempt }, counts: { accepted: 0, unresolved: 1 } }, items: [{ disposition: 'unresolved', candidateRef: item.candidateRef }] } });
    const fillRequests = requests.filter(body => body.tools?.some(tool => tool.function.name === 'fill_invoice_form'));
    expect(fillRequests).toHaveLength(2); expect(fillRequests[0]!.tools!.map(tool => tool.function.name)).toEqual(['fill_invoice_form']);
    expect(JSON.stringify(fillRequests[1]!.messages.find(message => message.tool_call_id === 'personal-original-fill'))).toContain('applied');
    expect(requests).toHaveLength(4);
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click(); expect(requests).toHaveLength(4);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
    await closeDesktopFixture(app, userData, failure); } } finally { await provider.stop(); } }
  if (failure) throw failure;
});
