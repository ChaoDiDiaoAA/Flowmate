import { describe, expect, it } from "vitest";
import { linkRegression, recordFinding, reviewFinding } from "../src/findings.js";

describe("reviewed Good/Bad findings", () => {
  it("requires a real observation and preserves an old Bad history", () => {
    expect(() => recordFinding({ caseId: "case", trialId: "trial-not-run", executionStatus: "NOT_RUN", classification: "good", verdict: null, rootCause: null, causeConfidence: "unresolved", evidence: [] })).toThrow("OBSERVATION_REQUIRED");
    const finding = recordFinding({ findingId: "finding-1", caseId: "case", trialId: "trial-1", executionStatus: "COMPLETED", classification: "bad", verdict: "FAIL", rootCause: "product", causeConfidence: "confirmed", evidence: [] });
    const reviewed = reviewFinding(finding.findingId, { classification: "bad", note: "confirmed from tool trace" });
    const fixed = linkRegression(finding.findingId, { trialId: "trial-2", executionStatus: "COMPLETED", verdict: "PASS" });
    expect(reviewed.history).toHaveLength(2);
    expect(fixed.history.some((item) => item.classification === "bad")).toBe(true);
  });
});
