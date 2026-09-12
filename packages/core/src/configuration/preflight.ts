import { ModelRefSchema, Sha256Schema, TestCandidateSchema, type ModelRef, type TestCandidate } from "@flowmate/contracts";

export type PreflightInput = {
  sampleId: string;
  datasetVersion: string;
  inputHash: string;
  allowed: boolean;
};

export type RuntimeProfile = {
  profileId: string;
  environment: "local-test" | "production";
  available: boolean;
  /** `live` means a real provider/model is required; `controlled` is test-only. */
  mode?: "controlled" | "live";
  modelRef?: ModelRef;
  /** Optional expected digest of the Pi-resolved model snapshot. */
  modelConfigHash?: string;
  authPath?: string;
  modelsPath?: string;
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
  if (profile.mode === "live" && (!profile.modelRef?.provider || !profile.modelRef.modelId)) {
    return reject(profile.environment, "PROFILE_INCOMPLETE", "a Live Profile needs provider and model");
  }
  if (profile.modelRef && !ModelRefSchema.safeParse(profile.modelRef).success) {
    return reject(profile.environment, "MODEL_REF_INVALID", "runtime model reference is invalid");
  }
  if (profile.modelRef && (profile.modelRef.provider !== checked.data.modelRef.provider || profile.modelRef.modelId !== checked.data.modelRef.modelId)) {
    return reject(profile.environment, "MODEL_REF_MISMATCH", "runtime model reference differs from the candidate");
  }
  if (profile.allowedSampleIds && !profile.allowedSampleIds.includes(input.sampleId)) {
    return reject(profile.environment, "SAMPLE_NOT_ALLOWED", "sample is outside the selected profile allowlist");
  }
  if (profile.modelConfigHash && profile.modelConfigHash !== checked.data.modelConfigHash) return reject(profile.environment, "PROFILE_MISMATCH", "runtime model snapshot differs from the candidate");
  if (input.datasetVersion !== checked.data.datasetVersion) return reject(profile.environment, "DATASET_MISMATCH", "input dataset differs from the candidate");
  if (!input.allowed) return reject(profile.environment, "INPUT_NOT_APPROVED", "input projection is not approved");
  if (!input.sampleId || !Sha256Schema.safeParse(input.inputHash).success) return reject(profile.environment, "INPUT_INVALID", "input identity or digest is invalid");
  return { eligible: true, environment: "local-test", profileId: profile.profileId, reasons: ["first test run does not require a quality score"] };
}
