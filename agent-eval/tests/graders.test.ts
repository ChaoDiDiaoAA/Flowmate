import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareDecimal, gradeCurrency, gradeFields } from "../src/grader-fields.js";
import { gradeRuntime, verdictFor } from "../src/grader-runtime.js";
import type { FieldGold } from "../src/schema.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missingCurrency: FieldGold = {
  fieldPath: "fields.currency", sourceValue: "CNY", sourceNormalized: "CNY", sourceStatus: "present", normalized: null, valueStatus: "missing", inputAvailability: "available", evidence: [], comparison: "status", reviewStatus: "verified",
};
const amount: FieldGold = {
  fieldPath: "fields.totalAmount", sourceValue: "110.00", sourceNormalized: "110.00", sourceStatus: "present", normalized: "110.00", valueStatus: "present", inputAvailability: "available", evidence: [{ id: "block-7", sha256: hash("block-7"), source: "synthetic/block-7" }], comparison: "decimal", reviewStatus: "verified",
};

describe("independent evaluation graders", () => {
  it("compares decimals exactly without product normalization", () => {
    expect(compareDecimal("110", "110.00")).toBe(true);
    expect(compareDecimal("110.01", "110.00")).toBe(false);
    expect(compareDecimal("-0.0", "0")).toBe(true);
  });

  it("keeps missing distinct from guessed currency", () => {
    expect(gradeCurrency({ normalized: null, status: "missing" }, missingCurrency)).toMatchObject({ verdict: "PASS" });
    expect(gradeCurrency({ normalized: "CNY", status: "present" }, missingCurrency)).toMatchObject({ verdict: "FAIL" });
  });

  it("marks value correct but missing evidence as unjudgeable", () => {
    const results = gradeFields({ fields: { totalAmount: { normalized: "110", status: "present", evidence: [] } } }, [amount]);
    expect(results[0]).toMatchObject({ verdict: "UNJUDGEABLE", reasonCode: "EVIDENCE_MISMATCH" });
  });

  it("grades runtime event order requirements and cleanup separately", () => {
    const results = gradeRuntime({ processAlive: true, events: [
      { type: "tool.finished", toolName: "read_evidence", sessionId: "parent", evidence: [] },
      { type: "delegation.finished", sessionId: "parent", childSessionId: "child", cleanupStatus: "complete" },
    ] }, { oracleId: "subagent", requiredEvents: ["delegation.finished"], requiredTools: ["read_evidence"], requireDistinctChildSession: true, requireCleanup: true });
    expect(verdictFor(results)).toBe("FAIL");
    expect(results.find((item) => item.assertionId.endsWith(":cleanup"))).toMatchObject({ reasonCode: "CLEANUP_INCOMPLETE" });
  });

  it("does not pass cleanup when host liveness was not observed", () => {
    const results = gradeRuntime({ events: [{ type: "runtime.finished", cleanupStatus: "complete" }] }, { oracleId: "cleanup", requireCleanup: true });
    expect(results).toContainEqual(expect.objectContaining({ verdict: "UNJUDGEABLE", reasonCode: "CLEANUP_EVIDENCE_MISSING" }));
  });
});
