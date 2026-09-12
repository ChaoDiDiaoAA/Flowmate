import { describe, expect, it } from "vitest";
import { decide } from "../src/decision.js";
import type { EvalTrial } from "../src/schema.js";

const base = (caseId: string, verdict: EvalTrial["verdict"], status: EvalTrial["executionStatus"] = "COMPLETED"): EvalTrial => ({ evalRunId: "eval", trialId: caseId, caseId, candidateId: "candidate", caseHash: "a".repeat(64), goldHash: "b".repeat(64), graderHash: "c".repeat(64), attemptIndex: 1, executionStatus: status, jobId: null, runIds: [], childRunIds: [], startedAt: null, endedAt: null, usage: { inputTokens: null, outputTokens: null, cost: null, unknown: true }, assertionResults: [], verdict, errorKind: null, upstreamBlocked: status !== "COMPLETED", productReportRefs: [] });

describe("quality decision gate", () => {
  it("keeps missing mechanism evidence insufficient", () => {
    expect(decide({ candidateId: "candidate", assetVersion: "p0", requiredCaseIds: ["case"], requiredEvidenceCaseIds: ["child"] }, [base("case", "PASS")])).toMatchObject({ status: "INSUFFICIENT_EVIDENCE" });
  });

  it("fails a mandatory unauthorized action", () => {
    const trial = { ...base("case", "FAIL"), assertionResults: [{ assertionId: "access", verdict: "FAIL", critical: true, evidence: [], reasonCode: "UNAUTHORIZED_ACCESS" }] };
    expect(decide({ candidateId: "candidate", assetVersion: "p0", requiredCaseIds: ["case"] }, [trial])).toMatchObject({ status: "FAIL", blockingReasons: ["QUALITY_FAILURE:case", "UNAUTHORIZED_ACCESS"] });
  });
});
