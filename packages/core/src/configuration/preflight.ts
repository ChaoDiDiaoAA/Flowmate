import { Sha256Schema, TestCandidateSchema, type TestCandidate } from "@flowmate/contracts";

export type PreflightInput = {
  sampleId: string;
  datasetVersion: string;
  inputHash: string;
  allowed: boolean;
};

export type RuntimeProfile = {
  profileId: string;
  environment: "local-test" | "production";
  modelProfileHash: string;
  available: boolean;
  /** `live` means a real provider/model is required; `controlled` is test-only. */
  mode?: "controlled" | "live";
  modelRef?: { provider: string; modelId: string };
  authPath?: string;
  allowedSampleIds?: string[];
};

export type EligibilityResult =
  | { eligible: true; environment: "local-test"; profileId: string; reasons: string[] }
  | { eligible: false; environment: "local-test" | "production"; error: { code: string; message: string } };

function reject(environment: RuntimeProfile["environment"], code: string, message: string): EligibilityResult {
  return { eligible: false, environment, error: { code, message } };
}

export function preflight(candidate: TestCandidate, input: PreflightInput, profile: RuntimeProfile): EligibilityResult {
  const checked = TestCandidateSchema.safeParse(candidate);
  if (!checked.success) return reject(profile.environment, "CANDIDATE_INVALID", "candidate does not satisfy the fixed test contract");
  if (profile.environment !== "local-test") return reject(profile.environment, "PRODUCTION_FORBIDDEN", "P0 candidates may run only in local-test");
  if (!profile.available) return reject(profile.environment, "PROFILE_UNAVAILABLE", "selected runtime profile is unavailable");
  if (profile.mode === "live" && (!profile.modelRef?.provider || !profile.modelRef.modelId || !profile.authPath)) {
    return reject(profile.environment, "PROFILE_INCOMPLETE", "a Live Profile needs provider, model, and auth path");
  }
  if (profile.allowedSampleIds && !profile.allowedSampleIds.includes(input.sampleId)) {
    return reject(profile.environment, "SAMPLE_NOT_ALLOWED", "sample is outside the selected profile allowlist");
  }
  if (profile.modelProfileHash !== checked.data.modelProfileHash) return reject(profile.environment, "PROFILE_MISMATCH", "runtime profile hash differs from the candidate");
  if (input.datasetVersion !== checked.data.datasetVersion) return reject(profile.environment, "DATASET_MISMATCH", "input dataset differs from the candidate");
  if (!input.allowed) return reject(profile.environment, "INPUT_NOT_APPROVED", "input projection is not approved");
  if (!input.sampleId || !Sha256Schema.safeParse(input.inputHash).success) return reject(profile.environment, "INPUT_INVALID", "input identity or digest is invalid");
  return { eligible: true, environment: "local-test", profileId: profile.profileId, reasons: ["first test run does not require a quality score"] };
}
