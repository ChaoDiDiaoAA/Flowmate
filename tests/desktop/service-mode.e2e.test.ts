import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { ServiceClient } from '../../apps/desktop/main/service-client.ts';
import { ForegroundDisconnectReportSchema } from '../../apps/service/protocol.ts';
import { CandidateDraftSchema, InvoiceFormBridgeRequestSchema, InvoiceFormTargetSchema, WorkspaceContextSchema,
  invoiceHeaderFields, type DocumentSnapshot, type Result, type RunSnapshot } from '@flowmate/contracts';
import type { ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { cleanupResources, closeDesktopFixture, mkdtemp, createHttpProvider, deferCleanup } from '../support/resources.ts';

test.afterEach(cleanupResources);
const root = resolve(import.meta.dirname, '../..');
function environment(userData: string) {
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function launch(userData: string) {
  return electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'),
    args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
}
async function installed(mode: 'enabled' | 'offline' | 'pending' | 'prepared' | 'unknown-settings') {
  const child = spawn(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', 'tests/desktop/service-mode-fixture.ts', mode],
    { cwd: root, env: environment(''), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let installation: ServiceInstallation | undefined, stderr = '';
  const messages: Array<{ type: string; operationId?: string; receipt?: { phase: string; error: { code: string } } }> = [];
  child.stderr.on('data', data => { stderr += String(data); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const packet = JSON.parse(line); messages.push(packet); if (packet.type === 'ready') installation = packet.installation; } catch { /* Only bounded fixture packets are metadata. */ } });
  const exited = once(child, 'close');
  deferCleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.stdin.end('close\n');
    const [code] = await exited; lines.close(); if (code !== 0) throw Error('Service mode fixture failed: ' + stderr); });
  await expect.poll(() => { if (child.exitCode !== null) throw Error(stderr || 'Service fixture exited.'); return installation !== undefined; }, { timeout: 60000 }).toBe(true);
  return { installation: installation!, child, messages };
}
async function hasLocalHost(app: Awaited<ReturnType<typeof launch>>) {
  return app.evaluate(() => (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles()
    .some(handle => handle && typeof handle === 'object' && 'spawnargs' in handle && Array.isArray(handle.spawnargs)
      && handle.spawnargs.some(arg => typeof arg === 'string' && /(?:apps[\\/]host[\\/]main\.ts|start-host\.js)$/.test(arg))));
}

async function holdOriginalServiceFill(app: Awaited<ReturnType<typeof launch>>, installationId: string) {
  await app.evaluate((_electron, installationId) => {
    const { Socket } = process.getBuiltinModule('node:net') as typeof import('node:net'), emit = Socket.prototype.emit, write = Socket.prototype.write;
    const sockets = new Set<import('node:net').Socket>(), buffers = new Map<import('node:net').Socket, Buffer>();
    const held: Array<{ socket: import('node:net').Socket; line: Buffer }> = [], review: typeof held = [], connections: string[] = [];
    const kinds = new Map<string, string>(); let holdReview = false;
    const replies: Array<{ requestId: string; receipt: unknown }> = [], commands: string[] = [], incoming: Array<{ operation: string; runId: number; toolCallId: number }> = [];
    let first: unknown = null, drain: unknown = null, createKey: { operation: 'create'; personalAgentId: number; requestId: string } | null = null, armed = true;
    Socket.prototype.write = function (this: import('node:net').Socket, ...args: Parameters<typeof write>) {
      try { const packet = JSON.parse(String(args[0]));
        if (packet.type === 'service_connect' && packet.installationId === installationId || packet.type === 'invoice_work_create' || packet.type === 'submit_invoice_form_input') sockets.add(this);
        if (sockets.has(this)) commands.push(packet.type);
        if (sockets.has(this) && typeof packet.requestId === 'string') kinds.set(packet.requestId, packet.type);
        if (packet.type === 'invoice_work_create' && createKey === null) createKey = { operation: 'create', personalAgentId: packet.input.personalAgentId, requestId: packet.input.requestId };
        if (sockets.has(this) && packet.type === 'invoice_form_response') replies.push({ requestId: packet.requestId, receipt: packet.receipt });
      } catch { /* Observe metadata without changing original command bytes. */ }
      return Reflect.apply(write, this, args);
    } as typeof write;
    Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
      if (!sockets.has(this) || event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
      let buffer = Buffer.concat([buffers.get(this) ?? Buffer.alloc(0), args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
        const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        try { const packet = JSON.parse(line.toString());
          if (packet.type === 'service_ready') connections.push(packet.connectionId);
          if (packet.type === 'invoice_form_request') incoming.push({ operation: packet.request.operation, runId: packet.request.runId, toolCallId: packet.request.toolCallId });
          if (packet.type === 'response' && packet.value?.ok === true && Array.isArray(packet.value.data?.pendingAdmissions)) drain = packet.value.data;
          if (holdReview && packet.type === 'response' && kinds.get(packet.requestId) === 'query_job_candidate') {
            holdReview = false; review.push({ socket: this, line }); continue;
          }
          if (armed && packet.type === 'invoice_form_request' && packet.request.operation === 'apply') {
            armed = false; first = { requestId: packet.requestId, request: packet.request }; held.push({ socket: this, line }); continue;
          }
        } catch { /* Malformed original frames still reach the production parser. */ }
        forward.push(line);
      }
      buffers.set(this, buffer);
      return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    Reflect.set(globalThis, 'serviceFillConnectionGate', { connections, replies, commands, incoming, get heldCount() { return held.length; },
      get first() { return first; }, get drain() { return drain; }, get createKey() { return createKey; },
      holdReview() { holdReview = true; }, get reviewHeldCount() { return review.length; },
      releaseReview() { for (const value of review.splice(0)) Reflect.apply(emit, value.socket, ['data', value.line]); },
      deliverOriginal() { for (const value of held.splice(0)) Reflect.apply(emit, value.socket, ['data', value.line]); },
      restore() { for (const value of review.splice(0)) Reflect.apply(emit, value.socket, ['data', value.line]);
        Socket.prototype.emit = emit; Socket.prototype.write = write; buffers.clear(); held.splice(0); } });
  }, installationId);
}

test('service-mode Personal candidates use the original Fill bridge through an explicit Chat and reject an old connection bridge after reconnect', async () => {
  test.setTimeout(180000); const fixture = await installed('enabled'), userData = fixture.installation.dataRoot;
  const client = new ServiceClient(); deferCleanup(() => client.disconnect());
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined, candidateId: number | null = null, material: DocumentSnapshot | undefined;
  let requests = 0, personalRequests = 0, fillRequests = 0, releaseCurrent = () => {};
  const currentFill = new Promise<void>(resolve => { releaseCurrent = resolve; });
  const stream = (delta: unknown, finish: string) => new Response('data: ' + JSON.stringify({ id: 'service-fill-local', object: 'chat.completion.chunk',
    created: 1, model: 'service-fill-local', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer service-fill-synthetic-key'); requests++;
    const body = await request.json() as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
    if (body.tools?.some(tool => tool.function.name === 'fill_invoice_form')) {
      fillRequests++; if (candidateId === null) throw Error('Fill must use the original saved candidate.');
      if (fillRequests === 3) {
        expect(JSON.stringify(body.messages.find(message => message.tool_call_id === 'service-fill-current'))).toContain('applied');
        return stream({ role: 'assistant', content: 'The original candidate was applied for human review.' }, 'stop');
      }
      if (fillRequests === 2) await currentFill;
      if (fillRequests > 3) throw Error('No additional Fill request is authorized by this bounded fixture.');
      return stream({ role: 'assistant', tool_calls: [{ index: 0, id: fillRequests === 1 ? 'service-fill-old' : 'service-fill-current', type: 'function',
        function: { name: 'fill_invoice_form', arguments: JSON.stringify({ candidateId }) } }] }, 'tool_calls');
    }
    personalRequests++; if (personalRequests === 2) return stream({ role: 'assistant', content: 'The original candidate is saved for human review.' }, 'stop');
    if (!material || personalRequests !== 1) throw Error('Only the original Personal invoice phase is authorized.');
    const missing = { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] };
    const candidate = CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(name => [name, missing])),
      totalAmount: { raw: '113.00', normalized: '113.00', state: 'present', alternatives: [], sources: [{ documentId: material.documentRef.id,
        version: material.documentRef.version, artifactId: material.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' }] } }, lines: [], notes: [] });
    return stream({ role: 'assistant', tool_calls: [{ index: 0, id: 'service-personal-save', type: 'function', function: { name: 'save_invoice_candidate',
      arguments: JSON.stringify({ documentId: material.documentRef.id, candidate }) } }] }, 'tool_calls');
  });
  try {
    expect(await client.connect(fixture.installation)).toMatchObject({ ok: true });
    const imported = await client.request({ type: 'import_prepared_invoice_material', input: { contract: 'flowmate-prepared-invoice/v1', sample: 'service-personal-fill', sourceText: 'Total 113.00',
      original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] } }) as Result<DocumentSnapshot>;
    if (!imported.ok) throw Error(imported.error.code); material = imported.data;
    app = await launch(userData); let page = await app.firstWindow(); expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(async baseUrl => { const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'service-fill', credentialRef: '00000000000000000000000000000097', name: 'Service Fill', kind: 'custom', providerId: null,
        baseUrl, model: 'service-fill-local', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'service-fill' },
        { modelId: 'service-fill', apiKey: 'service-fill-synthetic-key' }); }, 'http://127.0.0.1:' + provider.port + '/v1')).toMatchObject({ ok: true });
    await holdOriginalServiceFill(app, fixture.installation.installationId);
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click(); await page.locator('.personal-configuration > summary').click();
    await page.getByLabel('Personal Agent model', { exact: true }).selectOption('service-fill');
    await page.getByRole('button', { name: 'Save assistant configuration', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Assistant configuration saved'); await page.locator('.personal-configuration > summary').click();
    await page.getByRole('button', { name: 'New invoice work', exact: true }).click();
    await page.getByLabel('Invoice work goal', { exact: true }).fill('Prepare the original service-owned invoice for an explicit foreground Fill.');
    await page.locator('.personal-create input[type=checkbox]').first().check(); expect(requests).toBe(0);
    await page.getByRole('button', { name: 'Submit invoice work', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Work 1', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => { const tasks = await window.flowmate.personalTasks.list({ workId: 1, limit: 10 });
      return tasks.ok && tasks.data.items.some(task => task.runStatus === 'completed' && task.stoppedAt !== null); })).toBe(true);
    await page.getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    const original = await page.evaluate(async () => {
      const [work, conversation, tasks, history, sessions] = await Promise.all([window.flowmate.invoiceWorks.get({ view: 'work', workId: 1, limit: 10 }),
        window.flowmate.personalAgent.openConversation({ workId: 1 }), window.flowmate.personalTasks.list({ workId: 1, limit: 10 }),
        window.flowmate.personalTasks.history({ target: { workId: 1 }, limit: 100 }), window.flowmate.listSessions()]);
      if (!work.ok || work.data.view !== 'work' || !conversation.ok || !tasks.ok || !history.ok || !sessions.ok) throw Error('Original service Work facts are unavailable.');
      return { work: work.data, conversation: conversation.data, tasks: tasks.data, history: history.data, sessions: sessions.data };
    });
    const item = original.work.items[0]!; if (!item.jobId || !item.candidateRef) throw Error('Expected a real original saved candidate.'); candidateId = item.candidateRef.id;
    expect(original.conversation).toMatchObject({ runtimeKind: 'durable', sessionId: original.work.work.sessionId }); expect(original.sessions.items).toEqual([]);
    expect(personalRequests).toBe(2); expect(requests).toBe(2);
    await page.locator('.personal-items button').first().click(); await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Personal Agent invoice review', exact: true })).toContainText('Original invoice item ' + item.itemId);
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    const fill = page.getByRole('button', { name: 'Fill form', exact: true }); await expect(fill).toBeDisabled();
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { sessionId: null, jobId: item.jobId, candidateRef: item.candidateRef } });
    expect(await page.evaluate(() => window.flowmate.listSessions())).toEqual({ ok: true, data: original.sessions }); expect(requests).toBe(2);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => { const workspace = await window.flowmate.readWorkspace(); return workspace.ok && workspace.data.sessionId !== null; })).toBe(true);
    const selected = await page.evaluate(async () => { const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok || workspace.data.sessionId === null) return null;
      const session = await window.flowmate.querySession(workspace.data.sessionId); return session.ok ? session.data : null; });
    if (!selected) throw Error('Expected an explicitly selected Chat Session.');
    expect(selected).toMatchObject({ runtimeKind: 'agent_session', availability: 'ready' }); expect(selected.sessionId).not.toBe(original.work.work.sessionId);
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click(); await page.locator('.personal-items button').first().click();
    await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').holdReview());
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click();
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').reviewHeldCount)).toBe(1);
    await page.getByRole('button', { name: 'Results', exact: true }).click(); await expect(fill).toBeDisabled(); expect(requests).toBe(2);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').commands.filter((type: string) => type === 'submit_invoice_form_input'))).toEqual([]);
    await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').releaseReview());
    await expect(fill).toBeEnabled(); await fill.click();
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').heldCount)).toBe(1).catch(async cause => {
      const diagnostic = await page.evaluate(async sessionId => ({ workspace: await window.flowmate.readWorkspace(), runtime: await window.flowmate.queryRuntimeState(),
        runs: await window.flowmate.listSessionRuns({ sessionId }) }), selected.sessionId);
      const transport = await app!.evaluate(() => { const gate = Reflect.get(globalThis, 'serviceFillConnectionGate'); return { commands: gate.commands, incoming: gate.incoming }; });
      throw Error(String(cause) + '\nFill evidence: ' + JSON.stringify({ requests, personalRequests, fillRequests, diagnostic, transport }) + '\nUI: ' + await page.locator('main').innerText());
    });
    const delayed = await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').first) as { requestId: string; request: unknown };
    const oldBridge = InvoiceFormBridgeRequestSchema.parse(delayed.request);
    expect(oldBridge).toMatchObject({ sessionId: selected.sessionId, candidateId: item.candidateRef.id, candidateSequence: item.candidateRef.sequence });
    expect(await page.evaluate(input => window.flowmate.backgroundService.disconnect(input), { installationId: fixture.installation.installationId })).toMatchObject({ ok: true, data: { state: 'offline' } });
    const drained = ForegroundDisconnectReportSchema.parse(await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').drain)); expect(drained.stopped).toBe(true);
    const stopped = await client.request({ type: 'query_run', runId: oldBridge.runId }) as Result<RunSnapshot>; if (!stopped.ok) throw Error(stopped.error.code);
    expect(stopped.data).toMatchObject({ status: 'failed', cancelRequestedAt: null, cleanup: { stopReason: 'shutdown', stopped: true } }); expect(stopped.data.stoppedAt).not.toBeNull();
    expect(await page.evaluate(input => window.flowmate.backgroundService.connect(input), { installationId: fixture.installation.installationId })).toMatchObject({ ok: true, data: { state: 'ready' } });
    const connections = await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').connections) as string[];
    expect(connections).toHaveLength(1); expect(connections[0]).not.toBe(drained.connectionId); expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(sessionId => window.flowmate.querySession(sessionId), selected.sessionId)).toMatchObject({ ok: true,
      data: { runtimeKind: 'agent_session', availability: 'unusable', historyState: 'recoverable', modelUseBlocked: false } });
    await expect(page.getByRole('button', { name: 'Discard changes', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect.poll(() => page.evaluate(async oldSessionId => { const workspace = await window.flowmate.readWorkspace();
      return workspace.ok && workspace.data.sessionId !== null && workspace.data.sessionId !== oldSessionId; }, selected.sessionId)).toBe(true);
    const foreground = await page.evaluate(async () => { const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok || workspace.data.sessionId === null) return null;
      const session = await window.flowmate.querySession(workspace.data.sessionId); return session.ok ? session.data : null; });
    if (!foreground) throw Error('Expected a new explicitly selected Chat after the old NativeSession retired.');
    expect(foreground).toMatchObject({ runtimeKind: 'agent_session', availability: 'ready' }); expect(foreground.sessionId).not.toBe(selected.sessionId);
    expect(foreground.sessionId).not.toBe(original.work.work.sessionId); expect(requests).toBe(3);
    await page.getByRole('button', { name: 'Personal Agent', exact: true }).click(); await page.locator('.personal-items button').first().click();
    await page.getByRole('button', { name: 'View original invoice / review', exact: true }).click(); await page.getByRole('button', { name: 'Results', exact: true }).click();
    await expect(fill).toBeEnabled(); await fill.click(); await expect.poll(() => fillRequests).toBe(2);
    const runs = await page.evaluate(sessionId => window.flowmate.listSessionRuns({ sessionId }), foreground.sessionId); if (!runs.ok) throw Error(runs.error.code);
    expect(runs.data.items).toHaveLength(1); const currentRun = runs.data.items[0]!;
    const current = await page.evaluate(runId => window.flowmate.queryRun(runId), currentRun.runId); if (!current.ok) throw Error(current.error.code);
    expect(current.data).toMatchObject({ kind: 'agent', sessionId: foreground.sessionId, jobId: item.jobId });
    expect('runtimeKind' in current.data && current.data.runtimeKind === 'durable').toBe(false);
    const target = InvoiceFormTargetSchema.parse(current.data.config.formTarget), workspace = WorkspaceContextSchema.parse(current.data.config.workspaceContext);
    expect(target.formInstanceId).not.toBe(oldBridge.target.formInstanceId);
    expect(workspace).toMatchObject({ sessionId: foreground.sessionId, documentRef: item.documentRef, jobId: item.jobId, candidateRef: item.candidateRef });
    await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').deliverOriginal());
    await expect(page.getByRole('region', { name: 'Invoice form', exact: true })).toContainText('Revision 0');
    expect(await app.evaluate((_electron, requestId) => Reflect.get(globalThis, 'serviceFillConnectionGate').replies.filter((reply: { requestId: string }) => reply.requestId === requestId), delayed.requestId)).toEqual([]);
    releaseCurrent();
    await expect(page.getByRole('region', { name: 'Invoice form', exact: true })).toContainText('Revision 1'); await expect(page.getByLabel('Total amount', { exact: true })).toHaveValue('113.00');
    await expect.poll(() => page.evaluate(async runId => { const run = await window.flowmate.queryRun(runId); return run.ok && run.data.status === 'completed'; }, currentRun.runId)).toBe(true);
    const applied = await page.evaluate(async ({ runId, sessionId }) => { const tools = await window.flowmate.listRunToolCalls({ runId, sessionId });
      if (!tools.ok || tools.data.items.length !== 1) throw Error('Expected the actual current Fill call.');
      return { tools: tools.data.items, receipt: await window.flowmate.queryInvoiceFormApplication({ runId, toolCallId: tools.data.items[0]!.toolCallId }) }; },
    { runId: currentRun.runId, sessionId: foreground.sessionId });
    expect(applied.tools).toMatchObject([{ toolName: 'fill_invoice_form', status: 'succeeded', formApplicationOutcome: 'applied' }]);
    expect(applied.receipt).toMatchObject({ ok: true, data: { outcome: 'applied', runId: currentRun.runId, toolCallId: applied.tools[0]!.toolCallId,
      formInstanceId: target.formInstanceId, candidateId: item.candidateRef.id, candidateSequence: item.candidateRef.sequence, appliedRevision: target.expectedRevision + 1 } });
    expect(await page.evaluate(runId => window.flowmate.queryRun(runId), oldBridge.runId)).toMatchObject({ ok: true, data: { status: 'failed', sessionId: selected.sessionId,
      stoppedAt: stopped.data.stoppedAt, cleanup: { stopReason: 'shutdown', stopped: true } } });
    expect(await page.evaluate(input => window.flowmate.queryInvoiceFormApplication(input), { runId: oldBridge.runId, toolCallId: oldBridge.toolCallId })).toMatchObject({ ok: true, data: { outcome: 'unknown' } });
    expect(await page.evaluate(input => window.flowmate.queryJobCandidate(input), { jobId: item.jobId, candidateId: item.candidateRef.id })).toMatchObject({ ok: true,
      data: { candidate: { candidateId: item.candidateRef.id, sequence: item.candidateRef.sequence, status: 'generated' } } });
    expect(personalRequests).toBe(2); expect(fillRequests).toBe(3); expect(requests).toBe(5);
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    const createKey = await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').createKey) as { operation: 'create'; personalAgentId: number; requestId: string };
    const created = await page.evaluate(key => window.flowmate.invoiceWorks.queryOperation(key), createKey); expect(created).toMatchObject({ ok: true });
    await app.evaluate(() => Reflect.get(globalThis, 'serviceFillConnectionGate').restore()); await closeDesktopFixture(app, userData); app = null; expect(fixture.child.exitCode).toBeNull();
    app = await launch(userData); page = await app.firstWindow(); expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(key => window.flowmate.invoiceWorks.queryOperation(key), createKey)).toEqual(created);
    expect(await page.evaluate(() => window.flowmate.personalAgent.openConversation({ workId: 1 }))).toEqual({ ok: true, data: original.conversation });
    expect(await page.evaluate(() => window.flowmate.personalTasks.list({ workId: 1, limit: 10 }))).toEqual({ ok: true, data: original.tasks });
    expect(await page.evaluate(() => window.flowmate.personalTasks.history({ target: { workId: 1 }, limit: 100 }))).toEqual({ ok: true, data: original.history });
    expect(await page.evaluate(() => window.flowmate.invoiceWorks.get({ view: 'work', workId: 1, limit: 10 }))).toEqual({ ok: true, data: original.work });
    expect(requests).toBe(5);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { releaseCurrent(); try { if (app) { await app.evaluate(({ dialog }) => { Reflect.get(globalThis, 'serviceFillConnectionGate')?.restore();
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {}); await closeDesktopFixture(app, userData, failure); } } finally { await provider.stop(); } }
  if (failure) throw failure;
});

test('an invalid service installation blocks the desktop without creating a local Host or product database', async () => {
  test.setTimeout(60000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-service-mode-invalid-'));
  writeFileSync(join(userData, 'service-installation.json'), JSON.stringify({ version: 1, enabled: true, installationId: 'invalid' }));
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined;
  try {
    app = await launch(userData); const page = await app.firstWindow();
    const state = await page.evaluate(() => window.flowmate.getState());
    expect(state).toMatchObject({ ok: true, data: { ready: false, backgroundService: { state: 'incompatible' } } });
    expect(await page.evaluate(() => Object.keys(window.flowmate.backgroundService).sort())).toEqual(['connect', 'disconnect', 'enable', 'getServiceState', 'prepare', 'queryActivation']);
    expect(await hasLocalHost(app)).toBe(false);
    expect(existsSync(join(userData, 'data/app.sqlite'))).toBe(false);
    const before = await page.evaluate(() => window.flowmate.backgroundService.getServiceState());
    expect(before).toMatchObject({ ok: true, data: { state: 'incompatible' } });
    await page.evaluate(() => window.flowmate.backgroundService.connect({ installationId: '00000000-0000-4000-8000-000000000001' }));
    expect(existsSync(join(userData, 'data/app.sqlite'))).toBe(false);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
});

for (const mode of ['offline', 'pending'] as const) test(`${mode} service selection never falls back to a local Host or database`, async () => {
  test.setTimeout(120000); const fixture = await installed(mode), userData = fixture.installation.dataRoot;
  const databaseFile = join(userData, 'data/app.sqlite'), originalDatabase = existsSync(databaseFile) ? readFileSync(databaseFile) : null;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined;
  try {
    app = await launch(userData); const page = await app.firstWindow();
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { ready: false,
      backgroundService: { state: mode === 'offline' ? 'offline' : 'blocked', installationId: fixture.installation.installationId } } });
    expect(await hasLocalHost(app)).toBe(false);
    if (originalDatabase) expect(readFileSync(databaseFile).equals(originalDatabase)).toBe(true); else expect(existsSync(databaseFile)).toBe(false);
    await page.evaluate(() => window.flowmate.restartHost());
    expect(await hasLocalHost(app)).toBe(false);
    if (originalDatabase) expect(readFileSync(databaseFile).equals(originalDatabase)).toBe(true); else expect(existsSync(databaseFile)).toBe(false);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
});

test('a prepared installation without activation retains the original local Host mode', async () => {
  test.setTimeout(120000); const fixture = await installed('prepared'), userData = fixture.installation.dataRoot;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined;
  try {
    app = await launch(userData); const page = await app.firstWindow();
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { ready: true, backgroundService: { state: 'disabled' } } });
    expect(await hasLocalHost(app)).toBe(true); expect(existsSync(join(userData, 'data/app.sqlite'))).toBe(true);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
});

test('the connected desktop uses service credentials and leaves one original background Work running across close and reopen', async () => {
  test.setTimeout(120000); const fixture = await installed('enabled'), userData = fixture.installation.dataRoot;
  const client = new ServiceClient(); deferCleanup(() => client.disconnect());
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined, requests = 0, release = () => {};
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer service-mode-synthetic-key'); await request.json(); requests++;
    await new Promise<void>(resolveHeld => { release = resolveHeld; request.signal.addEventListener('abort', () => resolveHeld(), { once: true }); });
    return new Response('data: ' + JSON.stringify({ id: 'service-mode-local', object: 'chat.completion.chunk', created: 1, model: 'service-mode-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Original invoice needs human clarification.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    expect(await client.connect(fixture.installation)).toMatchObject({ ok: true });
    const material = await client.request({ type: 'import_prepared_invoice_material', input: { contract: 'flowmate-prepared-invoice/v1', sample: 'service-mode-invoice', sourceText: 'Total 113.00',
      original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] } }) as { ok: true; data: { documentRef: { id: number; version: string } } };
    expect(material.ok).toBe(true);
    app = await launch(userData); let page = await app.firstWindow();
    expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(async baseUrl => { const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'service-mode', credentialRef: '00000000000000000000000000000091', name: 'Service local', kind: 'custom', providerId: null,
        baseUrl, model: 'service-mode-model', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'service-mode' },
        { modelId: 'service-mode', apiKey: 'service-mode-synthetic-key' }); }, 'http://127.0.0.1:' + provider.port + '/v1')).toMatchObject({ ok: true });
    const state = await page.evaluate(() => window.flowmate.getState()); if (!state.ok) throw Error(state.error.code);
    expect(state.data).toMatchObject({ ready: true, backgroundService: { state: 'ready' }, modelCredentials: { 'service-mode': 'configured' } });
    const ref = state.data.settings.models[0]!.credentialRef;
    expect(existsSync(join(userData, 'security/service-credentials', ref + '.json'))).toBe(true);
    expect(existsSync(join(userData, 'security/credentials', ref + '.json'))).toBe(false);
    const agent = await page.evaluate(() => window.flowmate.personalAgent.get()); if (!agent.ok) throw Error(agent.error.code);
    expect(await page.evaluate(initial => window.flowmate.personalAgent.update({ personalAgentId: initial.personalAgentId, expectedRevision: initial.revision,
      configuration: { ...initial.configuration, modelId: 'service-mode', tools: ['read_invoice_document'] } }), agent.data)).toMatchObject({ ok: true });
    const updated = await page.evaluate(() => window.flowmate.personalAgent.get()); if (!updated.ok) throw Error(updated.error.code);
    const created = await page.evaluate(async input => window.flowmate.invoiceWorks.create(input), { personalAgentId: updated.data.personalAgentId, expectedAgentRevision: updated.data.revision,
      requestId: 'service-mode-original-work', goal: 'Preserve the original background invoice.', documents: [material.data.documentRef] });
    if (!created.ok) throw Error(created.error.code);
    await expect.poll(() => requests).toBe(1);
    await closeDesktopFixture(app, userData); app = null;
    expect(fixture.child.exitCode).toBeNull(); expect(requests).toBe(1); release();
    await expect.poll(async () => { const tasks = await client.request({ type: 'personal_task_list', input: { workId: created.data.workId, limit: 10 } }) as { ok: true; data: { items: Array<{ stoppedAt: string | null; runStatus: string }> } };
      return tasks.ok && tasks.data.items.some(task => task.stoppedAt !== null && task.runStatus === 'completed'); }).toBe(true);
    app = await launch(userData); page = await app.firstWindow(); expect(await hasLocalHost(app)).toBe(false);
    const recovered = await page.evaluate(input => window.flowmate.invoiceWorks.queryOperation(input), { operation: 'create' as const, personalAgentId: updated.data.personalAgentId, requestId: 'service-mode-original-work' });
    expect(recovered).toEqual(created); expect(requests).toBe(1);
    expect(await page.evaluate(async () => { const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveEvaluationSettings({ role: 'agent', expectedRevision: state.data.settings.revision,
        connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'eval-only', api: 'openai-completions' }, apiKey: 'evaluation-only-synthetic-key' }); })).toMatchObject({ ok: true });
    const evaluated = await page.evaluate(() => window.flowmate.getState()); if (!evaluated.ok) throw Error(evaluated.error.code);
    const evaluationRef = evaluated.data.settings.evaluation?.agent?.credentialRef; expect(evaluationRef).toBeTruthy();
    expect(existsSync(join(userData, 'security/credentials', evaluationRef + '.json'))).toBe(true);
    expect(existsSync(join(userData, 'security/service-credentials', evaluationRef + '.json'))).toBe(false); expect(requests).toBe(1);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { release(); try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await provider.stop(); } }
  if (failure) throw failure;
});

test('an unconfirmed original foreground stop report keeps the desktop and original service connection open', async () => {
  test.setTimeout(120000); const fixture = await installed('enabled'), userData = fixture.installation.dataRoot;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined;
  try {
    app = await launch(userData); const page = await app.firstWindow();
    expect(await page.evaluate(() => window.flowmate.backgroundService.getServiceState())).toMatchObject({ ok: true, data: { state: 'ready' } });
    await app.evaluate(async () => {
      const { Socket } = process.getBuiltinModule('node:net') as typeof import('node:net');
      const emit = Socket.prototype.emit, write = Socket.prototype.write;
      let remaining = 1, originalSocket: import('node:net').Socket | null = null, connectionId: string | null = null;
      const queriedConnectionIds: string[] = [];
      Socket.prototype.write = function (this: import('node:net').Socket, ...args: Parameters<typeof write>) {
        try { const packet = JSON.parse(String(args[0])); if (packet.type === 'service_query_disconnect') queriedConnectionIds.push(packet.input.connectionId); }
        catch { /* Other original frames are unchanged. */ }
        return Reflect.apply(write, this, args);
      } as typeof write;
      Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event === 'data' && Buffer.isBuffer(args[0]) && remaining) {
          try {
            const packet = JSON.parse(args[0].toString());
            if (packet.type === 'response' && packet.value?.ok === true && typeof packet.value.data?.connectionId === 'string'
              && typeof packet.value.data.stopped === 'boolean') {
              remaining--; originalSocket = this; connectionId = packet.value.data.connectionId;
              packet.value.data = { ...packet.value.data, stopped: false, pendingAdmissions: ['controlled-original-admission'], pending: [] };
              args[0] = Buffer.from(JSON.stringify(packet) + '\n');
            }
          } catch { /* Other original transport bytes are unchanged. */ }
        }
        return Reflect.apply(emit, this, [event, ...args]);
      };
      Reflect.set(globalThis, 'serviceStopReportGate', { get connectionId() { return connectionId; }, queriedConnectionIds,
        drop() { originalSocket?.destroy(); }, restoreRead() { Socket.prototype.emit = emit; },
        restore() { Socket.prototype.emit = emit; Socket.prototype.write = write; } });
    });
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await expect.poll(() => page.evaluate(() => window.flowmate.backgroundService.getServiceState())).toMatchObject({ ok: true,
      data: { state: 'stopping', error: { code: 'service_foreground_stop_unconfirmed' } } });
    expect(app.process().exitCode).toBeNull(); expect(fixture.child.exitCode).toBeNull();
    expect(await hasLocalHost(app)).toBe(false);
    const originalConnectionId = await app.evaluate(() => Reflect.get(globalThis, 'serviceStopReportGate').connectionId);
    expect(originalConnectionId).toMatch(/^[0-9a-f-]{36}$/i);
    await app.evaluate(() => Reflect.get(globalThis, 'serviceStopReportGate').drop());
    await expect.poll(() => page.evaluate(() => window.flowmate.backgroundService.getServiceState())).toMatchObject({ ok: true, data: { state: 'offline' } });
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await app.evaluate(() => new Promise<void>(done => setImmediate(done)));
    expect(page.isClosed()).toBe(false);
    expect(app.process().exitCode).toBeNull();
    await app.evaluate(() => Reflect.get(globalThis, 'serviceStopReportGate').restoreRead());
    expect(await page.evaluate(input => window.flowmate.backgroundService.connect(input), { installationId: fixture.installation.installationId }))
      .toMatchObject({ ok: true, data: { state: 'stopping' } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'serviceStopReportGate').queriedConnectionIds)).toEqual([originalConnectionId]);
    await app.evaluate(() => Reflect.get(globalThis, 'serviceStopReportGate').restore());
    await closeDesktopFixture(app, userData); app = null; expect(fixture.child.exitCode).toBeNull();
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) { await app.evaluate(() => Reflect.get(globalThis, 'serviceStopReportGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); } }
  if (failure) throw failure;
});

test('a timed out service settings save recovers its original metadata-only request after Main restarts', async () => {
  test.setTimeout(120000); const fixture = await installed('enabled'), userData = fixture.installation.dataRoot;
  const metadataFile = join(userData, 'data/desktop-service-settings-request.json');
  const client = new ServiceClient(); deferCleanup(() => client.disconnect());
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined, saving: Promise<unknown> | null = null;
  try {
    expect(await client.connect(fixture.installation)).toMatchObject({ ok: true });
    app = await launch(userData); let page = await app.firstWindow();
    await app.evaluate((_electron, file) => {
      const { Socket } = process.getBuiltinModule('node:net') as typeof import('node:net');
      const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs'), emit = Socket.prototype.emit, write = Socket.prototype.write;
      let target: import('node:net').Socket | null = null, requestId: string | null = null, buffer = Buffer.alloc(0);
      const requests: Array<{ installationId: string; operationId: string; metadataAtWrite: string | null }> = [];
      Socket.prototype.write = function (this: import('node:net').Socket, ...args: Parameters<typeof write>) {
        try { const packet = JSON.parse(String(args[0])); if (packet.type === 'service_settings_save') {
          target = this; requestId = packet.requestId;
          requests.push({ installationId: packet.input.installationId, operationId: packet.input.operationId,
            metadataAtWrite: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
        } } catch { /* No setting body or secret is recorded by this gate. */ }
        return Reflect.apply(write, this, args);
      } as typeof write;
      Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        if (this !== target || event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
        buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
        for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
          const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
          try { const packet = JSON.parse(line.toString()); if (packet.type === 'response' && packet.requestId === requestId) continue; }
          catch { /* Invalid original bytes still reach the production parser. */ }
          forward.push(line);
        }
        return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
      };
      Reflect.set(globalThis, 'serviceSettingsResponseGate', { requests, restore() { Socket.prototype.emit = emit; Socket.prototype.write = write;
        if (target && buffer.length) Reflect.apply(emit, target, ['data', buffer]); buffer = Buffer.alloc(0); } });
    }, metadataFile);
    saving = page.evaluate(async () => { const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'restart-original', credentialRef: '00000000000000000000000000000092', name: 'Original saved model', kind: 'custom', providerId: null,
        baseUrl: 'http://127.0.0.1:1/v1', model: 'restart-original', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'restart-original' },
        { modelId: 'restart-original', apiKey: 'restart-original-synthetic-key' }); });
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'serviceSettingsResponseGate').requests.length)).toBe(1);
    expect(existsSync(metadataFile)).toBe(true);
    const writes = await app.evaluate(() => Reflect.get(globalThis, 'serviceSettingsResponseGate').requests) as Array<{ installationId: string; operationId: string; metadataAtWrite: string | null }>;
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as { version: 1; installationId: string; operationId: string };
    expect(metadata).toEqual({ version: 1, installationId: fixture.installation.installationId, operationId: writes[0]!.operationId });
    expect(JSON.parse(writes[0]!.metadataAtWrite!)).toEqual(metadata);
    expect(readFileSync(metadataFile, 'utf8')).not.toMatch(/apiKey|credential|settings|restart-original|synthetic/);
    expect(await saving).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } }); saving = null;
    const query = { installationId: metadata.installationId, operationId: metadata.operationId };
    const original = await client.queryCredentialOperation(query); expect(original).toMatchObject({ ok: true, data: { phase: 'committed', operationId: metadata.operationId } });
    if (!original.ok || !original.data?.settings) throw Error('Expected an original committed settings snapshot.');
    const originalRef = original.data.settings.models[0]!.credentialRef;
    await app.evaluate(() => Reflect.get(globalThis, 'serviceSettingsResponseGate').restore());
    await closeDesktopFixture(app, userData); app = null;
    expect(existsSync(metadataFile)).toBe(true);
    app = await launch(userData); page = await app.firstWindow();
    const recovered = await page.evaluate(() => window.flowmate.getState());
    expect(recovered).toMatchObject({ ok: true, data: { ready: true, settings: original.data.settings, modelCredentials: { 'restart-original': 'configured' } } });
    expect(existsSync(metadataFile)).toBe(false);
    const after = await client.queryCredentialOperation(query); expect(after).toEqual(original);
    if (recovered.ok) expect(recovered.data.settings.models[0]?.credentialRef).toBe(originalRef);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (saving) await saving.catch(() => {}); if (app) { await app.evaluate(() => Reflect.get(globalThis, 'serviceSettingsResponseGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); } }
  if (failure) throw failure;
});

test('a failed receipt with unknown publication retains the original settings request across restart and another save', async () => {
  test.setTimeout(120000); const fixture = await installed('unknown-settings'), userData = fixture.installation.dataRoot;
  const metadataFile = join(userData, 'data/desktop-service-settings-request.json'), client = new ServiceClient(); deferCleanup(() => client.disconnect());
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined;
  try {
    expect(await client.connect(fixture.installation)).toMatchObject({ ok: true });
    app = await launch(userData); let page = await app.firstWindow();
    const save = () => page.evaluate(async () => { const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'unknown-original', credentialRef: '00000000000000000000000000000093', name: 'Original unknown publication', kind: 'custom', providerId: null,
        baseUrl: 'http://127.0.0.1:1/v1', model: 'unknown-original', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'unknown-original' },
        { modelId: 'unknown-original', apiKey: 'unknown-original-synthetic-key' }); });
    expect(await save()).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as { version: 1; installationId: string; operationId: string };
    const original = await client.queryCredentialOperation({ installationId: metadata.installationId, operationId: metadata.operationId });
    expect(original).toMatchObject({ ok: true, data: { phase: 'failed', error: { code: 'operation_result_unknown' } } });
    expect(fixture.messages.some(message => message.type === 'fixture_unknown_settings_receipt' && message.receipt?.phase === 'failed'
      && message.receipt.error?.code === 'operation_result_unknown')).toBe(true);
    expect(await save()).toMatchObject({ ok: false });
    expect(JSON.parse(readFileSync(metadataFile, 'utf8'))).toEqual(metadata);
    expect(fixture.messages.filter(message => message.type === 'fixture_settings_save')).toHaveLength(1);
    await closeDesktopFixture(app, userData); app = null;
    app = await launch(userData); page = await app.firstWindow();
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { ready: false, backgroundService: { state: 'blocked' } } });
    expect(JSON.parse(readFileSync(metadataFile, 'utf8'))).toEqual(metadata);
    expect(await save()).toMatchObject({ ok: false });
    expect(fixture.messages.filter(message => message.type === 'fixture_settings_save')).toHaveLength(1);
    expect(JSON.parse(readFileSync(metadataFile, 'utf8'))).toEqual(metadata);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) await closeDesktopFixture(app, userData, failure); }
  if (failure) throw failure;
});
