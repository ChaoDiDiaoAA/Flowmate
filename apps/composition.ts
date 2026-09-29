import { createFileStore, createJobService, createToolExecutor, createToolRecorder, createWorkspaceService, makeApplication,
  RuntimeService, SessionService, ToolRegistry, openDatabase } from '@flowmate/core';
import { createDocumentService, createEvidenceService } from '@flowmate/data';
import { CandidateService, createInvoiceTools } from '@flowmate/employee-invoice';
import { createPromptTraceBuffer } from '@flowmate/logging';
import { PiAgentAdapter, PiProviderAdapter } from '@flowmate/runtime-pi';
import { acquireProductControllerLock, createLogger, resolveProductPaths, resolveWindowsUserData } from '@flowmate/shared';
import { appError, ok } from '@flowmate/contracts';
import type { Application, ProductPaths, PromptTraceBuffer, Result } from '@flowmate/contracts';
import type { AgentPort, ProviderPort, ToolDefinition } from '@flowmate/contracts';
import type { SafeLogger } from '@flowmate/shared';

export type ApplicationOptions = {
  paths: ProductPaths;
  provider?: ProviderPort;
  agent?: AgentPort;
  agentFactory?: (tools: readonly ToolDefinition<any, any>[]) => AgentPort;
  promptTrace?: PromptTraceBuffer;
  logger?: SafeLogger;
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
  const documents = createDocumentService({ paths: options.paths, repository: database.data.documents, files, now });
  const evidence = createEvidenceService({ documents, repository: database.data.documents, files, now,
    originalWasDelivered: (sessionId, source) => database.data.toolCalls.wasOriginalEvidenceDelivered({ sessionId, source }) });
  const candidates = new CandidateService({ repository: database.data.candidates, documents, evidence, now });
  const definitions = createInvoiceTools({ documents, evidence, candidates });
  const registry = new ToolRegistry(definitions);
  const toolExecutor = createToolExecutor({ registry, recorder: createToolRecorder(database.data.toolCalls, now),
    isSessionModelUseBlocked: (sessionId) => database.data.sessions.isModelUseBlocked(sessionId), now,
    monotonicNow: () => performance.now() });
  const provider = options.provider ?? new PiProviderAdapter();
  const agent = options.agentFactory?.(definitions) ?? options.agent ?? new PiAgentAdapter({ cwd: options.paths.runtimeDir, agentDir: options.paths.runtimeDir, promptTrace,
    tools: definitions });
  const runtime = new RuntimeService({
    runs: database.data.runs,
    sessions: database.data.sessions,
    provider,
    agent,
    log: logger,
    now,
    monotonicNow: () => performance.now(),
    tools: toolExecutor,
    formatToolResult: async (name, data, context, signal) => {
      if (name === 'read_invoice_evidence' && typeof data === 'object' && data !== null
        && 'kind' in data && data.kind === 'original' && 'source' in data) {
        const delivered = evidence.readForDelivery(data.source as import('@flowmate/contracts').SourceRef, context, signal);
        if (!delivered.ok) throw delivered.error;
        return [
          { type: 'text' as const, text: JSON.stringify(data) },
          { type: 'image' as const, data: Buffer.from(delivered.data.bytes).toString('base64'), mimeType: delivered.data.mimeType },
        ];
      }
      return [{ type: 'text' as const, text: JSON.stringify(data) }];
    },
  });
  const sessionService = new SessionService(database.data.sessions, agent, () => runtime.state(), now);
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
    importInvoiceMaterial: (sourceDirectory) => documents.importVoxel51({ sourceDirectory }),
    readDocumentPage: (input) => documents.readPageForWorkspace(input),
    readDocumentOriginal: (documentId, page) => {
      const image = documents.readOriginalForWorkspace(documentId, page);
      return image.ok ? ok({ documentRef: image.data.documentRef, mimeType: image.data.mimeType,
        base64: Buffer.from(image.data.bytes).toString('base64') }) : image;
    },
  }));
}

export async function createDefaultApplication(): Promise<Result<Application>> {
  const userData = resolveWindowsUserData(process.env);
  if (!userData.ok) return userData;
  const paths = resolveProductPaths(userData.data);
  if (!paths.ok) return paths;
  return createApplication({ paths: paths.data });
}
