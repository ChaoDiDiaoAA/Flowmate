import {
  appError,
  fail,
  normalizeAgentRunRequest,
  normalizeCreateSessionRequest,
  normalizeListSessionsRequest,
  normalizeSessionRunsRequest,
  ok,
} from '@flowmate/contracts';
import type {
  AgentControl,
  AgentRunRequest,
  Application,
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
} from '@flowmate/contracts';
import type { RunRepository } from './storage/repositories.ts';
import type { SessionService } from './sessions/service.ts';

export interface RuntimeServicePort {
  callProvider(
    request: ProviderRequest,
    control?: ProviderControl,
  ): Promise<Result<ProviderOutcome>>;
  start(request: NormalizedAgentRunRequest, control?: AgentControl): Promise<Result<RunAccepted>>;
  cancel(runId: DbId): Result<{ runId: DbId; accepted: boolean }>;
  state(): RuntimeState;
  close(): Promise<CloseReport>;
}

export type RunQueryPort = Pick<RunRepository, 'get'> & Partial<Pick<RunRepository, 'listBySession'>>;

export type DisposeResources = () => Promise<CloseReport>;

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
): Application {
  let closeInFlight: Promise<Result<CloseReport>> | null = null;
  let finalCloseResult: Result<CloseReport> | null = null;
  const closeErrors = new Map<string, ReturnType<typeof appError>>();
  return {
    callProvider: (request, control) => runtime.callProvider(request, control),
    queryRun: async (runId) => isDbId(runId) ? runs.get(runId) : fail(appError('input_invalid', 'input', 'Run ID 无效。')),
    createSession: async (raw = {}) => {
      const normalized = normalizeCreateSessionRequest(raw);
      return normalized.ok ? sessions?.create(normalized.data) ?? fail(sessionServiceUnavailable()) : normalized;
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
        const session = sessions?.get(run.data.sessionId);
        if (session?.ok && session.data.availability === 'history-unavailable') {
          return ok({ availability: 'process-exited', calls: [], droppedCalls: null });
        }
      }
      return ok(result);
    },
    startRun: async (raw: AgentRunRequest, control?: AgentControl) => {
      const normalized = normalizeAgentRunRequest(raw);
      return normalized.ok ? runtime.start(normalized.data, control) : normalized;
    },
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

function isDbId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sessionServiceUnavailable() {
  return appError('session_service_unavailable', 'runtime', 'Agent Session 服务尚未组装。', true);
}
