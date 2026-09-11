import { z } from "zod";
import { AssetRefSchema, Sha256Schema } from "./common.js";

export const DatasetPurposeSchema = z.enum(["development", "test", "holdout"]);
export type DatasetPurpose = z.infer<typeof DatasetPurposeSchema>;

export const DatasetCaseSchema = z.object({
  sampleId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceGroup: z.string().min(1),
  purpose: DatasetPurposeSchema,
  original: AssetRefSchema,
  parsed: AssetRefSchema,
  parserVersion: z.string().min(1),
  isolatedLabelRef: AssetRefSchema.nullable(),
  checks: z.array(z.object({ id: z.string().min(1), ok: z.boolean(), message: z.string().min(1) }).strict()),
}).strict();
export type DatasetCase = z.infer<typeof DatasetCaseSchema>;

export const DatasetManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  datasetVersion: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  cases: z.array(DatasetCaseSchema),
  checksums: z.record(z.string().min(1), Sha256Schema),
}).strict();
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;
