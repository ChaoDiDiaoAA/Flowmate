import { resolve } from 'node:path';
import { createFileStore, createInvoiceEditService, createInvoiceFormService, createJobService, createToolExecutor, createToolRecorder, createWorkspaceService, makeApplication,
  RuntimeService, SessionService, openDatabase } from '@flowmate/core';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools, fillInvoiceForm, projectInvoiceDocumentPage, validateHumanInvoiceCandidate } from '@flowmate/employee-invoice';
import { createPromptTraceBuffer } from '@flowmate/logging';
import { PiAgentAdapter, PiProviderAdapter, createNativeTools } from '@flowmate/runtime-pi';
import { acquireProductControllerLock, createLogger } from '@flowmate/shared';
import { appError, ok } from '@flowmate/contracts';
import type { Application, ProductPaths, PromptTraceBuffer, Result, RuntimeRequestOverrides, RuntimeStrategyPolicy } from '@flowmate/contracts';
import type { AgentPort, InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, ProviderPort, ToolDefinition } from '@flowmate/contracts';
import type { SafeLogger } from '@flowmate/shared';

export type ApplicationOptions = {
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
  const invoiceEdits = createInvoiceEditService({ candidates: database.data.candidates, files,
    validate: (draft, ref) => validateHumanInvoiceCandidate(draft, ref, documents), now });
  const native = createNativeTools({
    getWorkingDirectory: context => database.data.toolCalls.getNativeWorkingDirectory(context),
  });
  const recorder = createToolRecorder(database.data.toolCalls, now);
  const invoiceForms = options.invoiceFormBridge ? createInvoiceFormService({ recorder, runs: database.data.runs,
    sessions: database.data.sessions, documents: database.data.documents, jobs: database.data.jobs,
    workspace: database.data.workspace, candidates: database.data.candidates, bridge: options.invoiceFormBridge, now }) : undefined;
  const assembled = [...createInvoiceTools({ documents, documentRepository: database.data.documents,
    candidates: database.data.candidates, now }), ...(invoiceForms ? [fillInvoiceForm(invoiceForms)] : []), ...native.definitions];
  const definitions = Object.freeze([...(options.toolDefinitions?.(assembled) ?? assembled)]);
  const toolExecutor = createToolExecutor({ definitions, recorder,
    strategyPolicy: options.runtimePolicy, sampleSource: options.sampleSource,
    isSessionModelUseBlocked: (sessionId) => database.data.sessions.isModelUseBlocked(sessionId), now,
    monotonicNow: () => performance.now() });
  const provider = options.provider ?? new PiProviderAdapter();
  const agent = options.agentFactory?.(definitions) ?? options.agent ?? new PiAgentAdapter({ cwd: options.paths.runtimeDir, agentDir: options.paths.runtimeDir, promptTrace,
    tools: definitions });
  let sessionService: SessionService;
  const runtime = new RuntimeService({
    runs: database.data.runs,
    recoveryError: database.data.recoveryError,
    sessions: database.data.sessions,
    sessionInputs: database.data.sessionInputs,
    isSessionManaging: sessionId => sessionService?.isManaging(sessionId) ?? false,
    provider,
    agent,
    runtimeDefaults: options.runtimeDefaults,
    runtimePolicy: options.runtimePolicy, sampleSource: options.sampleSource,
    log: logger,
    now,
    monotonicNow: () => performance.now(),
    tools: toolExecutor,
    nativeTools: { runtimeDir: options.paths.runtimeDir,
      availability: native.availability.filter(item => definitions.some(definition => definition.name === item.name)) },
  });
  sessionService = new SessionService(database.data.sessions, agent, () => runtime.state(), now, database.data.runs,
    database.data.sessionInputs, (request, submission, control) => runtime.start(request, control, submission),
    request => runtime.appendInput(request), sessionId => runtime.verifySessionMutation(sessionId));
  const workspaceService = createWorkspaceService(database.data.workspace, now);
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
    documents: database.data.documents,
    jobs: database.data.jobs,
    candidates: database.data.candidates,
    events: database.data.businessEvents,
    runtimeEvents: database.data.runtimeEvents,
    toolCalls: database.data.toolCalls,
    ...(invoiceForms ? { invoiceForms } : {}),
    invoiceEdits,
    importInvoiceMaterial: (sourceDirectory) => documents.importVoxel51({ sourceDirectory }),
    hideDocument: (documentId) => database.data.documents.hide(documentId, now()),
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
