import type { RunIdentity, RuntimeEvent } from "@flowmate/contracts";
import type { Store } from "../jobs/repository.js";
import { persistRuntimeEvent } from "../evidence/events.js";

export type ControlledRuntime = {
  readonly sessionId?: string;
  /** Optional Pi-resolved model evidence exposed by runtime-pi. */
  readonly modelRef?: { provider: string; modelId: string };
  readonly modelConfigHash?: string;
  run(context: { taskPrompt: string }, onEvent?: (event: RuntimeEvent) => void): Promise<{ kind: "completed" | "aborted" | "failed"; sessionId: string; error?: string }>;
  abort(): Promise<void>;
  close(): Promise<void>;
};
export type CleanupResult = { status: "complete" | "incomplete"; reason?: string };
export type RunHandle = { done: Promise<{ kind: "completed" | "aborted" | "failed"; sessionId: string; error?: string }>; cancel(reason: string): Promise<CleanupResult> };
export type StartControlledRunOptions = { runtime: ControlledRuntime; store: Store; identity: RunIdentity; context: { taskPrompt: string }; onEvent?: (event: RuntimeEvent) => void };

function runStatus(kind: "completed" | "aborted" | "failed"): "succeeded" | "cancelled" | "failed" {
  return kind === "completed" ? "succeeded" : kind === "aborted" ? "cancelled" : "failed";
}

export function startControlledRun(options: StartControlledRunOptions): RunHandle {
  let cancelPromise: Promise<CleanupResult> | undefined;
  let closePromise: Promise<void> | undefined;
  const closeOnce = async (): Promise<void> => {
    closePromise ??= options.runtime.close();
    await closePromise;
  };
  const done = (async () => {
    let outcome: { kind: "completed" | "aborted" | "failed"; sessionId: string; error?: string };
    let cleanup: "complete" | "incomplete" = "complete";
    try {
      outcome = await options.runtime.run(options.context, (event) => {
        persistRuntimeEvent(options.store, event);
        options.onEvent?.(event);
      });
    } catch (error) {
      outcome = { kind: "failed", sessionId: "unknown", error: error instanceof Error ? error.message : "runtime failed" };
    }
    if (outcome.sessionId !== "unknown") {
      try { options.store.attachSession(options.identity, outcome.sessionId); } catch { /* preserve the runtime outcome; cleanup/reporting handles the failure */ }
    }
    try {
      await closeOnce();
    } catch {
      cleanup = "incomplete";
    }
    // A Pi loop can finish normally without ever submitting a candidate. That
    // is a product failure, not a successful extraction, and must be visible
    // to both the Job state and callers waiting on this handle.
    let settled = outcome;
    if (outcome.kind === "completed") {
      try {
        const snapshot = options.store.getJob(options.identity.jobId);
        if (!snapshot.candidates.some((candidate) => candidate.runId === options.identity.runId)) {
          settled = { kind: "failed", sessionId: outcome.sessionId, error: "NO_CANDIDATE" };
        }
      } catch {
        settled = { kind: "failed", sessionId: outcome.sessionId, error: "NO_CANDIDATE" };
      }
    }
    options.store.finishRun(options.identity.runId, runStatus(settled.kind), cleanup);
    return settled;
  })();
  return {
    done,
    async cancel(reason) {
      if (cancelPromise) return cancelPromise;
      cancelPromise = (async () => {
        try {
          options.store.requestCancel(options.identity.runId, reason);
          await options.runtime.abort();
          const outcome = await done;
          await closeOnce();
          // The runtime may settle immediately after abort while its close
          // promise is still pending. Finalize cleanup explicitly after close.
          options.store.finishRun(options.identity.runId, runStatus(outcome.kind), "complete");
          return { status: "complete" as const };
        } catch (error) {
          return { status: "incomplete" as const, reason: error instanceof Error ? error.message : "runtime cleanup failed" };
        }
      })();
      return cancelPromise;
    },
  };
}
