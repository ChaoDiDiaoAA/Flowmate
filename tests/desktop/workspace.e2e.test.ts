import { _electron as electron } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { invoiceHeaderFields, invoiceLineFields } from '@flowmate/contracts';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp, waitFor } from '../support/resources.ts';

it.afterEach(cleanupResources);

it('P7 Workspace is the seventh shared navigation destination and preserves a null saved chat', async () => {
  it.setTimeout(45_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p7-empty-workspace-'));
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await expect(page.locator('.rail .nav-item')).toHaveCount(7, { timeout: 3000 });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByTestId('workspace-page')).toBeVisible();
    await expect(page.getByTestId('workspace-summary')).toContainText('No invoice selected');
    const created = await page.evaluate(() => window.flowmate.createSession({ title: 'Saved, unselected chat' }));
    expect(created.ok).toBe(true);
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByTestId('workspace-summary')).toContainText('No chat selected');
    expect(await page.evaluate(async () => {
      const result = await window.flowmate.readWorkspace(); return result.ok ? result.data.sessionId : 'unavailable';
    })).toBeNull();
    await expect(page.getByRole('textbox', { name: 'Message to model' })).toBeEditable();
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { if (app) await closeDesktopFixture(app, userData, failure); }
});

it('P7 historical hidden invoice material cannot become the current Workspace source', async () => {
  it.setTimeout(60_000);
  const { userData, env, version } = await fixture(false, false, true);
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    expect(await page.evaluate(async () => {
      const session = await window.flowmate.createSession({ title: 'A current chat' }); if (!session.ok) throw new Error('Session failed');
      let workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace failed');
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } }); if (!workspace.ok) throw new Error('Session selection failed');
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'document', documentId: 2 } }); if (!workspace.ok) throw new Error('B selection failed');
      const task = await window.flowmate.startTask({ clientSequence: workspace.data.nextTaskSequence, expectedRevision: workspace.data.revision,
        documentRef: workspace.data.documentRef!, goal: 'Historical invoice B task' }); if (!task.ok) throw new Error('Task failed');
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: task.data.workspace.revision, change: { kind: 'document', documentId: 1 } }); if (!workspace.ok) throw new Error('A selection failed');
      return window.flowmate.hideDocument(2);
    })).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Invoice or processing record', { exact: true }).selectOption('processing:1');
    await page.getByRole('button', { name: 'View invoice', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Invoice 000002', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Parsed', exact: true }).click();
    await expect(page.locator('.parsed-list')).toContainText('Hidden invoice B source');
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { documentRef: { id: 1, version } } });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.getByRole('tab', { name: 'Parsed', exact: true }).click();
    await expect(page.locator('.workspace-blocks')).toContainText('Fixture block 1');
    await expect(page.locator('.workspace-blocks')).not.toContainText('Hidden invoice B source');
    for (const fault of [
      { type: 'list_document_pages', identity: 'document' }, { type: 'list_document_pages', identity: 'version' }, { type: 'list_document_pages', identity: 'artifact' },
      { type: 'read_document_page', identity: 'document' }, { type: 'read_document_page', identity: 'version' }, { type: 'read_document_page', identity: 'artifact' },
      { type: 'read_document_original', identity: 'document' }, { type: 'read_document_original', identity: 'version' },
    ] as const) {
      await corruptOneMaterialIdentity(app, userData, fault);
      await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
      await expect(page.getByRole('alert'), `${fault.type}:${fault.identity}`).toContainText('The invoice material changed. Refresh the workspace.');
      await expect(page.locator('.workspace-blocks')).toContainText('Fixture block 1');
      await expect(page.locator('.workspace-blocks')).not.toContainText('Hidden invoice B source');
      await expect(page.getByRole('button', { name: 'Select block b1', exact: true })).toBeDisabled();
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { p7MaterialIdentityFault: { changed: number } }).p7MaterialIdentityFault.changed)).toBe(1);
      await app.evaluate(() => (globalThis as typeof globalThis & { p7MaterialIdentityFault: { restore(): void } }).p7MaterialIdentityFault.restore());
      await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Select block b1', exact: true })).toBeEnabled();
    }
    await corruptOneMaterialIdentity(app, userData, { type: 'read_document_page', identity: 'artifact' });
    await page.getByRole('button', { name: 'More blocks', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The invoice material changed. Refresh the workspace.');
    await expect(page.getByRole('button', { name: 'Select block b51', exact: true })).toHaveCount(0);
    await app.evaluate(() => (globalThis as typeof globalThis & { p7MaterialIdentityFault: { restore(): void } }).p7MaterialIdentityFault.restore());
    await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select block b1', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Select block b1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select block b1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { selection: {
      targetId: 1, targetVersion: version, artifactId: 2, page: 1, block: 'b1' } } });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { if (app) await closeDesktopFixture(app, userData, failure); }
});

it('P7 sparse parsed pages are actual identities and unavailable original mapping cannot forge page 1', async () => {
  it.setTimeout(45_000);
  const { userData, env, version } = await fixture(true);
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    expect(await page.evaluate(async () => {
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace unavailable');
      return window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'document', documentId: 1 } });
    })).toMatchObject({ ok: true });
    const index = await page.evaluate(() => window.flowmate.listDocumentPages({ documentId: 1 }));
    expect(index).toMatchObject({ ok: true, data: { documentRef: { id: 1, version }, pages: [{ page: 2 }, { page: 5 }] } });
    expect(await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      return handlers.get('flowmate:restore-workspace')!({ sender: contents, senderFrame: { url: 'https://untrusted.invalid' } });
    })).toMatchObject({ ok: false, error: { code: 'ipc_forbidden' } });
    expect(await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      return handlers.get('flowmate:restore-workspace')!({ sender: contents, senderFrame: contents.mainFrame }, { path: 'forged' });
    })).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select page 1', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Parsed', exact: true }).click();
    await expect(page.getByLabel('Parsed page', { exact: true }).locator('option')).toHaveText(['Page 2', 'Page 5']);
    await page.getByLabel('Parsed page', { exact: true }).selectOption('5');
    await expect(page.getByRole('button', { name: 'Select block b53', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Select parsed page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select parsed page', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { selection: {
      formatVersion: 1, kind: 'source', target: 'document', targetId: 1, targetVersion: version, artifactId: 2, page: 5 } } });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { if (app) await closeDesktopFixture(app, userData, failure); }
});

function stream(value: string | { name: string; id: string; args: unknown }) {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'p7-fixture', object: 'chat.completion.chunk', created: 1,
    model: 'p7-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const delta = typeof value === 'string' ? { role: 'assistant', content: value } : { role: 'assistant', tool_calls: [
    { index: 0, id: value.id, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.args) } },
  ] };
  return new Response(`${chunk(delta, null)}${chunk({}, typeof value === 'string' ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(sparse = false, failCleanup = false, secondDocument = false) {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p7-workspace-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-p7-material-'));
  const source = join(sourceRoot, '000001'); mkdirSync(source);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([...Array.from({ length: 52 }, (_, index) => ({ type: 'text', text: `Fixture block ${index + 1}`,
    bbox: [0, 0, 10, 10], page_idx: 0 })), { type: 'text', text: 'Second page source', bbox: [0, 0, 10, 10], page_idx: 1 }]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'First page', blockCount: 52 }, { pageNumber: 2, text: 'Second page source', blockCount: 1 }]);
  writeFileSync(join(source, 'original.png'), png); writeFileSync(join(source, 'content.json'), content); writeFileSync(join(source, 'pages.json'), pages);
  writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'p7-controlled', datasetRevision: 'rev-1', qualityStatus: 'complete', allowedUsesClaim: ['local review'],
    licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: png.length }, { path: 'content.json', bytes: Buffer.byteLength(content) },
      { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
  const digest = createHash('sha256');
  for (const name of ['original.png', 'content.json', 'pages.json', 'metadata.json']) {
    const bytes = readFileSync(join(source, name)); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); digest.update(length).update(bytes);
  }
  const version = 'p7-legacy-v1';
  const parsed = { formatVersion: 2, pages: [{ page: sparse ? 2 : 1, blocks: Array.from({ length: 52 }, (_, index) => ({ id: `b${index + 1}`,
    kind: 'text', text: `Fixture block ${index + 1}`, sourceIndex: index, sourceType: 'controlled', bbox: null })) },
    { page: sparse ? 5 : 2, blocks: [{ id: 'b53', kind: 'text', text: 'Second page source', sourceIndex: 0, sourceType: 'controlled', bbox: null }] }],
    completeness: { status: 'complete', checks: [], warnings: [] } };
  const seed = spawnSync(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', '-e', `
    import { openDatabase, createFileStore } from '@flowmate/core';
    import { resolveProductPaths } from '@flowmate/shared';
    const input = JSON.parse(await Bun.stdin.text()); const paths = resolveProductPaths(input.root);
    if (!paths.ok) throw new Error(paths.error.code);
    const opened = openDatabase(paths.data); if (!opened.ok) throw new Error(opened.error.code);
    try {
      const at = '2026-10-03T00:00:00.000Z';
      const files = createFileStore(paths.data, opened.data.documents);
      const published = await files.publish({ sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p7-controlled',sourceVersion:input.version,at,
        original:{kind:'original',primaryName:'original.png',files:[{name:'original.png',bytes:Buffer.from(input.png,'base64'),mimeType:'image/png'}]},
        parsed:{kind:'parsed',primaryName:'parsed.json',files:[{name:'parsed.json',bytes:Buffer.from(JSON.stringify(input.parsed)),mimeType:'application/json'}]} });
      if (!published.ok) throw new Error(published.error.code);
      const result = opened.data.documents.register({documentId:published.data.documentId,sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p7-controlled',version:input.version,
        originalArtifact:published.data.original,parsedArtifact:published.data.parsed,status:'available',
        metadata:{version:2,sampleId:'000001',pageCount:input.parsed.pages.length,warnings:[],allowedUsesClaim:['local review'],licenseVerification:'not_verified',unavailableReason:null},createdAt:at,updatedAt:at});
      if (!result.ok) throw new Error(result.error.code);
      if (input.secondDocument) {
        const secondParsed = {formatVersion:2,pages:[{page:1,blocks:[{id:'b1',kind:'text',text:'Hidden invoice B source',sourceIndex:0,sourceType:'controlled',bbox:null}]}],completeness:{status:'complete',checks:[],warnings:[]}};
        const second = await files.publish({sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p7-controlled-B',sourceVersion:'p7-legacy-B',at,
          original:{kind:'original',primaryName:'original.png',files:[{name:'original.png',bytes:Buffer.from(input.png,'base64'),mimeType:'image/png'}]},
          parsed:{kind:'parsed',primaryName:'parsed.json',files:[{name:'parsed.json',bytes:Buffer.from(JSON.stringify(secondParsed)),mimeType:'application/json'}]} });
        if (!second.ok) throw new Error(second.error.code);
        const registered = opened.data.documents.register({documentId:second.data.documentId,sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p7-controlled-B',version:'p7-legacy-B',
          originalArtifact:second.data.original,parsedArtifact:second.data.parsed,status:'available',metadata:{version:2,sampleId:'000002',pageCount:1,warnings:[],allowedUsesClaim:['local review'],licenseVerification:'not_verified',unavailableReason:null},createdAt:at,updatedAt:at});
        if (!registered.ok) throw new Error(registered.error.code);
      }
      if (input.failCleanup) opened.data.db.exec("CREATE TRIGGER p7_fail_workspace BEFORE UPDATE ON workspace WHEN NEW.active_document_id IS NULL AND OLD.active_document_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'p7 controlled cleanup failure'); END");
    } finally { opened.data.close(); }
  `], { cwd: resolve(import.meta.dirname, '../..'), input: JSON.stringify({ root: userData, version, parsed, png: png.toString('base64'), failCleanup, secondDocument }),
    encoding: 'utf8', windowsHide: true });
  if (seed.status !== 0) throw new Error(`Managed fixture seed failed: ${seed.stderr}`);
  const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  const candidate = { fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, name === 'invoiceNumber'
    ? { raw: 'P7-CONTROLLED', normalized: 'P7-CONTROLLED', state: 'present', alternatives: [], sources: [
      { documentId: 1, version, artifactId: 2, page: 1, blockId: 'b1', quote: 'Fixture block 1' },
      { documentId: 1, version, artifactId: 2, page: 2, blockId: 'b53', quote: 'Second page source' },
    ] } : missing])), lines: [Object.fromEntries(invoiceLineFields.map(name => [name, { ...missing }]))], notes: [] };
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData, FLOWMATE_TEST_INVOICE_SOURCE_ROOT: sourceRoot };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return { userData, source, env, candidate, version };
}

const headerLabels = ['Invoice number', 'Issue date', 'Seller name', 'Seller tax ID', 'Buyer name', 'Buyer tax ID', 'Currency', 'Net amount', 'Tax amount', 'Total amount'];
const lineLabels = ['Description', 'Quantity', 'Unit', 'Unit price', 'Net amount', 'Tax rate', 'Tax amount', 'Total amount'];

async function corruptOneMaterialIdentity(app: Awaited<ReturnType<typeof electron.launch>>, userData: string,
  fault: { type: 'list_document_pages' | 'read_document_page' | 'read_document_original' | 'query_job_candidate'; identity: 'document' | 'version' | 'artifact' | 'job' | 'candidate' | 'sequence' }) {
  await app.evaluate((_electron, { root, fault }) => {
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
      && value.spawnargs.includes('apps/host/main.ts') && value.spawnargs.includes(root)) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    if (!child?.stdin || !child.stdout) throw new Error('Owned Host pipe missing');
    const write = child.stdin.write, emit = child.stdout.emit; let buffer = Buffer.alloc(0), targetId: string | null = null;
    const gate = { changed: 0, restore() { child.stdin.write = write; child.stdout.emit = emit; } };
    child.stdin.write = function (...args: Parameters<typeof write>) {
      const command = JSON.parse(String(args[0])) as { type?: string; requestId?: string };
      if (command.type === fault.type) targetId ??= command.requestId ?? null;
      return Reflect.apply(write, child.stdin, args);
    } as typeof write;
    child.stdout.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, child.stdout, [event, ...args]);
      buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
        const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        const response = JSON.parse(line.toString('utf8')) as { type?: string; requestId?: string; value?: { ok: boolean; data: Record<string, unknown> } };
        if (!gate.changed && targetId && response.type === 'response' && response.requestId === targetId && response.value?.ok) {
          if (fault.identity === 'document') response.value.data.documentRef = { id: 2, version: 'p7-legacy-B' };
          else if (fault.identity === 'version') response.value.data.documentRef = { id: 1, version: 'p7-legacy-B' };
          else if (fault.identity === 'artifact') response.value.data.parsedArtifactId = 4;
          else {
            const candidate = response.value.data.candidate as Record<string, unknown>;
            if (fault.identity === 'job') candidate.jobId = 2;
            if (fault.identity === 'candidate') candidate.candidateId = 2;
            if (fault.identity === 'sequence') candidate.sequence = 2;
          }
          gate.changed++; forward.push(Buffer.from(`${JSON.stringify(response)}\n`));
        } else forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, child.stdout, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    (globalThis as typeof globalThis & { p7MaterialIdentityFault?: typeof gate }).p7MaterialIdentityFault = gate;
  }, { root: userData, fault });
}

async function dropOneWorkspaceReceipt(app: Awaited<ReturnType<typeof electron.launch>>, userData: string) {
  await app.evaluate((_electron, root) => {
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
      && value.spawnargs.includes('apps/host/main.ts') && value.spawnargs.includes(root)) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    if (!child?.stdin || !child.stdout) throw new Error('Isolated P7 Host pipe missing');
    const write = child.stdin.write, emit = child.stdout.emit;
    let buffer = Buffer.alloc(0), targetId: string | null = null;
    const gate = { writes: 0, reads: 0, dropped: 0, restore() { child.stdin.write = write; child.stdout.emit = emit; } };
    child.stdin.write = function (...args: Parameters<typeof write>) {
      try { const command = JSON.parse(String(args[0])) as { type?: string; requestId?: string };
        if (command.type === 'update_workspace') { gate.writes++; targetId ??= command.requestId ?? null; }
        if (command.type === 'read_workspace') gate.reads++;
      } catch { /* Forward the original bytes. */ }
      return Reflect.apply(write, child.stdin, args);
    } as typeof write;
    child.stdout.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, child.stdout, [event, ...args]);
      buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
        const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        try { const response = JSON.parse(line.toString('utf8')) as { type?: string; requestId?: string };
          if (!gate.dropped && targetId && response.type === 'response' && response.requestId === targetId) { gate.dropped++; continue; }
        } catch { /* Normal protocol parser owns malformed input. */ }
        forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, child.stdout, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    (globalThis as typeof globalThis & { p7WorkspaceGate?: typeof gate }).p7WorkspaceGate = gate;
  }, userData);
}

async function holdOneWorkspaceRead(app: Awaited<ReturnType<typeof electron.launch>>, userData: string, type: 'list_document_pages' | 'query_job_candidate') {
  await app.evaluate((_electron, { root, type }) => {
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
      && value.spawnargs.includes('apps/host/main.ts') && value.spawnargs.includes(root)) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    if (!child?.stdin || !child.stdout) throw new Error('Isolated Host pipe missing');
    const write = child.stdin.write, emit = child.stdout.emit; let buffer = Buffer.alloc(0), targetId: string | null = null;
    const gate = { held: 0, requests: 0, line: null as Buffer | null, release() {
      child.stdin.write = write; child.stdout.emit = emit;
      if (gate.line) Reflect.apply(emit, child.stdout, ['data', gate.line]);
    } };
    child.stdin.write = function (...args: Parameters<typeof write>) {
      try { const command = JSON.parse(String(args[0])) as { type?: string; requestId?: string };
        if (command.type === type) { gate.requests++; targetId ??= command.requestId ?? null; }
      } catch { /* Forward unchanged. */ }
      return Reflect.apply(write, child.stdin, args);
    } as typeof write;
    child.stdout.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, child.stdout, [event, ...args]);
      buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
        const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        try { const response = JSON.parse(line.toString('utf8')) as { type?: string; requestId?: string };
          if (!gate.held && targetId && response.type === 'response' && response.requestId === targetId) { gate.held++; gate.line = Buffer.from(line); continue; }
        } catch { /* The production parser handles malformed output. */ }
        forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, child.stdout, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    (globalThis as typeof globalThis & { p7ReadGate?: typeof gate }).p7ReadGate = gate;
  }, { root: userData, type });
}

it('P7 real Workspace selects every saved field and line, pages sources, freezes inputs and restores without another model call', async () => {
  it.setTimeout(120_000);
  const { userData, source, env, candidate, version } = await fixture();
  type Body = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; tool_call_id?: string; content: unknown }> };
  const requests: Body[] = [];
  let candidatePrepared = false, holding = false, release!: () => void;
  const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
  const server = await createHttpProvider(async request => {
    const body = await request.json() as Body; requests.push(body);
    if (!candidatePrepared) {
      if (body.messages.some(message => message.tool_call_id === 'p7-save')) { candidatePrepared = true; return stream('P7 candidate saved.'); }
      return stream({ name: 'save_invoice_candidate', id: 'p7-save', args: { documentId: 1, candidate } });
    }
    if (holding) await held;
    return stream('P7 saved response.');
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    let page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await waitFor(() => page.evaluate(async () => { const value = await window.flowmate.getState(); return value.ok && value.data.ready; }));
    const prepared = await page.evaluate(async port => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error('Missing settings');
      const settings = await window.flowmate.saveSettings({ ...state.data.settings, version: 3,
        runtime: { timeoutMs: 90_000, stopGraceMs: 500 }, models: [{ id: 'p7-model', credentialRef: 'p7_fixture_credential',
          name: 'Controlled P7', kind: 'custom', providerId: null, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'p7-fixture', api: 'openai-completions',
          contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'p7-model' }, { modelId: 'p7-model', apiKey: 'synthetic-p7-key' });
      if (!settings.ok) throw new Error('Settings failed');
      const session = await window.flowmate.createSession({ title: 'P7 saved chat' }); if (!session.ok) throw new Error('Session failed');
      let workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace failed');
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'document', documentId: 1 } }); if (!workspace.ok) throw new Error('Document failed');
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } }); if (!workspace.ok) throw new Error('Session failed');
      const task = await window.flowmate.startTask({ clientSequence: workspace.data.nextTaskSequence, expectedRevision: workspace.data.revision,
        documentRef: workspace.data.documentRef!, goal: 'Controlled P7 processing task' }); if (!task.ok) throw new Error('Task failed');
      return window.flowmate.startRun({ sessionId: session.data.sessionId, modelId: 'p7-model', text: 'Prepare controlled candidate', goalMode: 'save-candidate',
        workspace: { revision: task.data.workspace.revision, documentRef: task.data.workspace.documentRef, jobId: task.data.workspace.jobId,
          candidateRef: task.data.workspace.candidateRef, sessionId: session.data.sessionId } });
    }, server.port);
    expect(prepared.ok).toBe(true);
    await waitFor(() => page.evaluate(async () => { const state = await window.flowmate.queryRuntimeState(); return state.ok && state.data.active === null && !state.data.blocked; }), 20_000);
    expect(await page.evaluate(async () => {
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok || !workspace.data.jobId) throw new Error('Missing task');
      const job = await window.flowmate.queryJob(workspace.data.jobId); if (!job.ok) throw new Error('Missing processing task');
      const result = await window.flowmate.selectCandidate({ jobId: workspace.data.jobId, candidateId: 1,
        expectedCandidateId: job.data.currentCandidateId, expectedRevision: workspace.data.revision });
      if (!result.ok) throw new Error(JSON.stringify(result.error)); return result;
    })).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByTestId('workspace-summary')).toContainText('P7 saved chat');
    expect(await page.evaluate(() => window.flowmate.createSession({ title: 'Newer unselected chat' }))).toMatchObject({ ok: true });
    await expect(page.getByTestId('workspace-summary')).toContainText('Controlled P7 processing task');
    await page.getByRole('tab', { name: 'Results', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select Invoice number', exact: true })).toBeEnabled();
    for (const type of ['list_document_pages', 'query_job_candidate'] as const) {
      await holdOneWorkspaceRead(app, userData, type);
      await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
      await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { p7ReadGate: { held: number } }).p7ReadGate.held)).toBe(1);
      await page.getByRole('tab', { name: 'Parsed', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Select parsed page', exact: true })).toBeEnabled();
      await app.evaluate(() => (globalThis as typeof globalThis & { p7ReadGate: { release(): void } }).p7ReadGate.release());
      await page.getByRole('tab', { name: 'Results', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Select Invoice number', exact: true })).toBeEnabled();
      await expect(page.getByText('Loading saved result…', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Loading invoice material…', { exact: true })).toHaveCount(0);
    }
    const selected = async () => {
      const result = await page.evaluate(() => window.flowmate.readWorkspace()); if (!result.ok) throw new Error('Workspace read failed'); return result.data;
    };
    const beforeCandidateFaults = await selected();
    for (const identity of ['document', 'version', 'job', 'candidate', 'sequence'] as const) {
      await corruptOneMaterialIdentity(app, userData, { type: 'query_job_candidate', identity });
      await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
      await expect(page.getByRole('alert'), identity).toContainText('The saved result changed. Refresh the workspace.');
      await expect(page.locator('.workspace-candidate')).toContainText('P7-CONTROLLED');
      await expect(page.getByRole('button', { name: 'Select Invoice number', exact: true })).toBeDisabled();
      expect(await selected()).toEqual(beforeCandidateFaults);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { p7MaterialIdentityFault: { changed: number } }).p7MaterialIdentityFault.changed)).toBe(1);
      await app.evaluate(() => (globalThis as typeof globalThis & { p7MaterialIdentityFault: { restore(): void } }).p7MaterialIdentityFault.restore());
      await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Select Invoice number', exact: true })).toBeEnabled();
    }
    for (const [index, label] of headerLabels.entries()) {
      const control = page.getByRole('button', { name: `Select ${label}`, exact: true });
      await control.focus(); await page.keyboard.press('Space');
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      expect((await selected()).selection).toMatchObject({ kind: 'field', targetId: 1, targetVersion: 1, fieldPath: `fields.${invoiceHeaderFields[index]}` });
    }
    for (const [index, label] of lineLabels.entries()) {
      const control = page.getByRole('button', { name: `Select Line 1 ${label}`, exact: true }); await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      expect((await selected()).selection).toMatchObject({ fieldPath: `lines.0.${invoiceLineFields[index]}` });
    }
    await page.getByRole('button', { name: 'Select line 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select line 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect((await selected()).selection).toMatchObject({ kind: 'line', lineIndex: 0, targetId: 1, targetVersion: 1 });
    const beforeSource = await selected();
    await page.getByRole('button', { name: 'Invoice number source 2', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Parsed', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Select block b53', exact: true })).toBeVisible();
    expect(await selected()).toMatchObject({ revision: beforeSource.revision + 1, activeView: 'candidate', selection: {
      kind: 'source', targetId: 1, targetVersion: version, artifactId: 2, page: 2, block: 'b53' } });
    await page.getByRole('button', { name: 'Select parsed page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select parsed page', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Parsed page', { exact: true }).selectOption('1');
    await expect(page.getByRole('button', { name: 'More blocks', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select block b51', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'More blocks', exact: true }).click();
    await page.getByRole('button', { name: 'Select block b51', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select block b51', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect((await selected()).selection).toMatchObject({ page: 1, block: 'b51', artifactId: 2 });
    await page.getByRole('tab', { name: 'Original', exact: true }).click();
    await page.getByRole('button', { name: 'Select page 1', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select page 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect((await selected()).selection).toMatchObject({ page: 1, artifactId: 2 });
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(page.getByTestId('workspace-summary')).toContainText('No selection');
    expect((await selected()).selection).toBeNull();
    await page.getByRole('tab', { name: 'Results', exact: true }).click();
    await page.getByRole('button', { name: 'Select Tax amount', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select Tax amount', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const countBeforeRestore = requests.length;
    const saved = await selected();
    await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select Tax amount', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect((await selected()).revision).toBe(saved.revision);
    expect(requests.length).toBe(countBeforeRestore);
    const screenshots = process.env.FLOWMATE_SCREENSHOT_ROOT ? join(process.env.FLOWMATE_SCREENSHOT_ROOT, 'p7-workspace') : join(userData, 'workspace-layouts'); mkdirSync(screenshots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      expect(await page.evaluate(async theme => {
        const state = await window.flowmate.getState(); if (!state.ok) return state;
        return window.flowmate.saveSettings({ ...state.data.settings, profile: { ...state.data.settings.profile, theme } });
      }, theme)).toMatchObject({ ok: true });
      for (const [width, height] of [[1440, 900], [1280, 800], [980, 720]] as const) {
        await page.setViewportSize({ width, height });
        await page.getByRole('button', { name: 'Select Tax amount', exact: true }).focus();
        await expect(page.locator('.desktop-shell')).toHaveClass(new RegExp(`theme-${theme}`));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        expect(await page.getByRole('button', { name: 'Select Tax amount', exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
        await page.screenshot({ path: join(screenshots, `${width}x${height}-${theme}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    await composer.fill('Explain this selected tax amount.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    holding = true;
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => requests.length).toBe(countBeforeRestore + 1);
    const currentRun = await page.evaluate(async () => { const state = await window.flowmate.queryRuntimeState(); return state.ok ? state.data.active : null; });
    expect(currentRun).not.toBeNull(); if (!currentRun || currentRun.sessionId === null) throw new Error('Missing active Agent request');
    expect(await page.evaluate(runId => window.flowmate.queryRun(runId), currentRun.runId)).toMatchObject({ ok: true,
      data: { config: { workspaceContext: { selection: { kind: 'field', fieldPath: 'fields.taxAmount' } } } } });
    expect(JSON.stringify(requests.at(-1))).toContain('fields.taxAmount');
    await dropOneWorkspaceReceipt(app, userData);
    await page.getByRole('button', { name: 'Select Line 1 Tax rate', exact: true }).click();
    await expect(page.getByText('Saving workspace selection…', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select Tax amount', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Select Line 1 Tax rate', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Follow up', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Fill form', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await composer.fill('Draft survives the pending selection.');
    await expect(page.getByRole('button', { name: 'Select Line 1 Tax rate', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await expect(composer).toHaveValue('Draft survives the pending selection.');
    const recovery = await app.evaluate(() => {
      const gate = (globalThis as typeof globalThis & { p7WorkspaceGate?: { writes: number; reads: number; dropped: number; restore(): void } }).p7WorkspaceGate;
      if (!gate) throw new Error('Missing receipt gate');
      const facts = { writes: gate.writes, reads: gate.reads, dropped: gate.dropped }; gate.restore(); return facts;
    });
    expect(recovery).toEqual({ writes: 1, reads: 1, dropped: 1 });
    expect(requests.length).toBe(countBeforeRestore + 1);
    await composer.fill('Preserve this later draft.');
    await page.getByRole('button', { name: 'Follow up', exact: true }).click();
    await expect(page.getByTestId('session-input').filter({ hasText: 'Preserve this later draft.' })).toBeVisible();
    await composer.fill('Unsaved newer draft survives Stop.');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue('Unsaved newer draft survives Stop.');
    const ledger = await page.evaluate(sessionId => window.flowmate.listSessionInputs({ sessionId, limit: 50 }), currentRun.sessionId);
    expect(ledger.ok).toBe(true);
    if (ledger.ok) {
      expect(ledger.data.items.find(item => item.content.text === 'Explain this selected tax amount.')?.content.workspaceContext?.selection)
        .toMatchObject({ kind: 'field', fieldPath: 'fields.taxAmount' });
      expect(ledger.data.items.find(item => item.content.text === 'Preserve this later draft.')?.content.workspaceContext?.selection)
        .toMatchObject({ kind: 'field', fieldPath: 'lines.0.taxRate' });
    }
    release(); holding = false;
    const countBeforeReboot = requests.length;
    await closeDesktopFixture(app, userData); app = null;
    const db = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
    try { expect(JSON.parse((db.query('SELECT selection_json FROM workspace WHERE id = 1').get() as { selection_json: string }).selection_json))
      .toMatchObject({ kind: 'field', fieldPath: 'lines.0.taxRate' }); } finally { db.close(); }
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select Line 1 Tax rate', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('workspace-summary')).toContainText('P7 saved chat');
    await expect(page.getByTestId('workspace-summary')).not.toContainText('Newer unselected chat');
    expect(requests.length).toBe(countBeforeReboot);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { release(); try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await server.stop(true); } }
});

for (const fault of ['target-missing', 'root-unavailable', 'cleanup-write-failed'] as const)
it(`P7 public Workspace recovery distinguishes ${fault} without replay`, async () => {
  it.setTimeout(60_000);
  const { userData, env } = await fixture(false, fault === 'cleanup-write-failed');
  let requests = 0;
  const server = await createHttpProvider(() => { requests++; return stream('Unexpected recovery model call'); });
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  let heldPath: string | null = null, originalPath: string | null = null;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    expect(await page.evaluate(async port => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      const settings = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p7-recovery', credentialRef: 'p7_recovery_credential', name: 'Recovery fixture',
        kind: 'custom', providerId: null, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'p7-recovery', api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384, reasoning: false }],
        defaultModelId: 'p7-recovery' }, { modelId: 'p7-recovery', apiKey: 'synthetic-recovery-key' });
      if (!settings.ok) return settings;
      let workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) return workspace;
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'document', documentId: 1 } }); if (!workspace.ok) return workspace;
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'selection', selection: {
        formatVersion: 1, kind: 'source', target: 'document', targetId: 1, targetVersion: workspace.data.documentRef!.version, artifactId: 2, page: 2, block: 'b53' } } });
      if (!selected.ok) throw new Error(JSON.stringify(selected.error)); return selected;
    }, server.port)).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByTestId('workspace-summary')).toContainText('Page 2 · Block b53');
    const composer = page.getByRole('textbox', { name: 'Message to model' }); await composer.fill('Recovery preserves this unsent draft.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    // Production owns an exclusive SQLite connection. Inspect and install faults only
    // while that isolated owner has closed; the actual public recovery runs after reboot.
    await closeDesktopFixture(app, userData); app = null;
    const db = new Database(join(userData, 'data', 'app.sqlite'));
    let before: unknown, documentBefore: unknown;
    try {
      before = db.query('SELECT * FROM workspace WHERE id=1').get();
      documentBefore = db.query('SELECT status,metadata_json,updated_at FROM documents WHERE id=1').get();
      const artifact = db.query('SELECT relative_path FROM artifacts WHERE id=2').get() as { relative_path: string };
      originalPath = fault === 'root-unavailable' ? join(userData, 'artifacts') : join(userData, artifact.relative_path);
      heldPath = `${originalPath}.p7-held`;
    } finally { db.close(); }
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const restoredPage = await app.firstWindow(); await restoredPage.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await restoredPage.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(restoredPage.getByTestId('workspace-summary')).toContainText('Page 2 · Block b53');
    const restoredComposer = restoredPage.getByRole('textbox', { name: 'Message to model' }); await restoredComposer.fill('Recovery preserves this unsent draft.');
    renameSync(originalPath!, heldPath!);
    await restoredPage.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
    if (fault === 'target-missing') {
      await expect(restoredPage.getByTestId('workspace-summary')).toContainText('No invoice selected');
      expect(await restoredPage.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: {
        documentRef: null, jobId: null, candidateRef: null, selection: null, revision: (before as { revision: number }).revision + 1 } });
    } else {
      await expect(restoredPage.getByText(fault === 'root-unavailable' ? 'Workspace recovery is blocked. Check access to the saved invoice material, then refresh.'
        : 'Your changes could not be saved. Please try again.', { exact: true })).toBeVisible();
      await expect(restoredPage.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
      await expect(restoredPage.getByRole('button', { name: 'Select page 1', exact: true })).toBeDisabled();
    }
    await expect(restoredComposer).toHaveValue('Recovery preserves this unsent draft.'); expect(requests).toBe(0);
    await closeDesktopFixture(app, userData); app = null;
    const afterDb = new Database(join(userData, 'data', 'app.sqlite'));
    try {
      if (fault === 'target-missing') expect(afterDb.query('SELECT status,metadata_json,updated_at FROM documents WHERE id=1').get()).toEqual(documentBefore);
      else {
        expect(afterDb.query('SELECT * FROM workspace WHERE id=1').get()).toEqual(before);
        expect(afterDb.query('SELECT status,metadata_json,updated_at FROM documents WHERE id=1').get()).toEqual(documentBefore);
      }
      if (fault === 'cleanup-write-failed') afterDb.query('DROP TRIGGER p7_fail_workspace').run();
    } finally { afterDb.close(); }
    renameSync(heldPath!, originalPath!); heldPath = null;
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const repairedPage = await app.firstWindow(); await repairedPage.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await repairedPage.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    if (fault !== 'target-missing') {
      await expect(repairedPage.getByTestId('workspace-summary')).toContainText('Page 2 · Block b53');
      expect(await repairedPage.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: {
        revision: (before as { revision: number }).revision, selection: { page: 2, block: 'b53' } } });
    } else await expect(repairedPage.getByTestId('workspace-summary')).toContainText('No invoice selected');
    expect(requests).toBe(0);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally {
    if (heldPath && originalPath) renameSync(heldPath, originalPath);
    try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await server.stop(true); }
  }
});
