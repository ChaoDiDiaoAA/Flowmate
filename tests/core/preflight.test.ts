import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { freezeCandidate, type CandidateConfig } from "../../packages/core/src/configuration/candidate.ts";
import { preflight, type PreflightInput, type RuntimeProfile } from "../../packages/core/src/configuration/preflight.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const config: CandidateConfig = {
  schemaVersion: "1",
  appSourceHash: hash("app"),
  lockHash: hash("lock"),
  runtimeLockHash: hash("runtime"),
  datasetVersion: "p0-fixture",
  modelRef: { provider: "flowmate-controlled", modelId: "controlled" },
  modelConfigHash: hash("model"),
  promptHash: hash("prompt"),
  toolVersions: { read_parsed_document: "1", read_evidence: "1", submit_invoice_candidate: "1" },
  extensionVersions: {},
  environment: "local-test",
  budget: { maxModelRequests: 3, maxToolCalls: 5, wallTimeMs: 10_000 },
  eligibility: "test",
};
const input: PreflightInput = { sampleId: "SYN-001", datasetVersion: "p0-fixture", inputHash: hash("input"), allowed: true };
const profile: RuntimeProfile = { profileId: "offline-fixture", environment: "local-test", modelConfigHash: hash("model"), modelRef: { provider: "flowmate-controlled", modelId: "controlled" }, available: true };

describe("candidate freezing and preflight", () => {
  it("derives a stable candidate id from the immutable configuration", () => {
    const first = freezeCandidate(config);
    const second = freezeCandidate({ ...config, toolVersions: { ...config.toolVersions } });
    expect(first.candidateId).toBe(second.candidateId);
    expect(first.candidateId).toMatch(/^candidate-[a-f0-9]{64}$/);
  });

  it("allows a first local test without a quality score", () => {
    expect(preflight(freezeCandidate(config), input, profile)).toMatchObject({ eligible: true, environment: "local-test" });
  });

  it("allows a custom live model when its explicit models file supplies the credential binding", () => {
    const result = preflight(freezeCandidate(config), input, {
      ...profile,
      mode: "live",
      modelRef: { provider: "flowmate-controlled", modelId: "controlled" },
      modelsPath: "D:/flowmate/private/llm/models.json",
    });
    expect(result).toMatchObject({ eligible: true, environment: "local-test" });
  });

  it.each([
    ["production", { ...profile, environment: "production" as const }, input, "PRODUCTION_FORBIDDEN"],
    ["missing profile", { ...profile, available: false }, input, "PROFILE_UNAVAILABLE"],
    ["model drift", { ...profile, modelConfigHash: hash("other") }, input, "PROFILE_MISMATCH"],
    ["model reference drift", { ...profile, modelRef: { provider: "other", modelId: "model" } }, input, "MODEL_REF_MISMATCH"],
    ["dataset drift", profile, { ...input, datasetVersion: "other" }, "DATASET_MISMATCH"],
  ])("rejects %s before model execution", (_name, profileValue, inputValue, expected) => {
    const candidate = freezeCandidate(config);
    const result = preflight(candidate, inputValue as PreflightInput, profileValue as RuntimeProfile);
    expect(result).toMatchObject({ eligible: false, error: { code: expected } });
  });
});
