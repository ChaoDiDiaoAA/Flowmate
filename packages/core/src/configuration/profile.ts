import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ModelRefSchema, Sha256Schema } from "@flowmate/contracts";
import type { RuntimeProfile } from "./preflight.js";

const RuntimeProfileFileSchema = z.object({
  profileId: z.string().min(1),
  mode: z.enum(["controlled", "live"]),
  environment: z.enum(["local-test", "production"]),
  available: z.boolean(),
  modelRef: ModelRefSchema.optional(),
  /** Optional expected digest of Pi's sanitized runtime model snapshot. */
  modelConfigHash: Sha256Schema.optional(),
  authPath: z.string().min(1).optional(),
  modelsPath: z.string().min(1).optional(),
  allowedSampleIds: z.array(z.string().min(1)).optional(),
}).strict();

export type RuntimeProfileFile = z.infer<typeof RuntimeProfileFileSchema>;

function unwrapProfile(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "profile" in value) {
    return (value as { profile?: unknown }).profile;
  }
  return value;
}

/**
 * Parse the on-disk Profile format once for CLI and Electron. The profile may
 * be the top-level JSON object or the `profile` section of the unified
 * Flowmate config. Relative
 * credential/model paths are always resolved from the Profile file directory,
 * so changing the caller's working directory cannot select another secret or
 * model configuration. Provider and credential semantics remain Pi-owned.
 */
export function parseRuntimeProfile(value: unknown, profileDirectory: string): RuntimeProfile {
  const parsed = RuntimeProfileFileSchema.safeParse(unwrapProfile(value));
  if (!parsed.success) throw new Error("RUNTIME_PROFILE_INVALID");
  const record = parsed.data;
  if (record.mode === "live" && !record.modelRef) throw new Error("RUNTIME_PROFILE_INCOMPLETE: live Profile needs modelRef");
  const resolvePath = (value: string) => isAbsolute(value) ? value : resolve(profileDirectory, value);
  return {
    profileId: record.profileId,
    environment: record.environment,
    available: record.available,
    mode: record.mode,
    ...(record.modelRef === undefined ? {} : { modelRef: record.modelRef }),
    ...(record.modelConfigHash === undefined ? {} : { modelConfigHash: record.modelConfigHash }),
    ...(record.authPath === undefined ? {} : { authPath: resolvePath(record.authPath) }),
    ...(record.modelsPath === undefined ? {} : { modelsPath: resolvePath(record.modelsPath) }),
    ...(record.allowedSampleIds === undefined ? {} : { allowedSampleIds: [...record.allowedSampleIds] }),
  };
}
