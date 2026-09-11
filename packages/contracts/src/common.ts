import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be lowercase hex");
export const AssetRefSchema = z.object({
  assetId: z.string().min(1),
  sha256: Sha256Schema,
  mediaType: z.string().min(1),
}).strict();
export type AssetRef = z.infer<typeof AssetRefSchema>;

export const EvidenceRefSchema = z.object({
  assetId: z.string().min(1),
  blockId: z.string().min(1).nullable(),
  page: z.number().int().positive().nullable(),
  quote: z.string().nullable(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ValueStatusSchema = z.enum(["present", "missing", "ambiguous", "conflict"]);
export type ValueStatus = z.infer<typeof ValueStatusSchema>;

export const FieldValueSchema = z.object({
  raw: z.string().nullable(),
  normalized: z.string().nullable(),
  status: ValueStatusSchema,
  evidence: z.array(EvidenceRefSchema),
}).strict().superRefine((value, ctx) => {
  if (value.status === "missing" && value.normalized !== null) {
    ctx.addIssue({ code: "custom", path: ["normalized"], message: "missing values must have null normalized value" });
  }
});
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const SchemaVersionSchema = z.literal("1");
