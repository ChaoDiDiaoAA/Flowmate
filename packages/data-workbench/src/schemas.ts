import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const sourcePolicySchema = z
  .object({
    sourceId: z.string(),
    domain: z.string(),
    sourceType: z.enum(["public_web", "internal_business"]),
    accessStrategy: z.literal("public"),
    sourcePolicy: z.enum(["allowed", "unknown", "denied"]),
    rawRetention: z.enum(["allowed", "metadata_only", "denied"]),
    datasetUsage: z.enum(["allowed", "denied"]),
    synthetic: z.boolean(),
    containsSyntheticIdentifiers: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();

export const acquisitionJobSchema = z
  .object({
    jobId: z.string(),
    sourceId: z.string(),
    objective: z.string(),
    status: z.enum([
      "CREATED",
      "DISCOVERING_ADAPTER",
      "FETCHING",
      "STAGED",
      "RAW_SAVED",
      "PARSING",
      "DEDUPLICATING",
      "POLICY_CHECKING",
      "CATALOGING",
      "COMPLETED",
      "ADAPTER_NOT_FOUND",
      "FETCH_FAILED",
      "PARSER_UNAVAILABLE",
      "PARSE_FAILED",
      "RESULT_DOWNLOAD_TLS_FAILED",
      "BATCH_LIMIT_EXCEEDED",
      "POLICY_REJECTED",
      "CATALOG_WRITE_FAILED",
      "CANCELLED",
    ]),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    counts: z
      .object({
        discovered: z.number(),
        stored: z.number(),
        duplicated: z.number(),
        quarantined: z.number(),
        failed: z.number(),
      })
      .strict(),
  })
  .strict();

export const rawArtifactRefSchema = z
  .object({
    artifactId: z.string(),
    sourceIds: z.array(z.string()),
    acquisitionJobIds: z.array(z.string()),
    canonicalUrl: z.string().optional(),
    rawRef: z.string().optional(),
    rawSha256: sha256Schema,
    mimeType: z.string(),
    retentionStatus: z.enum(["retained", "metadata_only", "deleted_by_policy"]),
  })
  .strict();

export const parsedDocumentSchema = z
  .object({
    artifactId: z.string(),
    parserName: z.string(),
    parserVersion: z.string(),
    parsedAt: z.string(),
    contentRef: z.string(),
    structureRef: z.string().optional(),
    imageRefs: z.array(z.string()),
    contentSha256: sha256Schema,
    pageCount: z.number().optional(),
    warnings: z.array(z.string()),
  })
  .strict();

export const dedupeDecisionSchema = z
  .object({
    status: z.enum([
      "unique",
      "duplicate_url",
      "duplicate_raw",
      "duplicate_content",
      "url_updated",
    ]),
    canonicalArtifactId: z.string(),
    relatedArtifactIds: z.array(z.string()),
  })
  .strict();

export const policyDecisionSchema = z
  .object({
    itemId: z.string(),
    licenseStatus: z.enum(["allowed", "unknown", "denied"]),
    privacyStatus: z.enum(["passed", "quarantined", "delete_content"]),
    qualityStatus: z.enum(["passed", "quarantined"]),
    action: z.enum(["catalog", "quarantine", "delete_content_keep_metadata"]),
    reasonCodes: z.array(z.string()),
    policyVersion: z.literal("p0-policy-1.0"),
    decidedAt: z.string(),
  })
  .strict();

export const catalogEntryRefSchema = z
  .object({
    entryId: z.string(),
    entryType: z.enum([
      "knowledge",
      "public_sample",
      "business_asset",
      "quarantine",
      "failure",
    ]),
    noteRef: z.string(),
    sourceId: z.string(),
    artifactId: z.string().optional(),
    pipelineStatus: z.string(),
  })
  .strict();

export const datasetManifestItemSchema = z
  .object({
    itemId: z.string(),
    itemType: z.enum(["knowledge", "public_sample", "business_asset"]),
    sourceId: z.string(),
    artifactId: z.string(),
    rawRef: z.string().optional(),
    derivedRef: z.string().optional(),
    expectedRef: z.string().optional(),
    rawSha256: sha256Schema,
    contentSha256: sha256Schema.optional(),
    parserName: z.string().optional(),
    parserVersion: z.string().optional(),
    licenseStatus: z.literal("allowed"),
    privacyStatus: z.literal("passed"),
    qualityStatus: z.literal("passed"),
    scenarios: z.array(z.string()),
  })
  .strict();

export const datasetManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    datasetVersion: z.string(),
    createdAt: z.string(),
    sourcePolicyVersion: z.string(),
    items: z.array(datasetManifestItemSchema),
    checksumsRef: z.string(),
  })
  .strict();
