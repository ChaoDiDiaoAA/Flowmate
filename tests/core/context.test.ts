import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { freezeCandidate, buildContext, type CandidateConfig } from "../../packages/core/src/index.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const candidateConfig: CandidateConfig = {
  schemaVersion: "1", appSourceHash: hash("app"), lockHash: hash("lock"), runtimeLockHash: hash("runtime"), datasetVersion: "p0-fixture", modelProfileHash: hash("model"), promptHash: hash("prompt"), toolVersions: { read_parsed_document: "1" }, extensionVersions: {}, environment: "local-test", budget: { maxModelRequests: 3, maxToolCalls: 5, wallTimeMs: 10_000 }, eligibility: "test",
};

describe("scoped extraction context", () => {
  it("contains only the selected input ids and no labels or credentials", () => {
    const candidate = freezeCandidate(candidateConfig);
    const context = buildContext(
      { jobId: "job-1", runId: "run-1", generation: 1, candidateId: candidate.candidateId },
      { sampleId: "SYN-001", datasetVersion: "p0-fixture", inputHash: hash("input"), allowedAssetIds: ["original:fixture:SYN-001", "parsed:fixture:SYN-001"] },
      candidate,
    );
    const serialized = JSON.stringify(context);
    expect(context.assetIds).toEqual(["original:fixture:SYN-001", "parsed:fixture:SYN-001"]);
    expect(serialized).not.toContain("GOLD_SENTINEL");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("isolatedLabelRef");
  });

  it("rejects an identity for a different candidate", () => {
    const candidate = freezeCandidate(candidateConfig);
    expect(() => buildContext({ jobId: "job-1", runId: "run-1", generation: 1, candidateId: "other" }, { sampleId: "SYN-001", datasetVersion: "p0-fixture", inputHash: hash("input"), allowedAssetIds: [] }, candidate)).toThrow("CANDIDATE_MISMATCH");
  });
});
