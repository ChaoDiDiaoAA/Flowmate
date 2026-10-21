import { _electron as electron } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { CandidateDraftSchema } from '@flowmate/contracts';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, installReadGate, mkdtemp, waitFor } from '../support/resources.ts';

it.setTimeout(90_000);
it.afterEach(cleanupResources);

function stream(value: string | { name: string; id: string; args: unknown }) {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'form-fixture', object: 'chat.completion.chunk', created: 1,
    model: 'form-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const delta = typeof value === 'string' ? { role: 'assistant', content: value } : { role: 'assistant', tool_calls: [
    { index: 0, id: value.id, type: 'function', function: { name: value.name, arguments: JSON.stringify(value.args) } },
  ] };
  return new Response(`${chunk(delta, null)}${chunk({}, typeof value === 'string' ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

async function dropOneOwnedHostResponse(app: Awaited<ReturnType<typeof electron.launch>>, userData: string,
  commandType: 'save_invoice_candidate' | 'submit_invoice_form_input' | 'accept_invoice_candidate' | 'reject_invoice_candidate' = 'save_invoice_candidate') {
  await app.evaluate((_electron, { ownedRoot, commandType, tracePath }) => {
    const { writeFileSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs');
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value
      && Array.isArray(value.spawnargs) && value.spawnargs.includes('apps/host/main.ts') && value.spawnargs.includes(ownedRoot)) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    if (!child?.stdin || !child.stdout) throw new Error('The isolated fixture Host pipe was not found.');
    const write = child.stdin.write; const emit = child.stdout.emit;
    let buffered = Buffer.alloc(0); let targetRequestId: string | null = null;
    const gate = { saveRequests: [] as Array<{ requestId: string; operationRef: string }>,
      inputRequests: [] as Array<{ requestId: string; clientSequence: number }>, exportRequests: [] as unknown[], decisionRequests: [] as unknown[], dropped: 0,
      originalInput: undefined as unknown, corruptQueryRunId: null as number | null, queryRequests: new Set<string>(),
      originalResult: undefined as unknown, restore: () => {
        child.stdin.write = write; child.stdout.emit = emit;
        if (buffered.length) { Reflect.apply(emit, child.stdout, ['data', buffered]); buffered = Buffer.alloc(0); }
      } };
    const recordIdentities = () => writeFileSync(tracePath, JSON.stringify({ saves: gate.saveRequests, inputs: gate.inputRequests }));
    recordIdentities();
    child.stdin.write = function (...args: Parameters<typeof write>) {
      try {
        const command = JSON.parse(String(args[0])) as { type?: string; requestId?: string;
          input?: { operationRef?: string; clientSequence?: number } };
        if (command.type === 'export_invoice_candidate') gate.exportRequests.push(command.input);
        if ((command.type === 'accept_invoice_candidate' || command.type === 'reject_invoice_candidate') && command.requestId) {
          gate.decisionRequests.push(command.input);
          if (command.type === commandType) targetRequestId ??= command.requestId;
        }
        if (command.type === 'save_invoice_candidate' && command.requestId && command.input?.operationRef) {
          gate.saveRequests.push({ requestId: command.requestId, operationRef: command.input.operationRef });
          recordIdentities();
          if (command.type === commandType) targetRequestId ??= command.requestId;
        }
        if (command.type === 'submit_invoice_form_input' && command.requestId && command.input?.clientSequence !== undefined) {
          gate.inputRequests.push({ requestId: command.requestId, clientSequence: command.input.clientSequence });
          gate.originalInput ??= command.input;
          recordIdentities();
          if (command.type === commandType) targetRequestId ??= command.requestId;
        }
        if (command.type === 'query_session_input' && command.requestId && command.input?.clientSequence !== undefined) gate.queryRequests.add(command.requestId);
      } catch { /* Observe complete commands only; forward their original bytes unchanged. */ }
      return Reflect.apply(write, child.stdin, args);
    } as typeof write;
    child.stdout.emit = function (event: string | symbol, ...args: unknown[]) {
      if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, child.stdout, [event, ...args]);
      buffered = Buffer.concat([buffered, args[0]]);
      const forward: Buffer[] = [];
      for (let newline = buffered.indexOf(10); newline !== -1; newline = buffered.indexOf(10)) {
        const line = buffered.subarray(0, newline + 1); buffered = buffered.subarray(newline + 1);
        let drop = false;
        try {
          const response = JSON.parse(line.toString('utf8')) as { type?: string; requestId?: string; value?: unknown };
          if (!gate.dropped && targetRequestId !== null && response.type === 'response' && response.requestId === targetRequestId) {
            gate.dropped += 1; gate.originalResult = response.value; drop = true;
          }
          if (gate.corruptQueryRunId !== null && response.requestId && gate.queryRequests.has(response.requestId)) {
            const value = response.value as { ok?: boolean; data?: { input?: { runId: number } } };
            if (value?.ok && value.data?.input) {
              value.data.input.runId = gate.corruptQueryRunId;
              forward.push(Buffer.from(`${JSON.stringify(response)}\n`)); continue;
            }
          }
        } catch { /* Invalid bytes retain the production parser's normal handling. */ }
        if (!drop) forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, child.stdout, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    (globalThis as typeof globalThis & { saveTransportGate?: typeof gate }).saveTransportGate = gate;
  }, { ownedRoot: userData, commandType, tracePath: join(userData, 'form-transport-identities.json') });
}

for (const outcome of ['accept-export', 'save-on-close', 'discard-on-close', 'reject-reselect', 'unknown-close-save', 'unknown-ui-save-close', 'unknown-fill-input', 'concurrent-fill-input', 'selection-while-fill', 'manual-review', 'native-export-faults', 'unknown-accept', 'unknown-reject', 'save-refresh-failure', 'fill-no-tool', 'discard-preview-race', 'workspace-source-race'] as const)
it(`real Fill and manual form public chain: ${outcome}`, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-form-desktop-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-form-source-'));
  const source = join(sourceRoot, '000001'); mkdirSync(source);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const blocks = [{ type: 'header', text: 'Invoice number: INV-FORM-1', bbox: [0, 0, 10, 10], page_idx: 0 }];
  const manual = outcome === 'manual-review' || outcome === 'discard-preview-race' || outcome === 'workspace-source-race';
  if (manual) for (let index = 2; index <= 55; index++) blocks.push({ type: 'text',
    text: index === 54 ? 'A 113.00' : index === 55 ? 'B 113.00' : index === 3 ? 'A / B' : `Extra evidence ${index}`, bbox: [0, 0, 10, 10], page_idx: 0 });
  const content = JSON.stringify(blocks);
  const pages = JSON.stringify([{ pageNumber: 1, text: blocks.map(block => block.text).join('\n'), blockCount: blocks.length }]);
  writeFileSync(join(source, 'original.png'), png); writeFileSync(join(source, 'content.json'), content); writeFileSync(join(source, 'pages.json'), pages);
  writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'desktop-form-invoice', datasetRevision: 'rev-1', qualityStatus: 'complete', allowedUsesClaim: ['local review'],
    licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: png.length }, { path: 'content.json', bytes: Buffer.byteLength(content) },
      { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
  const missing = { raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] };
  const documentVersion = 'pending-import';
  const candidate = CandidateDraftSchema.parse({ fields: Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount']
    .map(name => [name, name === 'invoiceNumber' ? { raw: 'INV-FORM-1', normalized: 'INV-FORM-1', state: 'present', alternatives: [],
      sources: [{ documentId: 1, version: documentVersion, artifactId: 2, page: 1, blockId: 'b1', quote: 'INV-FORM-1' }] } : missing])), lines: [], notes: [] });
  if (manual) {
    candidate.fields.buyerName = { raw: 'A / B', normalized: null, state: 'ambiguous', alternatives: ['A', 'B'],
      sources: [{ documentId: 1, version: documentVersion, artifactId: 2, page: 1, blockId: 'b3', quote: 'A / B' }] };
    candidate.lines = ['A', 'B'].map((name, index) => ({ description: missing, unit: missing, unitPrice: missing,
      netAmount: missing, taxRate: missing, taxAmount: missing, totalAmount: missing,
      quantity: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [],
        sources: [{ documentId: 1, version: documentVersion, artifactId: 2, page: 1, blockId: `b${54 + index}`, quote: `${name} 113.00` }] } }));
  }
  type Body = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; tool_call_id?: string; content: unknown }> };
  const requests: Body[] = [];
  let releaseHeldFill: (() => void) | undefined;
  const heldFill = new Promise<void>(resolve => { releaseHeldFill = resolve; });
  let fillRequestHeld = false;
  const server = await createHttpProvider(async request => {
    const body = await request.json() as Body; requests.push(body);
    const fill = body.tools?.some(tool => tool.function.name === 'fill_invoice_form');
    if (fill) {
      if (outcome === 'fill-no-tool') return stream('The form is completed.');
      if ((outcome === 'unknown-fill-input' || outcome === 'concurrent-fill-input' || outcome === 'selection-while-fill') && !fillRequestHeld && !body.messages.some(message => message.tool_call_id === 'form-apply')) {
        fillRequestHeld = true; await heldFill;
      }
      return body.messages.some(message => message.tool_call_id === 'form-apply') ? stream('Form draft ready for review.')
        : stream({ name: 'fill_invoice_form', id: 'form-apply', args: { candidateId: 1 } });
    }
    return body.messages.some(message => message.tool_call_id === 'form-save') ? stream('Candidate saved.')
      : stream({ name: 'save_invoice_candidate', id: 'form-save', args: { documentId: 1, candidate } });
  });
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData, FLOWMATE_TEST_INVOICE_SOURCE_ROOT: sourceRoot };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) if (process.env[name]) env[name] = process.env[name]!;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  let checkpoint = 'launch';
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, source);
    const imported = await page.evaluate(() => window.flowmate.chooseAndImportInvoice());
    if (!imported.ok || !imported.data) throw new Error('Invoice import failed');
    for (const field of [...Object.values(candidate.fields), ...candidate.lines.flatMap(line => Object.values(line))])
      for (const sourceRef of field.sources) sourceRef.version = imported.data.documentRef.version;
    const prepared = await page.evaluate(async port => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error('Settings unavailable');
      const saved = await window.flowmate.saveSettings({ ...state.data.settings,
        runtime: { budget: { maxModelCalls: 32, maxToolCalls: 40, toolTimeoutMs: 20_000 }, timeoutMs: 90_000, stopGraceMs: 500 },
        models: [{ id: 'form-model', credentialRef: '00000000000000000000000000000027',
        name: 'Form fixture', kind: 'custom', providerId: null, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'form-fixture', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'form-model' }, { modelId: 'form-model', apiKey: 'synthetic-form-key' });
      if (!saved.ok) throw new Error('Settings failed');
      const session = await window.flowmate.createSession(); if (!session.ok) throw new Error('Session failed');
      let workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace failed');
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'document', documentId: 1 } }); if (!workspace.ok) throw new Error('Document failed');
      workspace = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } }); if (!workspace.ok) throw new Error('Session selection failed');
      const task = await window.flowmate.startTask({ clientSequence: workspace.data.nextTaskSequence, expectedRevision: workspace.data.revision, documentRef: workspace.data.documentRef!, goal: 'Form candidate fixture' });
      if (!task.ok) throw new Error('Task failed');
      const selected = task.data.workspace;
      return window.flowmate.startRun({ sessionId: session.data.sessionId, modelId: 'form-model', text: 'Save the invoice candidate.', goalMode: 'save-candidate',
        workspace: { revision: selected.revision, documentRef: selected.documentRef, jobId: selected.jobId, candidateRef: selected.candidateRef, sessionId: selected.sessionId! } });
    }, server.port);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.queryRuntimeState(); return result.ok && result.data.active === null && !result.data.blocked; }), 20_000);
    checkpoint = 'selected candidate and Fill control';
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Processing History', exact: true }).click();
    await page.getByText('Result 1 · generated', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices', exact: true }).click();
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    await page.getByRole('button', { name: /Result 1/ }).click();
    await page.getByRole('button', { name: 'Select result', exact: true }).click();
    if (manual) {
      checkpoint = 'P14 no-model Edit, field metadata, real evidence and Discard';
      const beforeEdit = requests.length;
      const withoutSession = await page.evaluate(async () => {
        const current = await window.flowmate.readWorkspace(); if (!current.ok) throw new Error('Workspace missing');
        return window.flowmate.updateWorkspace({ expectedRevision: current.data.revision, change: { kind: 'session', sessionId: null } });
      });
      expect(withoutSession).toMatchObject({ ok: true, data: { sessionId: null } });
      await page.reload(); await page.getByRole('button', { name: 'Invoices', exact: true }).click();
      await page.getByRole('button', { name: 'Edit result', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit result', exact: true }).click();
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('INV-FORM-1');
      await expect(page.getByRole('button', { name: 'Save result', exact: true })).toBeDisabled();
      await page.getByLabel('Invoice number', { exact: true }).fill('UNSAVED-MANUAL');
      await expect(page.locator('[data-field-path="fields.invoiceNumber"]')).toContainText('Raw: INV-FORM-1');
      await expect(page.locator('[data-field-path="fields.invoiceNumber"]')).toContainText('Normalized: INV-FORM-1');
      await page.getByRole('button', { name: 'Review Invoice number source 1', exact: true }).click();
      const evidence = page.getByRole('region', { name: 'Source evidence', exact: true });
      await expect(evidence).toContainText('Invoice number: INV-FORM-1');
      await expect(evidence).toContainText('Quote: INV-FORM-1');
      await expect(page.locator('[data-field-path="fields.buyerName"]')).toContainText('Alternatives: A · B');
      await page.getByRole('button', { name: 'Review Line 2 Quantity source 1', exact: true }).click();
      await expect(evidence).toContainText('B 113.00'); // b55 requires the actual second page of blocks.
      if (outcome === 'workspace-source-race') {
        checkpoint = 'Workspace source click cannot promote a late parsed-page reply over newer evidence';
        await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
        await page.getByRole('tab', { name: 'Results', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Result source 1', exact: true })).toBeEnabled();
        await installReadGate(app, userData);
        await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { hold(count: number, type: string): void } }).contextReadGate.hold(1, 'read_document_page'));
        await page.getByRole('button', { name: 'Result source 1', exact: true }).click();
        await waitFor(() => app!.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { held: unknown[] } }).contextReadGate.held.length === 1));
        await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices', exact: true }).click();
        await page.getByRole('button', { name: 'Review Line 2 Quantity source 1', exact: true }).click();
        await expect(evidence).toContainText('Quote: B 113.00');
        const beforeRelease = await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { commands: Array<{ type: string }> } }).contextReadGate.commands.filter(command => command.type === 'list_document_pages').length);
        await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { release(index: number): void } }).contextReadGate.release(0));
        // A later real IPC round trip and two paints drain the older reply, without a clock sleep.
        await page.evaluate(async () => { await window.flowmate.getState(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        await expect(evidence).toContainText('Quote: B 113.00');
        expect(await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { commands: Array<{ type: string }> } }).contextReadGate.commands.filter(command => command.type === 'list_document_pages').length)).toBe(beforeRelease);
        await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('UNSAVED-MANUAL');
        expect(requests).toHaveLength(beforeEdit); return;
      }
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get('flowmate:list-document-pages'); if (!original) throw new Error('Missing page index query');
        ipcMain.removeHandler('flowmate:list-document-pages'); ipcMain.handle('flowmate:list-document-pages', async (event, raw) => {
          const result = await original(event, raw);
          ipcMain.removeHandler('flowmate:list-document-pages'); ipcMain.handle('flowmate:list-document-pages', original);
          return new Promise(resolve => { (globalThis as typeof globalThis & { releaseEvidenceRead?: () => void }).releaseEvidenceRead = () => resolve(result); });
        });
      });
      await page.getByRole('button', { name: 'Review Invoice number source 1', exact: true }).click();
      await waitFor(() => app!.evaluate(() => Boolean((globalThis as typeof globalThis & { releaseEvidenceRead?: unknown }).releaseEvidenceRead)));
      await page.getByRole('button', { name: 'Review Line 2 Quantity source 1', exact: true }).click();
      await expect(evidence).toContainText('B 113.00');
      await app.evaluate(() => (globalThis as typeof globalThis & { releaseEvidenceRead(): void }).releaseEvidenceRead());
      await expect(evidence).toContainText('Quote: B 113.00');
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get('flowmate:list-document-pages'); if (!original) throw new Error('Missing page index query');
        ipcMain.removeHandler('flowmate:list-document-pages'); ipcMain.handle('flowmate:list-document-pages', async (event, raw) => {
          const result = await original(event, raw) as { ok: boolean; data: { parsedArtifactId: number } };
          ipcMain.removeHandler('flowmate:list-document-pages'); ipcMain.handle('flowmate:list-document-pages', original);
          return result.ok ? { ...result, data: { ...result.data, parsedArtifactId: result.data.parsedArtifactId + 999 } } : result;
        });
      });
      await page.getByRole('button', { name: 'Review Invoice number source 1', exact: true }).click();
      await expect(evidence).toContainText('The saved evidence reference no longer matches the document.');
      await page.getByRole('button', { name: 'Retry evidence', exact: true }).click();
      await expect(evidence).toContainText('Invoice number: INV-FORM-1');
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('UNSAVED-MANUAL');
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('INV-FORM-1');
      await expect(page.getByRole('region', { name: 'Invoice form', exact: true })).toContainText('Revision 0');
      await page.getByRole('button', { name: 'Remove line 1', exact: true }).click();
      await page.getByRole('button', { name: 'Add line', exact: true }).click();
      await page.getByLabel('Line 2 Quantity', { exact: true }).fill('113.00');
      const forgedMapping = await page.evaluate(async () => {
        const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace missing');
        const detail = await window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 1 }); if (!detail.ok) throw new Error('Candidate missing');
        const emptyLine = { description: '', quantity: '113.00', unit: '', unitPrice: '', netAmount: '', taxRate: '', taxAmount: '', totalAmount: '' };
        return window.flowmate.saveInvoiceCandidate({ operationRef: 'forged-row-origins', jobId: 1, basedOnCandidateId: 1,
          expectedCandidateId: 1, expectedRevision: workspace.data.revision, lineOrigins: [0, 1],
          draft: { fields: { invoiceNumber: 'INV-FORM-1', buyerName: 'A / B', issueDate: '', sellerName: '', sellerTaxId: '', buyerTaxId: '', currency: '', netAmount: '', taxAmount: '', totalAmount: '' }, lines: [emptyLine, emptyLine], notes: [] } });
      });
      expect(forgedMapping).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      await page.getByRole('button', { name: 'Save result', exact: true }).click();
      await page.getByText('Result saved for review.', { exact: true }).waitFor();
      const savedRows = await page.evaluate(() => window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 2 }));
      expect(savedRows).toMatchObject({ ok: true, data: { candidate: { lines: [
        { quantity: { sources: [{ quote: 'B 113.00' }] } }, { quantity: { valueOrigin: 'user-provided', sources: [] } }
      ] } } });
      expect(requests).toHaveLength(beforeEdit);
      expect(await page.evaluate(() => window.flowmate.listJobCandidates({ jobId: 1, limit: 100 })))
        .toMatchObject({ ok: true, data: { items: [{ candidateId: 2 }, { candidateId: 1 }] } });
      if (outcome === 'discard-preview-race') {
        checkpoint = 'Discard detail cannot replace a later candidate preview or recreate its editor';
        await expect(page.getByRole('button', { name: 'Edit result', exact: true })).toBeEnabled();
        await installReadGate(app, userData);
        await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { hold(count: number, type: string): void } }).contextReadGate.hold(1, 'query_job_candidate'));
        await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
        await waitFor(() => app!.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { held: Buffer[] } }).contextReadGate.held.length === 1));
        expect(await app.evaluate(() => JSON.parse((globalThis as typeof globalThis & { contextReadGate: { held: Buffer[] } }).contextReadGate.held[0]!.toString()).value.data.candidate.candidateId)).toBe(2);
        await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Processing History', exact: true }).click();
        await page.locator('.route-row').filter({ hasText: 'Result 1 · generated' }).getByRole('button', { name: 'View', exact: true }).click();
        await expect(page.locator('.candidate-details')).toContainText('A 113.00');
        await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { release(index: number): void } }).contextReadGate.release(0));
        await page.evaluate(async () => { await window.flowmate.getState(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        await expect(page.locator('.candidate-details')).toContainText('A 113.00');
        await expect(page.getByRole('region', { name: 'Invoice form', exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { candidateRef: { id: 2 } } });
        expect(requests).toHaveLength(beforeEdit); return;
      }
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get('flowmate:register-invoice-form-target'); if (!original) throw new Error('Missing form registration');
        ipcMain.removeHandler('flowmate:register-invoice-form-target'); ipcMain.handle('flowmate:register-invoice-form-target', async () => {
          ipcMain.removeHandler('flowmate:register-invoice-form-target'); ipcMain.handle('flowmate:register-invoice-form-target', original);
          return { ok: false, error: { code: 'state_conflict', category: 'input', retryable: false, message: 'Injected form registration refusal' } };
        });
      });
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await page.getByText('Local changes discarded; the saved result is retained, but a new editor could not be registered.', { exact: true }).waitFor();
      await expect(page.getByRole('region', { name: 'Invoice form', exact: true })).toHaveCount(0);
      expect(requests).toHaveLength(beforeEdit);
      return;
    }
    if (outcome === 'selection-while-fill') {
      checkpoint = 'P7 Fill keeps its original revision while selection and view preserve the local form';
      await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
      await page.getByRole('button', { name: 'Select Invoice number', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Select Invoice number', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Fill form', exact: true }).click();
      await expect.poll(() => fillRequestHeld).toBe(true);
      const beforeChangedSelection = requests.length;
      await page.getByRole('button', { name: 'Select Tax amount', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Select Tax amount', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('');
      releaseHeldFill?.();
      await waitFor(() => page.evaluate(async () => { const state = await window.flowmate.queryRuntimeState(); return state.ok && state.data.active === null && !state.data.blocked; }));
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('');
      const fillRequests = requests.filter(body => body.tools?.some(tool => tool.function.name === 'fill_invoice_form'));
      expect(fillRequests).toHaveLength(2);
      expect(JSON.stringify(fillRequests[1]!.messages.find(message => message.tool_call_id === 'form-apply'))).toContain('no longer matches');
      await page.getByLabel('Invoice number', { exact: true }).fill('P7-MANUAL-VERSION');
      await page.getByRole('button', { name: 'Select Seller name', exact: true }).click();
      await page.getByRole('tab', { name: 'Original', exact: true }).click();
      await page.getByRole('tab', { name: 'Results', exact: true }).click();
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('P7-MANUAL-VERSION');
      await expect(page.getByRole('dialog', { name: 'Unsaved invoice changes', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Save result', exact: true }).click();
      await expect(page.getByTestId('workspace-summary')).toContainText('Result 2');
      await expect(page.getByTestId('workspace-summary')).toContainText('No selection');
      const saved = await page.evaluate(async () => {
        const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok || !workspace.data.jobId || !workspace.data.candidateRef) throw new Error('Saved version missing');
        const detail = await window.flowmate.queryJobCandidate({ jobId: workspace.data.jobId, candidateId: workspace.data.candidateRef.id });
        return { workspace: workspace.data, detail };
      });
      expect(saved.workspace.selection).toBeNull(); expect(saved.workspace.candidateRef?.sequence).toBe(2);
      expect(saved.detail).toMatchObject({ ok: true, data: { candidate: { fields: { invoiceNumber: { raw: 'P7-MANUAL-VERSION' } } } } });
      await page.getByLabel('Invoice number', { exact: true }).fill('P7-PRESERVED-DRAFT');
      const rejected = await page.evaluate(async () => {
        const read = async () => { const value = await window.flowmate.readWorkspace(); if (!value.ok) throw new Error('Workspace unavailable'); return value.data; };
        const dirty = { fields: { invoiceNumber: 'P7-PRESERVED-DRAFT', issueDate: '', sellerName: '', sellerTaxId: '', buyerName: '', buyerTaxId: '', currency: '', netAmount: '', taxAmount: '', totalAmount: '' }, lines: [], notes: [] };
        const attempt = async () => {
          const current = await read();
          const base = { operationRef: crypto.randomUUID(), jobId: 1, candidateId: 2, expectedCandidateId: 2, expectedRevision: current.revision };
          return [await window.flowmate.saveInvoiceCandidate({ operationRef: base.operationRef, jobId: base.jobId, expectedRevision: base.expectedRevision, expectedCandidateId: 2, basedOnCandidateId: 2, draft: dirty }),
            await window.flowmate.acceptInvoiceCandidate({ ...base, operationRef: crypto.randomUUID(), dirty: false }),
            await window.flowmate.rejectInvoiceCandidate({ ...base, operationRef: crypto.randomUUID(), reason: 'Untrusted changed scene' })];
        };
        let current = await read();
        const changed = await window.flowmate.selectCandidate({ jobId: 1, candidateId: 1, expectedCandidateId: current.candidateRef?.id ?? null, expectedRevision: current.revision }); if (!changed.ok) throw new Error('Candidate switch failed');
        const candidate = await attempt();
        current = await read(); const restored = await window.flowmate.selectCandidate({ jobId: 1, candidateId: 2, expectedCandidateId: current.candidateRef?.id ?? null, expectedRevision: current.revision }); if (!restored.ok) throw new Error('Candidate restore failed');
        const session = await window.flowmate.createSession(); if (!session.ok) throw new Error('Session create failed');
        current = await read(); const selected = await window.flowmate.updateWorkspace({ expectedRevision: current.revision, change: { kind: 'session', sessionId: session.data.sessionId } }); if (!selected.ok) throw new Error('Session switch failed');
        return { candidate, session: await attempt() };
      });
      for (const results of [rejected.candidate, rejected.session]) for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('P7-PRESERVED-DRAFT');
      expect(requests.length).toBe(beforeChangedSelection + 1);
      return;
    }
    if (outcome === 'concurrent-fill-input') {
      checkpoint = 'three same-target calls all await Desktop state before one fixes its identity';
      await app.evaluate(({ ipcMain }, ownedRoot) => {
        const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
        const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value
          && Array.isArray(value.spawnargs) && value.spawnargs.includes('apps/host/main.ts') && value.spawnargs.includes(ownedRoot)) as import('node:child_process').ChildProcessWithoutNullStreams;
        const write = child.stdin.write; const emit = child.stdout.emit;
        const gate = { states: new Set<string>(), held: [] as Buffer[], buffered: Buffer.alloc(0), armed: false,
          fills: [] as Array<{ requestId: string; input: import('@flowmate/contracts').DesktopInvoiceFormRunRequest }>,
          input: undefined as import('@flowmate/contracts').DesktopInvoiceFormRunRequest | undefined, results: [] as unknown[],
          restore() { child.stdin.write = write; child.stdout.emit = emit; } };
        child.stdin.write = function (...args: Parameters<typeof write>) {
          const command = JSON.parse(String(args[0])) as { type: string; requestId: string; input: import('@flowmate/contracts').DesktopInvoiceFormRunRequest };
          if (gate.armed && command.type === 'get_state') gate.states.add(command.requestId);
          if (command.type === 'submit_invoice_form_input') gate.fills.push({ requestId: command.requestId, input: command.input });
          const written = Reflect.apply(write, child.stdin, args);
          if (command.type === 'submit_invoice_form_input' && gate.held.length === 2) {
            const remaining = gate.held; gate.held = [];
            Reflect.apply(emit, child.stdout, ['data', Buffer.concat(remaining)]);
          }
          return written;
        } as typeof write;
        child.stdout.emit = function (event: string | symbol, ...args: unknown[]) {
          if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, child.stdout, [event, ...args]);
          gate.buffered = Buffer.concat([gate.buffered, args[0]]); const forward: Buffer[] = [];
          for (let newline = gate.buffered.indexOf(10); newline !== -1; newline = gate.buffered.indexOf(10)) {
            const line = gate.buffered.subarray(0, newline + 1); gate.buffered = gate.buffered.subarray(newline + 1);
            const response = JSON.parse(line.toString('utf8')) as { type: string; requestId: string };
            if (gate.armed && response.type === 'response' && gate.states.has(response.requestId)) {
              gate.held.push(line);
              if (gate.held.length === 3) { gate.armed = false; forward.push(gate.held.shift()!); }
            } else forward.push(line);
          }
          return forward.length ? Reflect.apply(emit, child.stdout, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
        };
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
        const original = handlers.get('flowmate:start-invoice-form-run'); if (!original) throw new Error('Missing Fill handler.');
        ipcMain.removeHandler('flowmate:start-invoice-form-run');
        ipcMain.handle('flowmate:start-invoice-form-run', async (event, raw) => {
          const input = raw as import('@flowmate/contracts').DesktopInvoiceFormRunRequest;
          gate.input = input; gate.armed = true;
          gate.results = await Promise.all([original(event, input), original(event, { ...input, clientSequence: input.clientSequence + 1 }), original(event, input)]);
          gate.armed = false; ipcMain.removeHandler('flowmate:start-invoice-form-run'); ipcMain.handle('flowmate:start-invoice-form-run', original);
          return gate.results[0];
        });
        (globalThis as typeof globalThis & { concurrentFillGate?: typeof gate }).concurrentFillGate = gate;
      }, userData);
      await page.getByRole('button', { name: 'Fill form', exact: true }).click();
      await waitFor(() => app!.evaluate(() => (globalThis as typeof globalThis & { concurrentFillGate: { results: unknown[] } }).concurrentFillGate.results.length === 3));
      const concurrent = await app.evaluate(() => {
        const gate = (globalThis as typeof globalThis & { concurrentFillGate: { fills: unknown[]; states: Set<string>;
          input: import('@flowmate/contracts').DesktopInvoiceFormRunRequest; results: Array<import('@flowmate/contracts').Result<import('@flowmate/contracts').SessionInputAccepted & { requestId: string }>> } }).concurrentFillGate;
        return { fills: gate.fills, stateCount: gate.states.size, input: gate.input, results: gate.results };
      });
      expect(concurrent.stateCount).toBe(3);
      expect(concurrent.fills).toHaveLength(1);
      expect(concurrent.results[0]).toMatchObject({ ok: true, data: { inputId: expect.any(Number), runId: expect.any(Number) } });
      expect(concurrent.results[1]).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      if (concurrent.results[2]?.ok) expect(concurrent.results[2]).toEqual(concurrent.results[0]);
      else expect(concurrent.results[2]).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
      // Admission may finish before the original Run reaches HTTP. Establish the
      // Provider barrier before sampling a no-replay baseline; its response stays held.
      await expect.poll(() => fillRequestHeld).toBe(true);
      expect(requests.filter(body => body.tools?.some(tool => tool.function.name === 'fill_invoice_form'))).toHaveLength(1);
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('');
      const accepted = concurrent.results[0]; if (!accepted?.ok) throw new Error('Original Fill was not accepted');
      const jobId = concurrent.input.workspace.jobId;
      if (jobId === null) throw new Error('Original Fill Job missing');
      const readFillIdentities = () => page.evaluate(async ({ sessionId, runId, jobId }) => {
        const [runs, inputs, run, messages, job, candidates, workspace] = await Promise.all([window.flowmate.listSessionRuns({ sessionId }),
          window.flowmate.listSessionInputs({ sessionId }), window.flowmate.queryRun(runId), window.flowmate.listSessionMessages({ sessionId }),
          window.flowmate.queryJob(jobId), window.flowmate.listJobCandidates({ jobId }), window.flowmate.readWorkspace()]);
        if (!runs.ok || !inputs.ok || !run.ok || !messages.ok || !job.ok || !candidates.ok || !workspace.ok) throw new Error('Original Fill authority unavailable');
        return { runIds: runs.data.items.map(item => item.runId), inputs: inputs.data.items.map(item => ({ inputId: item.inputId,
          runId: item.runId, clientSequence: item.clientSequence, goalMode: item.goalMode, nativeEntryId: item.nativeEntryId })),
          run: { runId: run.data.runId, status: run.data.status, config: run.data.config },
          nativeUsers: messages.data.items.filter(item => item.role === 'user').map(item => ({ entryId: item.entryId, runId: item.runId })),
          candidateIds: candidates.data.items.map(item => ({ candidateId: item.candidateId, sequence: item.sequence })),
          currentCandidateId: job.data.currentCandidateId, workspaceCandidate: workspace.data.candidateRef };
      }, { sessionId: concurrent.input.workspace.sessionId, runId: accepted.data.runId, jobId });
      const beforeReplays = await readFillIdentities();
      expect(beforeReplays.runIds).toEqual([accepted.data.runId, prepared.data.runId]);
      expect(beforeReplays.inputs).toHaveLength(2);
      expect(beforeReplays.inputs[0]).toMatchObject({ inputId: accepted.data.inputId, runId: accepted.data.runId,
        clientSequence: concurrent.input.clientSequence, goalMode: 'fill-form', nativeEntryId: expect.any(String) });
      expect(beforeReplays.run).toMatchObject({ runId: accepted.data.runId, status: 'running' });
      expect(beforeReplays.nativeUsers).toHaveLength(2);
      expect(beforeReplays.candidateIds).toEqual([{ candidateId: 1, sequence: 1 }]);
      expect(beforeReplays.currentCandidateId).toBe(1); expect(beforeReplays.workspaceCandidate).toEqual({ id: 1, sequence: 1 });
      const beforeChangedReplay = requests.length;
      expect(await page.evaluate(input => window.flowmate.startInvoiceFormRun(input), concurrent.input)).toEqual(concurrent.results[0]);
      expect(await page.evaluate(input => window.flowmate.startInvoiceFormRun({ ...input, budget: { maxModelCalls: 63 } }), concurrent.input))
        .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(requests).toHaveLength(beforeChangedReplay);
      expect(await readFillIdentities()).toEqual(beforeReplays);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { concurrentFillGate: { fills: unknown[] } }).concurrentFillGate.fills.length)).toBe(1);
      await app.evaluate(() => (globalThis as typeof globalThis & { concurrentFillGate: { restore(): void } }).concurrentFillGate.restore());
      releaseHeldFill?.();
      await page.waitForFunction(() => (document.querySelector('[aria-label="Invoice number"]') as HTMLInputElement)?.value === 'INV-FORM-1');
      await waitFor(() => page.evaluate(async () => { const state = await window.flowmate.queryRuntimeState(); return state.ok && state.data.active === null; }));
      expect(requests.filter(body => body.tools?.some(tool => tool.function.name === 'fill_invoice_form'))).toHaveLength(2);
      expect(await page.evaluate(sessionId => window.flowmate.listSessionRuns({ sessionId }), concurrent.input.workspace.sessionId))
        .toMatchObject({ ok: true, data: { items: [{ runId: (concurrent.results[0] as { ok: true; data: { runId: number } }).data.runId }, { runId: prepared.data.runId }] } });
      expect(await page.evaluate(sessionId => window.flowmate.listSessionInputs({ sessionId }), concurrent.input.workspace.sessionId))
        .toMatchObject({ ok: true, data: { items: [{ clientSequence: concurrent.input.clientSequence }, { clientSequence: 1 }] } });
      const completed = await readFillIdentities();
      expect(completed.runIds).toEqual(beforeReplays.runIds); expect(completed.inputs).toEqual(beforeReplays.inputs);
      expect(completed.nativeUsers).toEqual(beforeReplays.nativeUsers); expect(completed.run.status).toBe('completed');
      expect(completed.candidateIds).toEqual(beforeReplays.candidateIds); expect(completed.currentCandidateId).toBe(beforeReplays.currentCandidateId);
      expect(completed.workspaceCandidate).toEqual(beforeReplays.workspaceCandidate);
      const application = await page.evaluate(async ({ runId, sessionId }) => {
        const tools = await window.flowmate.listRunToolCalls({ runId, sessionId });
        if (!tools.ok || tools.data.items.length !== 1) throw new Error('Expected the single original Fill tool call');
        return { tools: tools.data.items, receipt: await window.flowmate.queryInvoiceFormApplication({ runId, toolCallId: tools.data.items[0]!.toolCallId }) };
      }, { runId: accepted.data.runId, sessionId: concurrent.input.workspace.sessionId });
      expect(application.tools).toMatchObject([{ toolName: 'fill_invoice_form', status: 'succeeded', formApplicationOutcome: 'applied' }]);
      expect(application.receipt).toMatchObject({ ok: true, data: { outcome: 'applied', runId: accepted.data.runId,
        formInstanceId: concurrent.input.target.formInstanceId, appliedRevision: concurrent.input.target.expectedRevision + 1 } });
      console.info('Concurrent Fill barrier facts', { requestsBeforeReplay: beforeChangedReplay, requestsAfterCompletion: requests.length,
        runIds: completed.runIds, inputIds: completed.inputs.map(item => item.inputId), nativeUserCount: completed.nativeUsers.length,
        toolCalls: application.tools.length, outcome: application.receipt.ok ? application.receipt.data.outcome : 'unknown',
        candidateIds: completed.candidateIds, currentCandidateId: completed.currentCandidateId, workspaceCandidate: completed.workspaceCandidate });
      return;
    }
    if (outcome === 'unknown-fill-input') {
      checkpoint = 'Fill input accepted but its actual Host reply is lost before any apply';
      const openAssistant = page.getByRole('button', { name: 'Open Assistant', exact: true });
      if (await openAssistant.isVisible()) await openAssistant.click();
      expect(await page.evaluate(async () => {
        const state = await window.flowmate.getState(); if (!state.ok) return state;
        return window.flowmate.saveSettings({ ...state.data.settings, runtime: { ...state.data.settings.runtime,
          budget: { ...state.data.settings.runtime?.budget, maxModelCalls: 31 } } });
      })).toMatchObject({ ok: true });
      await dropOneOwnedHostResponse(app, userData, 'submit_invoice_form_input');
      await page.getByRole('button', { name: 'Fill form', exact: true }).click();
      await page.getByText('Fill input delivery is unknown. Check the original status; do not repeat Fill.', { exact: true }).waitFor({ timeout: 20_000 });
      const original = await app.evaluate(() => {
        const gate = (globalThis as typeof globalThis & { saveTransportGate: { dropped: number;
          inputRequests: Array<{ requestId: string; clientSequence: number }>; originalResult: unknown } }).saveTransportGate;
        return { dropped: gate.dropped, inputs: gate.inputRequests, result: gate.originalResult };
      });
      expect(original.dropped).toBe(1); expect(original.inputs).toHaveLength(1);
      expect(original.result).toMatchObject({ ok: true, data: { runId: expect.any(Number) } });
      expect(fillRequestHeld).toBe(true);
      expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('');
      const beforeCheck = requests.length;
      expect(await page.getByRole('button', { name: 'Check Fill status', exact: true }).isEnabled()).toBe(true);
      await app.evaluate((_electron, wrongRunId) => {
        (globalThis as typeof globalThis & { saveTransportGate: { corruptQueryRunId: number | null } }).saveTransportGate.corruptQueryRunId = wrongRunId;
      }, prepared.data.runId);
      const originalInput = await app.evaluate(() =>
        (globalThis as typeof globalThis & { saveTransportGate: { originalInput: import('@flowmate/contracts').DesktopInvoiceFormRunRequest } }).saveTransportGate.originalInput);
      expect(await page.evaluate(input => window.flowmate.startInvoiceFormRun(input), originalInput))
        .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      await page.getByRole('button', { name: 'Check Fill status', exact: true }).click();
      await page.getByText('The saved input belongs to another form target. Your draft is preserved; check the original Fill again.', { exact: true }).waitFor();
      expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { runtime: { budget: { maxModelCalls: 31 } } } } });
      expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('');
      expect(await page.getByRole('button', { name: 'Check Fill status', exact: true }).isEnabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Fill form', exact: true }).isDisabled()).toBe(true);
      expect(requests).toHaveLength(beforeCheck);
      await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { restore(): void } }).saveTransportGate.restore());
      await page.getByRole('button', { name: 'Check Fill status', exact: true }).click();
      await page.getByText(/Original Fill input is (queued|consumed)\. Its form application has not been confirmed\./).waitFor();
      expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { runtime: { budget: { maxModelCalls: 31 } } } } });
      expect(requests).toHaveLength(beforeCheck);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { inputRequests: unknown[] } }).saveTransportGate.inputRequests.length)).toBe(1);
      releaseHeldFill?.();
      await page.waitForFunction(() => (document.querySelector('[aria-label="Invoice number"]') as HTMLInputElement)?.value === 'INV-FORM-1');
      await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.queryRuntimeState(); return result.ok && result.data.active === null && !result.data.blocked; }));
      const completedFill = requests.filter(body => body.tools?.some(tool => tool.function.name === 'fill_invoice_form'));
      expect(completedFill).toHaveLength(2);
      expect(JSON.stringify(completedFill[1]!.messages.find(message => message.tool_call_id === 'form-apply'))).toContain('applied');
      return;
    }
    if (outcome === 'accept-export') {
      const openAssistant = page.getByRole('button', { name: 'Open Assistant', exact: true });
      if (await openAssistant.isVisible()) await openAssistant.click();
      expect(await page.evaluate(async () => {
        const state = await window.flowmate.getState(); if (!state.ok) return state;
        return window.flowmate.saveSettings({ ...state.data.settings, runtime: { budget: { maxModelCalls: 64, maxToolCalls: 100, toolTimeoutMs: 20000 },
          timeoutMs: 150000, stopGraceMs: 900 } });
      })).toMatchObject({ ok: true });
    }
    await page.getByRole('button', { name: 'Fill form', exact: true }).click();
    if (outcome === 'fill-no-tool') {
      await waitFor(() => page.evaluate(async () => { const value = await window.flowmate.queryRun(2); return value.ok && value.data.status === 'failed'; }));
      await waitFor(() => page.evaluate(async () => { const value = await window.flowmate.queryRuntimeState(); return value.ok && value.data.active === null && !value.data.blocked; }));
      await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Save result', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => window.flowmate.queryRun(2))).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'agent_goal_not_met' } } });
      expect(await page.evaluate(() => window.flowmate.listRunToolCalls({ runId: 2, sessionId: 1 }))).toMatchObject({ ok: true, data: { items: [] } });
      expect(await page.evaluate(() => window.flowmate.listJobCandidates({ jobId: 1, limit: 100 }))).toMatchObject({ ok: true, data: { items: [{ candidateId: 1 }] } });
      return;
    }
    await page.getByLabel('Invoice number', { exact: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector('[aria-label="Invoice number"]') as HTMLInputElement)?.value === 'INV-FORM-1');
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.queryRuntimeState(); return result.ok && result.data.active === null && !result.data.blocked; }));
    const fillRequests = requests.filter(body => body.tools?.some(tool => tool.function.name === 'fill_invoice_form'));
    expect(fillRequests).toHaveLength(2); expect(fillRequests[0]!.tools!.map(tool => tool.function.name)).toEqual(['fill_invoice_form']);
    expect(JSON.stringify(fillRequests[1]!.messages.find(message => message.tool_call_id === 'form-apply'))).toContain('applied');
    expect(JSON.stringify(fillRequests)).not.toContain('formInstanceId');
    if (outcome === 'accept-export') {
      const frozen = await page.evaluate(async sessionId => {
        const runs = await window.flowmate.listSessionRuns({ sessionId });
        const inputs = await window.flowmate.listSessionInputs({ sessionId });
        if (!runs.ok || !inputs.ok) throw new Error('Fill records unavailable');
        const run = await window.flowmate.queryRun(runs.data.items[0]!.runId);
        if (!run.ok) throw new Error('Fill Run unavailable');
        return { run: run.data, input: inputs.data.items[0]! };
      }, prepared.data.sessionId);
      expect(frozen.run.config).toMatchObject({ version: 2, limits: { timeoutMs: 150_000, stopGraceMs: 900 },
        runtimeBudget: { maxModelCalls: 64, maxToolCalls: 100, toolTimeoutMs: 20_000 } });
      expect(frozen.input.content).toMatchObject({ version: 2, requestIdentityVersion: 1,
        originalBudgetOverrides: {} });
      if (!('originalBudgetOverrides' in frozen.input.content)) throw new Error('Missing original budget identity');
      expect(frozen.input.content.originalBudgetOverrides).toEqual({});
      expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { runtime: { budget: { maxModelCalls: 64 } } } } });
    }
    const beforeQuery = requests.length;
    await page.getByRole('button', { name: 'Check Fill status', exact: true }).click();
    await page.getByText('Form draft applied; review before saving.', { exact: true }).waitFor(); expect(requests).toHaveLength(beforeQuery);
    checkpoint = 'manual edit and dirty leave';
    await page.getByLabel('Invoice number', { exact: true }).fill('MANUAL-FORM-2');
    const forgedDecision = await page.evaluate(async () => {
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace missing');
      return window.flowmate.acceptInvoiceCandidate({ operationRef: 'forged-clean-claim', jobId: 1, candidateId: 1,
        expectedCandidateId: 1, expectedRevision: workspace.data.revision, dirty: false });
    });
    expect(forgedDecision).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2');
    if (outcome === 'unknown-close-save' || outcome === 'unknown-ui-save-close') {
      checkpoint = outcome;
      await dropOneOwnedHostResponse(app, userData);
      await page.evaluate(() => window.flowmate.onInvoiceFormInspectFinished(operation => {
        if (operation) (window as typeof window & { unknownCloseOperation?: import('@flowmate/contracts').InvoiceCandidateOperationQuery }).unknownCloseOperation = operation;
      }));
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async (_window: Electron.BaseWindow | Electron.MessageBoxOptions, options?: Electron.MessageBoxOptions) => {
          const selected = options ?? ('buttons' in _window ? _window : undefined);
          return { response: selected?.title === 'Unsaved invoice changes' ? 2 : 0, checkboxChecked: false };
        };
      });
      checkpoint = `${outcome}: schedule original operation`;
      if (outcome === 'unknown-close-save') await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
      else await page.getByRole('button', { name: 'Save result', exact: true }).click();
      checkpoint = `${outcome}: wait for original transport unknown`;
      await page.getByText(outcome === 'unknown-close-save'
        ? 'Close Save result is unknown. Check the original operation; your draft is retained.'
        : 'Save result is unknown. Query the original operation.', { exact: true }).waitFor({ timeout: 15_000 });
      checkpoint = `${outcome}: inspect real lost response and original operation`;
      const first = await app.evaluate(() => {
        const gate = (globalThis as typeof globalThis & { saveTransportGate: { dropped: number; saveRequests: Array<{ requestId: string; operationRef: string }>; originalResult: unknown } }).saveTransportGate;
        return { dropped: gate.dropped, saves: gate.saveRequests, result: gate.originalResult };
      });
      expect(first.dropped).toBe(1); expect(first.saves).toHaveLength(1);
      expect(first.result).toMatchObject({ ok: true, data: { changed: true, candidate: { candidateId: 2, origin: 'human_edit' } } });
      if (outcome === 'unknown-close-save') {
        const forwarded = await page.evaluate(() => (window as typeof window & { unknownCloseOperation?: import('@flowmate/contracts').InvoiceCandidateOperationQuery }).unknownCloseOperation);
        expect(forwarded).toMatchObject({ kind: 'save', request: { operationRef: first.saves[0]!.operationRef, basedOnCandidateId: 1,
          draft: { fields: { invoiceNumber: 'MANUAL-FORM-2' } } } });
      }
      expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2');
      expect(await page.getByRole('button', { name: 'Save result', exact: true }).isDisabled()).toBe(true);
      checkpoint = `${outcome}: schedule second close while original Save is unknown`;
      await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
      await new Promise(resolve => setTimeout(resolve, 150));
      // The faulty new Save can let Main actually close. Keep only real wire identities
      // in the owned fixture so a closed target cannot conceal that second command.
      checkpoint = `${outcome}: verify second close does not issue a new Save`;
      const afterClose = JSON.parse(readFileSync(join(userData, 'form-transport-identities.json'), 'utf8')) as {
        saves: Array<{ requestId: string; operationRef: string }>;
      };
      expect(afterClose.saves).toEqual(first.saves);
      checkpoint = `${outcome}: restore owned Host pipe`;
      await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { restore(): void } }).saveTransportGate.restore());
      checkpoint = `${outcome}: query original Save and retain the old draft`;
      await page.getByRole('button', { name: 'Check original operation', exact: true }).click();
      await page.getByText('Original save operation confirmed.', { exact: true }).waitFor();
      expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2');
      expect(await page.getByRole('button', { name: 'Discard changes', exact: true }).isEnabled()).toBe(true);
      expect(requests).toHaveLength(beforeQuery);
      // The current candidate advanced on the real commit. Discard the retained old copy,
      // then explicitly open the saved candidate instead of retargeting it automatically.
      checkpoint = `${outcome}: explicitly discard retained old copy and edit saved candidate`;
      const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      await nav.getByRole('button', { name: 'Chats', exact: true }).click();
      await page.getByRole('dialog', { name: 'Unsaved invoice changes' }).getByRole('button', { name: 'Discard changes', exact: true }).click();
      await nav.getByRole('button', { name: 'Invoices', exact: true }).click();
      await page.getByRole('button', { name: /Result 2/ }).click();
      await page.getByRole('button', { name: 'Edit result', exact: true }).click();
      await page.getByLabel('Invoice number', { exact: true }).waitFor();
      await page.getByLabel('Invoice number', { exact: true }).fill('AFTER-QUERY-3');
      await page.getByRole('button', { name: 'Save result', exact: true }).click();
      await page.getByText('Result saved for review.', { exact: true }).waitFor();
      expect(await page.evaluate(() => window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 3 }))).toMatchObject({ ok: true,
        data: { candidate: { origin: 'human_edit', basedOnCandidateId: 2, fields: { invoiceNumber: { raw: 'AFTER-QUERY-3' } } } } });
      expect(requests).toHaveLength(beforeQuery); return;
    }
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('dialog', { name: 'Unsaved invoice changes' }).waitFor();
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click();
    expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2');
    await page.getByRole('button', { name: 'Check Fill status', exact: true }).click();
    expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2'); expect(requests).toHaveLength(beforeQuery);
    checkpoint = 'actual native close protects dirty changes';
    await app.evaluate(({ app, dialog }) => {
      const current = globalThis as typeof globalThis & { closeChoices?: string[] };
      dialog.showMessageBox = async (_window: Electron.BaseWindow | Electron.MessageBoxOptions, options?: Electron.MessageBoxOptions) => {
        current.closeChoices = options?.buttons ?? ('buttons' in _window ? _window.buttons : undefined);
        return { response: 0, checkboxChecked: false };
      };
      app.quit();
    });
    await waitFor(() => app!.evaluate(() => Boolean((globalThis as typeof globalThis & { closeChoices?: string[] }).closeChoices)));
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { closeChoices?: string[] }).closeChoices))
      .toEqual(['Continue editing', 'Discard changes', 'Save result']);
    expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2');
    if (outcome === 'save-on-close' || outcome === 'discard-on-close') {
      checkpoint = outcome;
      if (outcome === 'save-on-close') {
        await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
        await page.getByRole('button', { name: 'Select Tax amount', exact: true }).click();
        await page.getByRole('tab', { name: 'Original', exact: true }).click();
        await page.getByRole('tab', { name: 'Results', exact: true }).click();
        await expect(page.getByLabel('Invoice number', { exact: true })).toHaveValue('MANUAL-FORM-2');
      }
      await app.evaluate(({ dialog }, selected) => { dialog.showMessageBox = async () => ({ response: selected, checkboxChecked: false }); }, outcome === 'save-on-close' ? 2 : 1);
      await closeDesktopFixture(app, userData); app = null;
      const db = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
      try {
        expect(db.query('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 2 });
        expect(db.query('SELECT tool_name AS name FROM tool_calls ORDER BY id').all()).toEqual([{ name: 'save_invoice_candidate' }, { name: 'fill_invoice_form' }]);
        const rows = db.query('SELECT origin,based_on_candidate_id,json_extract(fields_json,\'$.values.invoiceNumber.raw\') AS invoiceNumber FROM invoice_candidates ORDER BY id').all();
        expect(rows).toEqual(outcome === 'save-on-close'
          ? [{ origin: 'model', based_on_candidate_id: null, invoiceNumber: 'INV-FORM-1' }, { origin: 'human_edit', based_on_candidate_id: 1, invoiceNumber: 'MANUAL-FORM-2' }]
          : [{ origin: 'model', based_on_candidate_id: null, invoiceNumber: 'INV-FORM-1' }]);
      } finally { db.close(); }
      expect(requests).toHaveLength(beforeQuery); return;
    }
    checkpoint = 'real manual Save and Accept';
    if (outcome === 'save-refresh-failure') {
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get('flowmate:query-job-candidate'); if (!original) throw new Error('Missing candidate query');
        ipcMain.removeHandler('flowmate:query-job-candidate'); ipcMain.handle('flowmate:query-job-candidate', async (event, raw) => {
          if ((raw as { candidateId: number }).candidateId !== 2) return original(event, raw);
          ipcMain.removeHandler('flowmate:query-job-candidate'); ipcMain.handle('flowmate:query-job-candidate', original);
          return { ok: false, error: { code: 'storage_read_failed', category: 'storage', retryable: true, message: 'Injected post-Save detail read failure' } };
        });
      });
      await page.getByRole('button', { name: 'Save result', exact: true }).click();
      await page.getByText('Result saved: candidate 2. Editor could not be reloaded. Injected post-Save detail read failure', { exact: true }).waitFor();
      expect(await page.evaluate(() => window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 2 })))
        .toMatchObject({ ok: true, data: { candidate: { origin: 'human_edit', status: 'generated' } } });
      expect(requests).toHaveLength(beforeQuery); return;
    }
    const originalSave = await page.evaluate(async () => {
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace missing');
      const original = window.crypto.randomUUID.bind(window.crypto);
      (window as typeof window & { restoreFormUUID?: () => void }).restoreFormUUID = () => { window.crypto.randomUUID = original; };
      window.crypto.randomUUID = () => '00000000-0000-4000-8000-000000000001';
      return { operationRef: window.crypto.randomUUID(), jobId: 1, basedOnCandidateId: 1, expectedCandidateId: 1, expectedRevision: workspace.data.revision,
        draft: { fields: { invoiceNumber: 'MANUAL-FORM-2', issueDate: '', sellerName: '', sellerTaxId: '', buyerName: '', buyerTaxId: '',
          currency: '', netAmount: '', taxAmount: '', totalAmount: '' }, lines: [], notes: [] }, lineOrigins: [] };
    });
    await page.getByRole('button', { name: 'Save result', exact: true }).click();
    await page.evaluate(() => {
      const fixture = window as typeof window & { restoreFormUUID?: () => void };
      fixture.restoreFormUUID?.(); delete fixture.restoreFormUUID;
    });
    await page.getByText('Result saved for review.', { exact: true }).waitFor();
    expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2');
    // The exact committed operation is returned before the old target/Workspace gate.
    expect(await page.evaluate(input => window.flowmate.saveInvoiceCandidate(input), originalSave)).toMatchObject({ ok: true, data: { changed: true, candidate: { candidateId: 2 } } });
    expect(await page.evaluate(input => window.flowmate.queryInvoiceCandidateOperation({ kind: 'save', request: input }), originalSave)).toMatchObject({ ok: true, data: { changed: true, candidate: { candidateId: 2 } } });
    await expect(page.getByRole('button', { name: 'Save result', exact: true })).toBeDisabled();
    const noDiff = await page.evaluate(() => window.flowmate.listJobCandidates({ jobId: 1, limit: 100 }));
    expect(noDiff).toMatchObject({ ok: true, data: { items: [{ candidateId: 2 }, { candidateId: 1 }] } });
    if (outcome === 'unknown-accept' || outcome === 'unknown-reject') {
      const kind = outcome === 'unknown-accept' ? 'accept' : 'reject';
      checkpoint = `P14 real ${kind} commit with lost Host response`;
      await dropOneOwnedHostResponse(app, userData, kind === 'accept' ? 'accept_invoice_candidate' : 'reject_invoice_candidate');
      await page.getByRole('button', { name: kind === 'accept' ? 'Accept result' : 'Reject result', exact: true }).click();
      if (kind === 'reject') {
        const prompt = page.getByRole('dialog', { name: 'Reject invoice result', exact: true });
        await prompt.getByLabel('Reason for rejection', { exact: true }).fill('Actual review refusal');
        await prompt.getByRole('button', { name: 'Reject result', exact: true }).click();
      }
      await page.getByText(`${kind === 'accept' ? 'Accept' : 'Reject'} result is unknown. Query the original operation.`, { exact: true }).waitFor({ timeout: 15_000 });
      const wire = await app.evaluate(() => {
        const gate = (globalThis as typeof globalThis & { saveTransportGate: { dropped: number; decisionRequests: unknown[]; originalResult: unknown } }).saveTransportGate;
        return { dropped: gate.dropped, decisions: gate.decisionRequests, result: gate.originalResult };
      });
      expect(wire.dropped).toBe(1); expect(wire.decisions).toHaveLength(1);
      expect(wire.result).toMatchObject({ ok: true, data: { candidate: { candidateId: 2, status: kind === 'accept' ? 'accepted' : 'rejected' } } });
      const laterWorkspace = await page.evaluate(async () => {
        const value = await window.flowmate.readWorkspace(); if (!value.ok) throw new Error('Workspace missing');
        return window.flowmate.updateWorkspace({ expectedRevision: value.data.revision, change: { kind: 'session', sessionId: null } });
      });
      expect(laterWorkspace.ok).toBe(true);
      await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { restore(): void } }).saveTransportGate.restore());
      await page.getByRole('button', { name: 'Check original operation', exact: true }).click();
      await page.getByText(`Original ${kind} operation confirmed.`, { exact: true }).waitFor();
      expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(laterWorkspace);
      expect(requests).toHaveLength(beforeQuery); return;
    }
    if (outcome === 'reject-reselect') {
      await page.getByRole('button', { name: 'Reject result', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Reject invoice result', exact: true });
      expect(await dialog.getByLabel('Reason for rejection', { exact: true }).getAttribute('maxlength')).toBe('256');
      await dialog.getByLabel('Reason for rejection', { exact: true }).fill('Reviewed: source must be checked.');
      await dialog.getByRole('button', { name: 'Reject result', exact: true }).click();
      await page.getByText('Result rejected.', { exact: true }).waitFor();
      expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { candidateRef: null } });
      expect(await page.evaluate(() => window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 2 }))).toMatchObject({ ok: true, data: { candidate: { status: 'rejected' } } });
      await page.getByRole('button', { name: 'Select result', exact: true }).click();
      await page.getByRole('button', { name: 'Edit result', exact: true }).click();
      await page.getByLabel('Invoice number', { exact: true }).waitFor();
      expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('MANUAL-FORM-2');
      expect(await page.getByRole('button', { name: 'Fill form', exact: true }).isDisabled()).toBe(true);
    }
    await page.getByRole('button', { name: 'Accept result', exact: true }).click();
    await page.getByText('Result accepted.', { exact: true }).waitFor();
    expect(requests).toHaveLength(beforeQuery);
    if (outcome === 'accept-export') await dropOneOwnedHostResponse(app, userData);
    if (outcome === 'native-export-faults') {
      checkpoint = 'P14 Native cancellation, concurrency, partial publication and stale owner';
      await dropOneOwnedHostResponse(app, userData);
      const beforeCancel = await page.evaluate(() => window.flowmate.listActivity({ jobId: 1, limit: 100 }));
      await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
      await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
      await page.getByText('Export Save cancelled. No new managed export was created.', { exact: true }).waitFor();
      expect(await page.evaluate(() => window.flowmate.listActivity({ jobId: 1, limit: 100 }))).toEqual(beforeCancel);
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { exportRequests: unknown[] } }).saveTransportGate.exportRequests)).toHaveLength(0);
      expect(existsSync(join(userData, 'outputs', 'invoice-1-result-2.json'))).toBe(false);
      await app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = () => new Promise(resolve => { (globalThis as typeof globalThis & { releaseInvoiceDialog?: (filePath: string) => void }).releaseInvoiceDialog = filePath => resolve({ canceled: false, filePath }); });
      });
      await page.evaluate(() => { (window as typeof window & { nativeExportPromise?: Promise<unknown> }).nativeExportPromise = window.flowmate.saveInvoiceExport({ operationRef: 'native-held', candidateId: 2, format: 'json' }); });
      await waitFor(() => app!.evaluate(() => Boolean((globalThis as typeof globalThis & { releaseInvoiceDialog?: unknown }).releaseInvoiceDialog)));
      expect(await page.evaluate(() => window.flowmate.saveInvoiceExport({ operationRef: 'native-second', candidateId: 2, format: 'json' })))
        .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      const heldDestination = join(userData, 'held.json');
      await app.evaluate((_electron, path) => (globalThis as typeof globalThis & { releaseInvoiceDialog(filePath: string): void }).releaseInvoiceDialog(path), heldDestination);
      expect(await page.evaluate(() => (window as typeof window & { nativeExportPromise?: Promise<unknown> }).nativeExportPromise))
        .toMatchObject({ ok: true, data: { outcome: 'saved', destinationPath: heldDestination } });
      const conflictPath = join(userData, 'conflict.json'); writeFileSync(conflictPath, 'keep');
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, conflictPath);
      expect(await page.evaluate(() => window.flowmate.saveInvoiceExport({ operationRef: 'native-conflict', candidateId: 2, format: 'json' })))
        .toMatchObject({ ok: false, error: { code: 'state_conflict', message: expect.stringContaining('Managed export registered') } });
      expect(readFileSync(conflictPath, 'utf8')).toBe('keep');
      expect(await page.evaluate(() => window.flowmate.queryInvoiceCandidateOperation({ kind: 'export', request: { operationRef: 'native-conflict', candidateId: 2, format: 'json' } })))
        .toMatchObject({ ok: true, data: { candidateId: 2 } });
      const stalePath = join(userData, 'stale.csv');
      await app.evaluate(({ dialog }) => {
        delete (globalThis as typeof globalThis & { releaseInvoiceDialog?: unknown }).releaseInvoiceDialog;
        dialog.showSaveDialog = () => new Promise(resolve => { (globalThis as typeof globalThis & { releaseInvoiceDialog?: (filePath: string) => void }).releaseInvoiceDialog = filePath => resolve({ canceled: false, filePath }); });
      });
      await page.evaluate(() => { void window.flowmate.saveInvoiceExport({ operationRef: 'native-stale', candidateId: 2, format: 'csv' }); });
      await waitFor(() => app!.evaluate(() => Boolean((globalThis as typeof globalThis & { releaseInvoiceDialog?: unknown }).releaseInvoiceDialog)));
      await page.reload();
      await app.evaluate((_electron, path) => (globalThis as typeof globalThis & { releaseInvoiceDialog(filePath: string): void }).releaseInvoiceDialog(path), stalePath);
      await waitFor(() => page.evaluate(async () => { const value = await window.flowmate.queryInvoiceCandidateOperation({ kind: 'export', request: { operationRef: 'native-stale', candidateId: 2, format: 'csv' } }); return value.ok; }));
      expect(existsSync(stalePath)).toBe(false);
      expect(await page.evaluate(() => window.flowmate.queryInvoiceCandidateOperation({ kind: 'export', request: { operationRef: 'native-stale', candidateId: 2, format: 'csv' } })))
        .toEqual({ ok: true, data: null });
      checkpoint = 'Native original-operation query cannot admit an export after its owner reloads';
      await installReadGate(app, userData);
      await app.evaluate(({ dialog, ipcMain }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get('flowmate:save-invoice-export'); if (!original) throw new Error('Missing Native Save handler');
        ipcMain.removeHandler('flowmate:save-invoice-export'); ipcMain.handle('flowmate:save-invoice-export', async (event, raw) => {
          const real = await original(event, raw);
          (globalThis as typeof globalThis & { staleQueryNativeResult?: unknown }).staleQueryNativeResult = real;
          ipcMain.removeHandler('flowmate:save-invoice-export'); ipcMain.handle('flowmate:save-invoice-export', original); return real;
        });
        (globalThis as typeof globalThis & { contextReadGate: { hold(count: number, type: string): void } }).contextReadGate.hold(1, 'query_invoice_candidate_operation');
      }, stalePath);
      const beforeStaleQuery = await page.evaluate(() => window.flowmate.listActivity({ jobId: 1, limit: 100 }));
      await page.evaluate(() => { void window.flowmate.saveInvoiceExport({ operationRef: 'native-query-stale', candidateId: 2, format: 'csv' }); });
      await waitFor(() => app!.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { held: unknown[] } }).contextReadGate.held.length === 1));
      expect(await app.evaluate(() => JSON.parse((globalThis as typeof globalThis & { contextReadGate: { held: Buffer[] } }).contextReadGate.held[0]!.toString()).value)).toEqual({ ok: true, data: null });
      await page.reload();
      await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { release(index: number): void } }).contextReadGate.release(0));
      await waitFor(() => app!.evaluate(() => Boolean((globalThis as typeof globalThis & { staleQueryNativeResult?: unknown }).staleQueryNativeResult)));
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { staleQueryNativeResult?: unknown }).staleQueryNativeResult)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { commands: Array<{ type: string }> } }).contextReadGate.commands.filter(command => command.type === 'export_invoice_candidate'))).toHaveLength(0);
      expect(await page.evaluate(() => window.flowmate.listActivity({ jobId: 1, limit: 100 }))).toEqual(beforeStaleQuery);
      expect(existsSync(join(userData, 'outputs', 'invoice-1-result-2.csv'))).toBe(false); expect(existsSync(stalePath)).toBe(false);
      expect(await page.evaluate(() => window.flowmate.queryInvoiceCandidateOperation({ kind: 'export', request: { operationRef: 'native-query-stale', candidateId: 2, format: 'csv' } }))).toEqual({ ok: true, data: null });
      await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate: { restore(): void } }).contextReadGate.restore());
      await page.getByRole('button', { name: 'Invoices', exact: true }).click();
      const lostPath = join(userData, 'lost-response.json');
      await app.evaluate(({ dialog, ipcMain }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get('flowmate:save-invoice-export'); if (!original) throw new Error('Missing Native Save handler');
        ipcMain.removeHandler('flowmate:save-invoice-export'); ipcMain.handle('flowmate:save-invoice-export', async (event, raw) => {
          const real = await original(event, raw);
          (globalThis as typeof globalThis & { originalNativeResult?: unknown }).originalNativeResult = real;
          ipcMain.removeHandler('flowmate:save-invoice-export'); ipcMain.handle('flowmate:save-invoice-export', original);
          return { ok: false, error: { code: 'operation_result_unknown', category: 'runtime', retryable: false, message: 'Native Save response unknown. Check the original managed operation.' } };
        });
      }, lostPath);
      await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
      await page.getByText('Native Save response unknown. Check the original managed operation.', { exact: true }).waitFor();
      expect(await app.evaluate(() => (globalThis as typeof globalThis & { originalNativeResult?: unknown }).originalNativeResult))
        .toMatchObject({ ok: true, data: { outcome: 'saved', destinationPath: lostPath } });
      expect(readFileSync(lostPath)).toEqual(readFileSync(heldDestination));
      await expect(page.getByRole('button', { name: 'Export JSON', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Check original operation', exact: true }).click();
      await page.getByText('Original managed export confirmed. The external destination is not recorded; inspect the chosen file or explicitly Save again.', { exact: true }).waitFor();
      const managedPath = join(userData, 'outputs', 'invoice-1-result-2.json');
      writeFileSync(managedPath, Buffer.alloc(readFileSync(managedPath).length, 32));
      for (const query of ['query', 'direct'] as const) expect(await page.evaluate(kind => {
        const request = { operationRef: 'native-held', candidateId: 2, format: 'json' as const };
        return kind === 'query' ? window.flowmate.queryInvoiceCandidateOperation({ kind: 'export', request }) : window.flowmate.exportInvoiceCandidate(request);
      }, query)).toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
      unlinkSync(managedPath);
      expect(await page.evaluate(() => window.flowmate.queryInvoiceCandidateOperation({ kind: 'export', request: { operationRef: 'native-held', candidateId: 2, format: 'json' } })))
        .toMatchObject({ ok: false, error: { code: 'artifact_unavailable' } });
      expect(requests).toHaveLength(beforeQuery); return;
    }
    for (const format of ['JSON', 'CSV', 'Markdown']) {
      const destination = join(userData, `chosen-result.${format === 'Markdown' ? 'md' : format.toLowerCase()}`);
      await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
      await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
      await page.getByText(`Export saved: ${destination}`, { exact: true }).waitFor();
      expect(readFileSync(destination)).toEqual(readFileSync(join(userData, 'outputs', `invoice-1-result-2.${format === 'Markdown' ? 'md' : format.toLowerCase()}`)));
    }
    const facts = await page.evaluate(async () => ({ workspace: await window.flowmate.readWorkspace(), candidate: await window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 2 }) }));
    expect(facts).toMatchObject({ candidate: { ok: true, data: { candidate: { origin: 'human_edit', status: 'accepted', basedOnCandidateId: 1,
      fields: { invoiceNumber: { raw: 'MANUAL-FORM-2', valueOrigin: 'user-provided', sources: [] } } } } } });
    expect(requests).toHaveLength(beforeQuery);
    if (outcome === 'accept-export') {
      checkpoint = 'P14 restart retains accepted/export facts without replaying model or tools';
      const originals = await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { exportRequests: import('@flowmate/contracts').ExportInvoiceCandidateRequest[] } }).saveTransportGate.exportRequests);
      expect(originals).toHaveLength(3);
      await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { restore(): void } }).saveTransportGate.restore());
      await closeDesktopFixture(app, userData); app = null;
      app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
      const restarted = await app.firstWindow();
      await waitFor(() => restarted.evaluate(async () => { const value = await window.flowmate.getState(); return value.ok && value.data.ready; }));
      for (const original of originals) expect(await restarted.evaluate(request => window.flowmate.queryInvoiceCandidateOperation({ kind: 'export', request }), original))
        .toMatchObject({ ok: true, data: { candidateId: 2, format: original.format } });
      expect(await restarted.evaluate(() => window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 2 })))
        .toMatchObject({ ok: true, data: { candidate: { status: 'accepted', origin: 'human_edit' } } });
      await expect(restarted.getByRole('region', { name: 'Invoice form', exact: true })).toHaveCount(0);
      expect(requests).toHaveLength(beforeQuery);
    }
  } catch (error) {
    failure = new Error(`Invoice form checkpoint ${checkpoint}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, { cause: error });
    throw failure;
  }
  finally {
    releaseHeldFill?.();
    await server.stop(true);
    if (app) {
      await app.evaluate(() => (globalThis as typeof globalThis & { contextReadGate?: { restore(): void } }).contextReadGate?.restore()).catch(() => undefined);
      await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate?: { restore(): void } }).saveTransportGate?.restore()).catch(() => undefined);
      await app.evaluate(() => (globalThis as typeof globalThis & { concurrentFillGate?: { restore(): void } }).concurrentFillGate?.restore()).catch(() => undefined);
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => undefined);
      await closeDesktopFixture(app, userData, failure);
    }
  }
});
