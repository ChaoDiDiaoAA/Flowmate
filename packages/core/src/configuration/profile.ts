import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { RuntimeProfile } from "./preflight.js";
import { hashModelProfile, ModelProfileSchema, type ModelProfile } from "./model-profile.js";

const ModelRefSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
}).strict();

const RuntimeProfileFileSchema = z.object({
  profileId: z.string().min(1),
  mode: z.enum(["controlled", "live"]),
  environment: z.enum(["local-test", "production"]),
  available: z.boolean(),
  modelProfileHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  modelRef: ModelRefSchema.optional(),
  modelProfile: ModelProfileSchema.optional(),
  authPath: z.string().min(1).optional(),
  modelsPath: z.string().min(1).optional(),
  allowedSampleIds: z.array(z.string().min(1)).optional(),
}).strict();

export type RuntimeProfileFile = z.infer<typeof RuntimeProfileFileSchema>;

/**
 * Parse the on-disk Profile format once for CLI and Electron. Relative
 * credential/model paths are always resolved from the Profile file directory,
 * so changing the caller's working directory cannot select another secret or
 * model configuration.
 */
export function parseRuntimeProfile(value: unknown, profileDirectory: string): RuntimeProfile {
  const parsed = RuntimeProfileFileSchema.safeParse(value);
  if (!parsed.success) throw new Error("RUNTIME_PROFILE_INVALID");
  const record = parsed.data;
  const effectiveModelRef = record.modelRef ?? record.modelProfile?.modelRef;
  const computedModelProfileHash = record.modelProfile ? hashModelProfile(record.modelProfile) : undefined;
  if (!computedModelProfileHash && !record.modelProfileHash) {
    throw new Error("RUNTIME_PROFILE_INCOMPLETE: modelProfile or modelProfileHash is required");
  }
  if (record.modelProfile) {
    if (record.modelProfileHash && computedModelProfileHash !== record.modelProfileHash) {
      throw new Error("RUNTIME_PROFILE_MODEL_HASH_MISMATCH");
    }
    if (record.modelRef && (record.modelRef.provider !== record.modelProfile.modelRef.provider || record.modelRef.modelId !== record.modelProfile.modelRef.modelId)) {
      throw new Error("RUNTIME_PROFILE_MODEL_REF_MISMATCH");
    }
    if (record.modelProfile.purpose.environment !== record.environment) {
      throw new Error("RUNTIME_PROFILE_ENVIRONMENT_MISMATCH");
    }
  }
  if (record.mode === "live" && !effectiveModelRef) throw new Error("RUNTIME_PROFILE_INCOMPLETE: live Profile needs modelRef");
  if (record.mode === "live" && !record.authPath && !record.modelsPath) {
    throw new Error("RUNTIME_PROFILE_INCOMPLETE: live Profile needs authPath or modelsPath");
  }
  const resolvePath = (value: string) => isAbsolute(value) ? value : resolve(profileDirectory, value);
  return {
    profileId: record.profileId,
    environment: record.environment,
    modelProfileHash: computedModelProfileHash ?? record.modelProfileHash!,
    available: record.available,
    mode: record.mode,
    ...(effectiveModelRef === undefined ? {} : { modelRef: effectiveModelRef }),
    ...(record.modelProfile === undefined ? {} : { modelProfile: record.modelProfile as ModelProfile }),
    ...(record.authPath === undefined ? {} : { authPath: resolvePath(record.authPath) }),
    ...(record.modelsPath === undefined ? {} : { modelsPath: resolvePath(record.modelsPath) }),
    ...(record.allowedSampleIds === undefined ? {} : { allowedSampleIds: [...record.allowedSampleIds] }),
  };
}
