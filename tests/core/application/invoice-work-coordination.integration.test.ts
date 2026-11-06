import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, defineTask, defineTool, type SubmissionId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { appError, DelegateArgsSchema, fail, ok, PersonalAgentConfigurationSchema, type InvoiceWorkCreateRequest, type InvoiceWorkWorkingContext,
  type CloudRuntimeDeliveryPort, type DurableRuntimePort, type ProviderConfig, type Result } from '@flowmate/contracts';
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
import { buildInvoiceWorkContext, createDurableRuntime, createDurableSqliteStorage, type DurableRuntimeOptions } from '@flowmate/runtime-durable';
import { openCloudRuntimeStore } from '../../../apps/cloud-runtime-storage.ts';
import { createCloudRuntimeRouter } from '../../../apps/cloud-runtime-router.ts';
import { CloudDeepSeekProxy } from '../../../apps/cloud-deepseek-proxy.ts';
import { callCloudModelSocket, listenCloudModelSocket } from '../../../apps/cloud-model-socket.ts';
import { callCloudUnixRpc, listenCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { createCloudRuntimeRpcClient, createCloudRuntimeRpcHandler } from '../../../apps/cloud-runtime-rpc.ts';
import { createCloudRuntimeAuthorizer } from '../../../apps/cloud-runtime-authority.ts';
import { createCloudChildReportReader } from '../../../apps/cloud-desktop-authority.ts';
import { createCloudAuthorityCallbacksClient, createCloudAuthorityRpcClient, createCloudAuthorityRpcHandler } from '../../../apps/cloud-authority-rpc.ts';
import { createCloudRuntimeService } from '../../../apps/cloud-runtime-service.ts';
import { startCloudAuthorityEndpoints } from '../../../apps/cloud-authority-service.ts';
import { CloudNativeResultReceiver } from '../../../apps/cloud-native-result-receiver.ts';
import { CloudModelAttempts } from '../../../packages/core/src/personal-agent/cloud-model-attempts.ts';
import { createDurableInvoiceSubagentService } from '../../../packages/core/src/personal-agent/subagents.ts';
import { createInvoiceWorkCompactionCallbacks } from '../../../packages/core/src/personal-agent/compaction.ts';
import { toPiParameters } from '../../../packages/runtime-pi/src/schema.ts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
const now = () => new Date().toISOString();
const requireRuntime = createRequire(new URL('../../../packages/runtime-durable/package.json', import.meta.url));
const installedVersion = (name: string): string => JSON.parse(readFileSync(requireRuntime.resolve(`${name}/package.json`), 'utf8')).version;
const sdk = { durable: installedVersion('@earendil-works/pi-durable'), ai: installedVersion('@earendil-works/pi-ai'), chord: installedVersion('@earendil-works/chord') };

async function fixture(mode: 'candidate' | 'no-candidate' | 'fail' | 'owned' | 'mixed' | 'child' | 'child-retryable' | 'compaction' | 'compaction-retryable' | 'oversize' | 'retryable' = 'candidate', thinkingLevel: 'off' | 'high' = 'off',
  runtimeScope: 'local' | 'cloud' = 'local', isolated = false, throughProxy = false, socketTransport = false, runtimeSocket = false,
  authoritySocket = false, authorityCallbacks = false, authorityTools = false, authoritySubagents = false, authorityCompactions = false,
  useRuntimeService = false) {
  const childMode = mode === 'child' || mode === 'child-retryable', compactionMode = mode === 'compaction' || mode === 'compaction-retryable';
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-coordination-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const cloudRoot = join(root, 'cloud-runtime');
  if (isolated) { if (runtimeScope !== 'cloud' || mode === 'owned') throw Error('Unsupported cloud test fixture.'); mkdirSync(cloudRoot, { mode: 0o700 }); }
  const modelSocketDir = join(root, 'cloud-model-socket');
  if (socketTransport) { if (!throughProxy || process.platform !== 'linux') throw Error('Unsupported socket test fixture.'); mkdirSync(modelSocketDir, { mode: 0o700 }); }
  const runtimeSocketDir = join(root, 'cloud-runtime-socket');
  if (runtimeSocket) { if (!isolated || process.platform !== 'linux') throw Error('Unsupported runtime socket fixture.'); mkdirSync(runtimeSocketDir, { mode: 0o700 }); }
  const authoritySocketDir = join(root, 'cloud-authority-socket');
  if (authoritySocket) { if (!isolated || process.platform !== 'linux') throw Error('Unsupported Authority socket fixture.'); mkdirSync(authoritySocketDir, { mode: 0o700 }); }
  if ((authorityCallbacks || authorityTools || authoritySubagents || authorityCompactions) && !authoritySocket) throw Error('Authority callbacks need their socket.');
  if (useRuntimeService && (!runtimeSocket || !authoritySocket || !socketTransport)) throw Error('Runtime service needs all three sockets.');
  let database = need(openTestDatabase(paths));
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: 'coordination-local-profile', thinkingLevel,
    resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    tools: childMode ? ['Agent', 'read_invoice_document'] : ['read_invoice_document', 'save_invoice_candidate'], workingDirectory: null, preferences: '' });
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
  let childFailed = false, summaryRequests = 0;
  const owned = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), closed: Promise.withResolvers<void>() };
  deferCleanup(() => owned.release.resolve());
  let held: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>>; skip: number } | null = null;
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    wireRequests.push(body);
    if (compactionMode && JSON.stringify(body).includes('context summarization assistant')) {
      summaryRequests++; if (mode === 'compaction-retryable' && summaryRequests === 1) return new Response('Controlled summary failure.', { status: 503 });
      const chunk = { id: 'controlled-cloud-summary', object: 'chat.completion.chunk', created: 1, model: 'coordination-local-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Original invoice evidence summary.' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as InvoiceWorkWorkingContext;
    requests.push(context);
    if (held?.skip) held.skip--;
    else if (held) { const original = held; held = null; original.entered.resolve(); await original.release.promise; }
    if (mode === 'fail' || mode === 'retryable' && requests.length === 1) return new Response('Controlled transport failure.', { status: 503 });
    if (mode === 'child-retryable' && context.delegation && !childFailed) { childFailed = true; return new Response('Controlled child failure.', { status: 503 }); }
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
    if (childMode && !context.delegation && ordinal === 0) {
      tool = { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker', run_in_background: false,
        description: 'Check the original invoice', prompt: 'Verify the original invoice evidence.' } };
    } else if (mode !== 'no-candidate' && mode !== 'oversize' && mode !== 'retryable' && !childMode && ordinal === 0) {
      if (mode === 'mixed') tool = { name: 'save_invoice_candidate', arguments: { documentId, candidate } };
      else tool = { name: 'read_invoice_document', arguments: { documentId, page: 1, afterBlockId: null, limit: 10 } };
    } else if (mode !== 'no-candidate' && mode !== 'mixed' && !childMode && !compactionMode && ordinal === 1) tool = { name: 'save_invoice_candidate', arguments: { documentId, candidate } };
    const delta = tool ? { role: 'assistant', ...(compactionMode ? { content: 'Original evidence '.repeat(9000) } : {}),
      tool_calls: [{ index: 0, id: `coordinator-wire-${requests.length}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: mode === 'oversize' ? 'x'.repeat(262_145) : 'Original phase completed for human review.' };
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
  const errors: string[] = [], childObservations: unknown[] = [], phaseObservations: unknown[] = []; let rpcRequests = 0, authorityRequests = 0, callbackRequests = 0, toolRequests = 0, childRequests = 0, compactionRequests = 0, resultRequests = 0;
  let resultDelivery = true, loseResultReceipt = false;
  async function connect() {
  const governor = new DurableInvoiceGovernor(database, now, () => foreground, runtimeScope);
  let runtime!: DurableRuntimePort;
  let childRuntime: DurableRuntimePort | undefined;
  const subagents = createDurableInvoiceSubagentService({ database, now, governor, observeSubagent: async input => {
    const result = childRuntime ? await childRuntime.observeSubagent(input)
      : fail(appError('personal_agent_unavailable', 'runtime', 'Controlled child runtime unavailable.'));
    if (result.ok && result.data) { const { answer: _answer, ...facts } = result.data; childObservations.push(facts); }
    return result;
  } });
  const contexts = new InvoiceWorkPhaseContextService({ database, now, buildContext: buildInvoiceWorkContext });
  const productCompactions = createInvoiceWorkCompactionCallbacks({ database, governor, contexts, subagents: subagents.callbacks });
  const files = createFileStore(paths, database), documents = createDocumentService({ paths, files, allowedSourceRoot: root, now,
    transaction: operation => database.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const definitions = [...createInvoiceTools({ documents: { readParsedForRun: (id, context) => database.read(scope =>
    documents.readParsedForRun(id, context, { repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) },
    documentRepository: { get: id => database.read(scope => scope.documents.get(id)) },
    candidates: { save: input => database.transaction(scope => scope.candidates.save(input)),
      listForRun: input => database.read(scope => scope.candidates.listForRun(input)),
      readForRun: input => database.read(scope => scope.candidates.readForRun(input)) }, now }), ...(childMode ? [subagents.tool] : [])];
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
  let authorityClient: ReturnType<typeof createCloudAuthorityCallbacksClient> | null = null;
  const runtimeOptions: Omit<DurableRuntimeOptions, 'storage'> = { registry,
    onChanged: () => coordinator?.wake(),
    readApiKey: () => 'controlled-local-key', verifyModelUse: input => authorityCallbacks ? authorityClient!.verifyModelUse(input) : governor.verifyModelUse(input),
    verifySchedulingUse: (input, pending) => authorityCallbacks ? authorityClient!.verifySchedulingUse(input, pending) : governor.verifySchedulingUse(input, pending),
    reserveModelRequest: input => governor.reserveModelRequest(input),
    ...(childMode ? { subagents: authoritySubagents ? {
      readPlan: input => authorityClient!.subagents.readPlan(input), verify: input => authorityClient!.subagents.verify(input),
      adopt: input => authorityClient!.subagents.adopt(input), reserveModelRequest: input => authorityClient!.subagents.reserveModelRequest(input),
      onParentConsumed: input => authorityClient!.subagents.onParentConsumed(input),
    } : subagents.callbacks } : {}),
    ...(compactionMode ? { compactions: authorityCompactions ? {
      readPlan: input => authorityClient!.compactions.readPlan(input), verify: input => authorityClient!.compactions.verify(input),
      reserveModelRequest: input => authorityClient!.compactions.reserveModelRequest(input),
    } : productCompactions } : {}),
    readWorkingContext: input => authorityCallbacks ? authorityClient!.readWorkingContext(input)
      : input.child ? subagents.readWorkingContext(input) : contexts.get(input),
    verifyWorkingContext: async input => authorityCallbacks ? authorityClient!.verifyWorkingContext(input)
      : input.child ? (await subagents.readWorkingContext(input)).ok ? ok(undefined)
        : fail(appError('state_conflict', 'runtime', 'Controlled child context unavailable.')) : contexts.verify(input),
    tools: mode === 'owned' ? [] : definitions.filter(tool => configuration.tools.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description,
      executionMode: tool.executionMode, inputSchema: { ...toPiParameters(tool.name === 'Agent'
        ? DelegateArgsSchema.extend({ run_in_background: DelegateArgsSchema.shape.run_in_background.removeDefault() }) : tool.inputSchema) } })),
    executeTool: async input => {
      if (authorityTools) return authorityClient!.executeTool(input);
      const reconciled = await observer.reconcile({ workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId, requestId: input.requestId });
      return reconciled.ok ? bridge.executeTool(input) : reconciled;
    }, readToolResult: input => authorityTools ? authorityClient!.readToolResult(input) : bridge.readToolResult(input),
    onToolFeedback: input => authorityTools ? authorityClient!.onToolFeedback(input) : bridge.onToolFeedback(input) };
  const cloudStore = isolated && !useRuntimeService ? need(await openCloudRuntimeStore(cloudRoot)) : null;
  const proxy = throughProxy ? new CloudDeepSeekProxy({ ledger: new CloudModelAttempts(database, governor, now),
    readApiKey: () => 'controlled-authority-key', fetch: (_url, init) => fetch(`${provider.connection!.baseUrl}/chat/completions`, init) }) : null;
  const modelSocketPath = join(modelSocketDir, 'model.sock');
  const modelServer = socketTransport && proxy ? need(await listenCloudModelSocket({ socketPath: modelSocketPath, proxy,
    prepare: async input => {
      const linked = await observer.reconcile({ workId: input.workId, sessionId: input.sessionId,
        attemptId: input.attemptId, requestId: input.requestId });
      return linked.ok ? ok(undefined) : linked;
    } })) : null;
  const authoritySocketPath = join(authoritySocketDir, 'authority.sock');
  const authorityHandler = createCloudAuthorityRpcHandler(createCloudRuntimeAuthorizer(database), {
    readWorkingContext: input => input.child ? subagents.readWorkingContext(input) : contexts.get(input),
    verifyWorkingContext: async input => input.child ? (await subagents.readWorkingContext(input)).ok ? ok(undefined)
      : fail(appError('state_conflict', 'runtime', 'Controlled child context unavailable.')) : contexts.verify(input),
    verifyModelUse: input => governor.verifyModelUse(input), verifySchedulingUse: (input, pending) => governor.verifySchedulingUse(input, pending),
    executeTool: async input => {
      const linked = await observer.reconcile({ workId: input.workId, sessionId: input.sessionId, attemptId: input.attemptId, requestId: input.requestId });
      return linked.ok ? bridge.executeTool(input) : linked;
    }, readToolResult: input => bridge.readToolResult(input), onToolFeedback: input => bridge.onToolFeedback(input),
    subagents: subagents.callbacks, compactions: productCompactions,
  }, async () => { coordinator?.wake(); return ok(undefined); }, async event => {
    resultRequests++;
    if (!resultDelivery) return fail(appError('cloud_result_unavailable', 'runtime', 'Controlled Authority outage.', true));
    const result = await new CloudNativeResultReceiver(database, runtime, now).receive(event);
    if (result.ok && loseResultReceipt) { loseResultReceipt = false; return fail(appError('operation_result_unknown', 'runtime', 'Controlled lost receipt.', true)); }
    return result;
  });
  const authorityServer = authoritySocket ? need(await listenCloudUnixRpc({ socketPath: authoritySocketPath,
    handle: (value, signal) => { authorityRequests++; if (value && typeof value === 'object' && 'method' in value && value.method !== 'authorize') {
      callbackRequests++; if (['executeTool', 'readToolResult', 'onToolFeedback'].includes(String(value.method))) toolRequests++;
      if (['readChildPlan', 'verifyChild', 'adoptChild', 'childConsumed'].includes(String(value.method))) childRequests++;
      if (['readCompactionPlan', 'verifyCompaction'].includes(String(value.method))) compactionRequests++;
    } return authorityHandler(value, signal); } })) : null;
  authorityClient = authorityServer ? createCloudAuthorityCallbacksClient(authoritySocketPath) : null;
  const nativeRuntime = useRuntimeService ? null : cloudStore ? createCloudRuntimeRouter({ store: cloudStore,
    runtimeOptions: binding => ({ ...runtimeOptions, registry: createRegistry(),
      onNativeResult: async event => { const opened = await cloudStore.openSession(binding, false); return opened.ok ? opened.data.enqueueResult(event) : opened; },
      onNativeResultOversized: async event => { const opened = await cloudStore.openSession(binding, false); return opened.ok ? opened.data.enqueueOversizedResult(event) : opened; },
      cloudModel: { binding,
      send: async (input, signal) => {
        if (modelServer) return callCloudModelSocket(modelSocketPath, input, signal);
        const linked = await observer.reconcile({ workId: input.workId, sessionId: input.sessionId,
          attemptId: input.attemptId, requestId: input.requestId });
        if (!linked.ok) return linked;
        if (proxy) return proxy.send(input, signal);
        try { return ok(await fetch(`${provider.connection!.baseUrl}/chat/completions`, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer controlled-local-key' }, body: input.body, signal })); }
        catch { return fail(appError('cloud_model_result_unknown', 'runtime', 'Controlled transport failed.', true)); }
      } } }),
    authorize: authorityServer ? createCloudAuthorityRpcClient(authoritySocketPath) : (_operation, input) => database.read(scope => {
      const work = scope.db.query<{ session_id: number }, [number]>('SELECT session_id FROM invoice_works WHERE id=?').get(input.workId);
      const session = scope.sessions.get(input.sessionId);
      if (!work || work.session_id !== input.sessionId || !session.ok || session.data.runtimeKind !== 'durable'
        || session.data.durableRuntimeId === 'local' || session.data.cloudWorkspaceId === null)
        return fail(appError('cloud_access_denied', 'runtime', 'The controlled fixture owner does not match.'));
      const binding = { workId: input.workId, sessionId: input.sessionId, cloudRuntimeId: session.data.durableRuntimeId,
        workspaceId: session.data.cloudWorkspaceId };
      return session.data.durableConversationId === null ? ok({ binding, state: 'allocated' as const })
        : ok({ binding, state: 'ready' as const, nativeConversationId: session.data.durableConversationId });
    }) }) : need(await createDurableRuntime({ ...runtimeOptions, storage: await createDurableSqliteStorage(database.coordinator) }));
  const runtimeSocketPath = join(runtimeSocketDir, 'runtime.sock'), handleRuntime = nativeRuntime ? createCloudRuntimeRpcHandler(nativeRuntime) : null;
  const runtimeServer = runtimeSocket && handleRuntime ? need(await listenCloudUnixRpc({ socketPath: runtimeSocketPath,
    handle: value => { rpcRequests++; return handleRuntime(value); } })) : null;
  const cloudRuntimeService = useRuntimeService ? need(await createCloudRuntimeService({ root: cloudRoot, runtimeSocketPath, authoritySocketPath,
    modelSocketPath, tools: runtimeOptions.tools ?? [] })) : null;
  runtime = runtimeServer || cloudRuntimeService ? createCloudRuntimeRpcClient(runtimeSocketPath) : nativeRuntime!;
  const observe = runtime.observeSubmission.bind(runtime);
  runtime.observeSubmission = async input => { const result = await observe(input);
    if (result.ok && result.data) phaseObservations.push({ ...result.data, readAt: now() }); return result; };
  childRuntime = runtime;
  observer = new InvoiceWorkPhaseObserver({ database, runtime, now });
  const models = new InvoiceWorkModelService({ database, runtime, now, resolveConfiguration: () => ok(provider) });
  const tasks = new PersonalTasksService({ database, runtime, now, phaseObserver: observer,
    ...(childMode ? { reconcileChildren: identity => subagents.reconcileAttempt(identity) } : {}), restoreAttempt: async identity => {
    const phase = await database.read(scope => scope.db.query<{ request_id: string }, [number]>(
      'SELECT request_id FROM invoice_work_phases WHERE attempt_id=? ORDER BY id DESC LIMIT 1').get(identity.attemptId));
    return phase ? models.restore({ ...identity, requestId: phase.request_id }) : ok(undefined);
  }, verifyModelUse: identity => governor.verifyModelUse(identity), onChanged: () => coordinator.wake() });
  coordinator = new InvoiceWorkCoordinator({ database, runtime, modelService: models, contexts, phaseObserver: observer, governor, tasks,
    now, sdk, runtimeScope, verifyResources: () => ok(undefined), onError: error => errors.push(error.code) });
  const service = new InvoiceWorkService({ database, now, assessExecution: input => governor.assess(input), onChanged: () => coordinator.wake(),
    ...(mode === 'mixed' ? { runtimeDefaults: () => ok({ budget: { maxModelCalls: 32, maxToolCalls: 100 }, timeoutMs: 300000 }) } : {}) });
  deferCleanup(async () => { owned.release.resolve(); const quiescing = coordinator.close(); need(await runtime.close());
    if (runtimeServer) need(await nativeRuntime!.close()); if (cloudRuntimeService) need(await cloudRuntimeService.close()); need(await quiescing);
    if (runtimeServer) need(await runtimeServer.close()); if (modelServer) need(await modelServer.close());
    if (authorityServer) need(await authorityServer.close()); if (cloudStore) need(await cloudStore.close()); });
  return { governor, contexts, models, observer, runtime, nativeRuntime, coordinator, service, tasks, cloudStore, modelServer, runtimeServer, authorityServer, cloudRuntimeService };
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
  const holdNext = (skip = 0) => { const original = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), skip };
    held = original; deferCleanup(() => original.release.resolve()); return original; };
  const restart = async (beforeReconnect?: () => Promise<void>) => {
    const quiescing = connection.coordinator.close(); need(await connection.runtime.close());
    if (connection.runtimeServer) need(await connection.nativeRuntime!.close());
    if (connection.cloudRuntimeService) need(await connection.cloudRuntimeService.close()); need(await quiescing);
    if (connection.runtimeServer) need(await connection.runtimeServer.close());
    if (connection.modelServer) need(await connection.modelServer.close());
    if (connection.authorityServer) need(await connection.authorityServer.close());
    if (connection.cloudStore) need(await connection.cloudStore.close());
    await database.close(); await beforeReconnect?.(); database = need(openTestDatabase(paths)); connection = await connect();
  };
  return { get database() { return database; }, paths, cloudRoot, configuration, provider, get governor() { return connection.governor; },
    get contexts() { return connection.contexts; }, get models() { return connection.models; }, get observer() { return connection.observer; },
    get runtime() { return connection.runtime; }, get coordinator() { return connection.coordinator; },
    get service() { return connection.service; }, get tasks() { return connection.tasks; }, requests, wireRequests, owned, errors,
    runtimeRpcRequests: () => rpcRequests, authorityRpcRequests: () => authorityRequests, authorityCallbackRequests: () => callbackRequests, childObservations, phaseObservations,
    get cloudStore() { return connection.cloudStore; }, authorityToolRequests: () => toolRequests, authoritySubagentRequests: () => childRequests, authorityCompactionRequests: () => compactionRequests,
    usedRuntimeService: () => Boolean(connection.cloudRuntimeService), authorityResultRequests: () => resultRequests,
    setResultDelivery: (value: boolean) => { resultDelivery = value; }, loseNextResultReceipt: () => { loseResultReceipt = true; },
    create, work, item, supplement, start, restart, holdNext };
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

test('the local coordinator leaves a cloud Work queued instead of executing it locally', async () => {
  const f = await fixture('no-candidate');
  const request: InvoiceWorkCreateRequest = { personalAgentId: 1, expectedAgentRevision: 0, requestId: 'cloud-not-local',
    goal: 'Review this cloud invoice.', documents: [{ id: 1, version: 'v1' }] };
  const created = need(await f.database.transaction(scope => scope.invoiceWorks.create(request, { at: now(), admission: { kind: 'queued' },
    runtimeOwner: { cloudRuntimeId: '11111111-1111-4111-8111-111111111111', workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })));
  if (!created.execution.attempt) throw Error('Expected the cloud attempt.');
  const item = (await f.work(created.workId)).items[0]!;
  need(await f.database.transaction(scope => scope.invoiceWorks.freezePhase({ workId: created.workId,
    attemptId: created.execution.attempt!.attemptId, itemId: item.itemId, requestId: 'cloud-pending-phase', kind: 'prompt', at: now(),
    basis: { contextSnapshotId: null, inputIds: [], documentRefs: [item.documentRef], configurationRevision: 0, itemRevision: item.revision } })));
  const local = await f.create('local-after-cloud', [1]);
  await f.start();
  expect(f.requests).toHaveLength(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM runs WHERE session_id=?').get(created.sessionId))).toEqual({ count: 0 });
  expect((await f.work(local.workId)).work.execution.runStatus).toBe('completed');
  expect((await f.work(created.workId)).work.execution).toMatchObject({ queued: true, runStatus: null });
}, 15_000);

test.each([false, true])('cloud coordinator advances a third Work while the first is held; isolated storage=%s', async isolated => {
  const f = await fixture('no-candidate', 'off', 'cloud', isolated);
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const create = async (requestId: string, cloudRuntimeId: string) => need(await f.database.transaction(scope => scope.invoiceWorks.create({
    personalAgentId: 1, expectedAgentRevision: 0, requestId, goal: 'Review this original cloud invoice.',
    documents: [{ id: 1, version: 'v1' }] }, { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId, cloudRuntimeId } })));
  const first = await create('cloud-independent-first', '11111111-1111-4111-8111-111111111111');
  const gate = f.holdNext(); f.coordinator.wake(); await waitFor(async () => f.requests.length > 0, 3_000); await gate.entered.promise;
  const second = await create('cloud-independent-second', '22222222-2222-4222-8222-222222222222');
  const third = await create('cloud-independent-third', '33333333-3333-4333-8333-333333333333');
  try {
    for (let index = 0; index < 5; index++) f.coordinator.wake();
    await waitFor(async () => f.requests.length >= 3);
    expect(f.requests.map(context => context.work.workId)).toEqual([first.workId, second.workId, third.workId]);
    expect((await f.work(first.workId)).work.execution.runStatus).toBe('running');
    expect((await f.work(second.workId)).work.execution.runStatus).toBe('completed');
    expect(f.requests.filter(context => context.work.workId === first.workId)).toHaveLength(1);
  } finally { gate.release.resolve(); }
  need(await f.coordinator.drain());
  expect(f.errors).toEqual([]);
}, 20_000);

test('cloud coordinator records the original native Session before preparing a model or submitting a phase', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud');
  const created = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-bind-before-model', goal: 'Review the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  const originalPrepare = f.runtime.prepareModel.bind(f.runtime);
  let bindingAtPrepare: number | null = null;
  f.runtime.prepareModel = async input => {
    const session = need(await f.database.read(scope => scope.sessions.get(input.sessionId)));
    if (session.runtimeKind === 'durable') bindingAtPrepare = session.durableConversationId;
    return originalPrepare(input);
  };
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect(bindingAtPrepare).toBeGreaterThan(0);
  const session = need(await f.database.read(scope => scope.sessions.get(created.sessionId)));
  expect(session.runtimeKind === 'durable' && session.durableConversationId).toBe(bindingAtPrepare);
  expect(f.requests).toHaveLength(1);
}, 15_000);

test('cloud coordination uses isolated real Durable stores even when their native Session IDs coincide', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true);
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const create = async (requestId: string, cloudRuntimeId: string) => need(await f.database.transaction(scope => scope.invoiceWorks.create({
    personalAgentId: 1, expectedAgentRevision: 0, requestId, goal: 'Review the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId, cloudRuntimeId } })));
  const first = await create('cloud-isolated-first', '11111111-1111-4111-8111-111111111111');
  f.coordinator.wake(); need(await f.coordinator.drain());
  const second = await create('cloud-isolated-second', '22222222-2222-4222-8222-222222222222');
  f.coordinator.wake(); need(await f.coordinator.drain());
  const sessions = await f.database.read(scope => scope.db.query<{ durable_runtime_id: string; durable_conversation_id: number }, [number, number]>(
    'SELECT durable_runtime_id,durable_conversation_id FROM sessions WHERE id IN (?,?) ORDER BY id').all(first.sessionId, second.sessionId));
  expect(sessions).toHaveLength(2);
  expect(sessions[0]!.durable_runtime_id).not.toBe(sessions[1]!.durable_runtime_id);
  expect(sessions[0]!.durable_conversation_id).toBe(sessions[1]!.durable_conversation_id);
  expect(f.requests.map(context => context.work.workId)).toEqual([first.workId, second.workId]);
}, 15_000);

test('native cloud result outbox keeps the exact original submission across reopen and duplicate delivery', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true);
  const binding = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111' };
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-outbox-original', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: binding })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  const phase = await f.database.read(scope => scope.db.query<{ request_id: string; attempt_id: number }, [number]>(
    'SELECT request_id,attempt_id FROM invoice_work_phases WHERE work_id=?').get(work.workId));
  if (!phase || !f.cloudStore) throw Error('Expected the original native phase and isolated store.');
  const query = { workId: work.workId, sessionId: work.sessionId, attemptId: phase.attempt_id, requestId: phase.request_id };
  const view = need(await f.runtime.getSubmission(query)), observation = need(await f.runtime.observeSubmission(query));
  if (!view || !observation || view.status !== 'done') throw Error('Expected the original native completion.');
  const session = need(await f.cloudStore.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
  const submission = await session.storage.submission(view.nativeSubmissionId as SubmissionId, BACKGROUND_CONTEXT);
  if (!submission || submission.type !== 'input' || submission.status !== 'done') throw Error('Expected the original submitted answer.');
  const event = { version: 1 as const, ...binding, ...query, nativeConversationId: view.nativeConversationId,
    nativeSubmissionId: view.nativeSubmissionId, nativeInputEntryId: observation.nativeEntryId, nativeAnswerEntryId: submission.answer,
    consumedAt: observation.consumedAt, status: view.status, answer: view.answer, reason: view.reason };
  expect(await session.enqueueResult({ ...event, answer: 'Changed original answer.' })).toMatchObject({ ok: false });
  need(await session.enqueueResult(event)); need(await session.enqueueResult(event));
  expect(await session.enqueueResult({ ...event, answer: 'Changed original answer.' })).toMatchObject({ ok: false });
  expect(need(await session.pendingResults())).toMatchObject([{ event, attempts: 0 }]);
  let historyChunks = 0;
  const boundedHistory = { getSubmission: f.runtime.getSubmission.bind(f.runtime), observeSubmission: f.runtime.observeSubmission.bind(f.runtime),
    queryHistory: async () => fail(appError('cloud_transport_unavailable', 'runtime', 'A full history page exceeds the transport boundary.')),
    queryHistoryEntry: (input: Parameters<DurableRuntimePort['queryHistoryEntry']>[0]) => { historyChunks++;
      return f.runtime.queryHistoryEntry({ ...input, limit: 17 }); } };
  const firstReceipt = need(await new CloudNativeResultReceiver(f.database, boundedHistory, now).receive(event));
  expect(historyChunks).toBeGreaterThan(1);
  if (process.platform === 'linux') {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-result-wake-')); let wakes = 0;
    const personal = { cloudAuthority: { workspaceId: binding.workspaceId, governor: f.governor, callbacks: {}, tools: [], attachQueue: () => {},
      reconcilePhase: async () => ok(null) }, personal: {}, conditionsChanged: () => { wakes++; } } as unknown as import('../../../apps/personal-agent.ts').PersonalAgentRuntime;
    const endpoints = need(await startCloudAuthorityEndpoints({ workspaceId: binding.workspaceId, database: f.database, personal, runtime: f.runtime,
      files: createFileStore(f.paths, f.database), inspect: () => fail(appError('source_invalid', 'input', 'Unused.')),
      now, readApiKey: () => undefined, desktopSocket: join(root, 'desktop.sock'), authoritySocket: join(root, 'authority.sock'), modelSocket: join(root, 'model.sock') }));
    try {
      expect(await callCloudUnixRpc(join(root, 'authority.sock'), { version: 1, method: 'nativeResult', request: event }))
        .toEqual({ ok: true, data: { ok: true, data: firstReceipt } });
      expect(wakes).toBe(1);
    } finally { need(await endpoints.close()); }
  }
  await f.restart();
  if (!f.cloudStore) throw Error('Expected the reopened isolated store.');
  const reopened = need(await f.cloudStore.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
  expect(need(await reopened.pendingResults())).toMatchObject([{ event, attempts: 0 }]);
  expect(need(await new CloudNativeResultReceiver(f.database, f.runtime, now).receive(event))).toEqual(firstReceipt);
  const failure = { deliveryId: crypto.randomUUID(), at: '2000-01-01T00:00:00.000Z', nextAt: '2000-01-01T00:00:01.000Z' };
  need(await reopened.recordDeliveryFailure(event, failure)); need(await reopened.recordDeliveryFailure(event, failure));
  expect(need(await reopened.pendingResults())).toMatchObject([{ event, attempts: 1 }]);
  for (let index = 0; index < 7; index++) need(await reopened.recordDeliveryFailure(event, { ...failure, deliveryId: crypto.randomUUID() }));
  expect(need(await reopened.pendingResults())).toEqual([]);
  expect(need(await reopened.listResults({ attemptId: query.attemptId, limit: 10 }))).toMatchObject({
    items: [{ requestId: query.requestId, nativeSubmissionId: event.nativeSubmissionId, state: 'blocked', attempts: 8 }], nextAfterSubmissionId: null });
  expect(await reopened.retryResultByIdentity({ attemptId: query.attemptId, requestId: 'another-phase', nativeSubmissionId: event.nativeSubmissionId }))
    .toMatchObject({ ok: false });
  need(await reopened.retryResultByIdentity({ attemptId: query.attemptId, requestId: query.requestId, nativeSubmissionId: event.nativeSubmissionId }));
  expect(need(await reopened.pendingResults())).toMatchObject([{ event, attempts: 0 }]);
  expect(await reopened.acknowledgeResult(event, { ...firstReceipt, workId: firstReceipt.workId + 1 })).toMatchObject({ ok: false });
  expect(need(await reopened.pendingResults())).toHaveLength(1);
  need(await reopened.acknowledgeResult(event, firstReceipt)); need(await reopened.acknowledgeResult(event, firstReceipt));
  expect(await reopened.acknowledgeResult(event, { ...firstReceipt, receiptId: '22222222-2222-4222-8222-222222222222' })).toMatchObject({ ok: false });
  expect(need(await reopened.pendingResults())).toEqual([]);
}, 15_000);

test('an oversized native answer stays available in its original entry and is shown as blocked', async () => {
  const f = await fixture('oversize', 'off', 'cloud', true, true);
  const binding = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111' };
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-oversized-result', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: binding })));
  f.coordinator.wake();
  let attemptId = 0;
  await waitFor(async () => { const phase = await f.database.read(scope => scope.db.query<{ attempt_id: number }, [number]>(
    'SELECT attempt_id FROM invoice_work_phases WHERE work_id=?').get(work.workId)); if (!phase) return false;
    attemptId = phase.attempt_id; const session = need(await f.cloudStore!.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
    return need(await session.listResults({ attemptId })).items.some(item => item.state === 'blocked' && item.blockedReason === 'size_limit');
  }, 10_000);
  const session = need(await f.cloudStore!.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
  const result = need(await session.listResults({ attemptId })).items[0]!;
  expect(result).toMatchObject({ state: 'blocked', blockedReason: 'size_limit', nativeStatus: 'done' });
  expect(await session.retryResultByIdentity({ attemptId, requestId: result.requestId, nativeSubmissionId: result.nativeSubmissionId }))
    .toMatchObject({ ok: false, error: { code: 'cloud_result_too_large' } });
  expect(need(await session.pendingResults())).toEqual([]); expect(f.requests).toHaveLength(1);
  need(await f.coordinator.drain());
  const saved = await f.database.read(scope => scope.db.query<{ run_id: number }, [number]>('SELECT run_id FROM invoice_work_attempts WHERE id=?').get(attemptId));
  if (!saved) throw Error('Expected the original run.');
  expect(need(await f.database.read(scope => scope.runs.get(saved.run_id)))).toMatchObject({ status: 'failed', output: null, error: { code: 'cloud_result_too_large' } });
  await f.restart();
  const reopened = need(await f.cloudStore!.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
  expect(need(await reopened.listResults({ attemptId })).items[0]).toMatchObject({ ...result });
  const submission = await reopened.storage.submission(result.nativeSubmissionId as SubmissionId, BACKGROUND_CONTEXT);
  if (!submission || submission.type !== 'input' || submission.status !== 'done') throw Error('Expected the original completed submission.');
  const entry = await reopened.storage.entry(submission.answer, BACKGROUND_CONTEXT);
  expect(JSON.stringify(entry)).toContain('x'.repeat(262_145));
  expect(f.requests).toHaveLength(1);
}, 20_000);

test('cloud Runtime automatically records a completed native Submission in its outbox', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true);
  const binding = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111' };
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-auto-outbox', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: binding })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  if (!f.cloudStore) throw Error('Expected the original cloud store.');
  const session = need(await f.cloudStore.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
  await waitFor(async () => need(await session.pendingResults()).length === 1, 3_000);
  expect(need(await session.pendingResults())[0]!.event).toMatchObject({ workId: work.workId, sessionId: work.sessionId,
    status: 'done', nativeAnswerEntryId: expect.any(Number), answer: 'Original phase completed for human review.' });
}, 15_000);

test('a confirmed retryable cloud model failure uses a new durable attempt and the original Work budget', async () => {
  const f = await fixture('retryable', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-retryable-503', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed'); expect(f.requests).toHaveLength(2);
  const attempts = await f.database.read(scope => scope.db.query<{ model_attempt_id: string; transport_ordinal: number; state: string; http_status: number }, [number]>(
    'SELECT model_attempt_id,transport_ordinal,state,http_status FROM cloud_model_attempts WHERE work_id=? ORDER BY transport_ordinal').all(work.workId));
  expect(attempts.map(({ transport_ordinal, state, http_status }) => ({ transport_ordinal, state, http_status }))).toEqual([
    { transport_ordinal: 0, state: 'confirmed', http_status: 503 }, { transport_ordinal: 1, state: 'confirmed', http_status: 200 }]);
  expect(attempts[0]!.model_attempt_id).not.toBe(attempts[1]!.model_attempt_id);
  expect(need(await f.governor.remainingBudget(work.workId)).modelCalls).toBe(14);
}, 20_000);

test.skipIf(process.platform !== 'linux')('the independent cloud Runtime retries a confirmed 503 through Authority sockets', async () => {
  const f = await fixture('retryable', 'off', 'cloud', true, true, true, true, true, true, true, false, false, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-socket-retryable', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed'); expect(f.requests).toHaveLength(2);
  const attempts = await f.database.read(scope => scope.db.query<{ transport_ordinal: number; http_status: number }, [number]>(
    'SELECT transport_ordinal,http_status FROM cloud_model_attempts WHERE work_id=? ORDER BY transport_ordinal').all(work.workId));
  expect(attempts).toEqual([{ transport_ordinal: 0, http_status: 503 }, { transport_ordinal: 1, http_status: 200 }]);
}, 20_000);

test('restart after a confirmed retryable failure reuses the original checkpoint and does not resend the failed attempt', async () => {
  const f = await fixture('retryable', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-retryable-restart', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake();
  await waitFor(async () => !!await f.database.read(scope => scope.db.query("SELECT model_attempt_id FROM cloud_model_attempts WHERE state='confirmed' AND http_status=503").get()), 5_000);
  expect(f.requests).toHaveLength(1);
  await f.restart(); need(await f.coordinator.recover());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed'); expect(f.requests).toHaveLength(2);
  const attempts = await f.database.read(scope => scope.db.query<{ transport_ordinal: number; http_status: number }, [number]>(
    'SELECT transport_ordinal,http_status FROM cloud_model_attempts WHERE work_id=? ORDER BY transport_ordinal').all(work.workId));
  expect(attempts).toEqual([{ transport_ordinal: 0, http_status: 503 }, { transport_ordinal: 1, http_status: 200 }]);
}, 20_000);

test('repeated confirmed 503 failures stop after four original-checkpoint attempts', async () => {
  const f = await fixture('fail', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-retryable-exhausted', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('failed'); expect(f.requests).toHaveLength(4);
  const attempts = await f.database.read(scope => scope.db.query<{ transport_ordinal: number; http_status: number }, [number]>(
    'SELECT transport_ordinal,http_status FROM cloud_model_attempts WHERE work_id=? ORDER BY transport_ordinal').all(work.workId));
  expect(attempts).toEqual([0, 1, 2, 3].map(transport_ordinal => ({ transport_ordinal, http_status: 503 })));
  expect(need(await f.governor.remainingBudget(work.workId)).modelCalls).toBe(12);
}, 20_000);

test('reopening a cloud Session repairs a missing outbox record without repeating its model request', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true);
  const binding = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111' };
  if (!f.cloudStore) throw Error('Expected the original cloud store.');
  const open = f.cloudStore.openSession.bind(f.cloudStore);
  f.cloudStore.openSession = async (...input) => {
    const result = await open(...input);
    if (result.ok) result.data.enqueueResult = async () => fail(appError('cloud_result_unavailable', 'runtime', 'Controlled outbox interruption.', true));
    return result;
  };
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-outbox-repair', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: binding })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  const phase = await f.database.read(scope => scope.db.query<{ request_id: string; attempt_id: number }, [number]>(
    'SELECT request_id,attempt_id FROM invoice_work_phases WHERE work_id=?').get(work.workId));
  if (!phase) throw Error('Expected the original cloud phase.');
  const originalCalls = f.requests.length; expect(originalCalls).toBe(1);
  await f.restart();
  need(await f.runtime.getSubmission({ workId: work.workId, sessionId: work.sessionId, attemptId: phase.attempt_id, requestId: phase.request_id }));
  if (!f.cloudStore) throw Error('Expected the reopened cloud store.');
  const session = need(await f.cloudStore.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
  await waitFor(async () => need(await session.pendingResults()).length === 1, 3_000);
  expect(need(await session.pendingResults())[0]!.event).toMatchObject({ workId: work.workId, status: 'done' });
  expect(f.requests).toHaveLength(originalCalls);
}, 15_000);

test('a real isolated cloud generation passes through the Authority model-attempt proxy', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-proxy-generation', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  const attempts = await f.database.read(scope => scope.db.query<{ state: string; request_json: string }, []>(
    'SELECT state,request_json FROM cloud_model_attempts').all());
  expect(attempts).toHaveLength(1); expect(attempts[0]!.state).toBe('confirmed');
  expect(JSON.parse(attempts[0]!.request_json)).toMatchObject({ workId: work.workId, sessionId: work.sessionId,
    model: 'coordination-local-model', nativeTaskId: expect.any(Number), checkpointEntryId: expect.any(Number),
    modelAttemptId: expect.any(String) });
}, 15_000);

test('a cloud invoice child uses the same Authority proxy and shared Work model budget', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-proxy-child', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); const settled = await f.coordinator.drain();
  if (!settled.ok) throw Error(JSON.stringify({ error: settled.error, reports: f.errors, phaseObservations: f.phaseObservations }));
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  const childRuns = await f.database.read(scope => scope.db.query('SELECT status,error_json FROM runs WHERE kind=\'subagent\'').all());
  expect(childRuns).toMatchObject([{ status: 'completed' }]);
  const attempts = await f.database.read(scope => scope.db.query<{ state: string; request_json: string }, []>(
    'SELECT state,request_json FROM cloud_model_attempts ORDER BY created_at,rowid').all());
  const facts = attempts.map(value => ({ state: value.state, request: JSON.parse(value.request_json) }));
  expect(facts.filter(value => value.request.child)).toHaveLength(1);
  if (!facts.every(value => value.state === 'confirmed')) throw Error(JSON.stringify({ states: facts.map(value => ({ state: value.state,
    nativeTaskId: value.request.nativeTaskId, child: Boolean(value.request.child) })), reports: f.errors, phaseObservations: f.phaseObservations }));
  expect(facts.every(value => value.state === 'confirmed')).toBe(true);
  const child = facts.find(value => value.request.child)!;
  const target = { workId: work.workId, sessionId: work.sessionId, attemptId: child.request.attemptId,
    childRunId: child.request.child.childRunId, originToolCallId: child.request.child.originToolCallId };
  expect(child.request).toMatchObject({ workId: work.workId, child: { childRunId: expect.any(Number), childSessionId: expect.any(Number) } });
  expect(need(await f.governor.remainingBudget(work.workId)).modelCalls).toBe(16 - facts.length);
  const report = createCloudChildReportReader(f.database, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  expect(need(await report(target))).toMatchObject({ ...target, output: { text: expect.any(String) } });
  expect(await report({ ...target, originToolCallId: target.originToolCallId + 1 })).toMatchObject({ ok: false });
  const anotherWorkspace = createCloudChildReportReader(f.database, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  expect(await anotherWorkspace(target)).toMatchObject({ ok: false });
}, 20_000);

test('a confirmed retryable child model failure retains the original child and uses a new attempt', async () => {
  const f = await fixture('child-retryable', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-child-retryable', goal: 'Check this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  const attempts = await f.database.read(scope => scope.db.query<{ request_json: string; transport_ordinal: number; http_status: number }, [number]>(
    "SELECT request_json,transport_ordinal,http_status FROM cloud_model_attempts WHERE work_id=? AND json_extract(request_json,'$.child') IS NOT NULL ORDER BY transport_ordinal").all(work.workId));
  expect(attempts.map(value => [value.transport_ordinal, value.http_status])).toEqual([[0, 503], [1, 200]]);
  const children = attempts.map(value => JSON.parse(value.request_json).child.childRunId);
  expect(children[0]).toBe(children[1]);
  expect(await f.database.read(scope => scope.db.query("SELECT COUNT(*) count FROM runs WHERE kind='subagent'").get())).toEqual({ count: 1 });
}, 20_000);

test.skipIf(process.platform !== 'linux')('native cloud parent and child use the real Unix model socket with Authority reservations', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-socket-child', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  const attempts = await f.database.read(scope => scope.db.query<{ state: string; child: number }, []>(
    "SELECT state,json_extract(request_json,'$.child.childRunId') child FROM cloud_model_attempts ORDER BY rowid").all());
  expect(attempts.filter(value => value.child !== null)).toHaveLength(1);
  expect(attempts.every(value => value.state === 'confirmed')).toBe(true);
  expect(need(await f.governor.remainingBudget(work.workId)).modelCalls).toBe(16 - attempts.length);
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud parent and child cross both Runtime and model Unix sockets', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-two-sockets', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  expect(f.runtimeRpcRequests()).toBeGreaterThan(5);
  const attempts = await f.database.read(scope => scope.db.query<{ state: string; child: number | null }, []>(
    "SELECT state,json_extract(request_json,'$.child.childRunId') child FROM cloud_model_attempts").all());
  expect(attempts.filter(value => value.child !== null)).toHaveLength(1);
  expect(attempts.every(value => value.state === 'confirmed')).toBe(true);
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud parent and child recheck product authority across a third Unix socket', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-three-sockets', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  expect(f.authorityRpcRequests()).toBeGreaterThan(10);
  expect(f.runtimeRpcRequests()).toBeGreaterThan(5);
  const attempts = await f.database.read(scope => scope.db.query<{ state: string; child: number | null }, []>(
    "SELECT state,json_extract(request_json,'$.child.childRunId') child FROM cloud_model_attempts").all());
  expect(attempts.filter(value => value.child !== null)).toHaveLength(1);
  expect(attempts.every(value => value.state === 'confirmed')).toBe(true);
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud native context and model authorization use the Authority callback socket', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-authority-callbacks', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  expect(f.authorityCallbackRequests()).toBeGreaterThan(3);
  const attempts = await f.database.read(scope => scope.db.query<{ state: string; child: number | null }, []>(
    "SELECT state,json_extract(request_json,'$.child.childRunId') child FROM cloud_model_attempts").all());
  expect(attempts.filter(value => value.child !== null)).toHaveLength(1);
  expect(attempts.every(value => value.state === 'confirmed')).toBe(true);
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud invoice tools execute and deliver original receipts through the Authority socket', async () => {
  const f = await fixture('candidate', 'off', 'cloud', true, true, true, true, true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-authority-tools', goal: 'Prepare the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  const view = await f.work(work.workId);
  expect(view.work.execution.runStatus).toBe('completed'); expect(view.items[0]!.candidateRef).not.toBeNull();
  expect(f.authorityToolRequests()).toBeGreaterThan(1);
  const tools = await f.database.read(scope => scope.db.query<{ result_json: string | null }, []>(
    'SELECT result_json FROM tool_calls ORDER BY id').all());
  expect(tools).toHaveLength(2); expect(tools.every(call => call.result_json !== null)).toBe(true);
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud invoice delegation crosses the Authority socket and returns the original child result', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true, true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-authority-delegation', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake();
  const settled = await f.coordinator.drain();
  if (!settled.ok) throw Error(JSON.stringify({ error: settled.error, reports: f.errors,
    runs: await f.database.read(scope => scope.db.query('SELECT id,kind,status,session_id,ended_at,stopped_at,error_json FROM runs').all()),
    sessions: await f.database.read(scope => scope.db.query('SELECT id,durable_conversation_id FROM sessions').all()),
    calls: await f.database.read(scope => scope.db.query('SELECT id,tool_name,status,stopped_at FROM tool_calls').all()),
    observations: f.childObservations, phases: await f.database.read(scope => scope.db.query('SELECT id,created_at,consumed_at,closed_at FROM invoice_work_phases').all()),
    phaseObservations: f.phaseObservations }));
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  const children = await f.database.read(scope => scope.db.query<{ status: string }, []>("SELECT status FROM runs WHERE kind='subagent'").all());
  expect(children).toEqual([{ status: 'completed' }]);
  expect(f.authorityToolRequests()).toBeGreaterThan(1);
  const calls = await f.database.read(scope => scope.db.query<{ child: number | null }, []>(
    "SELECT json_extract(request_json,'$.child.childRunId') child FROM cloud_model_attempts").all());
  expect(calls.filter(value => value.child !== null)).toHaveLength(1);
  const observed = f.childObservations.find(value => (value as { creation?: string }).creation === 'created') as import('@flowmate/contracts').DurableSubagentObservation | undefined;
  if (!observed) throw Error('The original child observation is missing.');
  const child = { workId: observed.workId, sessionId: observed.sessionId, attemptId: observed.attemptId, requestId: observed.requestId,
    childRunId: observed.childRunId, childSessionId: observed.childSessionId, originToolCallId: observed.originToolCallId,
    nativeToolTaskId: observed.nativeToolTaskId };
  const history = need(await f.runtime.queryHistoryPage({ workId: work.workId, sessionId: work.sessionId, child, limit: 100 }));
  expect(history.owner).toMatchObject({ workId: work.workId, sessionId: child.childSessionId, childRunId: child.childRunId });
  expect(history.entries.length).toBeGreaterThan(0);
  expect(await f.runtime.queryHistoryPage({ workId: work.workId, sessionId: work.sessionId,
    child: { ...child, requestId: 'another-original-phase' }, limit: 100 })).toMatchObject({ ok: false });
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud child plan, adoption and consumption callbacks cross the Authority socket', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true, true, true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-child-callbacks', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); const settled = await f.coordinator.drain();
  if (!settled.ok) throw Error(JSON.stringify({ error: settled.error, reports: f.errors,
    phases: await f.database.read(scope => scope.db.query('SELECT id,created_at,consumed_at,closed_at FROM invoice_work_phases').all()),
    runs: await f.database.read(scope => scope.db.query('SELECT id,kind,status,session_id,ended_at,stopped_at,error_json FROM runs').all()),
    observations: f.childObservations, phaseObservations: f.phaseObservations }));
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  expect(f.authoritySubagentRequests()).toBeGreaterThan(2);
  const children = await f.database.read(scope => scope.db.query<{ status: string }, []>("SELECT status FROM runs WHERE kind='subagent'").all());
  expect(children).toEqual([{ status: 'completed' }]);
}, 20_000);

test.skipIf(process.platform !== 'linux')('the cloud Runtime service executes a parent and child using only its sockets and native store', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true, true, true, true, true, false, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-runtime-service', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); const settled = await f.coordinator.drain();
  if (!settled.ok) throw Error(JSON.stringify({ error: settled.error, reports: f.errors,
    phases: await f.database.read(scope => scope.db.query('SELECT id,created_at,consumed_at,closed_at FROM invoice_work_phases').all()),
    attempts: await f.database.read(scope => scope.db.query('SELECT id,run_id,stop_requested_at,stopped_at FROM invoice_work_attempts').all()),
    runs: await f.database.read(scope => scope.db.query('SELECT id,kind,status,started_at,ended_at,stopped_at FROM runs').all()),
    observations: f.childObservations, phaseObservations: f.phaseObservations }));
  expect(f.usedRuntimeService()).toBe(true);
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  expect(f.authoritySubagentRequests()).toBeGreaterThan(2);
  expect(f.authorityToolRequests()).toBeGreaterThan(1);
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud Runtime delivers the original native terminal result to Authority automatically', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true, true, true, true, true, true, false, false, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-runtime-result-delivery', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); const settled = await f.coordinator.drain();
  if (!settled.ok) throw Error(JSON.stringify({ error: settled.error, reports: f.errors,
    phases: await f.database.read(scope => scope.db.query('SELECT id,created_at,consumed_at,closed_at FROM invoice_work_phases').all()),
    attempts: await f.database.read(scope => scope.db.query('SELECT id,run_id,stop_requested_at,stopped_at FROM invoice_work_attempts').all()),
    runs: await f.database.read(scope => scope.db.query('SELECT id,kind,status,started_at,ended_at,stopped_at FROM runs').all()),
    phaseObservations: f.phaseObservations }));
  await waitFor(async () => (await f.database.read(scope => scope.db.query<{ count: number }, [number]>(
    'SELECT COUNT(*) count FROM cloud_native_result_receipts WHERE work_id=?').get(work.workId)))!.count === 1, 3_000);
  expect(f.requests).toHaveLength(1);
}, 20_000);

test.skipIf(process.platform !== 'linux')('a restarted Runtime redelivers its persisted native result when Authority returns', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true, true, true, true, true, true, false, false, true);
  f.setResultDelivery(false);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-result-restart', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  await waitFor(async () => f.authorityResultRequests() > 0, 3_000);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM cloud_native_result_receipts').get())).toEqual({ count: 0 });
  const phase = await f.database.read(scope => scope.db.query<{ attempt_id: number }, [number]>(
    'SELECT attempt_id FROM invoice_work_phases WHERE work_id=?').get(work.workId));
  if (!phase) throw Error('Expected the original phase.');
  const owner = { workId: work.workId, sessionId: work.sessionId, attemptId: phase.attempt_id };
  const before = need(await (f.runtime as DurableRuntimePort & { delivery: CloudRuntimeDeliveryPort }).delivery.status(owner));
  await f.restart(); f.setResultDelivery(true);
  const after = need(await (f.runtime as DurableRuntimePort & { delivery: CloudRuntimeDeliveryPort }).delivery.status(owner));
  expect(after.runtimeGeneration).not.toBe(before.runtimeGeneration); expect(after.observationRevision).toBeGreaterThanOrEqual(before.observationRevision);
  await waitFor(async () => (await f.database.read(scope => scope.db.query<{ count: number }, [number]>(
    'SELECT COUNT(*) count FROM cloud_native_result_receipts WHERE work_id=?').get(work.workId)))!.count === 1, 6_000);
  expect(f.requests).toHaveLength(1);
}, 20_000);

test.skipIf(process.platform !== 'linux')('manual delivery retry after a blocked outbox keeps the original result without another model call', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true, true, true, true, true, true, false, false, true);
  f.setResultDelivery(false);
  const binding = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111' };
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-result-manual-retry', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: binding })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  await waitFor(async () => f.authorityResultRequests() > 0, 3_000);
  const phase = await f.database.read(scope => scope.db.query<{ request_id: string; attempt_id: number }, [number]>(
    'SELECT request_id,attempt_id FROM invoice_work_phases WHERE work_id=?').get(work.workId));
  if (!phase) throw Error('Expected the original phase.');
  let nativeSubmissionId = 0;
  await f.restart(async () => {
    const store = need(await openCloudRuntimeStore(f.cloudRoot));
    try {
      const session = need(await store.openSession({ ...binding, workId: work.workId, sessionId: work.sessionId }, false));
      await waitFor(async () => need(await session.pendingResults()).length === 1, 4_000);
      const original = need(await session.pendingResults())[0]!; nativeSubmissionId = original.event.nativeSubmissionId;
      for (let attempts = original.attempts; attempts < 8; attempts++) need(await session.recordDeliveryFailure(original.event,
        { deliveryId: crypto.randomUUID(), at: '2000-01-01T00:00:00.000Z', nextAt: '2000-01-01T00:00:01.000Z' }));
    } finally { need(await store.close()); }
  });
  const delivery = (f.runtime as DurableRuntimePort & { delivery: CloudRuntimeDeliveryPort }).delivery;
  const owner = { workId: work.workId, sessionId: work.sessionId, attemptId: phase.attempt_id };
  const original = { ...owner, requestId: phase.request_id, nativeSubmissionId };
  expect(need(await delivery.status(owner)).results.items).toMatchObject([{ requestId: original.requestId, nativeSubmissionId, state: 'blocked', attempts: 8 }]);
  expect(await delivery.retry({ ...original, nativeSubmissionId: nativeSubmissionId + 1 })).toMatchObject({ ok: false });
  f.setResultDelivery(true);
  expect(await delivery.retry(original)).toMatchObject({ ok: true, data: { ...original, state: 'pending' } });
  await waitFor(async () => (await f.database.read(scope => scope.db.query<{ count: number }, [number]>(
    'SELECT COUNT(*) count FROM cloud_native_result_receipts WHERE work_id=?').get(work.workId)))!.count === 1, 5_000);
  await waitFor(async () => need(await delivery.status(owner)).results.items[0]?.state === 'delivered', 5_000);
  expect(f.requests).toHaveLength(1);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM cloud_native_result_receipts').get())).toEqual({ count: 1 });
}, 25_000);

test.skipIf(process.platform !== 'linux')('a lost Authority result receipt is recovered without another model call or business receipt', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true, true, true, true, true, true, false, false, true);
  f.loseNextResultReceipt();
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-result-lost-ack', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  await waitFor(async () => f.authorityResultRequests() >= 2, 5_000);
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM cloud_native_result_receipts').get())).toEqual({ count: 1 });
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed'); expect(f.requests).toHaveLength(1);
}, 20_000);

test.skipIf(process.platform !== 'linux')('stopping a delegated cloud Work aborts its original child through both sockets', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true, true, true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-authority-delegation-stop', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  const gate = f.holdNext(1); f.coordinator.wake();
  try {
    await waitFor(async () => f.requests.some(context => Boolean(context.delegation)), 5_000);
    const current = await f.work(work.workId), attempt = current.work.execution.attempt;
    if (!attempt) throw Error('Expected the original cloud attempt.');
    const stopped = need(await f.tasks.stop({ workId: work.workId, attemptId: attempt.attemptId,
      requestId: 'cloud-original-stop', expectedRevision: current.work.revision }));
    expect(stopped.accepted).toBe(true);
  } finally { gate.release.resolve(); }
  need(await f.coordinator.drain());
  const current = await f.work(work.workId);
  expect(current.work.execution).toMatchObject({ runStatus: 'cancelled', stopUnconfirmed: false });
  expect(f.requests.filter(context => Boolean(context.delegation))).toHaveLength(1);
}, 20_000);

test.skipIf(process.platform !== 'linux')('a lost cross-socket cloud delegation never creates another child or resends its uncertain model call', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true, true, true, true, true, true);
  need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-cross-socket-child-restart', goal: 'Independently check the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  const gate = f.holdNext(1); f.coordinator.wake();
  await waitFor(async () => f.requests.some(context => Boolean(context.delegation)), 5_000);
  const before = await f.database.read(scope => scope.db.query<{ model_attempt_id: string }, []>(
    "SELECT model_attempt_id FROM cloud_model_attempts WHERE json_extract(request_json,'$.child') IS NOT NULL").get());
  expect(before).not.toBeNull();
  await f.restart(); gate.release.resolve();
  const recovered = await f.coordinator.recover();
  if (!recovered.ok) expect(['source_invalid', 'cloud_authorization_unavailable', 'tool_commit_unconfirmed', 'invoice_work_budget_unknown']).toContain(recovered.error.code);
  const children = await f.database.read(scope => scope.db.query<{ count: number }, []>("SELECT COUNT(*) count FROM runs WHERE kind='subagent'").get());
  expect(children).toEqual({ count: 1 });
  const attempts = await f.database.read(scope => scope.db.query<{ model_attempt_id: string; state: string }, []>(
    "SELECT model_attempt_id,state FROM cloud_model_attempts WHERE json_extract(request_json,'$.child') IS NOT NULL").all());
  expect(attempts).toEqual([{ model_attempt_id: before!.model_attempt_id, state: 'uncertain' }]);
  expect(f.requests.filter(context => Boolean(context.delegation))).toHaveLength(1);
}, 20_000);

test('cloud native compaction sends its summary through the same Authority proxy and Work budget', async () => {
  const f = await fixture('compaction', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-proxy-compaction', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  const summary = await f.database.read(scope => scope.db.query<{ request_json: string; state: string }, []>(
    "SELECT request_json,state FROM cloud_model_attempts WHERE json_extract(request_json,'$.kind')='compaction'").get());
  expect(summary?.state).toBe('confirmed');
  const original = JSON.parse(summary!.request_json);
  const observed = need(await f.runtime.queryCompaction({ workId: work.workId, sessionId: work.sessionId,
    attemptId: original.attemptId, requestId: original.requestId, operationId: original.compactionOperationId }));
  expect(observed).toMatchObject({ nativeTaskId: original.nativeTaskId, outcome: 'completed', summarySaved: true });
  const reservations = await f.database.read(scope => scope.db.query<{ count: number }, []>('SELECT SUM(count) count FROM invoice_work_model_reservations').get());
  const attempts = await f.database.read(scope => scope.db.query<{ count: number }, []>('SELECT COUNT(*) count FROM cloud_model_attempts').get());
  expect(reservations!.count).toBe(attempts!.count);
}, 20_000);

test('a confirmed retryable compaction failure retains the original summary task and uses a new attempt', async () => {
  const f = await fixture('compaction-retryable', 'off', 'cloud', true, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-compaction-retryable', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  const attempts = await f.database.read(scope => scope.db.query<{ request_json: string; transport_ordinal: number; http_status: number }, [number]>(
    "SELECT request_json,transport_ordinal,http_status FROM cloud_model_attempts WHERE work_id=? AND json_extract(request_json,'$.kind')='compaction' ORDER BY transport_ordinal").all(work.workId));
  expect(attempts.map(value => [value.transport_ordinal, value.http_status])).toEqual([[0, 503], [1, 200]]);
  const first = JSON.parse(attempts[0]!.request_json), second = JSON.parse(attempts[1]!.request_json);
  expect(first.nativeTaskId).toBe(second.nativeTaskId); expect(first.modelAttemptId).not.toBe(second.modelAttemptId);
  expect(need(await f.runtime.queryCompaction({ workId: work.workId, sessionId: work.sessionId, attemptId: first.attemptId,
    requestId: first.requestId, operationId: first.compactionOperationId }))).toMatchObject({ nativeTaskId: first.nativeTaskId, outcome: 'completed', summarySaved: true });
}, 20_000);

test.skipIf(process.platform !== 'linux')('cloud compaction verifies its original plan through the Authority callback socket', async () => {
  const f = await fixture('compaction', 'off', 'cloud', true, true, true, true, true, true, true, false, true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-compaction-callbacks', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect(f.authorityCompactionRequests()).toBeGreaterThan(1);
  const attempts = await f.database.read(scope => scope.db.query<{ state: string }, [number]>(
    "SELECT state FROM cloud_model_attempts WHERE work_id=? AND json_extract(request_json,'$.kind')='compaction'").all(work.workId));
  expect(attempts).toEqual([{ state: 'confirmed' }]);
}, 20_000);

test('a lost real cloud generation response is not sent upstream again after runtime restart', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true, true);
  need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-proxy-lost-response', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  const gate = f.holdNext(); f.coordinator.wake(); await waitFor(async () => f.requests.length > 0, 3_000);
  const before = await f.database.read(scope => scope.db.query<{ model_attempt_id: string; state: string }, []>(
    'SELECT model_attempt_id,state FROM cloud_model_attempts').get());
  expect(before).toMatchObject({ model_attempt_id: expect.any(String), state: 'sending' });
  await f.restart(); gate.release.resolve();
  need(await f.coordinator.recover());
  const after = await f.database.read(scope => scope.db.query<{ model_attempt_id: string; state: string }, []>(
    'SELECT model_attempt_id,state FROM cloud_model_attempts').all());
  expect(after).toEqual([{ model_attempt_id: before!.model_attempt_id, state: 'uncertain' }]);
  expect(f.requests).toHaveLength(1);
}, 15_000);

test('a lost cloud child response keeps its original model identity after runtime restart', async () => {
  const f = await fixture('child', 'off', 'cloud', true, true);
  need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-proxy-lost-child', goal: 'Independently check this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  const gate = f.holdNext(1); f.coordinator.wake(); await waitFor(async () => f.requests.some(context => Boolean(context.delegation)), 5_000);
  const before = await f.database.read(scope => scope.db.query<{ model_attempt_id: string; state: string }, []>(
    "SELECT model_attempt_id,state FROM cloud_model_attempts WHERE json_extract(request_json,'$.child') IS NOT NULL").get());
  expect(before).toMatchObject({ model_attempt_id: expect.any(String), state: 'sending' });
  await f.restart(); gate.release.resolve();
  need(await f.coordinator.recover());
  const after = await f.database.read(scope => scope.db.query<{ model_attempt_id: string; state: string }, []>(
    "SELECT model_attempt_id,state FROM cloud_model_attempts WHERE json_extract(request_json,'$.child') IS NOT NULL").all());
  expect(after).toEqual([{ model_attempt_id: before!.model_attempt_id, state: 'uncertain' }]);
  expect(f.requests.filter(context => Boolean(context.delegation))).toHaveLength(1);
}, 20_000);

test('isolated cloud runtime can shut down while a native model request remains held', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true);
  need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-shutdown-held', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  const gate = f.holdNext(); f.coordinator.wake(); await waitFor(async () => f.requests.length > 0, 3_000);
  const restarting = f.restart();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([restarting.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    expect(closed).toBe(true);
  } finally { if (timer) clearTimeout(timer); gate.release.resolve(); await restarting; }
}, 15_000);

test('isolated cloud coordinator recovers queued original Works after restarting before native allocation', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true);
  const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const runtimes = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const works = await Promise.all(runtimes.map((cloudRuntimeId, index) => f.database.transaction(scope => need(scope.invoiceWorks.create({
    personalAgentId: 1, expectedAgentRevision: 0, requestId: `cloud-recover-queued-${index}`,
    goal: 'Review the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId, cloudRuntimeId } })) )));
  await f.restart(); need(await f.coordinator.recover());
  expect(f.requests.map(context => context.work.workId).sort()).toEqual(works.map(work => work.workId).sort());
  for (const work of works) expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
  expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) count FROM invoice_work_attempts').get())).toEqual({ count: 2 });
}, 15_000);

test('cloud recovery keeps the original recovery intent after a temporary model-binding failure', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true);
  const work = need(await f.database.transaction(scope => scope.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 0,
    requestId: 'cloud-recover-binding', goal: 'Review this original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  f.observer.reconcile = async () => fail(appError('storage_write_failed', 'storage', 'Controlled product receipt outage.', true));
  const gate = f.holdNext(); f.coordinator.wake();
  expect(await f.coordinator.drain()).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  const phase = await f.database.read(scope => scope.db.query<{ request_id: string }, [number]>(
    'SELECT request_id FROM invoice_work_phases WHERE work_id=?').get(work.workId));
  expect(phase).not.toBeNull();
  await f.restart(); gate.release.resolve();
  const originalRestore = f.models.restore.bind(f.models), originalResume = f.runtime.resumeAttempt.bind(f.runtime);
  let failed = false, resumed = 0;
  f.models.restore = async input => {
    if (!failed) { failed = true; return fail(appError('provider_model_configuration_unavailable', 'runtime', 'Controlled restore outage.', true)); }
    return originalRestore(input);
  };
  f.runtime.resumeAttempt = async input => { resumed++; return originalResume(input); };
  expect(await f.coordinator.recover()).toMatchObject({ ok: false, error: { code: 'provider_model_configuration_unavailable' } });
  f.coordinator.wake(); need(await f.coordinator.drain());
  expect(resumed).toBe(1);
  expect((await f.work(work.workId)).work.execution.runStatus).toBe('completed');
}, 15_000);

test('a recovered cloud Work does not keep an old transient coordination error at shutdown', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true), work = need(await f.database.transaction(scope => scope.invoiceWorks.create({
    personalAgentId: 1, expectedAgentRevision: 0, requestId: 'cloud-transient-recovery', goal: 'Review the original invoice.',
    documents: [{ id: 1, version: 'v1' }] }, { at: now(), admission: { kind: 'queued' }, runtimeOwner: {
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cloudRuntimeId: '11111111-1111-4111-8111-111111111111' } })));
  const reconcile = f.observer.reconcile.bind(f.observer); let first = true;
  f.observer.reconcile = async input => { if (first) { first = false; return fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled outage.', true)); }
    return reconcile(input); };
  f.coordinator.wake(); await waitFor(async () => f.errors.includes('cloud_transport_result_unknown'), 3_000);
  f.coordinator.wake(); await waitFor(async () => (await f.work(work.workId)).work.execution.runStatus === 'completed', 5_000);
  expect(await f.coordinator.close()).toEqual(ok(undefined));
}, 15_000);

test('successful recovery of one cloud Work does not clear another Work\'s unresolved error', async () => {
  const f = await fixture('no-candidate', 'off', 'cloud', true), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const create = (requestId: string, cloudRuntimeId: string) => f.database.transaction(scope => scope.invoiceWorks.create({
    personalAgentId: 1, expectedAgentRevision: 0, requestId, goal: 'Review the original invoice.', documents: [{ id: 1, version: 'v1' }] },
  { at: now(), admission: { kind: 'queued' }, runtimeOwner: { workspaceId, cloudRuntimeId } })).then(need);
  const failed = await create('cloud-unresolved-one', '11111111-1111-4111-8111-111111111111');
  const other = await create('cloud-unresolved-two', '22222222-2222-4222-8222-222222222222');
  const reconcile = f.observer.reconcile.bind(f.observer);
  f.observer.reconcile = async input => input.workId === failed.workId
    ? fail(appError('cloud_transport_result_unknown', 'runtime', 'Controlled outage.', true)) : reconcile(input);
  f.coordinator.wake();
  await waitFor(async () => f.errors.includes('cloud_transport_result_unknown') && (await f.work(other.workId)).work.execution.runStatus === 'completed', 5_000);
  expect(await f.coordinator.close()).toMatchObject({ ok: false, error: { code: 'cloud_transport_result_unknown' } });
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
