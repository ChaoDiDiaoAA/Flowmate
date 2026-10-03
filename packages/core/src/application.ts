import {
  appError,
  fail,
  normalizeAgentRunRequest,
  normalizeProviderRequest,
  normalizeCreateSessionRequest,
  normalizeRenameSessionRequest,
  normalizeSessionId,
  normalizeListSessionsRequest,
  normalizeSessionRunsRequest,
  normalizeSessionMessagesRequest,
  invoiceToolSchemas,
  RunToolCallsRequestSchema,
  RunToolCallRequestSchema,
  RuntimeToolViewSchema,
  RuntimeToolPageSchema,
  ok,
} from '@flowmate/contracts';
import type {
  AgentControl,
  AgentRunRequest,
  Application,
  CandidateRepository,
  CloseReport,
  DbId,
  ListSessionsRequest,
  NormalizedAgentRunRequest,
  ProviderControl,
  ProviderOutcome,
  ProviderRequest,
  PromptTraceBuffer,
  Result,
  RunAccepted,
  RunSnapshot,
  RuntimeState,
  SessionPage,
  SessionRunsPage,
  SessionRunsRequest,
  SessionSnapshot,
  NativeToolAvailability,
  ToolCallSnapshot,
  RuntimeToolView,
} from '@flowmate/contracts';
import type { BusinessEventRepository, DocumentRepository, JobRepository, RunRepository, ToolCallRepository } from './storage/repositories.ts';
import type { EventService } from './events/service.ts';
import type { SessionService } from './sessions/service.ts';
import type { WorkspaceService } from './workspace/service.ts';
import type { JobService } from './jobs/service.ts';
import type { InvoiceFormService } from './tools/invoice-form.ts';
import type { InvoiceEditService } from './invoice-edit/service.ts';

export interface RuntimeServicePort {
  callProvider(
    request: ProviderRequest,
    control?: ProviderControl,
  ): Promise<Result<ProviderOutcome>>;
  start(request: NormalizedAgentRunRequest, control?: AgentControl): Promise<Result<RunAccepted>>;
  queryNativeTools?(): Result<readonly NativeToolAvailability[]>;
  cancel(runId: DbId): Result<{ runId: DbId; accepted: boolean }>;
  revokeDocumentUse(documentId: DbId): Promise<Result<{ affectedSessionIds: DbId[]; stopRequested: boolean }>>;
  state(): RuntimeState;
  close(): Promise<CloseReport>;
}

export type RunQueryPort = Pick<RunRepository, 'get'> & Partial<Pick<RunRepository, 'listBySession'>>;

export type DisposeResources = () => Promise<CloseReport>;
type ProductApplicationOptions = {
  documents: DocumentRepository;
  jobs: JobRepository;
  candidates: CandidateRepository;
  events: BusinessEventRepository;
  runtimeEvents?: EventService;
  toolCalls?: Pick<ToolCallRepository, 'list' | 'getById'>;
  invoiceForms?: Pick<InvoiceFormService, 'query'>;
  invoiceEdits?: Pick<InvoiceEditService, 'save' | 'accept' | 'reject' | 'export' | 'queryOperation'>;
  importInvoiceMaterial: (sourceDirectory: string) => Promise<Result<import('@flowmate/contracts').DocumentSnapshot>>;
  hideDocument?: (documentId: DbId) => Result<{ documentId: DbId; affectedChatCount: number }>;
  readDocumentPage: (input: import('@flowmate/contracts').InvoiceToolInput<'read_invoice_document'>) => Result<import('@flowmate/contracts').InvoiceToolOutput<'read_invoice_document'>>;
  listDocumentPages: (input: import('@flowmate/contracts').InvoiceToolInput<'list_invoice_pages'>) => Result<import('@flowmate/contracts').InvoiceToolOutput<'list_invoice_pages'>>;
  readDocumentOriginal: (documentId: DbId, page: number) => Result<import('@flowmate/contracts').DocumentOriginalImage>;
};

/**
 * Public Application is deliberately a thin boundary. It delegates lifecycle
 * decisions to RuntimeService and facts to the repository; it does not know
 * about Cases, Langfuse, fixtures, or Pi SDK event types.
 */
export function makeApplication(
  runtime: RuntimeServicePort,
  runs: RunQueryPort,
  dispose: DisposeResources,
  sessions?: SessionService,
  promptTrace?: PromptTraceBuffer,
  workspace?: WorkspaceService,
  jobs?: JobService,
  products?: ProductApplicationOptions,
  maxRunIdAtBoot = 0,
): Application {
  let closeInFlight: Promise<Result<CloseReport>> | null = null;
  let finalCloseResult: Result<CloseReport> | null = null;
  const closeErrors = new Map<string, ReturnType<typeof appError>>();
  return {
    callProvider: async (raw, control) => {
      const normalized = normalizeProviderRequest(raw);
      return normalized.ok ? runtime.callProvider(normalized.data, control) : normalized;
    },
    queryRun: async (runId) => isDbId(runId) ? runs.get(runId) : fail(appError('input_invalid', 'input', 'Run ID 无效。')),
    queryRuntimeEvents: async input => products?.runtimeEvents?.query(input) ?? ({ ok: false,
      error: appError('runtime_events_unavailable', 'runtime', 'Runtime 事件服务尚未组装。', true), context: null }),
    subscribeRuntimeEvents: async (input, listener) => products?.runtimeEvents?.subscribe(input, listener)
      ?? fail(appError('runtime_events_unavailable', 'runtime', 'Runtime 事件服务尚未组装。', true)),
    listRunToolCalls: async raw => {
      if (!products?.toolCalls) return fail(appError('tool_calls_unavailable', 'storage', 'Run 工具查询尚未组装。', true));
      const parsed = RunToolCallsRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Run tool query is invalid.'));
      const { runId, sessionId, beforeId, limit } = parsed.data;
      const run = runs.get(runId);
      if (!run.ok) return run;
      if ((run.data.kind === 'provider' ? null : run.data.sessionId) !== sessionId)
        return fail(appError('state_conflict', 'runtime', 'Run and Session do not match.', false, runId));
      if (run.data.kind === 'provider') return ok({ items: [], nextBeforeId: null });
      const calls = products.toolCalls.list({ runId, ...(beforeId === undefined ? {} : { beforeId }), limit });
      if (!calls.ok) return calls;
      try {
        if (calls.data.items.some(call => call.runId !== runId || call.sessionId !== sessionId)) throw new Error('ownership');
        return ok(RuntimeToolPageSchema.parse({ items: calls.data.items.map(toolView), nextBeforeId: calls.data.nextBeforeId }));
      } catch { return fail(appError('storage_corrupt', 'storage', 'Run tools could not be projected.')); }
    },
    queryRunToolCall: async raw => {
      if (!products?.toolCalls) return fail(appError('tool_calls_unavailable', 'storage', 'Run 工具查询尚未组装。', true));
      const parsed = RunToolCallRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Run tool query is invalid.'));
      const { runId, sessionId, toolCallId } = parsed.data;
      const run = runs.get(runId);
      if (!run.ok) return run;
      if (run.data.kind !== 'agent' || run.data.sessionId !== sessionId)
        return fail(appError('state_conflict', 'runtime', 'Run and Session do not match.', false, runId));
      const call = products.toolCalls.getById(toolCallId);
      if (!call.ok) return call;
      if (call.data.runId !== runId || call.data.sessionId !== sessionId)
        return fail(appError('state_conflict', 'runtime', 'Tool call does not belong to this Run.', false, runId));
      try { return ok(toolView(call.data)); }
      catch { return fail(appError('storage_corrupt', 'storage', 'Run tool could not be projected.')); }
    },
    createSession: async (raw = {}) => {
      const normalized = normalizeCreateSessionRequest(raw);
      return normalized.ok ? sessions?.create(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    queryNativeTools: async () => runtime.queryNativeTools?.()
      ?? fail(appError('tool_runtime_unavailable', 'runtime', 'Native tools are unavailable.')),
    renameSession: async (raw) => {
      const normalized = normalizeRenameSessionRequest(raw);
      return normalized.ok ? sessions?.rename(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    deleteSession: async (raw) => {
      const normalized = normalizeSessionId(raw);
      if (!normalized.ok) return normalized;
      const deleted = await (sessions?.deleteSession(normalized.data) ?? Promise.resolve(fail(sessionServiceUnavailable())));
      if (deleted.ok && deleted.data.disposition === 'permanent') {
        try { promptTrace?.clearSession(deleted.data.deletedSessionId); } catch { /* deletion is already committed */ }
      }
      return deleted;
    },
    listSessions: async (raw?: ListSessionsRequest) => {
      const normalized = normalizeListSessionsRequest(raw);
      return normalized.ok ? sessions?.list(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    querySession: async (sessionId) => {
      if (!isDbId(sessionId)) return fail(appError('input_invalid', 'input', 'Session ID 无效。'));
      return sessions?.get(sessionId) ?? fail(sessionServiceUnavailable());
    },
    listSessionRuns: async (raw: SessionRunsRequest) => {
      const normalized = normalizeSessionRunsRequest(raw);
      if (!normalized.ok) return normalized;
      if (!runs.listBySession) return fail(appError('session_runs_unavailable', 'storage', 'Session Run 仓储尚未组装。'));
      return runs.listBySession(normalized.data);
    },
    listSessionMessages: async (raw) => {
      const normalized = normalizeSessionMessagesRequest(raw);
      return normalized.ok ? sessions?.listMessages(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
    },
    queryPromptTrace: async (runId, callSequence) => {
      if (!isDbId(runId) || (callSequence !== undefined && !isDbId(callSequence))) {
        return fail(appError('input_invalid', 'input', 'Prompt Trace 查询参数无效。'));
      }
      const run = runs.get(runId);
      if (!run.ok) return run;
      if (run.data.kind === 'provider') return ok({ availability: 'not-collected', calls: [], droppedCalls: null });
      if (!promptTrace) return ok({ availability: 'not-collected', calls: [], droppedCalls: null });
      let result;
      try { result = promptTrace.query(runId, callSequence); }
      catch { return ok({ availability: 'source-unavailable', calls: [], droppedCalls: null }); }
      if (result.availability === 'not-started') {
        const agent = run.data.output?.agent;
        const calls = agent && typeof agent === 'object' && 'modelCallCount' in agent ? agent.modelCallCount : undefined;
        if (calls === 0) return ok(result);
        if (runId <= maxRunIdAtBoot) {
          return ok({ availability: 'process-exited', calls: [], droppedCalls: null });
        }
      }
      return ok(result);
    },
    startRun: async (raw: AgentRunRequest, control?: AgentControl) => {
      const normalized = normalizeAgentRunRequest(raw);
      return normalized.ok ? runtime.start(normalized.data, control) : normalized;
    },
    submitInput: async (raw, control) => sessions?.submitInput(raw, control) ?? fail(sessionServiceUnavailable()),
    querySessionInput: async (request) => sessions?.queryInput(request) ?? fail(sessionServiceUnavailable()),
    listSessionInputs: async request => sessions?.listInputs(request) ?? fail(sessionServiceUnavailable()),
    setSessionStatus: async request => sessions?.setStatus(request) ?? fail(sessionServiceUnavailable()),
    branchSession: async request => sessions?.branch(request) ?? fail(sessionServiceUnavailable()),
    queryInvoiceFormApplication: async (request) => products?.invoiceForms?.query(request)
      ?? fail(appError('form_bridge_unavailable', 'runtime', 'The controlled invoice form is unavailable.')),
    saveInvoiceCandidate: async request => products?.invoiceEdits?.save(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice editing is unavailable.')),
    acceptInvoiceCandidate: async request => products?.invoiceEdits?.accept(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice acceptance is unavailable.')),
    rejectInvoiceCandidate: async request => products?.invoiceEdits?.reject(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice rejection is unavailable.')),
    exportInvoiceCandidate: async request => products?.invoiceEdits?.export(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice export is unavailable.')),
    queryInvoiceCandidateOperation: async request => products?.invoiceEdits?.queryOperation(request)
      ?? fail(appError('invoice_edit_unavailable', 'runtime', 'Invoice operation lookup is unavailable.')),
    readWorkspace: async () => workspace?.read() ?? fail(appError('workspace_unavailable', 'storage', 'Workspace 服务尚未组装。', true)),
    restoreWorkspace: async () => workspace?.restore() ?? fail(appError('workspace_unavailable', 'storage', 'Workspace 服务尚未组装。', true)),
    updateWorkspace: async (raw) => workspace?.update(raw) ?? fail(appError('workspace_unavailable', 'storage', 'Workspace 服务尚未组装。', true)),
    startTask: async (raw) => jobs?.create(raw) ?? fail(appError('job_service_unavailable', 'storage', 'Job 服务尚未组装。', true)),
    queryTaskOperation: async (clientSequence) => jobs?.queryOperation(clientSequence)
      ?? fail(appError('job_service_unavailable', 'storage', 'Job 服务尚未组装。', true)),
    selectCandidate: async (raw) => workspace?.selectCandidate(raw)
      ?? fail(appError('workspace_unavailable', 'storage', '候选选择服务尚未组装。', true)),
    listDocuments: async (raw = {}) => {
      const page = normalizePageRequest(raw);
      return !page.ok ? page : products?.documents.list(page.data)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 查询尚未组装。', true));
    },
    queryDocument: async (documentId) => Number.isSafeInteger(documentId) && documentId > 0
      ? products?.documents.get(documentId) ?? fail(appError('document_service_unavailable', 'storage', 'Document 查询尚未组装。', true))
      : fail(appError('input_invalid', 'input', 'Document ID 无效。')),
    hideDocument: async (documentId) => Number.isSafeInteger(documentId) && documentId > 0
      ? products?.hideDocument?.(documentId)
        ?? fail(appError('document_service_unavailable', 'storage', 'Invoice removal is unavailable.', true))
      : fail(appError('input_invalid', 'input', 'Invoice reference is invalid.')),
    listJobs: async (raw = {}) => {
      const page = normalizePageRequest(raw, ['documentId']);
      if (!page.ok) return page;
      const request = raw && typeof raw === 'object' && 'documentId' in raw
        ? { ...page.data, documentId: (raw as { documentId?: number }).documentId } : page.data;
      if ('documentId' in request && request.documentId !== undefined && (!Number.isSafeInteger(request.documentId) || request.documentId < 1)) {
        return fail(appError('input_invalid', 'input', 'Document ID 无效。'));
      }
      return products?.jobs.list(request) ?? fail(appError('job_service_unavailable', 'storage', 'Job 查询尚未组装。', true));
    },
    queryJob: async (jobId) => Number.isSafeInteger(jobId) && jobId > 0
      ? products?.jobs.get(jobId) ?? fail(appError('job_service_unavailable', 'storage', 'Job 查询尚未组装。', true))
      : fail(appError('input_invalid', 'input', 'Job ID 无效。')),
    hideJob: async (jobId) => jobs?.hide(jobId)
      ?? fail(appError('job_service_unavailable', 'storage', 'Processing service is unavailable.', true)),
    listJobCandidates: async (raw) => {
      if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.jobId) || raw.jobId < 1
        || raw.beforeSequence !== undefined && raw.beforeSequence !== null && (!Number.isSafeInteger(raw.beforeSequence) || raw.beforeSequence < 1)
        || raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > 100)
        || Object.keys(raw).some((key) => !['jobId', 'beforeSequence', 'limit'].includes(key))) {
        return fail(appError('input_invalid', 'input', 'Candidate 分页参数无效。'));
      }
      return products?.candidates.listByJob({ jobId: raw.jobId, beforeSequence: raw.beforeSequence ?? null, limit: raw.limit ?? 50 })
        ?? fail(appError('candidate_service_unavailable', 'storage', 'Candidate 查询尚未组装。', true));
    },
    queryJobCandidate: async (raw) => {
      if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.jobId) || raw.jobId < 1
        || !Number.isSafeInteger(raw.candidateId) || raw.candidateId < 1
        || Object.keys(raw).some((key) => !['jobId', 'candidateId'].includes(key))) {
        return fail(appError('input_invalid', 'input', 'Candidate 查询参数无效。'));
      }
      return products?.candidates.readByJob({ jobId: raw.jobId, candidateId: raw.candidateId })
        ?? fail(appError('candidate_service_unavailable', 'storage', 'Candidate 查询尚未组装。', true));
    },
    listActivity: async (raw) => {
      const page = normalizePageRequest(raw, ['jobId', 'documentId']);
      if (!page.ok) return page;
      if (!raw || typeof raw !== 'object' || (('jobId' in raw) === ('documentId' in raw))) {
        return fail(appError('input_invalid', 'input', 'Activity 必须按一个 Job 或 Document 查询。'));
      }
      const record = raw as Record<string, unknown>;
      const hasJob = 'jobId' in record;
      const id = hasJob ? record.jobId : record.documentId;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return fail(appError('input_invalid', 'input', 'Activity 所属 ID 无效。'));
      const filter = hasJob ? { jobId: id } : { documentId: id };
      return products?.events.list({ ...page.data, ...filter })
        ?? fail(appError('activity_service_unavailable', 'storage', 'Activity 查询尚未组装。', true));
    },
    importInvoiceMaterial: async (sourceDirectory) => {
      if (typeof sourceDirectory !== 'string' || !sourceDirectory.trim() || new TextEncoder().encode(sourceDirectory).byteLength > 4096) {
        return fail(appError('input_invalid', 'input', '正式材料目录无效。'));
      }
      return products?.importInvoiceMaterial(sourceDirectory)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 导入尚未组装。', true));
    },
    listDocumentPages: async raw => {
      const input = invoiceToolSchemas.list_invoice_pages.input.safeParse(raw);
      return !input.success ? fail(appError('input_invalid', 'input', 'Parsed page query is invalid.'))
        : products?.listDocumentPages(input.data) ?? fail(appError('document_service_unavailable', 'storage', 'Parsed page listing is unavailable.', true));
    },
    readDocumentPage: async (raw) => {
      const input = invoiceToolSchemas.read_invoice_document.input.safeParse(raw);
      if (!input.success) return fail(appError('input_invalid', 'input', 'Document 页面参数无效。'));
      return products?.readDocumentPage(input.data)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 页面查询尚未组装。', true));
    },
    readDocumentOriginal: async (documentId, page) => Number.isSafeInteger(documentId) && documentId > 0 && page === 1
      ? products?.readDocumentOriginal(documentId, page)
        ?? fail(appError('document_service_unavailable', 'storage', 'Document 原图查询尚未组装。', true))
      : fail(appError('input_invalid', 'input', 'Document 原图参数无效。')),
    revokeDocumentUse: async (documentId) => isDbId(documentId)
      ? runtime.revokeDocumentUse(documentId)
      : fail(appError('input_invalid', 'input', 'Document ID 无效。')),
    cancelRun: async (runId) => {
      if (!isDbId(runId)) return fail(appError('input_invalid', 'input', 'Run ID 无效。'));
      return runtime.cancel(runId);
    },
    queryRuntimeState: async () => {
      try { return ok(runtime.state()); }
      catch { return fail(appError('runtime_state_unavailable', 'runtime', 'Runtime 状态当前不可读取。', true)); }
    },
    close: () => {
      if (finalCloseResult) return Promise.resolve(finalCloseResult);
      if (closeInFlight) return closeInFlight;
      closeInFlight = closeOnce().then((result) => {
        if (!result.ok) {
          closeErrors.set(result.error.code, result.error);
          return ok({ stopped: false, closed: false, errors: [...closeErrors.values()] });
        }
        for (const error of result.data.errors) closeErrors.set(error.code, error);
        const complete = ok({ ...result.data, errors: [...closeErrors.values()] });
        if (complete.ok && complete.data.closed) finalCloseResult = complete;
        return complete;
      }).finally(() => { closeInFlight = null; });
      return closeInFlight;
    },
  };

  async function closeOnce(): Promise<Result<CloseReport>> {
    let runtimeReport: CloseReport;
    try {
      runtimeReport = await runtime.close();
    } catch {
      return ok({ stopped: false, closed: false, errors: [appError('runtime_close_failed', 'runtime', '运行资源关闭失败。', true)] });
    }

    let resourceReport: CloseReport;
    if (!runtimeReport.stopped) {
      resourceReport = { stopped: false, closed: false, errors: [] };
    } else {
      try {
        resourceReport = await dispose();
      } catch {
        resourceReport = { stopped: true, closed: false, errors: [appError('storage_close_failed', 'storage', '持久化资源关闭失败。', true)] };
      }
    }

    const report: CloseReport = {
      stopped: runtimeReport.stopped && resourceReport.stopped,
      closed: runtimeReport.closed && resourceReport.closed,
      errors: [...runtimeReport.errors, ...resourceReport.errors],
    };
    return ok(report);
  }
}

function toolView(call: ToolCallSnapshot): RuntimeToolView {
  return RuntimeToolViewSchema.parse({ toolCallId: call.toolCallId, runId: call.runId, sessionId: call.sessionId,
    toolName: call.toolName, status: call.status, requestedAt: call.requestedAt, startedAt: call.startedAt,
    endedAt: call.endedAt, stoppedAt: call.stoppedAt, committedCandidateId: call.result?.committedCandidateId ?? null,
    errorCode: call.result && call.result.status !== 'succeeded' ? call.result.error.code : null,
    stopped: typeof call.cleanup.stopped === 'boolean' ? call.cleanup.stopped : null,
    deliveryState: call.delivery.state, formApplicationOutcome: call.formApplication?.outcome ?? null });
}

function normalizePageRequest(value: unknown, allowedExtra: readonly string[] = []): Result<{ beforeId?: number; limit: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['beforeId', 'limit', ...allowedExtra].includes(key))) {
    return fail(appError('input_invalid', 'input', '分页参数无效。'));
  }
  const record = value as { beforeId?: unknown; limit?: unknown };
  if (record.beforeId !== undefined && (!Number.isSafeInteger(record.beforeId) || Number(record.beforeId) < 1)
    || record.limit !== undefined && (!Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 100)) {
    return fail(appError('input_invalid', 'input', '分页参数无效。'));
  }
  return { ok: true, data: { ...(record.beforeId === undefined ? {} : { beforeId: Number(record.beforeId) }), limit: Number(record.limit ?? 50) } };
}

function isDbId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sessionServiceUnavailable() {
  return appError('session_service_unavailable', 'runtime', 'Agent Session 服务尚未组装。', true);
}
