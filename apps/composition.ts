import { createInputDefinitions } from '../packages/core/src/prompt-templates.ts';
import { parseFrontmatter, loadPromptTemplates, expandPromptTemplate } from '@flowmate/runtime-pi';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileStore, createInvoiceEditService, createInvoiceFormService, createJobService, createToolExecutor, createToolRecorder, createWorkspaceService, createWorkspaceVerifier, makeApplication,
  ContextService, RuntimeService, SessionService, openDatabase, createResourceService, createExtensionService, createSubagentTool } from '@flowmate/core';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools, fillInvoiceForm, listSkillResources, readSkillResource, projectInvoiceDocumentPage, validateHumanInvoiceCandidate } from '@flowmate/employee-invoice';
import { createPromptTraceBuffer } from '@flowmate/logging';
import { PiAgentAdapter, PiProviderAdapter, createNativeTools, inspectNativeResources, PI_SDK_VERSION } from '@flowmate/runtime-pi';
import { acquireProductControllerLock, createLogger } from '@flowmate/shared';
import { appError, ok } from '@flowmate/contracts';
import type { Application, MemoryStore, ProductPaths, PromptTraceBuffer, Result, RuntimeRequestOverrides, RuntimeStrategyPolicy } from '@flowmate/contracts';
import type { AgentPort, InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, ProviderPort, ToolDefinition } from '@flowmate/contracts';
import type { SafeLogger } from '@flowmate/shared';

export type ApplicationOptions = {
  resourceRoot?: string;
  resourceDefaults?: () => Result<import('@flowmate/contracts').AssemblySelectionSnapshot | import('@flowmate/contracts').ResourceSelectionResult>;
  saveExtensionSelection?: (request: import('@flowmate/contracts').ExtensionSelectionRequest) => Promise<Result<import('@flowmate/contracts').ExtensionSelectionResult>>;
  saveResourceSelection?: (request: import('@flowmate/contracts').ResourceSelectionRequest) => Promise<Result<import('@flowmate/contracts').ResourceSelectionResult>>;
  paths: ProductPaths;
  invoiceSourceRoot?: string;
  provider?: ProviderPort;
  agent?: AgentPort;
  agentFactory?: (tools: readonly ToolDefinition<any, any>[]) => AgentPort;
  promptTrace?: PromptTraceBuffer;
  logger?: SafeLogger;
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>;
  runtimePolicy?: RuntimeStrategyPolicy;
  sampleSource?: 'production' | 'test' | 'evaluation';
  toolDefinitions?: (definitions: readonly ToolDefinition<any, any>[]) => readonly ToolDefinition<any, any>[];
  invoiceFormBridge?: (request: InvoiceFormBridgeRequest, signal: AbortSignal) => Promise<InvoiceFormApplicationReceipt>;
  observeCompaction?: (value: import('@flowmate/contracts').CompactionObservation) => void;
};

export async function createApplication(options: ApplicationOptions): Promise<Result<Application>> {
  const lock = await acquireProductControllerLock(options.paths);
  if (!lock.ok) return lock;
  const database = openDatabase(options.paths);
  if (!database.ok) {
    await lock.data.release();
    return database;
  }
  let logger: SafeLogger;
  try {
    logger = options.logger ?? createLogger(options.paths.logsDir);
  } catch {
    try { database.data.close(); } catch { /* preserve logger initialization failure */ }
    await lock.data.release();
    return { ok: false, error: appError('logger_init_failed', 'runtime', '运行日志初始化失败。', true) };
  }
  const promptTrace = options.promptTrace ?? createPromptTraceBuffer();
  let loggerClosed = false;
  let databaseClosed = false;
  const now = () => new Date().toISOString();
  const files = createFileStore(options.paths, database.data.documents);
  const documents = createDocumentService({ paths: options.paths,
    allowedSourceRoot: options.invoiceSourceRoot ?? resolve(process.cwd(), 'data', 'invoices', 'agent-input'),
    repository: database.data.documents, files, now });
  const workspaceVerifier = createWorkspaceVerifier({ inspectMaterial: ref => documents.inspectForWorkspace(ref) });
  const contextService = new ContextService({ store: database.data,
    materials: { inspectParsed: input => documents.inspectParsedForContext(input) } });
  const invoiceEdits = createInvoiceEditService({ candidates: database.data.candidates, files,
    validate: (draft, ref) => validateHumanInvoiceCandidate(draft, ref, documents), now });
  const native = createNativeTools({
    getWorkingDirectory: context => database.data.toolCalls.getNativeWorkingDirectory(context),
  });
  const recorder = createToolRecorder(database.data.toolCalls, now);
  const invoiceForms = options.invoiceFormBridge ? createInvoiceFormService({ recorder, runs: database.data.runs,
    sessions: database.data.sessions, documents: database.data.documents, jobs: database.data.jobs,
    workspace: database.data.workspace, candidates: database.data.candidates, bridge: options.invoiceFormBridge, now }) : undefined;
  let agent: import('@flowmate/contracts').AgentPort;
  const assembled = [...createInvoiceTools({ documents, documentRepository: database.data.documents,
    candidates: database.data.candidates, now }), listSkillResources((input, context) => resources.listSkillResources(input, context)),
    readSkillResource((input, context) => resources.readSkillResource(input, context)),
    ...(invoiceForms ? [fillInvoiceForm(invoiceForms)] : []), createSubagentTool(() => agent), ...native.definitions];
  const definitions = Object.freeze([...(options.toolDefinitions?.(assembled) ?? assembled)]);
  const unavailableTools = new Set(native.availability.filter(item => !item.available).map(item => item.name as string));
  const resources = createResourceService({ resourceRoot: options.resourceRoot ?? fileURLToPath(new URL('../resources/', import.meta.url)),
    bundleRoot: join(options.paths.runtimeDir, 'resource-bundles'),
    registeredToolNames: definitions.filter(tool => !unavailableTools.has(tool.name)).map(tool => tool.name), inspectNativeResources,
    getRun: runId => database.data.runs.get(runId) });
  const extensions = createExtensionService({ resourceRoot: options.resourceRoot ?? fileURLToPath(new URL('../resources/', import.meta.url)),
    sdkVersion: PI_SDK_VERSION, registeredTools: definitions });
  const inputDefinitions = createInputDefinitions({ resourceRoot: options.resourceRoot ?? fileURLToPath(new URL('../resources/', import.meta.url)),
    runtimeRoot: options.paths.runtimeDir, tools: assembled, parseFrontmatter, loadPromptTemplates, expandPromptTemplate });
  const toolExecutor = createToolExecutor({ definitions, recorder,
    strategyPolicy: options.runtimePolicy, sampleSource: options.sampleSource,
    isSessionModelUseBlocked: (sessionId) => database.data.sessions.isModelUseBlocked(sessionId), now,
    monotonicNow: () => performance.now() });
  const provider = options.provider ?? new PiProviderAdapter();
  agent = options.agentFactory?.(definitions) ?? options.agent ?? new PiAgentAdapter({ cwd: options.paths.runtimeDir, agentDir: options.paths.runtimeDir, promptTrace,
    resourceBundleRoot: join(options.paths.runtimeDir, 'resource-bundles'),
    tools: definitions });
  let sessionService: SessionService;
  const memory: MemoryStore = Object.assign(database.data.memory, { list: (input: Parameters<MemoryStore['list']>[0]) => sessionService.listHistory(input) });
  const runtime = new RuntimeService({
    memory,
    runs: database.data.runs,
    recoveryError: database.data.recoveryError,
    sessions: database.data.sessions,
    sessionInputs: database.data.sessionInputs,
    workspaceVerifier,
    contextService,
    contextRepository: database.data.context,
    resources,
    extensions,
    resourceDefaults: options.resourceDefaults,
    inputDefinitions,
    isSessionManaging: sessionId => sessionService?.isManaging(sessionId) ?? false,
    provider,
    agent,
    runtimeDefaults: options.runtimeDefaults,
    observeCompaction: options.observeCompaction,
    runtimePolicy: options.runtimePolicy, sampleSource: options.sampleSource,
    log: logger,
    now,
    monotonicNow: () => performance.now(),
    tools: toolExecutor,
    nativeTools: { runtimeDir: options.paths.runtimeDir,
      availability: native.availability.filter(item => definitions.some(definition => definition.name === item.name)) },
  });
  sessionService = new SessionService(database.data.sessions, agent, () => runtime.state(), now, database.data.runs,
    memory, database.data.sessionInputs, (request, submission, control) => runtime.start(request, control, submission),
    request => runtime.appendInput(request), (sessionId, intent) => runtime.verifySessionMutation(sessionId, intent));
  const workspaceService = createWorkspaceService(database.data.workspace, now, workspaceVerifier);
  const jobService = createJobService(database.data.jobs, now);
  return ok(makeApplication(runtime, database.data.runs, async () => {
    const errors = [];
    if (!loggerClosed) {
      try { await logger.close(); loggerClosed = true; } catch { errors.push(appError('logger_close_failed', 'runtime', '日志资源关闭失败。', true)); }
    }
    if (!databaseClosed) {
      try { database.data.close(); databaseClosed = true; } catch { errors.push(appError('database_close_failed', 'storage', '数据库资源关闭失败。', true)); }
    }
    let lockReleased = false;
    if (loggerClosed && databaseClosed) {
      const released = await lock.data.release();
      lockReleased = released.ok;
      if (!released.ok) errors.push(released.error);
    }
    return { stopped: true, closed: loggerClosed && databaseClosed && lockReleased, errors };
  }, sessionService, promptTrace, workspaceService, jobService, {
    resources,
    extensions,
    resourceDefaults: options.resourceDefaults,
    inputDefinitions,
    saveResourceSelection: options.saveResourceSelection,
    saveExtensionSelection: options.saveExtensionSelection,
    documents: database.data.documents,
    jobs: database.data.jobs,
    candidates: database.data.candidates,
    events: database.data.businessEvents,
    runtimeEvents: database.data.runtimeEvents,
    toolCalls: database.data.toolCalls,
    contextService,
    contextRepository: database.data.context,
    ...(invoiceForms ? { invoiceForms } : {}),
    invoiceEdits,
    importInvoiceMaterial: (sourceDirectory) => documents.importVoxel51({ sourceDirectory }),
    hideDocument: (documentId) => database.data.documents.hide(documentId, now()),
    listDocumentPages: (input) => {
      const loaded = documents.readParsedForWorkspace(input.documentId);
      return loaded.ok ? ok({ documentRef: loaded.data.document.documentRef,
        parsedArtifactId: loaded.data.document.parsedArtifactId, pageCount: loaded.data.parsed.pages.length,
        pages: loaded.data.parsed.pages.map(page => ({ page: page.page, blockCount: page.blocks.length,
          tableCount: page.blocks.filter(block => block.kind === 'table').length })) }) : loaded;
    },
    readDocumentPage: (input) => {
      const loaded = documents.readParsedForWorkspace(input.documentId);
      return loaded.ok ? projectInvoiceDocumentPage(input, loaded.data) : loaded;
    },
    readDocumentOriginal: (documentId, page) => {
      const image = documents.readOriginalForWorkspace(documentId, page);
      return image.ok ? ok({ documentRef: image.data.documentRef, mimeType: image.data.mimeType,
        base64: Buffer.from(image.data.bytes).toString('base64') }) : image;
    },
  }, database.data.maxRunIdAtBoot));
}
