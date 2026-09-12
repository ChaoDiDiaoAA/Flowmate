import { createHash } from "node:crypto";
import { z } from "zod";

const ModelRefSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
}).strict();

const ModelApiSchema = z.enum(["openai-completions", "openai-responses", "anthropic-messages"]);
const InputTypeSchema = z.enum(["text", "image"]);
const ThinkingSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const ModelCapabilitiesSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  inputTypes: z.array(InputTypeSchema).min(1),
  toolCalling: z.boolean(),
  streaming: z.boolean(),
}).strict();

const ModelGenerationSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  thinking: ThinkingSchema.optional(),
}).strict();

const CredentialReferenceSchema = z.object({
  profileId: z.string().min(1),
  source: z.enum(["pi-auth", "env"]),
  envVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source === "env" && !value.envVar) {
    ctx.addIssue({ code: "custom", path: ["envVar"], message: "env credentials require envVar" });
  }
  if (value.source === "pi-auth" && value.envVar !== undefined) {
    ctx.addIssue({ code: "custom", path: ["envVar"], message: "pi-auth credentials cannot declare envVar" });
  }
});

const BudgetSchema = z.object({
  maxModelRequests: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  wallTimeMs: z.number().int().positive(),
  maxKnownTokens: z.number().int().positive().nullable(),
  maxKnownCost: z.number().nonnegative().nullable(),
  unknownUsagePolicy: z.enum(["stop", "continue-with-count-time"]),
}).strict();

const PurposeSchema = z.object({
  environment: z.enum(["local-test", "production"]),
  roles: z.array(z.string().min(1)).optional(),
  allowedSampleIds: z.array(z.string().min(1)).optional(),
}).strict();

/** Product-owned, non-secret model settings. This is not Pi's models.json. */
export const ModelProfileSchema = z.object({
  profileId: z.string().min(1),
  version: z.string().min(1),
  modelRef: ModelRefSchema,
  api: ModelApiSchema,
  baseUrl: z.string().url(),
  capabilities: ModelCapabilitiesSchema,
  generation: ModelGenerationSchema,
  credential: CredentialReferenceSchema,
  budget: BudgetSchema,
  purpose: PurposeSchema,
  /** Digest of the effective custom Pi model definition, if one is used. */
  modelsConfigSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Parse the product model contract and reject secrets/unknown settings. */
export function parseModelProfile(value: unknown): ModelProfile {
  const parsed = ModelProfileSchema.safeParse(value);
  if (!parsed.success) throw new Error("MODEL_PROFILE_INVALID");
  return parsed.data;
}

/** Hash the normalized non-secret profile; no API key or machine path enters it. */
export function hashModelProfile(value: ModelProfile): string {
  const parsed = ModelProfileSchema.parse(value);
  return createHash("sha256").update(canonical(parsed)).digest("hex");
}

export { canonical as canonicalModelProfile };
