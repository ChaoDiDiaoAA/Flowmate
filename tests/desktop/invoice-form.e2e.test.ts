import { _electron as electron } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp, waitFor } from '../support/resources.ts';

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
  commandType: 'save_invoice_candidate' | 'submit_invoice_form_input' = 'save_invoice_candidate') {
  await app.evaluate((_electron, { ownedRoot, commandType, tracePath }) => {
    const { writeFileSync } = process.getBuiltinModule('node:fs') as typeof import('node:fs');
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value
      && Array.isArray(value.spawnargs) && value.spawnargs.includes('apps/host/main.ts') && value.spawnargs.includes(ownedRoot)) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    if (!child?.stdin || !child.stdout) throw new Error('The isolated fixture Host pipe was not found.');
    const write = child.stdin.write; const emit = child.stdout.emit;
    let buffered = Buffer.alloc(0); let targetRequestId: string | null = null;
    const gate = { saveRequests: [] as Array<{ requestId: string; operationRef: string }>,
      inputRequests: [] as Array<{ requestId: string; clientSequence: number }>, dropped: 0,
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

for (const outcome of ['accept-export', 'save-on-close', 'discard-on-close', 'reject-reselect', 'unknown-close-save', 'unknown-ui-save-close', 'unknown-fill-input', 'concurrent-fill-input', 'selection-while-fill'] as const)
it(`real Fill and manual form public chain: ${outcome}`, async () => {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-form-desktop-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-form-source-'));
  const source = join(sourceRoot, '000001'); mkdirSync(source);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const content = JSON.stringify([{ type: 'header', text: 'Invoice number: INV-FORM-1', bbox: [0, 0, 10, 10], page_idx: 0 }]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Invoice number: INV-FORM-1', blockCount: 1 }]);
  writeFileSync(join(source, 'original.png'), png); writeFileSync(join(source, 'content.json'), content); writeFileSync(join(source, 'pages.json'), pages);
  writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'desktop-form-invoice', datasetRevision: 'rev-1', qualityStatus: 'complete', allowedUsesClaim: ['local review'],
    licenseVerification: 'not_verified', files: [{ path: 'original.png', bytes: png.length }, { path: 'content.json', bytes: Buffer.byteLength(content) },
      { path: 'pages.json', bytes: Buffer.byteLength(pages) }] }));
  const digest = createHash('sha256');
  for (const name of ['original.png', 'content.json', 'pages.json', 'metadata.json']) {
    const bytes = readFileSync(join(source, name)); const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); digest.update(length).update(bytes);
  }
  const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
  const candidate = { fields: Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId', 'currency', 'netAmount', 'taxAmount', 'totalAmount']
    .map(name => [name, name === 'invoiceNumber' ? { raw: 'INV-FORM-1', normalized: 'INV-FORM-1', state: 'present', alternatives: [],
      sources: [{ documentId: 1, version: `rev-1:parsed-v3:${digest.digest('hex')}`, artifactId: 2, page: 1, blockId: 'b1', quote: 'INV-FORM-1' }] } : missing])), lines: [], notes: [] };
  type Body = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; tool_call_id?: string; content: unknown }> };
  const requests: Body[] = [];
  let releaseHeldFill: (() => void) | undefined;
  const heldFill = new Promise<void>(resolve => { releaseHeldFill = resolve; });
  let fillRequestHeld = false;
  const server = await createHttpProvider(async request => {
    const body = await request.json() as Body; requests.push(body);
    const fill = body.tools?.some(tool => tool.function.name === 'fill_invoice_form');
    if (fill) {
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
    const page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, source);
    expect((await page.evaluate(() => window.flowmate.chooseAndImportInvoice())).ok).toBe(true);
    const prepared = await page.evaluate(async port => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error('Settings unavailable');
      const saved = await window.flowmate.saveSettings({ ...state.data.settings,
        runtime: { budget: { maxModelCalls: 32, maxToolCalls: 40, toolTimeoutMs: 20_000 }, timeoutMs: 90_000, stopGraceMs: 500 },
        models: [{ id: 'form-model', credentialRef: 'form_fixture_credential',
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
      await page.getByText('Next Run limits', { exact: true }).click();
      await page.getByLabel('Next Run model requests', { exact: true }).fill('31');
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
      expect(await page.getByLabel('Next Run model requests', { exact: true }).inputValue()).toBe('31');
      expect(await page.getByLabel('Invoice number', { exact: true }).inputValue()).toBe('');
      expect(await page.getByRole('button', { name: 'Check Fill status', exact: true }).isEnabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Fill form', exact: true }).isDisabled()).toBe(true);
      expect(requests).toHaveLength(beforeCheck);
      await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate: { restore(): void } }).saveTransportGate.restore());
      await page.getByRole('button', { name: 'Check Fill status', exact: true }).click();
      await page.getByText(/Original Fill input is (queued|consumed)\. Its form application has not been confirmed\./).waitFor();
      expect(await page.getByLabel('Next Run model requests', { exact: true }).inputValue()).toBe('');
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
      await page.getByText('Next Run limits', { exact: true }).click();
      await page.getByLabel('Next Run model requests', { exact: true }).fill('64');
      await page.getByLabel('Next Run tool calls', { exact: true }).fill('100');
      await page.getByLabel('Next Run Run timeout (ms)', { exact: true }).fill('150000');
      await page.getByLabel('Next Run stop wait (ms)', { exact: true }).fill('900');
    }
    await page.getByRole('button', { name: 'Fill form', exact: true }).click();
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
        originalBudgetOverrides: { budget: { maxModelCalls: 64, maxToolCalls: 100 }, timeoutMs: 150_000, stopGraceMs: 900 } });
      expect(await page.getByLabel('Next Run model requests', { exact: true }).inputValue()).toBe('');
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
    const originalSave = await page.evaluate(async () => {
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error('Workspace missing');
      const original = window.crypto.randomUUID.bind(window.crypto);
      (window as typeof window & { restoreFormUUID?: () => void }).restoreFormUUID = () => { window.crypto.randomUUID = original; };
      window.crypto.randomUUID = () => '00000000-0000-4000-8000-000000000001';
      return { operationRef: window.crypto.randomUUID(), jobId: 1, basedOnCandidateId: 1, expectedCandidateId: 1, expectedRevision: workspace.data.revision,
        draft: { fields: { invoiceNumber: 'MANUAL-FORM-2', issueDate: '', sellerName: '', sellerTaxId: '', buyerName: '', buyerTaxId: '',
          currency: '', netAmount: '', taxAmount: '', totalAmount: '' }, lines: [], notes: [] } };
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
    await page.getByRole('button', { name: 'Save result', exact: true }).click();
    await page.getByText('Result saved for review.', { exact: true }).waitFor();
    const noDiff = await page.evaluate(() => window.flowmate.listJobCandidates({ jobId: 1, limit: 100 }));
    expect(noDiff).toMatchObject({ ok: true, data: { items: [{ candidateId: 2 }, { candidateId: 1 }] } });
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
    for (const format of ['JSON', 'CSV', 'Markdown']) {
      await page.getByRole('button', { name: `Export ${format}`, exact: true }).click();
      await page.getByText(new RegExp(`Export created:.*\\.${format === 'Markdown' ? 'md' : format.toLowerCase()}`)).waitFor();
    }
    const facts = await page.evaluate(async () => ({ workspace: await window.flowmate.readWorkspace(), candidate: await window.flowmate.queryJobCandidate({ jobId: 1, candidateId: 2 }) }));
    expect(facts).toMatchObject({ candidate: { ok: true, data: { candidate: { origin: 'human_edit', status: 'accepted', basedOnCandidateId: 1,
      fields: { invoiceNumber: { raw: 'MANUAL-FORM-2', valueOrigin: 'user-provided', sources: [] } } } } } });
    expect(requests).toHaveLength(beforeQuery);
  } catch (error) {
    failure = new Error(`Invoice form checkpoint ${checkpoint}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, { cause: error });
    throw failure;
  }
  finally {
    releaseHeldFill?.();
    await server.stop(true);
    if (app) {
      await app.evaluate(() => (globalThis as typeof globalThis & { saveTransportGate?: { restore(): void } }).saveTransportGate?.restore()).catch(() => undefined);
      await app.evaluate(() => (globalThis as typeof globalThis & { concurrentFillGate?: { restore(): void } }).concurrentFillGate?.restore()).catch(() => undefined);
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => undefined);
      await closeDesktopFixture(app, userData, failure);
    }
  }
});
