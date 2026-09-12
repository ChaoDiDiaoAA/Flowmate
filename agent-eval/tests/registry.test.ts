import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveEvidence, isReusable, type EvidenceReport } from "../src/registry.js";
import { EvalCaseSchema } from "../src/schema.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ref = (id: string) => ({ id, sha256: hash(id), source: `synthetic/${id}` });
const caseDef = EvalCaseSchema.parse({
  caseId: "P0-RT-TOOL-01-I",
  version: "1",
  primaryModule: "tool",
  relatedModules: [],
  runtimeRefs: ["RTC-04-01"],
  benchmarkRefs: ["BM-11"],
  scope: "integration",
  level: "F",
  sourceKind: "synthetic",
  sourceGroup: "runtime-tool",
  purpose: "development",
  inputRef: ref("input"),
  fixtureVersion: "fixture-1",
  goldRef: ref("gold"),
  rubricVersion: "rubric-1",
  required: true,
  assertions: ["tool-call", "tool-result"],
  driverId: "product-f",
});

const report: EvidenceReport = {
  reportId: "report-1",
  caseId: caseDef.caseId,
  candidateId: "candidate-1",
  scope: "integration",
  scenarioId: caseDef.caseId,
  variantId: "node",
  appSourceHash: "source-1",
  lockHash: "lock-1",
  patchHash: null,
  inputHash: caseDef.inputRef.sha256!,
  fixtureVersion: "fixture-1",
  executedAt: new Date().toISOString(),
  assertions: ["tool-call", "tool-result"],
  evidenceRefs: [ref("trace")],
  toolNames: ["read_parsed_document"],
};

describe("evaluation evidence registry", () => {
  it("reuses only a report matching the case, scope, input and versions", () => {
    const binding = resolveEvidence(caseDef, "candidate-1", [report], { variantId: "node", appSourceHash: "source-1", lockHash: "lock-1", inputHash: caseDef.inputRef.sha256!, requiredToolNames: ["read_parsed_document"] });
    expect(binding.primary?.reportId).toBe("report-1");
    expect(isReusable({ ...report, scope: "native" }, binding.binding)).toBe(false);
    expect(isReusable({ ...report, patchHash: hash("old-patch") }, binding.binding)).toBe(false);
  });

  it("does not treat a report with only a matching filename as evidence", () => {
    const result = resolveEvidence(caseDef, "candidate-1", [{ ...report, candidateId: "other-candidate", assertions: [] }], { variantId: "node", appSourceHash: "source-1", lockHash: "lock-1", inputHash: caseDef.inputRef.sha256! });
    expect(result.primary).toBeNull();
    expect(result.missing).toEqual([caseDef.caseId]);
  });
});
