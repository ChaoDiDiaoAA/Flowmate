import { expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { type AgentSession } from '@earendil-works/pi-coding-agent';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { invoiceToolSchemas, ok } from '@flowmate/contracts';
import type { AgentRunEvent, ProviderConfig, Result, ToolDefinition } from '@flowmate/contracts';
import { openDatabase } from '../../packages/core/src/storage/database.ts';
import { createApplication } from '../../apps/composition.ts';
import { resolveProductPaths } from '../../packages/shared/src/paths.ts';
import { createExtensionService } from '../../packages/core/src/extensions/service.ts';
import { PiAgentAdapter } from '../../packages/runtime-pi/src/session.ts';
import * as invoiceExtension from '../../packages/runtime-pi/src/extensions/invoice.ts';
import { createSubagentTool } from '../../packages/core/src/subagents.ts';
import { DocumentService } from '../../packages/data/src/documents.ts';
import { createHttpProvider, deferCleanup, mkdtempSync, waitFor } from '../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
const tool: ToolDefinition<any, any> = { name: 'check_invoice_sources', version: '1', effect: 'READ',
  description: 'Verify invoice sources', inputSchema: invoiceToolSchemas.check_invoice_sources.input,
  outputSchema: invoiceToolSchemas.check_invoice_sources.output, executionMode: 'parallel', execute: async () => { throw new Error('No model call expected'); } };
function fixture(subagents = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p12-sdk-'));
  const tools: ToolDefinition<any, any>[] = subagents ? [tool, createSubagentTool(() => adapter), ...(['read_invoice_document', 'read_invoice_evidence'] as const).map(name => ({
    name, version: '1', description: name, effect: 'READ' as const, executionMode: 'parallel' as const,
    inputSchema: invoiceToolSchemas[name].input, outputSchema: invoiceToolSchemas[name].output,
    execute: async () => { throw new Error('Registry-only fixture must never execute business tools'); } }))] : [tool];
  const catalog = createExtensionService({ resourceRoot: resolve(import.meta.dir, '../../resources'), sdkVersion: '0.85.1', registeredTools: tools });
  const refs = need(catalog.list()).filter(item => subagents || item.ref.id === 'invoice-assist').map(item => item.ref);
  let native!: AgentSession;
  const adapter = new PiAgentAdapter({ cwd: root, agentDir: root, tools, credentials: new InMemoryCredentialStore(),
    runtimeApiKey: 'p12-loopback-only', sessionSetup: session => { native = session; } });
  deferCleanup(() => adapter.close());
  const config: ProviderConfig = { version: 1, name: 'P12', revision: 1, modelRef: { provider: 'p12', model: 'p12' },
    native: { authPath: join(root, 'auth.json'), modelsPath: null },
    connection: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 16000 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  const sid = need(adapter.createSession()).nativeSessionId;
  const freeze = (policy: 'p2' | 'p3' | 'fill', enabled = true) => need(catalog.freeze({ selection: { enabledExtensions: enabled ? refs : [] },
    settingsRevision: 1, activeToolNames: tools.map(item => item.name), policy }));
  return { root, adapter, sid, config, freeze, native: () => native };
}

it('[F13-02/06/27] loads both actual controlled factories, keeps distinct owners and starts zero children', async () => {
  const f = fixture(true), frozen = f.freeze('p3');
  const prepared = need(await f.adapter.prepare(f.sid, f.config, { timeoutMs: 1000, stopGraceMs: 1000 }, new AbortController().signal,
    { activeToolNames: ['Agent', 'check_invoice_sources', 'read_invoice_document', 'read_invoice_evidence'], extensions: frozen }));
  const instances = prepared.snapshot.extensionAssembly!.instances;
  expect(instances.map(item => item.ref.id)).toEqual(['invoice-assist', 'subagents']);
  expect(new Set(instances.map(item => item.instanceId)).size).toBe(2);
  expect(f.native().extensionRunner.getAllRegisteredTools().map(item => item.definition.name)).toEqual(['check_invoice_sources', 'Agent']);
  expect(f.native().getActiveToolNames()).toEqual(['Agent', 'check_invoice_sources', 'read_invoice_document', 'read_invoice_evidence']);
  expect(f.native().sessionManager.getEntries().filter(item => item.type === 'message')).toHaveLength(0);
  expect(await f.adapter.releaseSession(f.sid)).toMatchObject({ stopped: true, closed: true });
  expect(need(f.adapter.inspectExtensions(f.sid)).instances).toMatchObject([
    { instanceId: instances[0]!.instanceId, state: 'disposed', cleanup: { shutdownAcknowledged: true, sdkDisposed: true } },
    { instanceId: instances[1]!.instanceId, state: 'disposed', cleanup: { shutdownAcknowledged: true, sdkDisposed: true } }]);
});

it('[F12-01/05/08] uses the installed public SDK factory, real registration and acknowledged startup', async () => {
  const f = fixture(), frozen = f.freeze('p3');
  const prepared = need(await f.adapter.prepare(f.sid, f.config, { timeoutMs: 1000, stopGraceMs: 1000 }, new AbortController().signal,
    { activeToolNames: ['check_invoice_sources'], extensions: frozen }));
  expect(prepared.snapshot.extensionAssembly?.instances).toHaveLength(1);
  const actual = prepared.snapshot.extensionAssembly!.instances[0]!;
  expect(actual.registeredTools).toEqual(['check_invoice_sources']);
  expect(f.native().extensionRunner.getAllRegisteredTools().map(item => item.definition.name)).toEqual(['check_invoice_sources']);
  expect(f.native().getAllTools().map(item => item.name)).toEqual(['check_invoice_sources']);
  expect(f.native().extensionRunner.getCommand('invoice-assist')).toBeDefined();
  const inspect = Reflect.get(f.adapter, 'inspectExtensions'); expect(typeof inspect).toBe('function');
  expect(need(inspect.call(f.adapter, f.sid))).toMatchObject({ nativeSessionId: f.sid,
    instances: [{ state: 'active', admission: 'open', instanceId: actual.instanceId, cleanup: { sdkSessionCreated: true, sdkDisposed: false } }] });
  expect(await f.adapter.releaseSession(f.sid)).toMatchObject({ stopped: true, closed: true });
  expect(need(inspect.call(f.adapter, f.sid))).toMatchObject({ instances: [{ state: 'disposed', cleanup: {
    shutdownAcknowledged: true, sdkDisposed: true, ownedCallbacksSettled: true } }] });
});

it.each(['disabled', 'excluded'] as const)('[F12-04/05] %s retains the ordinary source tool without extension registrations', async mode => {
  const f = fixture(), frozen = f.freeze(mode === 'excluded' ? 'p2' : 'p3', mode !== 'disabled');
  const prepared = need(await f.adapter.prepare(f.sid, f.config, { timeoutMs: 1000, stopGraceMs: 1000 }, new AbortController().signal,
    { activeToolNames: ['check_invoice_sources'], extensions: frozen }));
  expect(prepared.snapshot.extensions).toEqual(frozen);
  expect(prepared.snapshot.extensionAssembly).toMatchObject({ instances: [] });
  expect(f.native().getAllTools().map(item => item.name)).toEqual(['check_invoice_sources']);
  expect(f.native().extensionRunner.getAllRegisteredTools()).toEqual([]);
});

it.each(['partial', 'duplicate-tool', 'duplicate-command', 'duplicate-hook', 'missing-hook', 'extra-hook', 'unsafe-api'] as const)
  ('[F12-06/07] rejects real SDK %s registrations and retains truthful partial cleanup', async fault => {
  const original = invoiceExtension.createInvoiceAssistExtension;
  const injected = spyOn(invoiceExtension, 'createInvoiceAssistExtension').mockImplementation(input => pi => {
    if (fault === 'partial') { pi.registerTool(input.sdkTool); throw new Error('Controlled factory failure'); }
    if (fault === 'duplicate-tool') { pi.registerTool(input.sdkTool); pi.registerTool(input.sdkTool); return; }
    if (fault === 'duplicate-command') { pi.registerCommand('invoice-assist', { handler: async () => {} }); pi.registerCommand('invoice-assist', { handler: async () => {} }); return; }
    if (fault === 'duplicate-hook') { pi.on('session_start', () => {}); pi.on('session_start', () => {}); return; }
    if (fault === 'extra-hook') { Reflect.apply(pi.on, pi, ['agent_start', () => {}]); return; }
    if (fault === 'unsafe-api') { pi.exec('should-never-run', []); return; }
    return original(input)(new Proxy(pi, { get(target, key) {
      return key === 'on' ? (event: string, handler: unknown) => event === 'tool_result' ? undefined : Reflect.apply(target.on, target, [event, handler]) : Reflect.get(target, key);
    } }));
  });
  try {
    const f = fixture();
    const prepared = await f.adapter.prepare(f.sid, f.config, { timeoutMs: 1000, stopGraceMs: 1000 }, new AbortController().signal,
      { activeToolNames: ['check_invoice_sources'], extensions: f.freeze('p3') });
    expect(prepared.ok).toBe(false);
    const instance = need(f.adapter.inspectExtensions(f.sid)).instances[0]!;
    expect(instance).toMatchObject({ state: 'disposed', admission: 'closed', activatedAt: null,
      cleanup: { shutdownRequired: false, shutdownAcknowledged: false, sdkSessionCreated: false, sdkDisposed: false, ownedCallbacksSettled: true } });
    expect(instance.lastError?.code).toBe(fault === 'partial' || fault === 'missing-hook' ? 'extension_load_failed' : 'extension_registration_conflict');
    expect(f.native()).toBeUndefined();
  } finally { injected.mockRestore(); }
});

it('[F12-14] keeps a cancelled loading factory owned until it actually settles and never activates the late instance', async () => {
  const original = invoiceExtension.createInvoiceAssistExtension;
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { finish = resolve; });
  const injected = spyOn(invoiceExtension, 'createInvoiceAssistExtension').mockImplementation(input => async pi => {
    entered(); await barrier; await original(input)(pi);
  });
  const f = fixture(), controller = new AbortController();
  try {
    const preparation = f.adapter.prepare(f.sid, f.config, { timeoutMs: 1000, stopGraceMs: 1000 }, controller.signal,
      { activeToolNames: ['check_invoice_sources'], extensions: f.freeze('p3') });
    await started; controller.abort();
    expect(need(f.adapter.inspectExtensions(f.sid)).instances[0]).toMatchObject({ state: 'loading', admission: 'closed', cleanup: { ownedCallbacksSettled: false } });
    expect(await f.adapter.releaseSession(f.sid)).toMatchObject({ stopped: false, closed: false });
    finish(); expect(await preparation).toMatchObject({ ok: false, error: { code: 'agent_cancelled' } });
    expect(need(f.adapter.inspectExtensions(f.sid)).instances[0]).toMatchObject({ state: 'disposed', activatedAt: null });
    expect(f.native()).toBeUndefined();
  } finally { finish(); injected.mockRestore(); }
});

it('[F12-14/16] preserves actual Runtime blocking beyond stop grace until the real loading factory settles', async () => {
  const original = invoiceExtension.createInvoiceAssistExtension;
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { finish = resolve; });
  const injected = spyOn(invoiceExtension, 'createInvoiceAssistExtension').mockImplementation(input => async pi => { entered(); await barrier; await original(input)(pi); });
  try {
    const f = await businessFixture(); let end!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const done = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { end = resolve; });
    const accepted = need(await f.app.submitInput({ ...f.request, stopGraceMs: 100, timeoutMs: 5000 }, {
      onEvent(event) { if (event.type === 'run_finished') end(event); },
    }));
    await started; need(await f.app.cancelRun(accepted.runId));
    expect((await done).result).toMatchObject({ ok: true, data: { status: 'failed', stopped: false } });
    expect(need(await f.app.queryRuntimeState()).blocked).toBe(true);
    const loading = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!;
    expect(loading).toMatchObject({ state: 'loading', admission: 'closed', activatedAt: null, cleanup: { ownedCallbacksSettled: false } });
    expect(f.payloads).toHaveLength(0); expect(await f.app.submitInput({ ...f.request, clientSequence: 2 })).toMatchObject({ ok: false });
    finish(); await waitFor(async () => need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]?.state === 'disposed');
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]).toMatchObject({ instanceId: loading.instanceId, activatedAt: null });
    expect(f.payloads).toHaveLength(0);
  } finally { finish(); injected.mockRestore(); }
});

it.each(['shutdown', 'sdk-dispose'] as const)('[F12-16/17] preserves %s failure and retries only unfinished phases on the same UUID', async fault => {
  const f = fixture(); need(await f.adapter.prepare(f.sid, f.config, { timeoutMs: 1000, stopGraceMs: 1000 }, new AbortController().signal,
    { activeToolNames: ['check_invoice_sources'], extensions: f.freeze('p3') }));
  const runner = f.native().extensionRunner, id = need(f.adapter.inspectExtensions(f.sid)).instances[0]!.instanceId;
  let shutdowns = 0, disposals = 0;
  const originalEmit = runner.emit.bind(runner), originalDispose = f.native().dispose.bind(f.native());
  const emit = spyOn(runner, 'emit').mockImplementation(async event => {
    if (event.type === 'session_shutdown') { shutdowns++; if (fault === 'shutdown' && shutdowns === 1) throw new Error('Controlled shutdown failure'); }
    return originalEmit(event);
  });
  const sdk = spyOn(f.native(), 'dispose').mockImplementation(() => { disposals++; if (fault === 'sdk-dispose' && disposals === 1) throw new Error('Controlled SDK failure'); originalDispose(); });
  try {
    expect(need(await f.adapter.disposeExtensions(f.sid, id))).toMatchObject({ state: 'active', report: { stopped: true, closed: false } });
    expect(need(f.adapter.inspectExtensions(f.sid)).instances[0]).toMatchObject({ admission: 'closed', cleanup: { sdkDisposed: false, shutdownAcknowledged: fault === 'sdk-dispose' } });
    expect(need(await f.adapter.disposeExtensions(f.sid, id))).toMatchObject({ state: 'disposed', report: { closed: true } });
    const counts = { shutdowns, disposals };
    expect(need(await f.adapter.disposeExtensions(f.sid, id))).toMatchObject({ state: 'disposed', report: { closed: true } });
    expect({ shutdowns, disposals }).toEqual(counts);
    expect(shutdowns).toBe(fault === 'shutdown' ? 2 : 1); expect(disposals).toBe(fault === 'sdk-dispose' ? 2 : 1);
  } finally { emit.mockRestore(); sdk.mockRestore(); }
});

async function businessFixture(options: { sessionSetup?: (session: AgentSession) => void; beforePrepare?: () => Promise<void>; prepare?: (prepared: import('@flowmate/contracts').PreparedAgent) => void; trigger?: string; waitForResponse?: (request: Request) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p12-business-')), paths = need(resolveProductPaths(join(root, 'product')));
  const sourceRoot = join(root, 'source'), source = join(sourceRoot, '000001'); mkdirSync(source, { recursive: true });
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');
  const contents = { 'original.png': original, 'content.json': Buffer.from(JSON.stringify([{ type: 'text', text: 'Total 113.00', bbox: [0, 0, 1, 1], page_idx: 0 }])),
    'pages.json': Buffer.from(JSON.stringify([{ pageNumber: 1, text: 'Total 113.00', blockCount: 1 }])) };
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(join(source, name), bytes);
  writeFileSync(join(source, 'metadata.json'), JSON.stringify({ schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'p12-source', datasetRevision: 'p12-fixture', qualityStatus: 'complete', allowedUsesClaim: ['local test'], licenseVerification: 'not_verified',
    files: Object.entries(contents).map(([path, content]) => ({ path, bytes: content.length })) }));
  const payloads: any[] = []; let args: unknown;
  let settings = { revision: 7, selection: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] as import('@flowmate/contracts').ExtensionRef[] } };
  const resourceRoot = join(root, 'author'); mkdirSync(join(resourceRoot, 'extensions'), { recursive: true });
  copyFileSync(resolve(import.meta.dir, '../../resources/extensions/invoice-v1.json'), join(resourceRoot, 'extensions/invoice-v1.json'));
  copyFileSync(resolve(import.meta.dir, '../../resources/extensions/subagents-v1.json'), join(resourceRoot, 'extensions/subagents-v1.json'));
  if (options.trigger) { const seeded = need(openDatabase(paths)); seeded.db.exec(options.trigger); seeded.close(); }
  const server = await createHttpProvider(async request => {
    payloads.push(await request.json());
    if (options.waitForResponse) await options.waitForResponse(request);
    const delta = payloads.length === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'p12-check', type: 'function',
      function: { name: 'check_invoice_sources', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Sources verified.' };
    const chunk = (value: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'p12', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, payloads.length === 1 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }); deferCleanup(() => server.stop());
  const catalog = createExtensionService({ resourceRoot, sdkVersion: '0.85.1', registeredTools: [tool] });
  const selection = { enabledExtensions: [need(catalog.list())[0]!.ref] };
  settings.extensions = selection;
  let adapter!: PiAgentAdapter;
  const app = need(await createApplication({ paths, resourceRoot, invoiceSourceRoot: sourceRoot,
    resourceDefaults: () => ok(settings),
    agentFactory: (tools, resourceContents) => {
      adapter = new PiAgentAdapter({ resourceContents, cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools, sessionSetup: options.sessionSetup,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'p12-loopback-only' });
      if (options.prepare || options.beforePrepare) { const original = adapter.prepare.bind(adapter); adapter.prepare = async (...args) => { await options.beforePrepare?.(); const prepared = await original(...args); if (prepared.ok) options.prepare?.(prepared.data); return prepared; }; }
      return adapter;
    } }));
  deferCleanup(() => app.close());
  const doc = need(await app.importInvoiceMaterial(source)), session = need(await app.createSession());
  const page = need(await app.readDocumentPage({ documentId: doc.documentRef.id, page: 1, afterBlockId: null, limit: 10 }));
  args = { documentId: doc.documentRef.id, sources: [{ documentId: doc.documentRef.id, version: doc.documentRef.version,
    artifactId: doc.parsedArtifactId, page: 1, blockId: page.blocks[0]!.id, quote: 'Total 113.00' }] };
  need(await app.updateWorkspace({ expectedRevision: 0, change: { kind: 'session', sessionId: session.sessionId } }));
  const current = need(await app.updateWorkspace({ expectedRevision: 1, change: { kind: 'document', documentId: doc.documentRef.id } }));
  const config: ProviderConfig = { version: 1, name: 'P12', revision: 1, modelRef: { provider: 'p12', model: 'p12' }, native: { authPath: join(root, 'auth.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 16000 }, parameters: { maxRetries: 0, maxRetryDelayMs: 100 } };
  const request = { sessionId: session.sessionId, clientSequence: 1, mode: 'prompt' as const, text: 'Check the current invoice source', config,
    workspace: { revision: current.revision, sessionId: session.sessionId, documentRef: current.documentRef, jobId: current.jobId, candidateRef: current.candidateRef } };

  async function run(sequence = 1) {
    let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const done = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
    const accepted = need(await app.submitInput({ ...request, clientSequence: sequence }, { onEvent: event => { if (event.type === 'run_finished') finish(event); } }));
    return { accepted, terminal: await done };
  }
  return { root, paths, app, adapter, session, doc, request, selection, payloads, resourceRoot, run,
    args: () => structuredClone(args) as any,
    changeSelection(enabled: boolean) { settings = { ...settings, revision: settings.revision + 1, extensions: enabled ? selection : { enabledExtensions: [] } }; },
    changeArgs(value: unknown) { args = value; } };
}
it('[F12-04/08/12/23] fixes the Run choice and actual registration before invoice execution, native history and the next HTTP request', async () => {
  const f = await businessFixture(), { app, adapter, session, paths, request, selection, payloads } = f;
  const { accepted, terminal } = await f.run();
  expect(terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const saved = need(await app.queryRun(accepted.runId));
  expect(saved.config.extensions).toMatchObject({ settingsRevision: 7, selected: selection.enabledExtensions, included: [{ ref: selection.enabledExtensions[0] }] });
  expect(saved.config.extensionAssembly).toMatchObject({ instances: [{ nativeSessionId: session.nativeSessionId }] });
  expect(payloads).toHaveLength(2);
  const calls = need(await app.listRunToolCalls({ sessionId: session.sessionId, runId: accepted.runId }));
  expect(calls.items).toHaveLength(1);
  expect(calls.items[0]).toMatchObject({ status: 'succeeded', toolName: 'check_invoice_sources', deliveryState: 'request_observed' });
  expect(JSON.stringify(payloads[1])).toContain('check_invoice_sources');
  const history = need(adapter.exportSession(session.nativeSessionId));
  expect(history.entries.some(item => item.type === 'message' && item.message !== null && typeof item.message === 'object' && Reflect.get(item.message, 'role') === 'toolResult')).toBe(true);
  expect(need(adapter.inspectExtensions(session.nativeSessionId)).instances[0]?.state).toBe('active');
  const query = Reflect.get(app, 'querySessionExtensions'); expect(typeof query).toBe('function');
  const live = need(await query.call(app, { sessionId: session.sessionId })) as any;
  expect(live.instances[0].state).toBe('active');
  const historical = Reflect.get(app, 'queryRunExtensions'); expect(typeof historical).toBe('function');
  expect(need(await historical.call(app, { sessionId: session.sessionId, runId: accepted.runId }))).toMatchObject({
    frozen: saved.config.extensions, assembly: saved.config.extensionAssembly,
  });
  const command = Reflect.get(app, 'executeExtensionCommand'); expect(typeof command).toBe('function');
  expect(need(await command.call(app, { sessionId: session.sessionId, expectedInstanceId: live.instances[0].instanceId,
    name: 'invoice-assist', arguments: '' }))).toMatchObject({ instanceId: live.instances[0].instanceId, name: 'invoice-assist' });
  const dispose = Reflect.get(app, 'disposeSessionExtensions'); expect(typeof dispose).toBe('function');
  const disposed = need(await dispose.call(app, { sessionId: session.sessionId, expectedInstanceId: live.instances[0].instanceId }));
  expect(disposed).toMatchObject({ state: 'disposed', report: { stopped: true, closed: true } });
  expect(need(await dispose.call(app, { sessionId: session.sessionId, expectedInstanceId: live.instances[0].instanceId }))).toEqual(disposed);
  expect(need(await query.call(app, { sessionId: session.sessionId }))).toMatchObject({ instances: [{ state: 'disposed' }] });
  expect(await app.submitInput(request)).toEqual({ ok: true, data: accepted }); expect(payloads).toHaveLength(2);
  need(await app.close());
  const sql = new Database(paths.databaseFile, { readonly: true });
  try {
    const row = sql.query('SELECT result_json FROM tool_calls WHERE id=?').get(calls.items[0]!.toolCallId) as { result_json: string };
    expect(JSON.parse(row.result_json)).toMatchObject({ status: 'succeeded', data: { results: [{ status: 'valid' }] } });
    expect(sql.query('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(sql.query('SELECT count(*) AS n FROM session_inputs').get()).toEqual({ n: 1 });
  } finally { sql.close(); }

});

function changeHooks(change: (event: string, handler: (...args: any[]) => any, args: any[]) => unknown) {
  const original = invoiceExtension.createInvoiceAssistExtension;
  return spyOn(invoiceExtension, 'createInvoiceAssistExtension').mockImplementation(input => pi => original(input)(new Proxy(pi, {
    get(target, key) { return key === 'on' ? (event: string, handler: (...args: any[]) => any) => Reflect.apply(target.on, target,
      [event, (...args: any[]) => change(event, handler, args)]) : Reflect.get(target, key); },
  })));
}

it.each(['schema', 'document', 'artifact', 'version', 'block', 'quote', 'raw-id', 'raw-name'] as const)
  ('[F12-09] revalidates %s after real SDK Hook dispatch without overwriting the raw request', async fault => {
  const injected = changeHooks((event, handler, args) => {
    if (event === 'tool_call') {
      const input = args[0].input;
      if (fault === 'schema') input.unexpected = true;
      if (fault === 'document') input.documentId = 999;
      if (fault === 'artifact') input.sources[0].artifactId = 999;
      if (fault === 'version') input.sources[0].version = 'wrong-version';
      if (fault === 'block') input.sources[0].blockId = 'b9999';
      if (fault === 'quote') input.sources[0].quote = 'absent quote';
    }
    return handler(...args);
  });
  let reads = 0;
  const originalRead = DocumentService.prototype.readParsedForRun;
  const read = spyOn(DocumentService.prototype, 'readParsedForRun').mockImplementation(function(this: DocumentService, ...args) { reads++; return originalRead.apply(this, args); });
  try {
    const rawFault = fault.startsWith('raw-');
    const f = await businessFixture({ ...(rawFault ? { sessionSetup(session) {
      const before = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => { const result = await before?.(context, signal);
        if (fault === 'raw-id') context.toolCall.id = 'forged-call'; else context.toolCall.name = 'forged-tool'; return result; };
    } } : {}) });
    const { accepted, terminal } = await f.run();
    expect(terminal.result).toMatchObject({ ok: true, data: { status: rawFault ? 'failed' : 'completed', stopped: true,
      ...(rawFault ? { error: { code: 'extension_hook_failed' } } : {}) } });
    expect(reads).toBe(['version', 'block', 'quote'].includes(fault) ? 1 : 0);
    expect(f.payloads).toHaveLength(rawFault ? 1 : 2);
    if (['schema', 'document', 'artifact'].includes(fault))
      expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!.diagnostics).toContainEqual(expect.objectContaining({
        event: 'tool_call', code: fault === 'schema' ? 'input_invalid' : 'scope_invalid' }));
    need(await f.app.close());
    const sql = new Database(f.paths.databaseFile, { readonly: true });
    try {
      const row = sql.query('SELECT args_json,result_json,native_tool_call_id FROM tool_calls WHERE run_id=?').get(accepted.runId) as any;
      expect(row.native_tool_call_id).toBe('p12-check'); expect(JSON.parse(row.args_json).raw).toEqual(f.args());
      expect(JSON.parse(row.result_json)).toMatchObject(['version', 'block', 'quote'].includes(fault)
        ? { status: 'succeeded', data: { results: [{ status: 'invalid' }] } } : { status: rawFault ? 'cancelled' : 'failed' });
    } finally { sql.close(); }
  } finally { injected.mockRestore(); read.mockRestore(); }
});

it.each(['session_start', 'tool_call'] as const)('[F12-10] records a required %s failure before SDK error conversion can hide it', async event => {
  const injected = changeHooks((name, handler, args) => { if (name === event) throw new Error('Controlled critical Hook failure'); return handler(...args); });
  try {
    const f = await businessFixture(), { terminal } = await f.run();
    expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'extension_hook_failed' } } });
    expect(f.payloads).toHaveLength(event === 'session_start' ? 0 : 1);
    const view = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!;
    expect(view.admission).toBe('closed'); expect(view.diagnostics).toContainEqual(expect.objectContaining({ event, code: 'handler_failed' }));
  } finally { injected.mockRestore(); }
});

it.each(['tool_result', 'tool_execution_end'] as const)('[F12-11] contains a real %s observer error and preserves the saved result and next request', async event => {
  const injected = changeHooks((name, handler, args) => { if (name === event) throw new Error('Controlled observer failure'); return handler(...args); });
  try {
    const f = await businessFixture(), { terminal } = await f.run();
    expect(terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } }); expect(f.payloads).toHaveLength(2);
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]).toMatchObject({ state: 'active', admission: 'open',
      diagnostics: expect.arrayContaining([expect.objectContaining({ event, code: 'handler_failed' })]) });
    const feedback = f.payloads[1].messages.find((message: any) => message.role === 'tool');
    expect(JSON.parse(feedback.content)).toMatchObject({ results: [{ status: 'valid' }] });
  } finally { injected.mockRestore(); }
});

it('[F12-12] refuses altered Extension feedback after retaining the original ToolResult', async () => {
  const injected = changeHooks((name, handler, args) => {
    const result = handler(...args);
    if (name === 'tool_result') args[0].content[0].text = 'Forged feedback';
    return result;
  });
  try {
    const f = await businessFixture(), { accepted, terminal } = await f.run();
    expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true, error: { code: 'tool_feedback_conflict' } } });
    expect(f.payloads).toHaveLength(1); need(await f.app.close());
    const sql = new Database(f.paths.databaseFile, { readonly: true });
    try {
      const row = sql.query('SELECT status,result_json,delivery_json FROM tool_calls WHERE run_id=?').get(accepted.runId) as any;
      expect(row.status).toBe('succeeded'); expect(JSON.parse(row.result_json)).toMatchObject({ data: { results: [{ status: 'valid' }] } });
      expect(JSON.parse(row.delivery_json)).toMatchObject({ state: 'failed' });
    } finally { sql.close(); }
  } finally { injected.mockRestore(); }
});

it('[F12-23] preserves a failed Run with its fixed choice when actual proof cannot be saved and sends no HTTP', async () => {
  const f = await businessFixture({ trigger: "CREATE TRIGGER p12_proof_fault BEFORE UPDATE OF status ON runs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'controlled proof failure'); END;" });
  const { accepted, terminal } = await f.run();
  expect(terminal.result).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(need(await f.app.queryRun(accepted.runId)).status).toBe('failed');
  expect(f.payloads).toHaveLength(0);
  expect(need(await f.app.queryRunExtensions({ sessionId: f.session.sessionId, runId: accepted.runId }))).toMatchObject({
    frozen: { settingsRevision: 7, included: [{ ref: f.selection.enabledExtensions[0] }] }, assembly: null,
  });
});

it('[F12-23] rejects a genuine SDK proof whose instance ownership was changed before storage', async () => {
  const f = await businessFixture({ prepare(prepared) { Reflect.set(prepared.snapshot, 'extensionAssembly', {
    ...prepared.snapshot.extensionAssembly!, instances: [{ ...prepared.snapshot.extensionAssembly!.instances[0], nativeSessionId: 'forged-native-owner' }],
  }); } });
  const { terminal } = await f.run(); expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'agent_config_invalid' } } });
  expect(f.payloads).toHaveLength(0);
});

it('[F12-24] rejects inspected native identity that differs from the actual SQL Session owner', async () => {
  const f = await businessFixture(), inspect = f.adapter.inspectExtensions.bind(f.adapter);
  const altered = spyOn(f.adapter, 'inspectExtensions').mockImplementation(id => {
    const original = inspect(id); return original.ok ? ok({ ...original.data, nativeSessionId: 'forged-native-owner' }) : original;
  });
  try {
    expect(await f.app.querySessionExtensions({ sessionId: f.session.sessionId })).toMatchObject({ ok: false, error: { code: 'extension_instance_conflict' } });
    expect(f.payloads).toHaveLength(0);
  } finally { altered.mockRestore(); }
});

it('[F12-16/17/22] retains the product management gate after a swallowed shutdown Hook failure and retries the same owner', async () => {
  let shutdowns = 0;
  const injected = changeHooks((name, handler, args) => {
    if (name === 'session_shutdown' && ++shutdowns === 1) throw new Error('SDK emit catches this shutdown failure');
    return handler(...args);
  });
  try {
    const f = await businessFixture(); await f.run();
    const instance = need(await f.app.querySessionExtensions({ sessionId: f.session.sessionId })).instances[0]!;
    const request = { sessionId: f.session.sessionId, expectedInstanceId: instance.instanceId };
    expect(need(await f.app.disposeSessionExtensions(request))).toMatchObject({ state: 'active', report: { stopped: true, closed: false } });
    expect(need(await f.app.querySessionExtensions({ sessionId: f.session.sessionId })).instances[0]).toMatchObject({
      admission: 'closed', cleanup: { shutdownAcknowledged: false, sdkDisposed: false } });
    expect(await f.app.submitInput({ ...f.request, clientSequence: 2 })).toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(need(await f.app.disposeSessionExtensions(request))).toMatchObject({ state: 'disposed', report: { closed: true } });
    expect(shutdowns).toBe(2); expect(f.payloads).toHaveLength(2);
    expect(need(await f.app.disposeSessionExtensions(request))).toMatchObject({ report: { closed: true } }); expect(shutdowns).toBe(2);
  } finally { injected.mockRestore(); }
});

it('[F12-16] refuses cleanup while a real observer callback is pending and acknowledges only after settlement', async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { finish = resolve; });
  const injected = changeHooks(async (name, handler, args) => { if (name === 'tool_execution_end') { entered(); await barrier; } return handler(...args); });
  try {
    const f = await businessFixture(), running = f.run(); await started;
    const instance = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!;
    expect(instance.cleanup.ownedCallbacksSettled).toBe(false);
    expect(await f.adapter.releaseSession(f.session.nativeSessionId)).toMatchObject({ stopped: false, closed: false });
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]?.state).toBe('active');
    finish(); expect((await running).terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(need(await f.app.disposeSessionExtensions({ sessionId: f.session.sessionId, expectedInstanceId: instance.instanceId })))
      .toMatchObject({ state: 'disposed', report: { stopped: true, closed: true } });
  } finally { finish(); injected.mockRestore(); }
});

it.each(['throws', 'missing-receipt', 'stale-receipt'] as const)('[F12-21] cannot confirm a real command with %s and creates no Run or HTTP', async fault => {
  const original = invoiceExtension.createInvoiceAssistExtension;
  let firstTicket: unknown, calls = 0;
  const injected = spyOn(invoiceExtension, 'createInvoiceAssistExtension').mockImplementation(input => pi => original(input)(new Proxy(pi, {
    get(target, key) { return key === 'registerCommand' ? (name: string, options: any) => Reflect.apply(target.registerCommand, target,
      [name, { ...options, handler: async (...args: any[]) => {
        calls++; if (fault === 'throws') throw new Error('Controlled command failure');
        if (fault === 'missing-receipt') return;
        if (!firstTicket) { firstTicket = input.scope.getCommandTicket(); return options.handler(...args); }
        input.scope.writeCommandReceipt(firstTicket as any);
      } }]) : Reflect.get(target, key); },
  })));
  try {
    const f = await businessFixture(); await f.run();
    const instanceId = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!.instanceId;
    const request = { sessionId: f.session.sessionId, expectedInstanceId: instanceId, name: 'invoice-assist' as const, arguments: '' as const };
    if (fault === 'stale-receipt') expect((await f.app.executeExtensionCommand(request)).ok).toBe(true);
    expect(await f.app.executeExtensionCommand(request)).toMatchObject({ ok: false, error: { code: 'extension_command_failed' } });
    expect(calls).toBe(fault === 'stale-receipt' ? 2 : 1); expect(f.payloads).toHaveLength(2);
    expect(need(await f.app.listSessionRuns({ sessionId: f.session.sessionId })).items).toHaveLength(1);
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]).toMatchObject({ state: 'active', admission: 'open' });
  } finally { injected.mockRestore(); }
});

it('[F12-21/22] shares the command management barrier with Send, branch, fork, delete, compaction and close', async () => {
  let native!: AgentSession;
  const f = await businessFixture({ sessionSetup(session) { native = session; } }); await f.run();
  const getCommand = native.extensionRunner.getCommand.bind(native.extensionRunner);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { finish = resolve; });
  const command = spyOn(native.extensionRunner, 'getCommand').mockImplementation(name => {
    const registered = getCommand(name); return registered ? { ...registered, handler: async (...args) => { entered(); await barrier; return registered.handler(...args); } } : undefined;
  });
  const instanceId = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!.instanceId, sessionId = f.session.sessionId;
  const pending = f.app.executeExtensionCommand({ sessionId, expectedInstanceId: instanceId, name: 'invoice-assist', arguments: '' });
  try {
    await started;
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!.cleanup.ownedCallbacksSettled).toBe(false);
    const expected = { commitRevision: 0, entryCount: 0, leafId: null };
    const blocked = await Promise.all([
      f.app.submitInput({ ...f.request, clientSequence: 2 }),
      f.app.branchSession({ sessionId, expectedLeafId: null, expectedCommitRevision: 0, expectedEntryCount: 0, targetEntryId: 'unchanged' }),
      f.app.forkSession({ sourceSessionId: sessionId, expected, targetEntryId: 'unchanged', title: 'Blocked fork', clientOperationId: crypto.randomUUID() }),
      f.app.deleteSession(sessionId),
      f.app.compactSession({ sessionId, operationId: crypto.randomUUID(), expected, config: f.request.config }),
      f.app.disposeSessionExtensions({ sessionId, expectedInstanceId: instanceId }),
    ]);
    for (const result of blocked) { expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toMatch(/busy/); }
    expect(await f.adapter.close()).toMatchObject({ stopped: false, closed: false });
    finish(); expect(await pending).toMatchObject({ ok: true, data: { instanceId } }); expect(f.payloads).toHaveLength(2);
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!.cleanup.ownedCallbacksSettled).toBe(true);
  } finally { finish(); command.mockRestore(); }
});

it('[F12-15] changing future configuration during an actual Run never unloads its instance; Stop precedes release', async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { finish = resolve; });
  const f = await businessFixture({ waitForResponse: async () => { entered(); await barrier; } });
  let end!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
  const terminal = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { end = resolve; });
  const accepted = need(await f.app.submitInput(f.request, { onEvent(event) { if (event.type === 'run_finished') end(event); } }));
  try {
    await started; const original = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!; f.changeSelection(false);
    expect(need(await f.app.queryRunExtensions({ sessionId: f.session.sessionId, runId: accepted.runId })).frozen?.selected).toEqual(f.selection.enabledExtensions);
    expect(await f.app.disposeSessionExtensions({ sessionId: f.session.sessionId, expectedInstanceId: original.instanceId }))
      .toMatchObject({ ok: false, error: { code: 'session_busy' } });
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]).toMatchObject({ instanceId: original.instanceId, state: 'active', admission: 'open' });
    const cancelling = f.app.cancelRun(accepted.runId); finish(); need(await cancelling);
    expect((await terminal).result).toMatchObject({ ok: true, data: { status: 'cancelled', stopped: true } });
    expect(need(await f.app.disposeSessionExtensions({ sessionId: f.session.sessionId, expectedInstanceId: original.instanceId })))
      .toMatchObject({ state: 'disposed', report: { stopped: true, closed: true } });
    expect(f.payloads).toHaveLength(1);
  } finally { finish(); }
});

it('[F12-18/20] rebuilds on fixed resource or selection changes and rejects old callbacks or UUIDs without replaying history', async () => {
  let native!: AgentSession;
  const f = await businessFixture({ sessionSetup(session) { native = session; } }); await f.run();
  const old = native, first = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!;
  const prefix = need(f.adapter.exportSession(f.session.nativeSessionId)).entries;
  expect((await f.run(2)).terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  // The business Context has new derived resource paths for this Run, so its bundle legitimately rebuilds the Session.
  expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]?.instanceId).not.toBe(first.instanceId);
  f.changeSelection(false); expect((await f.run(3)).terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]?.state).toBe('disposed');
  expect(native.extensionRunner.getAllRegisteredTools()).toHaveLength(0);
  f.changeSelection(true); expect((await f.run(4)).terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  const next = need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]!;
  expect(next.instanceId).not.toBe(first.instanceId);
  expect(need(f.adapter.exportSession(f.session.nativeSessionId)).entries.slice(0, prefix.length)).toEqual([...prefix]);
  expect(await f.app.disposeSessionExtensions({ sessionId: f.session.sessionId, expectedInstanceId: first.instanceId }))
    .toMatchObject({ ok: false, error: { code: 'extension_instance_conflict' } });
  await old.extensionRunner.emit({ type: 'tool_execution_end', toolCallId: 'p12-check', toolName: 'check_invoice_sources', result: {}, isError: false });
  await old.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'p12-check', toolName: 'check_invoice_sources', input: f.args() }).catch(() => {});
  expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]).toEqual(next);
  expect(need(await f.app.listRunToolCalls({ sessionId: f.session.sessionId, runId: 1 })).items).toHaveLength(1);
  expect(f.payloads).toHaveLength(5);
});

it.each(['invalid-entry', 'missing'] as const)('[F12-19] rechecks %s metadata before a new Run and never silently falls back', async fault => {
  const f = await businessFixture(); await f.run();
  const metadata = join(f.resourceRoot, 'extensions/invoice-v1.json');
  const original = readFileSync(metadata);
  if (fault === 'missing') unlinkSync(metadata); else writeFileSync(metadata, original.toString().replace('invoice-assist-v1', 'untrusted-entry'));
  expect(await f.app.submitInput({ ...f.request, clientSequence: 2 })).toMatchObject({ ok: false, error: { code: 'extension_config_invalid' } });
  expect(f.payloads).toHaveLength(2);
  writeFileSync(metadata, original); expect((await f.run(2)).terminal.result).toMatchObject({ ok: true, data: { status: 'completed' } });
  expect(f.payloads).toHaveLength(3);
});

it('[F12-19] revalidates the admitted fixed manifest before actual SDK assembly', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  let sdkSessions = 0;
  const f = await businessFixture({ beforePrepare: async () => { entered(); await barrier; }, sessionSetup() { sdkSessions++; } });
  const pending = f.run();
  try {
    await started; unlinkSync(join(f.resourceRoot, 'extensions/invoice-v1.json')); release();
    const { accepted, terminal } = await pending;
    expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'extension_config_invalid' } } });
    expect(f.payloads).toHaveLength(0); expect(sdkSessions).toBe(0);
    expect(need(await f.app.queryRunExtensions({ sessionId: f.session.sessionId, runId: accepted.runId }))).toMatchObject({ frozen: { included: [{ ref: { id: 'invoice-assist' } }] }, assembly: null });
  } finally { release(); }
});

it('[F12-20] reuses the actual SDK instance when the fixed combination is identical, independently of settings revision', async () => {
  const f = fixture(), frozen = f.freeze('p3');
  const prepare = (extensions: typeof frozen) => f.adapter.prepare(f.sid, f.config, { timeoutMs: 1000, stopGraceMs: 1000 }, new AbortController().signal,
    { activeToolNames: ['check_invoice_sources'], extensions });
  need(await prepare(frozen)); const native = f.native(), first = need(f.adapter.inspectExtensions(f.sid)).instances[0]!;
  need(await prepare({ ...frozen, settingsRevision: 2 }));
  expect(f.native()).toBe(native); expect(need(f.adapter.inspectExtensions(f.sid)).instances[0]).toEqual(first);
});

it('rebuilds the native extension instance when only its frozen evaluation profile changes', async () => {
  const f = fixture(), frozen = f.freeze('p3');
  const prepare = (id: 'source-quote-trim' | 'source-check-denial') => f.adapter.prepare(f.sid, f.config,
    { timeoutMs: 1000, stopGraceMs: 1000 }, new AbortController().signal,
    { activeToolNames: ['check_invoice_sources'], extensions: { ...frozen, evaluationProfile: { id, version: 1 } } });
  need(await prepare('source-quote-trim'));
  const firstNative = f.native(), first = need(f.adapter.inspectExtensions(f.sid)).instances[0]!;
  need(await prepare('source-quote-trim'));
  expect(f.native()).toBe(firstNative); expect(need(f.adapter.inspectExtensions(f.sid)).instances[0]!.instanceId).toBe(first.instanceId);
  need(await prepare('source-check-denial'));
  expect(f.native()).not.toBe(firstNative); expect(need(f.adapter.inspectExtensions(f.sid)).instances[0]!.instanceId).not.toBe(first.instanceId);
});

it('[F12-10] requires an actual startup acknowledgement even when SDK emit returned normally', async () => {
  const injected = changeHooks((name, handler, args) => name === 'session_start' ? undefined : handler(...args));
  try {
    const f = await businessFixture(), { terminal } = await f.run();
    expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', error: { code: 'extension_load_failed' } } });
    expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]).toMatchObject({ state: 'disposed', activatedAt: null });
    expect(f.payloads).toHaveLength(0);
  } finally { injected.mockRestore(); }
});

it.each(['same-final', 'conflicting-final'] as const)('[F12-13/18] routes repeated %s through the original Executor and never performs another read', async fault => {
  let reads = 0, repeats = 0, native!: AgentSession;
  let originalOutcome: any, repeatedOutcome: any;
  const originalRead = DocumentService.prototype.readParsedForRun;
  const reading = spyOn(DocumentService.prototype, 'readParsedForRun').mockImplementation(function(this: DocumentService, ...args) { reads++; return originalRead.apply(this, args); });
  try {
    const f = await businessFixture({ sessionSetup(session) { native = session; }, prepare(prepared) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = (input, signal, observe) => execute({ ...input, toolBinding: { ...input.toolBinding!, execute: async (...call) => {
        const original = await input.toolBinding!.execute(...call); repeats++;
        const repeated = await input.toolBinding!.execute(call[0], fault === 'same-final' ? call[1] : { ...call[1] as object, unexpected: true }, call[2], call[3]);
        originalOutcome = original; repeatedOutcome = repeated;
        if (fault === 'same-final') return original;
        expect(repeated).toMatchObject({ fatal: true, result: { status: 'failed', error: { code: 'state_conflict' } } }); return repeated;
      } } }, signal, observe);
    } });
    const { accepted, terminal } = await f.run();
    expect(terminal.result).toMatchObject({ ok: true, data: { status: fault === 'same-final' ? 'completed' : 'failed', stopped: true } });
    // Stored ToolResult adds canonical version/committedCandidateId fields; the original outcome data is unchanged.
    if (fault === 'same-final') expect(repeatedOutcome.result).toMatchObject(originalOutcome.result);
    expect(reads).toBe(1); expect(repeats).toBe(1); expect(f.payloads).toHaveLength(fault === 'same-final' ? 2 : 1);
    const eventsRequest = { sessionId: f.session.sessionId, runId: accepted.runId, cursor: { runId: accepted.runId, lastPersistedSequence: 0 } };
    const before = await f.app.queryRuntimeEvents(eventsRequest); expect(before.ok).toBe(true);
    await native.extensionRunner.emit({ type: 'tool_execution_end', toolCallId: 'p12-check', toolName: 'check_invoice_sources', result: {}, isError: false });
    await native.extensionRunner.emit({ type: 'tool_execution_end', toolCallId: 'p12-check', toolName: 'check_invoice_sources', result: {}, isError: false });
    expect(await f.app.queryRuntimeEvents(eventsRequest)).toEqual(before);
    need(await f.app.close()); const sql = new Database(f.paths.databaseFile, { readonly: true });
    try { expect(sql.query('SELECT count(*) AS n FROM tool_calls').get()).toEqual({ n: 1 });
      expect(JSON.parse((sql.query('SELECT result_json FROM tool_calls').get() as any).result_json)).toMatchObject({ status: 'succeeded' }); }
    finally { sql.close(); }
  } finally { reading.mockRestore(); }
});

it('[F12-23] rolls back Run and Input admission together when the actual SQL receipt insert fails', async () => {
  const f = await businessFixture({ trigger: "CREATE TRIGGER p12_admission_fault BEFORE INSERT ON session_inputs BEGIN SELECT RAISE(ABORT,'controlled admission failure'); END;" });
  expect(await f.app.submitInput(f.request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(f.payloads).toHaveLength(0); expect(need(f.adapter.inspectExtensions(f.session.nativeSessionId)).instances[0]).toBeUndefined();
  need(await f.app.close()); const sql = new Database(f.paths.databaseFile, { readonly: true });
  try { for (const table of ['runs', 'session_inputs']) expect(sql.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 }); }
  finally { sql.close(); }
});

it.each(['tool-result', 'native-history'] as const)('[F12-12/23] stops before the next HTTP when actual %s persistence fails', async fault => {
  let reads = 0;
  const originalRead = DocumentService.prototype.readParsedForRun;
  const reading = spyOn(DocumentService.prototype, 'readParsedForRun').mockImplementation(function(this: DocumentService, ...args) { reads++; return originalRead.apply(this, args); });
  try {
    const trigger = fault === 'tool-result'
      ? "CREATE TRIGGER p12_tool_result_fault BEFORE UPDATE OF result_json ON tool_calls WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'controlled tool save failure'); END;"
      : "CREATE TRIGGER p12_history_fault BEFORE INSERT ON session_native_entries WHEN json_extract(NEW.entry_json,'$.message.role')='toolResult' BEGIN SELECT RAISE(ABORT,'controlled native save failure'); END;";
    const f = await businessFixture({ trigger }), { terminal } = await f.run();
    expect(terminal.result).toMatchObject({ ok: true, data: { status: 'failed', stopped: fault === 'native-history' } }); expect(reads).toBe(1); expect(f.payloads).toHaveLength(1);
    expect(await f.app.submitInput({ ...f.request, clientSequence: 2 })).toMatchObject({ ok: false }); expect(reads).toBe(1);
    need(await f.app.close()); const sql = new Database(f.paths.databaseFile, { readonly: true });
    try {
      const rows = sql.query('SELECT result_json FROM tool_calls').all() as any[]; expect(rows).toHaveLength(1);
      if (fault === 'native-history') expect(JSON.parse(rows[0].result_json)).toMatchObject({ status: 'succeeded', data: { results: [{ status: 'valid' }] } });
      else expect(rows[0].result_json).toBeNull();
    } finally { sql.close(); }
  } finally { reading.mockRestore(); }
});
