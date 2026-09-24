import { appError, ok } from '@flowmate/contracts';
import type {
  AgentControl,
  AgentRunRequest,
  Application,
  CloseReport,
  DbId,
  ProviderControl,
  ProviderOutcome,
  ProviderRequest,
  Result,
  RunAccepted,
  RunSnapshot,
  RuntimeState,
  CreateSessionRequest,
  ListSessionsRequest,
  SessionPage,
  SessionRunsPage,
  SessionRunsRequest,
  SessionSnapshot,
} from '@flowmate/contracts';

export interface RuntimeServicePort {
  callProvider(
    request: ProviderRequest,
    control?: ProviderControl,
  ): Promise<Result<ProviderOutcome>>;
  createSession(request: CreateSessionRequest): Promise<Result<SessionSnapshot>>;
  listSessions(request?: ListSessionsRequest): Promise<Result<SessionPage>>;
  querySession(sessionId: DbId): Promise<Result<SessionSnapshot>>;
  listSessionRuns(request: SessionRunsRequest): Promise<Result<SessionRunsPage>>;
  startRun(request: AgentRunRequest, control?: AgentControl): Promise<Result<RunAccepted>>;
  cancelRun(runId: DbId): Promise<Result<{ accepted: boolean; runId: DbId }>>;
  queryRuntimeState(): Promise<Result<RuntimeState>>;
  close(): Promise<CloseReport>;
}

export interface RunQueryPort {
  get(runId: DbId): Result<RunSnapshot>;
}

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
): Application {
  let closeInFlight: Promise<Result<CloseReport>> | null = null;
  let finalCloseResult: Result<CloseReport> | null = null;
  const closeErrors = new Map<string, ReturnType<typeof appError>>();
  return {
    callProvider: (request, control) => runtime.callProvider(request, control),
    createSession: (request) => runtime.createSession(request),
    listSessions: (request) => runtime.listSessions(request),
    querySession: (sessionId) => runtime.querySession(sessionId),
    listSessionRuns: (request) => runtime.listSessionRuns(request),
    startRun: (request, control) => runtime.startRun(request, control),
    cancelRun: (runId) => runtime.cancelRun(runId),
    queryRuntimeState: () => runtime.queryRuntimeState(),
    queryRun: async (runId) => runs.get(runId),
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
