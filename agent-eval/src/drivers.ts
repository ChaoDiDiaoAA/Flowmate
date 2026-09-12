import { createHash } from "node:crypto";
import { EvalTrialSchema, type EvalCase, type EvalTrial } from "./schema.js";
import type { EvalDriver, EvalDriverInput } from "./runner.js";
import type { EvidenceRef } from "./schema.js";

export type ProductApplicationLike = {
  start(command: { sampleId: string; candidateId: string; clientRequestId: string }): Promise<{ jobId: string; runId: string }>;
  wait(runId: string): Promise<{ kind: "completed" | "aborted" | "failed"; sessionId: string; error?: string }>;
  getJob(command: { jobId: string }): { candidates: unknown[] };
  cancel(command: { runId: string }): Promise<{ status: "complete" | "incomplete"; reason?: string }>;
};

export type ProductDriverOptions = {
  application: ProductApplicationLike;
  candidateId: string;
  sampleIdForCase?: (caseDef: EvalCase) => string;
  productReportRefs?: (input: EvalDriverInput, job: { candidates: unknown[] }) => EvidenceRef[];
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function trialBase(input: EvalDriverInput, status: EvalTrial["executionStatus"], startedAt: string | null, endedAt: string | null): EvalTrial {
  return {
    evalRunId: input.evalRunId,
    trialId: input.trialId,
    caseId: input.caseDef.caseId,
    candidateId: input.candidateId,
    caseHash: digest(input.caseDef),
    goldHash: input.caseDef.goldRef.sha256,
    graderHash: digest("flowmate-eval-grader-v1"),
    attemptIndex: input.attemptIndex,
    executionStatus: status,
    jobId: null,
    runIds: [],
    childRunIds: [],
    startedAt,
    endedAt,
    usage: { inputTokens: null, outputTokens: null, cost: null, unknown: true },
    assertionResults: [],
    verdict: null,
    errorKind: null,
    upstreamBlocked: status === "NOT_RUN",
    productReportRefs: [],
  };
}

/**
 * Adapt the product Application to the evaluation runner. The adapter only
 * starts and observes an owned Application run; it never writes product
 * storage or manufactures a quality verdict. Graders fill assertionResults
 * and verdict after the trial has been persisted.
 */
export function createProductDriver(options: ProductDriverOptions): EvalDriver {
  return async (input) => {
    if (input.signal.aborted) return EvalTrialSchema.parse({ ...trialBase(input, "NOT_RUN", null, null), errorKind: "EVAL_CANCELLED" });
    const sampleId = options.sampleIdForCase?.(input.caseDef) ?? input.caseDef.caseId;
    const startedAt = new Date().toISOString();
    let identity: { jobId: string; runId: string };
    try {
      identity = await options.application.start({ sampleId, candidateId: options.candidateId, clientRequestId: `eval:${input.trialId}` });
    } catch (error) {
      return EvalTrialSchema.parse({ ...trialBase(input, "ERROR", startedAt, new Date().toISOString()), errorKind: error instanceof Error ? error.message : "PRODUCT_START_FAILED" });
    }
    const onAbort = () => { void options.application.cancel({ runId: identity.runId }); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const outcome = await options.application.wait(identity.runId);
      const job = options.application.getJob({ jobId: identity.jobId });
      const trial = trialBase(input, "COMPLETED", startedAt, new Date().toISOString());
      return EvalTrialSchema.parse({
        ...trial,
        jobId: identity.jobId,
        runIds: [identity.runId],
        productReportRefs: options.productReportRefs?.(input, job) ?? [],
        errorKind: outcome.kind === "failed" ? outcome.error ?? "PRODUCT_RUN_FAILED" : outcome.kind === "aborted" ? "PRODUCT_RUN_ABORTED" : null,
      });
    } catch (error) {
      return EvalTrialSchema.parse({
        ...trialBase(input, "ERROR", startedAt, new Date().toISOString()),
        jobId: identity.jobId,
        runIds: [identity.runId],
        errorKind: error instanceof Error ? error.message : "PRODUCT_WAIT_FAILED",
      });
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  };
}
