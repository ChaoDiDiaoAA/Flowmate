import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cleanupResources, closeDesktopFixture, mkdtemp, waitFor } from '../support/resources.ts';

test.afterEach(cleanupResources);

test('opening Personal Agent reconnects the previously saved cloud workspace without submitting Work', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-cloud-reconnect-ui-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: resolve(import.meta.dirname, '../../node_modules/electron/dist/electron.exe'),
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await waitFor(() => page.evaluate(async () => { const state = await window.flowmate.getState(); return state.ok && state.data.ready; }));
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await page.evaluate(workspaceId => localStorage.setItem('flowmate.personal-agent.cloud-connection.v1', JSON.stringify({ workspaceId,
      target: { host: '127.0.0.1', port: 22, username: 'flowmate', privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\hosts' } })), workspaceId);
    await app.evaluate(({ ipcMain }) => {
      let connected = false, connects = 0, workWrites = 0;
      Reflect.set(globalThis, 'cloudReconnectCounts', () => ({ connects, workWrites }));
      ipcMain.removeHandler('flowmate:desktop-start'); ipcMain.handle('flowmate:desktop-start', () => ({ ok: true, data: undefined }));
      ipcMain.removeHandler('flowmate:cloud-state'); ipcMain.handle('flowmate:cloud-state', () => ({ ok: true, data: {
        workspaceId: connected ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null, ...(connected ? { desktopReady: true } : {}) } }));
      ipcMain.removeHandler('flowmate:cloud-connect'); ipcMain.handle('flowmate:cloud-connect', (_event, input) => {
        connects++; connected = true; return { ok: true, data: { workspaceId: input.workspaceId } };
      });
      ipcMain.removeHandler('flowmate:cloud-request'); ipcMain.handle('flowmate:cloud-request', (_event, input) => {
        if (input.command.type === 'invoice_work_create') workWrites++;
        return { ok: false, error: { code: 'storage_read_failed', category: 'storage', message: 'Controlled unavailable.', retryable: true } };
      });
    });
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await expect(page.getByText('Connected workspace: ' + workspaceId, { exact: true })).toBeVisible({ timeout: 5000 });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'cloudReconnectCounts')())).toEqual({ connects: 1, workWrites: 0 });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
});

test('opening Personal Agent automatically starts the installed local KimiCU connection', async () => {
  test.skip(process.platform !== 'win32' || !process.env.FLOWMATE_KIMICU_PLUGIN_ROOT || !process.env.KIMI_CU_WINDOWS_EXE,
    'The installed local KimiCU plugin and runtime are required.');
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-cloud-kimi-ui-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR',
    'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  mkdirSync(join(userData, 'data'), { recursive: true });
  writeFileSync(join(userData, 'data', 'kimi-cu.json'), JSON.stringify({ version: 1,
    pluginRoot: process.env.FLOWMATE_KIMICU_PLUGIN_ROOT, runtimeExecutable: process.env.KIMI_CU_WINDOWS_EXE }));
  const app = await electron.launch({ executablePath: resolve(import.meta.dirname, '../../node_modules/electron/dist/electron.exe'),
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await waitFor(() => page.evaluate(async () => { const state = await window.flowmate.getState(); return state.ok && state.data.ready; }));
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Cloud connection' })).toContainText('KimiCU is ready on this Windows desktop.', { timeout: 10_000 });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
});

test('cloud desktop preload keeps workspace and invoice identities across IPC', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-cloud-desktop-ui-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: resolve(import.meta.dirname, '../../node_modules/electron/dist/electron.exe'),
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = await page.evaluate(async workspace => {
      const profile = { workspaceId: workspace, target: { host: '127.0.0.1', port: 22, username: 'root',
        privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\known_hosts' } };
      return { state: await window.flowmate.cloudDesktop.state(), root: await window.flowmate.cloudDesktop.connect(profile),
        forbidden: await window.flowmate.cloudDesktop.request({ workspaceId: workspace, command: { type: 'call_provider', input: {} } } as never),
        disconnected: await window.flowmate.cloudDesktop.request({ workspaceId: workspace,
          command: { type: 'cloud_queue_read', input: { workId: 1, sessionId: 2, attemptId: 3 } } }) };
    }, workspaceId);
    expect(result.state).toEqual({ ok: true, data: { workspaceId: null } });
    expect(result.root).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(result.forbidden).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    expect(result.disconnected).toMatchObject({ ok: false, error: { code: 'cloud_workspace_unavailable' } });

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('flowmate:cloud-connect'); ipcMain.handle('flowmate:cloud-connect', () =>
        ({ ok: true, data: { workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }));
      ipcMain.removeHandler('flowmate:cloud-request'); ipcMain.handle('flowmate:cloud-request', () =>
        ({ ok: true, data: { workId: 99, sessionId: 2, attemptId: 3, version: 1, items: [] } }));
      ipcMain.removeHandler('flowmate:cloud-upload'); ipcMain.handle('flowmate:cloud-upload', () => ({ ok: true, data: {
        workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', uploadId: '11111111-1111-4111-8111-111111111111',
        sourceDocumentRef: { id: 99, version: 'v1' }, cloudDocumentRef: { id: 10, version: 'v1' } } }));
    });
    const mismatched = await page.evaluate(async workspace => ({
      connection: await window.flowmate.cloudDesktop.connect({ workspaceId: workspace, target: { host: '127.0.0.1', port: 22,
        username: 'flowmate', privateKeyPath: 'C:\\test\\key', knownHostsPath: 'C:\\test\\known_hosts' } }),
      queue: await window.flowmate.cloudDesktop.request({ workspaceId: workspace, command: { type: 'cloud_queue_read',
        input: { workId: 1, sessionId: 2, attemptId: 3 } } }),
      upload: await window.flowmate.cloudDesktop.upload({ workspaceId: workspace, documentRef: { id: 1, version: 'v1' } }),
    }), workspaceId);
    expect(mismatched.connection).toMatchObject({ ok: false });
    expect(mismatched.queue).toMatchObject({ ok: false });
    expect(mismatched.upload).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
});

test('desktop chooses cloud explicitly and creates work from the uploaded cloud invoice reference', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-cloud-work-ui-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: resolve(import.meta.dirname, '../../node_modules/electron/dist/electron.exe'),
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    await app.evaluate(({ ipcMain }) => {
      const at = '2026-10-29T00:00:00.000Z', frames: unknown[] = []; let created = false, accepted = false;
      let queueReceipt: { workId: number; sessionId: number; attemptId: number; controlRequestId: string; status: string; version: number } | null = null;
      let queueVersion = 1, queueItems = [{ submissionId: 3, requestId: 'original-phase', mode: 'followUp', content: 'Review the original invoice.' }];
      Reflect.set(globalThis, 'cloudQueueReplace', () => { queueVersion++; queueItems[0]!.content = 'A newer queue instruction.'; });
      let delivered = false;
      const progressCursor = { generation: '33333333-3333-4333-8333-333333333333', sequence: 0 };
      let progressWake: (() => void) | undefined, progressReset = false, emittedText = false;
      Reflect.set(globalThis, 'cloudProgressWake', () => progressWake?.());
      Reflect.set(globalThis, 'cloudProgressResync', () => { progressReset = true; progressWake?.(); });
      Reflect.set(globalThis, 'cloudProgressPending', false);
      Reflect.set(globalThis, 'cloudWorkFrames', frames);
      let agent = { personalAgentId: 1, revision: 0, runtimeKind: 'durable', configuration: { modelId: 'cloud-model', thinkingLevel: 'off',
        resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [], workingDirectory: null, preferences: '' },
        createdAt: at, updatedAt: at };
      const attempt = { attemptId: 2, runId: 10, runtimeLinked: true };
      const task = { workId: 7, sessionId: 8, attempt, runStatus: 'running', createdAt: at, queued: false, stopRequestedAt: null, stoppedAt: null };
      const olderTask = { ...task, attempt: { attemptId: 1, runId: 9, runtimeLinked: true }, runStatus: 'completed', stoppedAt: at };
      const work = { workId: 7, personalAgentId: 1, sessionId: 8, runtimeKind: 'durable', revision: 0, goal: 'Review cloud invoice.', status: 'open',
        createdAt: at, updatedAt: at, counts: { total: 1, unresolved: 1, accepted: 0, rejected: 0, excluded: 0 },
        execution: { attempt, runStatus: 'running', queued: false, requiresContinue: false, stopUnconfirmed: false, waitingReason: null, ownedChildRunIds: [] }, actions: [] };
      const item = { workId: 7, itemId: 9, revision: 0, documentRef: { id: 101, version: 'v1' }, jobId: 4,
        candidateRef: { id: 5, sequence: 1 }, disposition: 'unresolved', decision: null, disposedAt: null, todoCount: 0, latestInputId: null, updatedAt: at };
      const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
      const fields: Record<string, unknown> = Object.fromEntries(['invoiceNumber', 'issueDate', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId', 'currency', 'netAmount', 'taxAmount']
        .map(name => [name, missing]));
      fields.totalAmount = { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [],
        sources: [{ documentId: 101, version: 'v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Total 113.00' }] };
      ipcMain.removeHandler('flowmate:list-documents'); ipcMain.handle('flowmate:list-documents', () => ({ ok: true, data: { items: [{
        documentRef: { id: 1, version: 'v1' }, displayName: 'Local invoice', isHidden: false, status: 'available', pageCount: 1,
        originalArtifactId: 1, parsedArtifactId: 2, warnings: [], unavailableReason: null, createdAt: at, updatedAt: at }], nextBeforeId: null } }));
      ipcMain.removeHandler('flowmate:list-resources'); ipcMain.handle('flowmate:list-resources', () => ({ ok: true, data: { settingsRevision: 0,
        selection: { prompt: null, enabledSkills: [] }, diagnostics: [], items: [{ ref: { kind: 'prompt', id: 'invoice', version: 'v1' },
          name: 'invoice', description: 'Original prompt', keywords: [], enabled: false, available: true, disableModelInvocation: false,
          bodyFile: 'prompt.md', files: [{ path: 'prompt.md', bytes: 4 }], dependencies: [], dependencyChecks: [], diagnostics: [] }] } }));
      ipcMain.removeHandler('flowmate:cloud-state'); ipcMain.handle('flowmate:cloud-state', () => ({ ok: true, data: { workspaceId: null } }));
      ipcMain.removeHandler('flowmate:cloud-connect'); ipcMain.handle('flowmate:cloud-connect', (_event, input) => ({ ok: true, data: { workspaceId: input.workspaceId } }));
      ipcMain.removeHandler('flowmate:cloud-upload'); ipcMain.handle('flowmate:cloud-upload', (_event, input) => {
        frames.push({ type: 'upload', input }); return { ok: true, data: { workspaceId: input.workspaceId,
          uploadId: '11111111-1111-4111-8111-111111111111', sourceDocumentRef: input.documentRef, cloudDocumentRef: { id: 101, version: 'v1' } } }; });
      ipcMain.removeHandler('flowmate:cloud-upload-resource'); ipcMain.handle('flowmate:cloud-upload-resource', (_event, input) => {
        frames.push({ type: 'resource-upload', input }); return { ok: true, data: { workspaceId: input.workspaceId,
          uploadId: '22222222-2222-4222-8222-222222222222', ref: input.ref } }; });
      ipcMain.removeHandler('flowmate:cloud-request'); ipcMain.handle('flowmate:cloud-request', (_event, input) => {
        frames.push(input); const command = input.command;
        switch (command.type) {
          case 'personal_agent_get': return { ok: true, data: agent };
          case 'personal_agent_update': agent = { ...agent, revision: agent.revision + 1, configuration: command.input.configuration };
            return { ok: true, data: agent };
          case 'invoice_work_list': return { ok: true, data: { items: created ? [work] : [], nextBeforeId: null } };
          case 'invoice_work_create': created = true; return { ok: true, data: { operation: 'create', personalAgentId: 1, workId: 7,
            sessionId: 8, revision: 0, requestId: command.input.requestId, receivedAt: at,
            execution: { kind: 'waiting', authorizationAccepted: false, attempt: null, reason: 'Waiting for the original work.', todoIds: [] } } };
          case 'invoice_work_get': return command.input.view === 'item' ? { ok: true, data: { view: 'item', work, item, todos: [], nextAfterTodoId: null } }
            : { ok: true, data: { view: 'work', work, items: [item], nextAfterItemId: null } };
          case 'personal_task_list': return { ok: true, data: { workId: 7, items: [task, olderTask], nextBeforeAttemptId: null } };
          case 'personal_task_get': if (command.input.attemptId === 1) return { ok: true, data: { task: olderTask, children: [], nextAfterChildRunId: null, stopReceipt: null } };
            return { ok: true, data: { task, children: [{ runtimeKind: 'durable', kind: 'subagent', workId: 7,
            itemId: 9, parentAttemptId: 2, childRunId: 12, originToolCallId: 11, role: 'invoice-evidence-checker', runStatus: 'completed',
            resultRecorded: true, stopConfirmed: true, stoppedAt: at, parentModelReceivedAt: at,
            delivery: { version: 1, state: 'message_observed', messageObservedAt: at, includedInCallSequence: null, requestDispatchedAt: null, error: null } }],
            nextAfterChildRunId: null, stopReceipt: null } };
          case 'invoice_work_timeline': return { ok: true, data: { workId: 7, semantics: 'live-facts', entries: [], nextBefore: null } };
          case 'cloud_queue_read': return { ok: true, data: { workId: 7, sessionId: 8, attemptId: 2, version: queueVersion,
            activePhaseRequestId: 'original-phase', items: queueItems } };
          case 'cloud_queue_control': {
            queueVersion++; const isNew = command.input.action.kind === 'enqueue', isEdit = command.input.action.kind === 'edit';
            if (isNew) queueItems = [{ submissionId: 4, requestId: 'original-phase', mode: command.input.action.mode, content: command.input.action.content }];
            else if (isEdit) queueItems[0]!.content = command.input.action.content;
            else queueItems = [];
            queueReceipt = { workId: 7, sessionId: 8, attemptId: 2, controlRequestId: command.input.controlRequestId,
              status: 'applied', version: queueVersion, ...(isNew ? { submissionId: 4 } : {}) };
            return isNew || isEdit ? { ok: true, data: queueReceipt } : { ok: false, error: { code: 'operation_result_unknown', category: 'runtime', message: 'Lost control receipt.', retryable: true } };
          }
          case 'cloud_queue_query_control': return { ok: true, data: queueReceipt };
          case 'cloud_delivery_status': return { ok: true, data: { workId: 7, sessionId: 8, attemptId: command.input.attemptId,
            runtimeGeneration: '11111111-1111-4111-8111-111111111111', observationRevision: 1,
            native: { conversationId: 5, tasks: [{ taskId: 6, kind: 'pi.generation', status: 'running', abortRequested: false }], moreTasks: false,
              submissions: [{ submissionId: 3, type: 'input', status: 'placed' }], moreSubmissions: false },
            wake: command.input.attemptId === 2 ? { requestId: 'original-phase', revision: 2, active: false, at: null, blocked: true } : null,
            results: { items: command.input.attemptId === 2 ? [{ requestId: 'original-phase', nativeSubmissionId: 3, state: delivered ? 'delivered' : 'blocked',
              attempts: delivered ? 0 : 8, nextAt: null, nativeStatus: 'done' }] : [], nextAfterSubmissionId: null } } };
          case 'cloud_progress_wait': {
            const event = { workId: 7, sessionId: 8, cursor: { ...progressCursor }, changed: false, resync: command.input.cursor === null,
              snapshotChanged: false, fragments: [],
              runtimeGeneration: '11111111-1111-4111-8111-111111111111', observationRevision: 1 };
            if (command.input.cursor === null) return { ok: true, data: event };
            return new Promise(resolve => { Reflect.set(globalThis, 'cloudProgressPending', true); progressWake = () => { progressWake = undefined;
              Reflect.set(globalThis, 'cloudProgressPending', false); const reset = progressReset; progressReset = false;
              if (reset) { progressCursor.generation = '55555555-5555-4555-8555-555555555555'; progressCursor.sequence = 0; }
              else progressCursor.sequence++;
              const fragments = !reset && !emittedText ? [{ attemptId: 2, requestId: 'original-phase',
                modelAttemptId: '44444444-4444-4444-8444-444444444444', text: 'Draft cloud response' }] : [];
              if (fragments.length) emittedText = true;
              resolve({ ok: true, data: { ...event, cursor: { ...progressCursor }, changed: true, resync: reset, snapshotChanged: true,
                fragments, observationRevision: 2 } }); }; });
          }
          case 'cloud_delivery_retry': delivered = true; return { ok: false, error: { code: 'operation_result_unknown', category: 'runtime',
            message: 'Lost retry response.', retryable: true } };
          case 'cloud_child_report': return { ok: true, data: { ...command.input, output: { version: 4, text: 'Original cloud child report',
            partial: false, stopReason: 'stop', responseId: null, responseModel: null, durable: { workId: 7, attemptId: 2 },
            subagent: { parentRunId: 10, originToolCallId: 11, phaseId: 4, itemId: 9, parentRequestId: 'original-phase', role: 'invoice-evidence-checker' } } } };
          case 'cloud_review_original': return { ok: true, data: { workId: 7, itemId: 9, documentRef: item.documentRef,
            mimeType: 'image/png', base64: 'iVBORw0KGgo=' } };
          case 'cloud_review_page': return { ok: true, data: { workId: 7, itemId: 9, page: { documentRef: item.documentRef,
            parsedArtifactId: 2, page: 1, pageCount: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0,
              sourceType: 'prepared-text', bbox: null, source: { documentId: 101, version: 'v1', artifactId: 2, page: 1, blockId: 'b1', quote: 'Total 113.00' } }],
            nextAfterBlockId: null, completePage: true } } };
          case 'cloud_review_candidate': return { ok: true, data: { workId: 7, itemId: 9, status: 'generated', createdAt: at, context: null,
            detail: { candidateId: 5, jobId: 4, runId: 1, origin: 'model', basedOnCandidateId: null, sequence: 1, issueCount: 0,
              documentRef: item.documentRef, toolCallId: 2, candidate: { fields, lines: [], notes: [] }, checks: [], issues: [] } } };
          case 'cloud_review_open': return { ok: true, data: { workId: 7, itemId: 9, documentRef: item.documentRef,
            jobId: 4, candidateId: 5, sequence: 1, workspaceRevision: 3 } };
          case 'cloud_review_accept': accepted = true; return { ok: false, error: { code: 'operation_result_unknown', category: 'runtime',
            message: 'The original acceptance receipt was lost.', retryable: true } };
          case 'cloud_review_query_accept': return { ok: true, data: accepted ? { workId: 7, itemId: 9, documentRef: item.documentRef,
            jobId: 4, candidateId: 5, sequence: 1, status: 'accepted' } : null };
          case 'invoice_work_dispose_item': return { ok: true, data: { operation: 'disposeItem', workId: 7, itemId: 9,
            requestId: command.input.requestId, revision: 1, receivedAt: at, disposition: 'accepted' } };
          default: return { ok: false, error: { code: 'unexpected', category: 'input', message: 'Unexpected test request.', retryable: false } };
        }
      });
    });
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click();
    await page.getByRole('button', { name: 'Cloud workspace', exact: true }).click();
    await page.getByLabel('Cloud workspace ID').fill('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await page.getByLabel('SSH host').fill('example.test');
    await page.getByLabel('SSH private key path').fill('C:\\keys\\flowmate');
    await page.getByLabel('Verified known_hosts path').fill('C:\\keys\\known_hosts');
    await page.getByRole('button', { name: 'Connect to cloud', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connected workspace:' })).toBeVisible();
    await page.getByText('Assistant configuration', { exact: true }).click();
    await expect(page.getByLabel('Personal Agent Prompt')).toBeEnabled();
    await page.getByLabel('Personal Agent Prompt').selectOption({ label: 'invoice v1' });
    await page.getByRole('button', { name: 'Save assistant configuration', exact: true }).click();
    await expect(page.getByText('Assistant configuration saved. Existing work keeps its accepted configuration.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal').fill('Review cloud invoice.');
    await page.getByLabel('Cloud execution time limit (seconds)').fill('3600');
    await page.getByLabel('Local invoice').check();
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 7', exact: true })).toBeVisible();
    await expect(page.locator('.personal-items')).toContainText('Cloud invoice 101');
    await expect.poll(async () => (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'cloud_progress_wait').length).toBeGreaterThan(1);
    const beforeProgress = (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'invoice_work_get').length;
    await app.evaluate(() => (Reflect.get(globalThis, 'cloudProgressWake') as () => void)());
    await expect.poll(async () => (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'invoice_work_get').length).toBeGreaterThan(beforeProgress);
    await expect(page.getByText('Draft cloud response', { exact: true })).toBeVisible();
    await expect.poll(async () => app.evaluate(() => Reflect.get(globalThis, 'cloudProgressPending'))).toBe(true);
    await app.evaluate(() => (Reflect.get(globalThis, 'cloudProgressResync') as () => void)());
    await expect(page.getByText('Draft cloud response', { exact: true })).toHaveCount(0);
    const frames = await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ type?: string; command?: { type: string; input: { documents?: unknown } } }>;
    expect(frames.some(value => value.type === 'upload')).toBe(true);
    expect(frames.find(value => value.command?.type === 'invoice_work_create')?.command?.input.documents).toEqual([{ id: 101, version: 'v1' }]);
    expect(frames.find(value => value.command?.type === 'invoice_work_create')?.command?.input).toMatchObject({ cloudTimeoutMs: 3_600_000 });
    expect(frames.findIndex(value => value.type === 'resource-upload')).toBeLessThan(frames.findIndex(value => value.command?.type === 'personal_agent_update'));
    await expect(page.getByRole('heading', { name: 'Input 3 · followUp', exact: true })).toBeVisible();
    await page.getByLabel('Queued input 3').fill('My unsent queue edit.');
    await expect.poll(async () => app.evaluate(() => Reflect.get(globalThis, 'cloudProgressPending'))).toBe(true);
    const beforeQueueRefresh = (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'cloud_queue_read').length;
    await app.evaluate(() => (Reflect.get(globalThis, 'cloudProgressWake') as () => void)());
    await expect.poll(async () => (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'cloud_queue_read').length).toBeGreaterThan(beforeQueueRefresh);
    await expect(page.getByLabel('Queued input 3')).toHaveValue('My unsent queue edit.');
    await expect.poll(async () => app.evaluate(() => Reflect.get(globalThis, 'cloudProgressPending'))).toBe(true);
    await app.evaluate(() => { (Reflect.get(globalThis, 'cloudQueueReplace') as () => void)(); (Reflect.get(globalThis, 'cloudProgressWake') as () => void)(); });
    await expect(page.getByText('The queued input changed. Your unsent edit is retained.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Queued input 3')).toHaveValue('My unsent queue edit.');
    await expect(page.getByRole('button', { name: 'Save queued edit', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Use current queued input', exact: true }).click();
    await expect(page.getByLabel('Queued input 3')).toHaveValue('A newer queue instruction.');
    await page.getByLabel('Queued input 3').fill('My confirmed queue edit.');
    await page.getByRole('button', { name: 'Save queued edit', exact: true }).click();
    await expect(page.getByText('The queued input changed. Your unsent edit is retained.', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Queued input 3')).toHaveValue('My confirmed queue edit.');
    await page.getByRole('button', { name: 'Cancel queued input', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check queue control receipt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check queue control receipt', exact: true }).click();
    await expect(page.getByText('Queue version 4 · 0 pending input(s)', { exact: true })).toBeVisible();
    await page.getByLabel('New cloud queue instruction').fill('Check the original total again.');
    await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Input 4 · followUp', exact: true })).toBeVisible();
    await expect(page.getByText('Result 3 · blocked · 8 delivery attempts', { exact: true })).toBeVisible();
    await expect(page.getByText('Automatic wake is blocked.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry original result 3', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh result delivery', exact: true }).click();
    await expect(page.getByText('Result 3 · delivered · 0 delivery attempts', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Attempt 1 · completed', exact: true }).click();
    await expect(page.getByText('Attempt 1: completed · stop confirmed', { exact: true })).toBeVisible();
    await expect.poll(async () => app.evaluate(() => Reflect.get(globalThis, 'cloudProgressPending'))).toBe(true);
    const beforeOlderProgress = (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'personal_task_get').length;
    await app.evaluate(() => (Reflect.get(globalThis, 'cloudProgressWake') as () => void)());
    await expect.poll(async () => (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'personal_task_get').length).toBeGreaterThan(beforeOlderProgress);
    await expect(page.getByText('Attempt 1: completed · stop confirmed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Attempt 2 · running', exact: true }).click();
    await page.getByRole('button', { name: 'Read child report 12', exact: true }).click();
    await expect(page.getByText(/Original cloud child report/)).toBeVisible();
    await expect.poll(async () => app.evaluate(() => Reflect.get(globalThis, 'cloudProgressPending'))).toBe(true);
    const beforeReportRefresh = (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'personal_task_get').length;
    await app.evaluate(() => (Reflect.get(globalThis, 'cloudProgressWake') as () => void)());
    await expect.poll(async () => (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'personal_task_get').length).toBeGreaterThan(beforeReportRefresh);
    await expect(page.getByText(/Original cloud child report/)).toBeVisible();
    await page.getByRole('tab', { name: 'Invoices', exact: true }).click();
    await page.getByRole('button', { name: /Cloud invoice 101/ }).click();
    await page.getByLabel('Disposition reason').fill('My unsent disposition reason.');
    await expect.poll(async () => app.evaluate(() => Reflect.get(globalThis, 'cloudProgressPending'))).toBe(true);
    const beforeItemRefresh = (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'invoice_work_get').length;
    await app.evaluate(() => (Reflect.get(globalThis, 'cloudProgressWake') as () => void)());
    await expect.poll(async () => (await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string } }>)
      .filter(value => value.command?.type === 'invoice_work_get').length).toBeGreaterThan(beforeItemRefresh + 1);
    await expect(page.getByLabel('Disposition reason')).toHaveValue('My unsent disposition reason.');
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cloud invoice review', exact: true })).toBeVisible();
    await expect(page.getByText('Total 113.00', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Prepare candidate review', exact: true }).click();
    await page.getByRole('button', { name: 'Accept candidate', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check original receipt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check original receipt', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 7', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Cloud invoice 101/ }).click();
    await page.getByRole('button', { name: 'Attach confirmed acceptance', exact: true }).click();
    const after = await app.evaluate(() => Reflect.get(globalThis, 'cloudWorkFrames')) as Array<{ command?: { type: string; input: { decision?: { acceptRequest?: unknown } } } }>;
    const acceptedCommand = after.find(value => value.command?.type === 'cloud_review_accept')?.command;
    const attached = after.find(value => value.command?.type === 'invoice_work_dispose_item')?.command;
    expect(attached?.input.decision?.acceptRequest).toEqual((acceptedCommand?.input as { request?: unknown }).request);
    expect(after.find(value => value.command?.type === 'cloud_delivery_retry')?.command?.input).toEqual({ workId: 7, sessionId: 8,
      attemptId: 2, requestId: 'original-phase', nativeSubmissionId: 3 });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
});
