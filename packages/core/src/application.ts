import { appError, fail, ok } from '@flowmate/contracts';
import type {
  Application,
  CloseReport,
  DbId,
  ProviderControl,
  ProviderOutcome,
  ProviderRequest,
  Result,
  RunSnapshot,
} from '@flowmate/contracts';

export interface RuntimeServicePort {
  callProvider(
    request: ProviderRequest,
    control?: ProviderControl,
  ): Promise<Result<ProviderOutcome>>;
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
  return {
    callProvider: (request, control) => runtime.callProvider(request, control),
    queryRun: async (runId) => runs.get(runId),
    close: async () => {
      let runtimeReport: CloseReport;
      try {
        runtimeReport = await runtime.close();
      } catch {
        return fail(appError('runtime_close_failed', 'runtime', '运行资源关闭失败。', true));
      }

      let resourceReport: CloseReport;
      try {
        resourceReport = await dispose();
      } catch {
        return fail(appError('storage_close_failed', 'storage', '持久化资源关闭失败。', true));
      }

      const report: CloseReport = {
        stopped: runtimeReport.stopped && resourceReport.stopped,
        closed: runtimeReport.closed && resourceReport.closed,
        errors: [...runtimeReport.errors, ...resourceReport.errors],
      };
      return ok(report);
    },
  };
}
