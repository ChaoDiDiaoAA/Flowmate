import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, defineTask, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { appError, fail, ok, PersonalAgentConfigurationSchema, type InvoiceWorkCreateRequest, type InvoiceWorkWorkingContext,
  type ProviderConfig, type Result } from '@flowmate/contracts';
import { InvoiceWorkCoordinator } from '../../../packages/core/src/personal-agent/coordination.ts';
import { DurableInvoiceGovernor } from '../../../packages/core/src/personal-agent/admission.ts';
import { InvoiceWorkService } from '../../../packages/core/src/personal-agent/invoice-work.ts';
import { InvoiceWorkModelService } from '../../../packages/core/src/personal-agent/models.ts';
import { InvoiceWorkPhaseContextService, InvoiceWorkPhaseObserver } from '../../../packages/core/src/personal-agent/phase-context.ts';
import { PersonalTasksService } from '../../../packages/core/src/personal-agent/tasks.ts';
import { createInvoiceWorkToolBridge } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools } from '@flowmate/employee-invoice';
import { buildInvoiceWorkContext, createDurableRuntime, createDurableSqliteStorage } from '@flowmate/runtime-durable';
import { toPiParameters } from '../../../packages/runtime-pi/src/schema.ts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
const now = () => new Date().toISOString();
const requireRuntime = createRequire(new URL('../../../packages/runtime-durable/package.json', import.meta.url));
const installedVersion = (name: string): string => JSON.parse(readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8')).version;
const sdk = { durable: installedVersion('@earendil-works/pi-durable'), ai: installedVersion('@earendil-works/pi-ai'), chord: installedVersion('@earendil-works/chord') };

async function fixture(mode: 'candidate' | 'no-candidate' | 'fail' | 'owned' | 'mixed' = 'candidate', thinkingLevel: 'off' | 'high' = 'off') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-coordination-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  let database = need(openTestDatabase(paths));
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'coordination-local-profile', thinkingLevel,
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    tools: ['read_invoice_document', 'save_invoice_candidate'], workingDirectory: null, preferences: '' });
  await database.transaction(scope => {
    need(scope.personalAgents.ensureDefault(configuration, now()));
    for (const documentId of mode === 'mixed' ? Array.from({ length: 15 }, (_, index) => index + 1) : [1, 2]) {
      const originalId = documentId * 2 - 1, parsedId = documentId * 2;
      const original = Buffer.from('Controlled original invoice');
      let sourceText = `Invoice INV-${documentId}; Date 2026-10-29; Seller Original Seller; Buyer ${documentId >= 8 && documentId <= 10 ? '[missing]' : 'Buyer Alpha'}; Currency CNY; Net 100.00; Tax 13.00; Total ${documentId === 13 ? '114.00' : '113.00'}; Seller tax ID-A`;
      if (documentId === 15) sourceText = 'Invoice INV-15; Date 2026-10-29; Seller Original Seller; Buyer Buyer Alpha; Currency CNY; Net 44.00; Tax 0.00; Total 44.00; Line 1 quantity 2 unit 10.00 net 19.00; Line 2 quantity 3 unit 10.00 net 25.00';
      const parsed = Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1,
        blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'synthetic', bbox: null },
          ...(documentId >= 11 ? [{ id: 'b2', kind: 'text', text: documentId === 14 ? 'Seller tax ID-B' : 'Buyer Beta', sourceIndex: 1, sourceType: 'synthetic', bbox: null }] : [])] }],
        completeness: { status: 'complete', checks: [], warnings: [] } }));
      for (const [artifactId, name, content] of [[originalId, 'original.pdf', original], [parsedId, 'parsed.json', parsed]] as const) {
        mkdirSync(join(paths.artifactsDir, String(artifactId)), { recursive: true });
        writeFileSync(join(paths.artifactsDir, String(artifactId), name), content);
        scope.contents.remember({ ownerKind: 'artifact', ownerId: String(artifactId), relativePath: name }, content);
      }
      const metadata = { version: 1 as const, sourceKey: 'coordination', sourceRecordId: String(documentId), sourceVersion: 'v1' }, at = now();
      need(scope.documents.register({ documentId, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId, version: 'v1',
        originalArtifact: { artifactId: originalId, kind: 'original', relativePath: `artifacts/${originalId}/original.pdf`, bytes: original.length,
          mimeType: 'application/pdf', metadata: { ...metadata, files: [{ relativePath: 'original.pdf', bytes: original.length, mimeType: 'application/pdf' }] }, createdAt: at },
        parsedArtifact: { artifactId: parsedId, kind: 'parsed', relativePath: `artifacts/${parsedId}/parsed.json`, bytes: parsed.length,
          mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: parsed.length, mimeType: 'application/json' }] }, createdAt: at },
        status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled coordinator integration'],
          licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
    }
  });
  const requests: InvoiceWorkWorkingContext[] = [];
  const wireRequests: Array<Record<string, unknown>> = [];
  const owned = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), closed: Promise.withResolvers<void>() };
  deferCleanup(() => owned.release.resolve());
  let held: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    wireRequests.push(body);
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as InvoiceWorkWorkingContext;
    requests.push(context);
    if (held) { const original = held; held = null; original.entered.resolve(); await original.release.promise; }
    if (mode === 'fail') return new Response('Controlled transport failure.', { status: 503 });
    const ordinal = body.messages.filter(message => message.role === 'tool').length;
    const documentId = context.item.documentRef.id, candidate = invoiceWorkCandidateDraft();
    const source = (quote: string, blockId = 'b1') => ({ documentId, version: 'v1', artifactId: documentId * 2, page: 1, blockId, quote });
    for (const [field, value] of Object.entries({ invoiceNumber: `INV-${documentId}`, issueDate: '2026-10-29', sellerName: 'Original Seller',
      buyerName: 'Buyer Alpha', currency: 'CNY', netAmount: '100.00', taxAmount: '13.00', totalAmount: documentId === 13 ? '114.00' : '113.00' })) {
      candidate.fields[field as keyof typeof candidate.fields] = { raw: value, normalized: value, state: 'present', alternatives: [], sources: [source(value)] };
    }
    if (mode === 'mixed' && documentId >= 8 && documentId <= 10) candidate.fields.buyerName = {
      raw: null, normalized: null, state: 'missing', alternatives: [], sources: [source('Buyer [missing]')] };
    if (mode === 'mixed' && documentId >= 11 && documentId <= 12) candidate.fields.buyerName = { raw: 'Buyer Alpha / Buyer Beta', normalized: null,
      state: 'ambiguous', alternatives: ['Buyer Alpha', 'Buyer Beta'], sources: [source('Buyer Alpha'), source('Buyer Beta', 'b2')] };
    if (mode === 'mixed' && documentId === 14) {
      candidate.fields.sellerTaxId = { raw: 'ID-A / ID-B', normalized: null, state: 'ambiguous', alternatives: ['ID-A', 'ID-B'],
        sources: [source('Seller tax ID-A'), source('Seller tax ID-B', 'b2')] };
      candidate.notes = ['A model note cannot decide the original invoice disposition.'];
    }
    if (mode === 'mixed' && documentId === 15) {
      for (const [name, value] of Object.entries({ netAmount: '44.00', taxAmount: '0.00', totalAmount: '44.00' }))
        candidate.fields[name as keyof typeof candidate.fields] = { raw: value, normalized: value, state: 'present', alternatives: [], sources: [source(value)] };
      const missing = { raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] };
      candidate.lines = ([['2', '19.00'], ['3', '25.00']] as const).map(([quantity, netAmount]) => ({ description: missing, unit: missing,
        quantity: { raw: quantity, normalized: quantity, state: 'present', alternatives: [], sources: [source('quantity ' + quantity)] },
        unitPrice: { raw: '10.00', normalized: '10.00', state: 'present', alternatives: [], sources: [source('unit 10.00')] },
        netAmount: { raw: netAmount, normalized: netAmount, state: 'present', alternatives: [], sources: [source('net ' + netAmount)] },
        taxRate: missing, taxAmount: missing, totalAmount: missing }));
    }
    let tool: { name: string; arguments: unknown } | null = null;
    if (mode !== 'no-candidate' && ordinal === 0) {
      if (mode === 'mixed') tool = { name: 'save_invoice_candidate', arguments: { documentId, candidate } };
      else tool = { name: 'read_invoice_document', arguments: { documentId, page: 1, afterBlockId: null, limit: 10 } };
    } else if (mode !== 'no-candidate' && mode !== 'mixed' && ordinal === 1) tool = { name: 'save_invoice_candidate', arguments: { documentId, candidate } };
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `coordinator-wire-${requests.length}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: 'Original phase completed for human review.' };
    const chunk = { id: `coordinator-model-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'coordination-local-model',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const provider: ProviderConfig = { version: 1, name: configuration.modelId!, revision: 1,
    modelRef: { provider: 'controlled-coordinator', model: 'coordination-local-model' }, native: { authPath: 'unused-auth.json', modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 64000, maxTokens: 8192, reasoning: thinkingLevel !== 'off' },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  let foreground = true;
  const errors: string[] = [];
  async function connect() {
  const governor = new DurableInvoiceGovernor(database, now, () => foreground);
  const contexts = new InvoiceWorkPhaseContextService({ database, now, buildContext: buildInvoiceWorkContext });
  const files = createFileStore(paths, database), documents = createDocumentService({ paths, files, allowedSourceRoot: root, now,
    transaction: operation => database.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const definitions = createInvoiceTools({ documents: { readParsedForRun: (id, context) => database.read(scope =>
    documents.readParsedForRun(id, context, { repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) },
    documentRepository: { get: id => database.read(scope => scope.documents.get(id)) },
    candidates: { save: input => database.transaction(scope => scope.candidates.save(input)),
      listForRun: input => database.read(scope => scope.candidates.listForRun(input)),
      readForRun: input => database.read(scope => scope.candidates.readForRun(input)) }, now });
  const bridge = createInvoiceWorkToolBridge({ database, executor: createToolExecutor({ database, definitions, now }) });
  let observer: InvoiceWorkPhaseObserver, coordinator: InvoiceWorkCoordinator;
  const registry = createRegistry();
  if (mode === 'owned') {
    const background = defineTask<Record<string, never>, { phase: 'wait' }, null>({ name: 'test.coordinator-owned-task', version: 1,
      initial: () => ({ phase: 'wait' }), phases: { wait: async (_task, api, context) => {
        owned.entered.resolve(); await Promise.race([owned.release.promise, new Promise<void>(resolve => {
          if (api.signal.aborted) resolve(); else api.signal.addEventListener('abort', () => resolve(), { once: true });
        })]);
        if (api.signal.aborted) return;
        await api.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context); owned.closed.resolve();
      } }, abort: async (_task, api, context) => {
        await api.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context); owned.closed.resolve();
      } });
    registry.install({ name: 'test-coordinator-owned', tasks: [background], tools: [defineTool({ name: 'read_invoice_document',
      description: 'Read the original invoice while its owned evidence Task remains active.', parameters: Type.Object({ documentId: Type.Integer(),
        page: Type.Integer(), afterBlockId: Type.Null(), limit: Type.Integer() }), replay: 'safe', execute: async (_args, api, context) => {
        await api.commit(async tx => {
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
          await tx.createTask(background, {}, { conversationId: child.id, ownership: { kind: 'conversation' }, background: true });
        }, context);
        return { output: [{ type: 'text', text: 'An original owned evidence Task is pending.' }], control: { terminate: true } };
      } })] });
  }
  const runtime = need(await createDurableRuntime({ storage: await createDurableSqliteStorage(database.coordinator), registry,
    onChanged: () => coordinator?.wake(),
    readApiKey: () => 'controlled-local-key', verifyModelUse: input => governor.verifyModelUse(input), reserveModelRequest: input => governor.reserveModelRequest(input),
    readWorkingContext: input => contexts.get(input), verifyWorkingContext: input => contexts.verify(input),
    tools: mode === 'owned' ? [] : definitions.filter(tool => configuration.tools.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description,
      executionMode: tool.executionMode, inputSchema: { ...toPiParameters(tool.inputSchema) } })),
    executeTool: async input => {
      const reconciled = await observer.reconcile({ workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId, requestId: input.requestId });
      return reconciled.ok ? bridge.executeTool(input) : reconciled;
    }, readToolResult: input => bridge.readToolResult(input), onToolFeedback: input => bridge.onToolFeedback(input) }));
  observer = new InvoiceWorkPhaseObserver({ database, runtime, now });
  const models = new InvoiceWorkModelService({ database, runtime, now, resolveConfiguration: () => ok(provider) });
  const tasks = new PersonalTasksService({ database, runtime, now, phaseObserver: observer, restoreAttempt: async identity => {
    const phase = await database.read(scope => scope.db.query<{ request_id: string }, [number]>(
      'SELECT request_id FROM invoice_work_phases WHERE attempt_id=? ORDER BY id DESC LIMIT 1').get(identity.attemptId));
    return phase ? models.restore({ ...identity, requestId: phase.request_id }) : ok(undefined);
  }, verifyModelUse: identity => governor.verifyModelUse(identity), onChanged: () => coordinator.wake() });
  coordinator = new InvoiceWorkCoordinator({ database, runtime, modelService: models, contexts, phaseObserver: observer, governor, tasks,
    now, sdk, verifyResources: () => ok(undefined), onError: error => errors.push(error.code) });
  const service = new InvoiceWorkService({ database, now, assessExecution: input => governor.assess(input), onChanged: () => coordinator.wake(),
    ...(mode === 'mixed' ? { runtimeDefaults: () => ok({ budget: { maxModelCalls: 32, maxToolCalls: 100 }, timeoutMs: 300000 }) } : {}) });
  deferCleanup(async () => { owned.release.resolve(); const quiescing = coordinator.close(); need(await runtime.close()); need(await quiescing); });
  return { governor, contexts, models, observer, runtime, coordinator, service, tasks };
  }
  let connection = await connect();
  const create = (requestId: string, documentIds = [1, 2]) => {
    const request: InvoiceWorkCreateRequest = { personalAgentId: 1, expectedAgentRevision: 0, requestId, goal: 'Prepare each fixed invoice for human review.',
      documents: documentIds.map(id => ({ id, version: 'v1' })) };
    return connection.service.create(request).then(need);
  };
  const work = async (workId: number) => {
    const page = need(await connection.service.get({ view: 'work', workId, limit: 100 }));
    if (page.view !== 'work') throw Error('Expected fixed invoice members.'); return page;
  };
  const start = async () => { foreground = false; connection.coordinator.wake(); need(await connection.coordinator.drain()); };
  const item = async (workId: number, itemId: number) => {
    const page = need(await connection.service.get({ view: 'item', workId, itemId, limit: 100 }));
    if (page.view !== 'item') throw Error('Expected an original invoice item.'); return page;
  };
  const supplement = async (workId: number, requestId: string, text: string) => {
    const selected = (await work(workId)).items[0]!, current = await item(workId, selected.itemId), todo = current.todos[0];
    if (!todo) throw Error('Expected the original human Todo.');
    const request = { workId, itemId: selected.itemId, todoId: todo.todoId, requestId, expectedRevision: current.work.revision, text, materials: [] };
    return { request, receipt: need(await connection.service.supplement(request)) };
  };
  const holdNext = () => { const original = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    held = original; deferCleanup(() => original.release.resolve()); return original; };
  const restart = async () => {
    const quiescing = connection.coordinator.close(); need(await connection.runtime.close()); need(await quiescing);
    await database.close(); database = need(openTestDatabase(paths)); connection = await connect();
  };
  return { get database() { return database; }, paths, configuration, provider, get governor() { return connection.governor; },
    get contexts() { return connection.contexts; }, get models() { return connection.models; }, get observer() { return connection.observer; },
    get runtime() { return connection.runtime; }, get coordinator() { return connection.coordinator; },
    get service() { return connection.service; }, get tasks() { return connection.tasks; }, requests, wireRequests, owned, errors, create, work, item, supplement, start, restart, holdNext };
}

test('a saved candidate with an unavailable required field creates an original field and source bound supplement Todo', async () => {
  const f = await fixture('mixed'), created = await f.create('missing-original-buyer', [8]); await f.start();
  const work = await f.work(created.workId), selected = work.items[0]!, current = await f.item(created.workId, selected.itemId);
  expect(work.work).toMatchObject({ status: 'open', counts: { unresolved: 1 }, execution: { runStatus: 'completed' } });
  expect(current.todos).toHaveLength(1);
  expect(current.todos[0]).toMatchObject({ actor: 'user', action: 'supplement', fieldPath: 'fields.buyerName', applicable: true,
    problem: 'Required header field buyerName is missing.', needed: expect.stringContaining('fields.buyerName'),
    satisfiedBy: expect.stringContaining('candidate'), basis: { origin: 'rule', documentRefs: [{ id: 8, version: 'v1' }],
      sourceRefs: [{ documentId: 8, version: 'v1', artifactId: 16, page: 1, blockId: 'b1' }], inputIds: [], candidateRef: selected.candidateRef } });
  const writes = await f.database.read(scope => scope.db.query('SELECT total_changes() count').get());
  for (let index = 0; index < 3; index++) { expect(await f.item(created.workId, selected.itemId)).toEqual(current);
    need(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'missing-original-buyer' })); }
  expect(await f.database.read(scope => scope.db.query('SELECT total_changes() count').get())).toEqual(writes);
  expect(f.requests).toHaveLength(2); expect(f.errors).toEqual([]);
}, 15_000);

test('seven reviews, three original field supplements and two source conflicts coexist without closing invoice business or blocking another item', async () => {
  const f = await fixture('mixed'), other = await f.create('already-disposed-work', [1]); await f.start();
  const previous = await f.work(other.workId);
  need(await f.service.disposeItem({ workId: other.workId, itemId: previous.items[0]!.itemId, requestId: 'original-exclusion',
    expectedRevision: previous.work.revision, decision: { kind: 'excluded', reason: 'Explicitly excluded before the mixed Work.' } }));
  const disposed = await f.work(other.workId), created = await f.create('mixed-twelve-originals', Array.from({ length: 12 }, (_, index) => index + 1));
  await f.start(); const page = await f.work(created.workId), itemPages = await Promise.all(page.items.map(item => f.item(created.workId, item.itemId)));
  expect(page.work).toMatchObject({ status: 'open', counts: { total: 12, unresolved: 12 }, execution: { runStatus: 'completed', stopUnconfirmed: false } });
  expect(page.items.every(item => item.disposition === 'unresolved' && item.candidateRef !== null)).toBe(true);
  expect(itemPages.map(item => item.todos.length)).toEqual(Array(12).fill(1));
  expect(itemPages.slice(0, 7).map(item => ({ action: item.todos[0]!.action, fieldPath: item.todos[0]!.fieldPath })))
    .toEqual(Array.from({ length: 7 }, () => ({ action: 'review', fieldPath: null })));
  expect(itemPages.slice(7, 10).map(item => ({ action: item.todos[0]!.action, fieldPath: item.todos[0]!.fieldPath })))
    .toEqual(Array.from({ length: 3 }, () => ({ action: 'supplement', fieldPath: 'fields.buyerName' })));
  for (const item of itemPages.slice(10)) expect(item.todos[0]).toMatchObject({ action: 'review', fieldPath: 'fields.buyerName',
    problem: 'Required header field buyerName is ambiguous.', basis: { candidateRef: item.item.candidateRef,
      sourceRefs: [{ documentId: item.item.documentRef.id, version: 'v1', artifactId: item.item.documentRef.id * 2, page: 1, blockId: 'b1' },
        { documentId: item.item.documentRef.id, version: 'v1', artifactId: item.item.documentRef.id * 2, page: 1, blockId: 'b2' }] } });
  expect(f.requests.filter(request => request.work.workId === created.workId)).toHaveLength(24);
  expect((await f.governor.assess(created.workId))).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  expect(await f.work(other.workId)).toEqual(disposed);
  const writes = await f.database.read(scope => scope.db.query('SELECT total_changes() count').get());
  for (let index = 0; index < 3; index++) expect(await f.work(created.workId)).toEqual(page);
  expect(await f.database.read(scope => scope.db.query('SELECT total_changes() count').get())).toEqual(writes);
  expect(f.errors).toEqual([]);
}, 30_000);

test('a legally saved arithmetic conflict retains its original rule and field sources for human review', async () => {
  const f = await fixture('mixed'), created = await f.create('original-header-conflict', [13]); await f.start();
  const page = await f.work(created.workId), selected = page.items[0]!, current = await f.item(created.workId, selected.itemId);
  const original = need(await f.database.read(scope => scope.candidates.readByJob({ jobId: selected.jobId!, candidateId: selected.candidateRef!.id })));
  expect(original.candidate).toMatchObject({ status: 'generated', checks: expect.arrayContaining([{ rule: 'header-total', version: '1', status: 'failed',
    fieldPaths: ['/fields/netAmount', '/fields/taxAmount', '/fields/totalAmount'], actual: '114.00', expected: '113.00', difference: '1.00', tolerance: '0.01', reason: null }]),
    issues: expect.arrayContaining([{ code: 'header_total_mismatch', severity: 'error', origin: 'rule', fieldPaths: ['/fields/netAmount', '/fields/taxAmount', '/fields/totalAmount'],
      message: 'header-total differs from its calculated value.', rule: 'header-total' }]) });
  expect(current.todos).toHaveLength(1);
  expect(current.todos[0]).toMatchObject({ action: 'review', fieldPath: 'fields.totalAmount', problem: 'header-total differs from its calculated value.',
    needed: expect.stringContaining('113.00'), basis: { candidateRef: selected.candidateRef,
      sourceRefs: [{ documentId: 13, version: 'v1', artifactId: 26, page: 1, blockId: 'b1' }] } });
  expect(page.work).toMatchObject({ status: 'open', counts: { unresolved: 1 }, execution: { runStatus: 'completed' } });
  expect(f.requests).toHaveLength(2); expect(f.errors).toEqual([]);
}, 15_000);

test('two saved line conflicts using the same rule retain their own actual and expected amounts', async () => {
  const f = await fixture('mixed'), created = await f.create('two-original-line-conflicts', [15]); await f.start();
  const page = await f.work(created.workId), selected = page.items[0]!, current = await f.item(created.workId, selected.itemId);
  const saved = need(await f.database.read(scope => scope.candidates.readByJob({ jobId: selected.jobId!, candidateId: selected.candidateRef!.id })));
  expect(saved.candidate.checks.filter(check => check.rule === 'line-net')).toEqual([
    { rule: 'line-net', version: '1', status: 'failed', fieldPaths: ['/lines/0/quantity', '/lines/0/unitPrice', '/lines/0/netAmount'],
      actual: '19.00', expected: '20.00', difference: '-1.00', tolerance: '0.01', reason: null },
    { rule: 'line-net', version: '1', status: 'failed', fieldPaths: ['/lines/1/quantity', '/lines/1/unitPrice', '/lines/1/netAmount'],
      actual: '25.00', expected: '30.00', difference: '-5.00', tolerance: '0.01', reason: null }]);
  expect(current.todos).toHaveLength(2);
  expect(current.todos.map(todo => ({ fieldPath: todo.fieldPath, needed: todo.needed }))).toEqual([
    { fieldPath: 'lines.0.netAmount', needed: 'Review the original invoice amounts for lines.0.netAmount: saved 19.00; line-net expects 20.00.' },
    { fieldPath: 'lines.1.netAmount', needed: 'Review the original invoice amounts for lines.1.netAmount: saved 25.00; line-net expects 30.00.' }]);
  expect(current.todos.every(todo => todo.action === 'review' && todo.applicable)).toBe(true);
  expect(page.work).toMatchObject({ status: 'open', counts: { unresolved: 1 }, execution: { runStatus: 'completed' } });
  expect(f.requests).toHaveLength(2); expect(f.errors).toEqual([]);
}, 15_000);

test('a source ambiguity in an optional field remains a concrete human Todo even without a required-header issue or model authority', async () => {
  const f = await fixture('mixed'), created = await f.create('original-optional-ambiguity', [14]); await f.start();
  const page = await f.work(created.workId), current = await f.item(created.workId, page.items[0]!.itemId);
  expect(current.todos).toHaveLength(1);
  expect(current.todos[0]).toMatchObject({ actor: 'user', action: 'review', fieldPath: 'fields.sellerTaxId',
    problem: 'The saved invoice field fields.sellerTaxId is ambiguous.', basis: { origin: 'rule',
      sourceRefs: [{ documentId: 14, version: 'v1', artifactId: 28, page: 1, blockId: 'b1' },
        { documentId: 14, version: 'v1', artifactId: 28, page: 1, blockId: 'b2' }] } });
  expect(page.work).toMatchObject({ status: 'open', counts: { unresolved: 1 }, execution: { runStatus: 'completed' } });
  expect(f.requests).toHaveLength(2); expect(f.errors).toEqual([]);
}, 15_000);

test('two original supplements remain linked while a new closed phase rechecks the still missing field instead of treating input receipt as resolution', async () => {
  const f = await fixture('mixed'), created = await f.create('recheck-original-missing-buyer', [8]); await f.start();
  const first = (await f.work(created.workId)).items[0]!, before = await f.item(created.workId, first.itemId), originalTodo = before.todos[0]!;
  const definition = await f.database.read(scope => scope.db.query<{ definition_json: string }, [number]>(
    'SELECT definition_json FROM invoice_work_todos WHERE id=?').get(originalTodo.todoId)!.definition_json);
  const gate = f.holdNext(), one = await f.supplement(created.workId, 'first-original-buyer-clarification', 'Please preserve this original clarification.');
  await gate.entered.promise;
  const pending = await f.item(created.workId, first.itemId);
  expect(pending.todos[0]).toMatchObject({ todoId: originalTodo.todoId, applicable: true, action: 'supplement', fieldPath: 'fields.buyerName' });
  const two = await f.supplement(created.workId, 'second-original-buyer-clarification', 'A second original clarification while the first is active.');
  expect(one.receipt.todoId).toBe(originalTodo.todoId); expect(two.receipt.todoId).toBe(originalTodo.todoId);
  gate.release.resolve(); need(await f.coordinator.drain());
  const after = await f.item(created.workId, first.itemId);
  expect(after.todos).toHaveLength(1); expect(after.todos[0]!.todoId).not.toBe(originalTodo.todoId);
  expect(after.todos[0]).toMatchObject({ action: 'supplement', fieldPath: 'fields.buyerName', problem: 'Required header field buyerName is missing.', applicable: true,
    basis: { candidateRef: after.item.candidateRef, inputIds: [two.receipt.inputId], sourceRefs: originalTodo.basis.sourceRefs } });
  expect(after.work).toMatchObject({ status: 'open', counts: { unresolved: 1 }, execution: { runStatus: 'completed' } });
  expect(need(await f.service.queryOperation({ operation: 'supplement', workId: created.workId, requestId: one.request.requestId }))).toEqual(one.receipt);
  expect(need(await f.service.queryOperation({ operation: 'supplement', workId: created.workId, requestId: two.request.requestId }))).toEqual(two.receipt);
  expect(await f.database.read(scope => scope.db.query('SELECT definition_json,superseded_at FROM invoice_work_todos WHERE id=?').get(originalTodo.todoId)))
    .toEqual({ definition_json: definition, superseded_at: expect.any(String) });
  expect(f.requests[2]!.userInputs.map(input => input.inputId)).toEqual([one.receipt.inputId]);
  const original = f.requests[2]!, retained = f.requests.slice(2).filter(context => context.phase.phaseId === original.phase.phaseId),
    successor = f.requests.slice(2).filter(context => context.phase.phaseId !== original.phase.phaseId);
  expect(retained.length).toBeGreaterThan(1); for (const context of retained) expect(context).toEqual(original);
  expect(successor.length).toBeGreaterThan(0);
  for (const context of successor) expect(context.userInputs.map(input => input.inputId)).toEqual([two.receipt.inputId]);
  const writes = await f.database.read(scope => scope.db.query('SELECT total_changes() count').get());
  const calls = f.requests.length;
  for (let index = 0; index < 3; index++) expect(await f.item(created.workId, first.itemId)).toEqual(after);
  expect(await f.database.read(scope => scope.db.query('SELECT total_changes() count').get())).toEqual(writes);
  expect(f.requests).toHaveLength(calls); expect(f.errors).toEqual([]);
}, 20_000);

test('persisted create notifications drive the real SDK through read/save, release human review and admit the next Work in creation order', async () => {
  const f = await fixture(), first = await f.create('first-work'), second = await f.create('second-work', [2]);
  await f.database.transaction(scope => scope.db.query('UPDATE invoice_works SET created_at=?').run(first.receivedAt));
  expect(f.requests).toHaveLength(0);
  await f.start();
  expect(f.requests.map(request => request.work.workId)).toEqual([first.workId, first.workId, first.workId,
    first.workId, first.workId, first.workId, second.workId, second.workId, second.workId]);
  expect(f.requests.map(request => request.item.documentRef.id)).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 2]);
  expect((await f.work(first.workId)).items.every(item => item.candidateRef !== null && item.disposition === 'unresolved')).toBe(true);
  expect((await f.work(first.workId)).work.status).toBe('open');
  const facts = await f.database.read(scope => ({ runs: scope.db.query('SELECT status,job_id,stopped_at FROM runs ORDER BY id').all(),
    phases: scope.db.query('SELECT consumed_at,closed_at FROM invoice_work_phases ORDER BY id').all(),
    attempts: scope.db.query('SELECT stopped_at FROM invoice_work_attempts ORDER BY id').all(),
    candidates: scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get(),
    snapshots: scope.db.query('SELECT COUNT(*) count FROM invoice_work_context_snapshots').get() }));
  expect(facts.runs).toEqual([expect.objectContaining({ status: 'completed', job_id: null, stopped_at: expect.any(String) }),
    expect.objectContaining({ status: 'completed', job_id: null, stopped_at: expect.any(String) })]);
  expect(facts.phases).toHaveLength(3); expect(facts.phases.every(phase => phase.consumed_at !== null && phase.closed_at !== null)).toBe(true);
  expect(facts.attempts.every(attempt => attempt.stopped_at !== null)).toBe(true);
  expect(facts.candidates).toEqual({ count: 3 }); expect(facts.snapshots).toEqual({ count: 3 }); expect(f.errors).toEqual([]);
}, 20_000);

test('one invoice waiting for clarification does not block another fixed invoice, and a phase without business progress never polls the model', async () => {
  const f = await fixture('no-candidate'), created = await f.create('needs-material');
  const first = (await f.work(created.workId)).items[0]!;
  need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: created.workId, itemId: first.itemId,
    expectedRevision: first.revision, at: now(), todos: [{ actor: 'user', action: 'supplement', fieldPath: null,
      problem: 'Original material is incomplete.', needed: 'Supply original invoice clarification.', satisfiedBy: 'The original clarification is saved.',
      basis: { origin: 'rule', documentRefs: [first.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] })));
  await f.start();
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.item.documentRef.id).toBe(2);
  for (let index = 0; index < 3; index++) { await f.work(created.workId); need(await f.service.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'needs-material' })); }
  f.coordinator.wake(); need(await f.coordinator.drain()); expect(f.requests).toHaveLength(1);
  expect((await f.work(created.workId)).work.execution.runStatus).toBe('completed');
}, 15_000);

test('an explicit continue authorizes one phase per waiting invoice without a second automatic model loop', async () => {
  const f = await fixture('no-candidate'), created = await f.create('explicit-continue', [1]);
  await f.start(); const before = await f.work(created.workId);
  const receipt = need(await f.service.continueWork({ workId: created.workId, requestId: 'continue-original-work',
    expectedRevision: before.work.revision, expectedAttemptId: before.work.execution.attempt!.attemptId }));
  expect(receipt.execution).toMatchObject({ authorizationAccepted: true, relation: 'new' });
  need(await f.coordinator.drain()); expect(f.requests).toHaveLength(2);
  f.coordinator.wake(); need(await f.coordinator.drain()); expect(f.requests).toHaveLength(2);
}, 15_000);

test('cold recovery admits a persisted queued attempt and never revives its normally ended original root', async () => {
  const f = await fixture(), created = await f.create('cold-queued', [1]);
  await f.restart(); await f.start(); need(await f.coordinator.recover());
  expect(f.requests).toHaveLength(3);
  const original = (await f.work(created.workId)).work.execution.attempt;
  await f.restart(); need(await f.coordinator.recover());
  expect(f.requests).toHaveLength(3); expect((await f.work(created.workId)).work.execution.attempt).toEqual(original);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 1 });
}, 15_000);

test('cold recovery resumes an admitted native input with its stored model and context without resubmitting user input', async () => {
  const f = await fixture(), gate = f.holdNext(), created = await f.create('cold-native', [1]);
  const started = f.start(); await gate.entered.promise;
  const original = await f.database.read(scope => scope.db.query('SELECT id,native_conversation_id,native_submission_id FROM invoice_work_phases').get());
  expect(original).toMatchObject({ native_submission_id: expect.any(Number) });
  await f.restart(); gate.release.resolve(); await started;
  need(await f.coordinator.recover());
  expect(await f.database.read(scope => scope.db.query('SELECT id,native_conversation_id,native_submission_id FROM invoice_work_phases').get())).toEqual(original);
  expect((await f.work(created.workId)).work.execution.runStatus).toBe('completed');
  const history = need(await f.runtime.queryHistory({ workId: created.workId, sessionId: created.sessionId, limit: 100 }));
  expect(history.entries.filter(entry => entry.kind === 'flowmate.input')).toHaveLength(1);
  expect(f.errors).toEqual([]);
}, 20_000);

test('a new supplement after normal closure creates exactly one authorized successor, and duplicate commands or read queries add no execution', async () => {
  const f = await fixture(), created = await f.create('supplement-normal', [1]); await f.start();
  const first = (await f.work(created.workId)).work.execution.attempt!;
  const supplement = await f.supplement(created.workId, 'clarification-original', 'Use this original clarification only for its own invoice.');
  expect(supplement.receipt.execution).toMatchObject({ authorizationAccepted: true, relation: 'new' });
  expect(need(await f.service.supplement(supplement.request))).toEqual(supplement.receipt);
  need(await f.coordinator.drain());
  const current = await f.work(created.workId);
  expect(current.work.execution.attempt?.attemptId).not.toBe(first.attemptId);
  expect(f.requests).toHaveLength(6);
  expect(f.requests[3]!.userInputs).toMatchObject([{ inputId: supplement.receipt.inputId, text: supplement.request.text }]);
  await f.restart(); need(await f.coordinator.recover());
  expect(need(await f.service.supplement(supplement.request))).toEqual(supplement.receipt);
  expect(need(await f.service.queryOperation({ operation: 'supplement', workId: created.workId, requestId: supplement.request.requestId }))).toEqual(supplement.receipt);
  await f.work(created.workId); expect(f.requests).toHaveLength(6);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 2 });
}, 20_000);

test('supplements on a failed original root stay saved until an explicit continue authorizes a new attempt', async () => {
  const f = await fixture('fail'), created = await f.create('failed-original', [1]); await f.start();
  const first = await f.work(created.workId);
  expect(first.work.execution).toMatchObject({ runStatus: 'failed', requiresContinue: true, stopUnconfirmed: false });
  need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: created.workId, itemId: first.items[0]!.itemId,
    expectedRevision: first.items[0]!.revision, at: now(), todos: [{ actor: 'user', action: 'supplement', fieldPath: null,
      problem: 'The failed execution did not prepare a candidate.', needed: 'Save original clarification before continuing.', satisfiedBy: 'Original clarification is available.',
      basis: { origin: 'rule', documentRefs: [first.items[0]!.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] })));
  const saved = await f.supplement(created.workId, 'saved-after-failure', 'Saved after failure.');
  expect(saved.receipt.execution).toMatchObject({ authorizationAccepted: false, kind: 'waiting' });
  need(await f.coordinator.drain()); expect(f.requests).toHaveLength(1);
  await f.restart(); need(await f.coordinator.recover()); expect(f.requests).toHaveLength(1);
  const before = await f.work(created.workId);
  const continued = need(await f.service.continueWork({ workId: created.workId, requestId: 'continue-failed',
    expectedRevision: before.work.revision, expectedAttemptId: before.work.execution.attempt!.attemptId }));
  expect(continued.execution).toMatchObject({ authorizationAccepted: true, relation: 'new' });
  need(await f.coordinator.drain()); expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.userInputs).toMatchObject([{ inputId: saved.receipt.inputId, text: 'Saved after failure.' }]);
}, 15_000);

test('a committed user stop settles the original root and later clarification requires explicit continue', async () => {
  const f = await fixture('no-candidate'), created = await f.create('stopped-original', [1]), gate = f.holdNext();
  const started = f.start(); await gate.entered.promise;
  const before = await f.work(created.workId);
  const stopped = need(await f.tasks.stop({ workId: created.workId, attemptId: before.work.execution.attempt!.attemptId,
    expectedRevision: before.work.revision, requestId: 'stop-original-attempt' }));
  expect(stopped.accepted).toBe(true); gate.release.resolve(); await started;
  need(await f.coordinator.drain()); const current = await f.work(created.workId);
  expect(current.work.execution).toMatchObject({ runStatus: 'cancelled', requiresContinue: true, stopUnconfirmed: false });
  const phase = await f.database.read(scope => scope.db.query('SELECT consumed_at,closed_at FROM invoice_work_phases').get());
  expect(phase).toMatchObject({ consumed_at: null, closed_at: expect.any(String) });
  need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: created.workId, itemId: current.items[0]!.itemId,
    expectedRevision: current.items[0]!.revision, at: now(), todos: [{ actor: 'user', action: 'supplement', fieldPath: null,
      problem: 'The original stopped invoice needs clarification.', needed: 'Save the original input.', satisfiedBy: 'The original input is available.',
      basis: { origin: 'rule', documentRefs: [current.items[0]!.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] })));
  const saved = await f.supplement(created.workId, 'saved-after-stop', 'Original clarification after user stop.');
  expect(saved.receipt.execution).toMatchObject({ authorizationAccepted: false, kind: 'waiting' });
  need(await f.coordinator.drain()); await f.restart(); need(await f.coordinator.recover()); expect(f.requests).toHaveLength(1);
  const beforeContinue = await f.work(created.workId);
  const continued = need(await f.service.continueWork({ workId: created.workId, requestId: 'continue-stopped',
    expectedRevision: beforeContinue.work.revision, expectedAttemptId: beforeContinue.work.execution.attempt!.attemptId }));
  expect(continued.execution).toMatchObject({ authorizationAccepted: true, relation: 'new' });
  need(await f.coordinator.drain()); expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.userInputs).toMatchObject([{ inputId: saved.receipt.inputId, text: saved.request.text }]); expect(f.errors).toEqual([]);
}, 15_000);

test('accepted new clarification changes phase only at the old native boundary and keeps the same business root', async () => {
  const f = await fixture(), created = await f.create('pending-clarification', [1]), page = await f.work(created.workId);
  need(await f.database.transaction(scope => scope.invoiceWorks.replaceTodos({ workId: created.workId, itemId: page.items[0]!.itemId,
    expectedRevision: page.items[0]!.revision, at: now(), todos: [{ actor: 'user', action: 'supplement', fieldPath: null,
      problem: 'The original invoice needs clarification.', needed: 'Save original input.', satisfiedBy: 'The original input is available.',
      basis: { origin: 'rule', documentRefs: [page.items[0]!.documentRef], sourceRefs: [], inputIds: [], candidateRef: null } }] })));
  const first = await f.supplement(created.workId, 'first-input', 'Original first clarification.'), gate = f.holdNext();
  const started = f.start(); await gate.entered.promise;
  const second = await f.supplement(created.workId, 'second-input', 'New original clarification while the first phase is active.');
  expect(second.receipt.execution).toMatchObject({ kind: 'pending-boundary', relation: 'original', authorizationAccepted: true });
  gate.release.resolve(); await started; need(await f.coordinator.drain());
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 1 });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_phases').get())).toEqual({ count: 2 });
  const original = f.requests[0]!, retained = f.requests.filter(context => context.phase.phaseId === original.phase.phaseId),
    successor = f.requests.filter(context => context.phase.phaseId !== original.phase.phaseId);
  expect(retained.length).toBeGreaterThan(1); for (const context of retained) expect(context).toEqual(original);
  expect(successor.length).toBeGreaterThan(0);
  for (const context of successor) expect(context.userInputs.map(input => input.inputId)).toEqual([second.receipt.inputId]);
  expect(f.requests[0]!.userInputs.map(input => input.inputId)).toEqual([first.receipt.inputId]);
  expect((await f.work(created.workId)).work.execution.runStatus).toBe('completed');
}, 20_000);

test.each(['before-native-submit', 'after-native-submit'] as const)('cold recovery repairs the %s gap using the original phase identity', async gap => {
  const f = await fixture(), created = await f.create(`gap-${gap}`, [1]), gate = f.holdNext();
  if (gap === 'before-native-submit') f.runtime.submit = async () => fail(appError('storage_write_failed', 'storage', 'Controlled original submission outage.', true));
  else f.observer.reconcile = async () => fail(appError('storage_write_failed', 'storage', 'Controlled product link commit outage.', true));
  await expect(f.start()).rejects.toThrow('storage_write_failed');
  const stored = await f.database.read(scope => scope.db.query<{ id: number; request_id: string; native_submission_id: number | null }, []>(
    'SELECT id,request_id,native_submission_id FROM invoice_work_phases').get()!);
  expect(stored.native_submission_id).toBeNull();
  const identity = { workId: created.workId, sessionId: created.sessionId, attemptId: created.execution.attempt!.attemptId, requestId: stored.request_id };
  const submitted = need(await f.runtime.getSubmission(identity));
  expect(submitted === null).toBe(gap === 'before-native-submit');
  await f.restart(); gate.release.resolve(); need(await f.coordinator.recover());
  const recovered = await f.database.read(scope => scope.db.query('SELECT id,native_submission_id FROM invoice_work_phases').get());
  expect(recovered).toMatchObject({ id: stored.id, native_submission_id: submitted?.nativeSubmissionId ?? expect.any(Number) });
  expect((await f.work(created.workId)).work.execution.runStatus).toBe('completed');
  const history = need(await f.runtime.queryHistory({ workId: created.workId, sessionId: created.sessionId, limit: 100 }));
  expect(history.entries.filter(entry => entry.kind === 'flowmate.input')).toHaveLength(1);
}, 20_000);

test('a done input with a real owned native Task holds root admission until the actual owned completion event', async () => {
  const f = await fixture('owned'), first = await f.create('owned-first', [1]);
  await f.start(); await f.owned.entered.promise;
  const original = await f.database.read(scope => scope.db.query<{ request_id: string }, []>('SELECT request_id FROM invoice_work_phases').get()!);
  const observed = need(await f.runtime.observeSubmission({ workId: first.workId, sessionId: first.sessionId,
    attemptId: first.execution.attempt!.attemptId, requestId: original.request_id }));
  expect(observed).toMatchObject({ status: 'done', execution: 'active' });
  const second = await f.create('owned-second', [2]); need(await f.coordinator.drain());
  expect(f.requests).toHaveLength(1); expect((await f.work(first.workId)).work.execution.runStatus).toBe('running');
  expect((await f.work(second.workId)).work.execution.attempt?.runId).toBeNull();
  f.owned.release.resolve(); await f.owned.closed.promise;
  await waitFor(async () => (await f.work(first.workId)).work.execution.runStatus === 'completed'
    && (await f.work(second.workId)).work.execution.runStatus === 'completed');
  need(await f.coordinator.drain());
  expect((await f.work(first.workId)).work.execution.runStatus).toBe('completed');
  expect((await f.work(second.workId)).work.execution.runStatus).toBe('completed');
  expect(f.requests).toHaveLength(2);
}, 15_000);

test('the original Work deadline stops its real native owned Task even after the input is done', async () => {
  const f = await fixture('owned'), created = await f.create('owned-deadline', [1]);
  await f.database.transaction(scope => scope.db.query("UPDATE invoice_works SET budget_json=json_set(budget_json,'$.limits.timeoutMs',1000) WHERE id=?").run(created.workId));
  await f.start(); await f.owned.entered.promise;
  const stopped = await Promise.race([f.owned.closed.promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))]);
  expect(stopped).toBe(true); need(await f.coordinator.drain());
  expect((await f.work(created.workId)).work.execution).toMatchObject({ runStatus: 'failed', requiresContinue: true, stopUnconfirmed: false });
  expect(await f.database.read(scope => scope.db.query("SELECT json_extract(error_json,'$.code') code FROM runs").get())).toEqual({ code: 'agent_timeout' });
}, 15_000);

test('cold recovery keeps the original elapsed Work deadline before any native resume', async () => {
  const f = await fixture('owned'), created = await f.create('cold-owned-deadline', [1]);
  await f.database.transaction(scope => scope.db.query("UPDATE invoice_works SET budget_json=json_set(budget_json,'$.limits.timeoutMs',1000) WHERE id=?").run(created.workId));
  await f.start(); await f.owned.entered.promise; await f.restart();
  expect((await f.work(created.workId)).work.execution.runStatus).toBe('running');
  await new Promise(resolve => setTimeout(resolve, 1100));
  need(await f.coordinator.recover());
  expect((await f.work(created.workId)).work.execution).toMatchObject({ runStatus: 'failed', requiresContinue: true, stopUnconfirmed: false });
  expect(f.requests).toHaveLength(1);
  expect(await f.database.read(scope => scope.db.query("SELECT json_extract(error_json,'$.code') code FROM runs").get())).toEqual({ code: 'agent_timeout' });
}, 15_000);

test('cold recovery projects an already closed native phase once when its original candidate review commit was interrupted', async () => {
  const f = await fixture(), created = await f.create('closed-before-review', [1]), transaction = f.database.transaction;
  f.database.transaction = operation => transaction(scope => operation({ ...scope, invoiceWorks: { ...scope.invoiceWorks,
    replaceTodos: () => fail(appError('storage_write_failed', 'storage', 'Controlled original review projection outage.', true)) } }));
  await expect(f.start()).rejects.toThrow('storage_write_failed');
  const before = await f.work(created.workId);
  expect(before.items[0]!.candidateRef).not.toBeNull(); expect(before.items[0]!.todoCount).toBe(0);
  expect(await f.database.read(scope => scope.db.query('SELECT closed_at FROM invoice_work_phases').get())).toMatchObject({ closed_at: expect.any(String) });
  await f.restart(); need(await f.coordinator.recover());
  const projected = await f.item(created.workId, before.items[0]!.itemId);
  expect(projected.todos).toHaveLength(1); expect(projected.todos[0]).toMatchObject({ actor: 'user', action: 'review', basis: { candidateRef: before.items[0]!.candidateRef } });
  expect(projected.work.execution.runStatus).toBe('completed');
  need(await f.coordinator.recover());
  expect((await f.item(created.workId, before.items[0]!.itemId)).todos).toEqual(projected.todos); expect(f.requests).toHaveLength(3);
}, 15_000);

test('the last authorized model request can finish its real candidate phase normally without charging another request to settle the root', async () => {
  const f = await fixture(), created = await f.create('last-request', [1]);
  await f.database.transaction(scope => scope.db.query("UPDATE invoice_works SET budget_json=json_set(budget_json,'$.runtimeBudget.maxModelCalls',3) WHERE id=?").run(created.workId));
  await f.start(); expect(f.requests).toHaveLength(3);
  expect((await f.work(created.workId)).work.execution).toMatchObject({ runStatus: 'completed', requiresContinue: false, stopUnconfirmed: false });
  expect(need(await f.governor.remainingBudget(created.workId)).modelCalls).toBe(0);
  expect(await f.database.read(scope => scope.db.query('SELECT count FROM invoice_work_model_reservations').get())).toEqual({ count: 3 });
}, 15_000);

test('the persisted Work thinking level reaches actual HTTP and its original native submission', async () => {
  const f = await fixture('no-candidate', 'high'), created = await f.create('frozen-thinking', [1]);
  await f.start(); expect(f.wireRequests[0]!.reasoning_effort).toBe('high');
  const history = need(await f.runtime.queryHistory({ workId: created.workId, sessionId: created.sessionId, limit: 100 }));
  expect(history.entries.filter(entry => entry.kind === 'flowmate.input').map(entry => JSON.parse(entry.json).data.thinkingLevel)).toEqual(['high']);
}, 15_000);

test('a user stop closes a genuinely frozen but never submitted phase only with exact native not-started proof', async () => {
  const f = await fixture('no-candidate'), created = await f.create('never-submitted-stop', [1]), submit = f.runtime.submit;
  f.runtime.submit = async () => fail(appError('storage_write_failed', 'storage', 'Controlled interruption before the native submit call.', true));
  await expect(f.start()).rejects.toThrow('storage_write_failed'); f.runtime.submit = submit;
  const before = await f.work(created.workId), attemptId = before.work.execution.attempt!.attemptId;
  need(await f.tasks.stop({ workId: created.workId, attemptId, requestId: 'stop-never-submitted', expectedRevision: before.work.revision }));
  need(await f.coordinator.drain());
  const proof = need(await f.runtime.stopAttempt({ workId: created.workId, sessionId: created.sessionId, attemptId, stopGraceMs: 1000 }));
  expect(proof).toMatchObject({ stopped: true, reason: 'not-started' });
  expect((await f.work(created.workId)).work.execution).toMatchObject({ runStatus: 'cancelled', requiresContinue: true, stopUnconfirmed: false });
  expect(await f.database.read(scope => scope.db.query('SELECT native_conversation_id,native_submission_id,consumed_at,closed_at FROM invoice_work_phases').get()))
    .toEqual({ native_conversation_id: null, native_submission_id: null, consumed_at: null, closed_at: expect.any(String) });
  const next = await f.create('after-never-submitted-stop', [2]); need(await f.coordinator.drain());
  expect((await f.work(next.workId)).work.execution.runStatus).toBe('completed'); expect(f.requests).toHaveLength(1);
}, 15_000);

test('an expired frozen phase with no native input closes without inventing consumption or user stop', async () => {
  const f = await fixture('no-candidate'), created = await f.create('never-submitted-deadline', [1]), submit = f.runtime.submit;
  await f.database.transaction(scope => scope.db.query("UPDATE invoice_works SET budget_json=json_set(budget_json,'$.limits.timeoutMs',1000) WHERE id=?").run(created.workId));
  f.runtime.submit = async () => fail(appError('storage_write_failed', 'storage', 'Controlled interruption before the native submit call.', true));
  await expect(f.start()).rejects.toThrow('storage_write_failed'); f.runtime.submit = submit;
  await new Promise(resolve => setTimeout(resolve, 1100)); need(await f.coordinator.recover());
  expect((await f.work(created.workId)).work.execution).toMatchObject({ runStatus: 'failed', requiresContinue: true, stopUnconfirmed: false });
  expect(await f.database.read(scope => scope.db.query('SELECT native_submission_id,consumed_at,closed_at FROM invoice_work_phases').get()))
    .toEqual({ native_submission_id: null, consumed_at: null, closed_at: expect.any(String) });
  expect(await f.database.read(scope => scope.db.query("SELECT a.stop_requested_at,json_extract(r.error_json,'$.code') code FROM invoice_work_attempts a JOIN runs r ON r.id=a.run_id").get()))
    .toEqual({ stop_requested_at: null, code: 'agent_timeout' }); expect(f.requests).toHaveLength(0);
}, 15_000);

test('a real phase and context COMMIT with a lost response resumes the same snapshot and submits its native input only once', async () => {
  const f = await fixture(), created = await f.create('phase-commit-response-loss', [1]), transaction = f.database.transaction;
  let interrupted = false;
  const committed: Array<{ phaseId: number; contextId: number }> = [];
  f.database.transaction = async operation => {
    if (interrupted) return transaction(operation);
    const before = await f.database.read(scope => scope.db.query<{ count: number }, []>('SELECT COUNT(*) count FROM invoice_work_phases').get()!.count);
    const value = await transaction(operation);
    const saved = await f.database.read(scope => scope.db.query<{ phaseId: number; contextId: number }, []>(
      'SELECT p.id phaseId,c.id contextId FROM invoice_work_phases p JOIN invoice_work_context_snapshots c ON c.phase_id=p.id').all());
    if (before === 0 && saved.length === 1) {
      interrupted = true; committed.push(saved[0]!);
      throw Error('Controlled response loss after the real phase and context COMMIT.');
    }
    return value;
  };
  await f.start();
  expect(interrupted).toBe(true); expect(committed).toHaveLength(1);
  expect(await f.database.read(scope => scope.db.query('SELECT p.id phaseId,c.id contextId FROM invoice_work_phases p JOIN invoice_work_context_snapshots c ON c.phase_id=p.id').all()))
    .toEqual(committed);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_candidates').get())).toEqual({ count: 1 });
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual({ count: 1 });
  expect((await f.work(created.workId)).work.execution).toMatchObject({ runStatus: 'completed', requiresContinue: false, stopUnconfirmed: false });
  expect(f.requests).toHaveLength(3); expect(f.requests.every(context => context.phase.phaseId === committed[0]!.phaseId)).toBe(true);
  const history = need(await f.runtime.queryHistory({ workId: created.workId, sessionId: created.sessionId, limit: 100 }));
  expect(history.entries.filter(entry => entry.kind === 'flowmate.input')).toHaveLength(1); expect(f.errors).toEqual([]);
}, 15_000);

test('confirmed stopping of an originally failed frozen phase permits real Governor continuation and later Work admission without rewriting failure facts', async () => {
  const f = await fixture('no-candidate'), created = await f.create('failed-before-submit', [1]), submit = f.runtime.submit;
  f.runtime.submit = async () => fail(appError('storage_write_failed', 'storage', 'Controlled interruption before native submission.', true));
  await expect(f.start()).rejects.toThrow('storage_write_failed'); f.runtime.submit = submit;
  const current = await f.work(created.workId), attemptId = current.work.execution.attempt!.attemptId, runId = current.work.execution.attempt!.runId!;
  const cleanupError = appError('stop_unconfirmed', 'runtime', 'The original failure did not confirm native cleanup.', true);
  const originalFailure = appError('original_failure', 'runtime', 'The original failed execution diagnosis must be preserved.');
  need(await f.database.transaction(scope => {
    const run = need(scope.runs.get(runId)), at = now();
    return scope.runs.finish(runId, { status: 'failed', output: null, error: originalFailure, usage: run.usage, tokens: run.tokens,
      cleanup: { version: 1, stopped: false, stopReason: null, errors: [cleanupError], lateObservationRequired: true },
      endedAt: at, stoppedAt: null, durationMs: Date.parse(at) - Date.parse(run.startedAt!) });
  }));
  expect(await f.governor.assess(created.workId)).toMatchObject({ ok: true, data: { kind: 'blocked', reason: { code: 'stop_unconfirmed' } } });
  need(await f.tasks.stop({ workId: created.workId, attemptId, requestId: 'confirm-original-native-stop', expectedRevision: current.work.revision }));
  need(await f.coordinator.drain());
  expect(need(await f.tasks.get({ workId: created.workId, attemptId })).task.stoppedAt).toBeString();
  expect(need(await f.runtime.stopAttempt({ workId: created.workId, sessionId: created.sessionId, attemptId, stopGraceMs: 1000 })))
    .toMatchObject({ stopped: true, reason: 'not-started' });
  expect(await f.governor.assess(created.workId)).toMatchObject({ ok: true, data: { kind: 'waiting' } });
  const next = await f.create('after-confirmed-failed-work', [2]);
  expect(next.execution).toMatchObject({ authorizationAccepted: true, kind: 'accepted' });
  need(await f.coordinator.drain()); expect((await f.work(next.workId)).work.execution.runStatus).toBe('completed');
  const beforeContinue = await f.work(created.workId);
  const continued = need(await f.service.continueWork({ workId: created.workId, requestId: 'continue-confirmed-failed-work',
    expectedRevision: beforeContinue.work.revision, expectedAttemptId: attemptId }));
  expect(continued.execution).toMatchObject({ authorizationAccepted: true, relation: 'new', kind: 'accepted' });
  need(await f.coordinator.drain());
  expect((await f.work(created.workId)).work.execution.runStatus).toBe('completed');
  expect(f.requests.map(context => context.item.documentRef.id)).toEqual([2, 1]);
  expect(need(await f.database.read(scope => scope.runs.get(runId)))).toMatchObject({ status: 'failed', error: originalFailure,
    stoppedAt: null, cleanup: { stopped: false, errors: [cleanupError], lateObservationRequired: true } });
}, 15_000);
