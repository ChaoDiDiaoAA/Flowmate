import type { RunIdentity, RuntimeEvent } from "@flowmate/contracts";
import type { Store } from "./repository.js";
import { startControlledRun, type CleanupResult, type ControlledRuntime, type RunHandle } from "../runtime/controller.js";

export type JobServiceStart = {
  runtime: ControlledRuntime;
  identity: RunIdentity;
  context: { taskPrompt: string };
  onEvent?: (event: RuntimeEvent) => void;
};

export type JobService = {
  start(options: JobServiceStart): RunHandle;
  get(runId: string): RunHandle | undefined;
  wait(runId: string): Promise<Awaited<ReturnType<ControlledRuntime["run"]>>>;
  cancel(runId: string, reason?: string): Promise<CleanupResult>;
  activeRunCount(): number;
  close(reason?: string): Promise<CleanupResult>;
};

/**
 * Owns runtime handles for the process. The service is intentionally ignorant
 * of invoice rules; Store remains the authority for Run state while this layer
 * guarantees one cancellation/cleanup path for every embedded Pi runtime.
 */
export function createJobService(store: Store): JobService {
  const handles = new Map<string, RunHandle>();
  return {
    start(options) {
      if (handles.has(options.identity.runId)) throw new Error("RUN_ALREADY_ACTIVE");
      const handle = startControlledRun({ ...options, store });
      handles.set(options.identity.runId, handle);
      void handle.done.finally(() => {
        if (handles.get(options.identity.runId) === handle) handles.delete(options.identity.runId);
      });
      return handle;
    },
    get(runId) { return handles.get(runId); },
    async wait(runId) {
      const handle = handles.get(runId);
      if (!handle) throw new Error("RUN_NOT_ACTIVE");
      return handle.done;
    },
    async cancel(runId, reason = "requested") {
      const handle = handles.get(runId);
      if (!handle) {
        try {
          store.requestCancel(runId, reason);
          return { status: "complete" };
        } catch (error) {
          return { status: "incomplete", reason: error instanceof Error ? error.message : "run is not available" };
        }
      }
      return handle.cancel(reason);
    },
    async close(reason = "application_close") {
      const pending = [...handles.values()].map((handle) => handle.cancel(reason));
      const results = await Promise.all(pending);
      const incomplete = results.find((result) => result.status === "incomplete");
      return incomplete ?? { status: "complete" };
    },
    activeRunCount() { return handles.size; },
  };
}
