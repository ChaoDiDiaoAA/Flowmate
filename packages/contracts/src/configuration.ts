import { z } from "zod";
import { Sha256Schema } from "./common.js";

/** Stable reference into Pi's native model catalog. */
export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
}).strict();
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const TestCandidateSchema = z.object({
  candidateId: z.string().min(1), schemaVersion: z.literal("1"), appSourceHash: Sha256Schema,
  lockHash: Sha256Schema, runtimeLockHash: Sha256Schema, datasetVersion: z.string().min(1),
  modelRef: ModelRefSchema,
  modelConfigHash: Sha256Schema,
  promptHash: Sha256Schema,
  toolVersions: z.record(z.string().min(1), z.string().min(1)),
  extensionVersions: z.record(z.string().min(1), z.string().min(1)),
  environment: z.literal("local-test"),
  budget: z.object({ maxModelRequests: z.number().int().positive(), maxToolCalls: z.number().int().positive(), wallTimeMs: z.number().int().positive() }).strict(),
  eligibility: z.literal("test"),
}).strict();
export type TestCandidate = z.infer<typeof TestCandidateSchema>;
