import { describe, expect, it } from "vitest";
import {
  acquisitionJobSchema,
  catalogEntryRefSchema,
  datasetManifestSchema,
  dedupeDecisionSchema,
  parsedDocumentSchema,
  policyDecisionSchema,
  rawArtifactRefSchema,
  sourcePolicySchema,
} from "../src/schemas.js";

const sourcePolicy = {
  sourceId: "SRC-000001",
  domain: "example.com",
  sourceType: "public_web",
  accessStrategy: "public",
  sourcePolicy: "allowed",
  rawRetention: "allowed",
  datasetUsage: "allowed",
  synthetic: false,
  containsSyntheticIdentifiers: false,
  enabled: true,
};

describe("sourcePolicySchema", () => {
  it("accepts a complete public source policy", () => {
    expect(sourcePolicySchema.safeParse(sourcePolicy).success).toBe(true);
  });

  it("rejects authenticated sources for P0 automatic acquisition", () => {
    const result = sourcePolicySchema.safeParse({
      ...sourcePolicy,
      accessStrategy: "authenticated",
    });
    expect(result.success).toBe(false);
  });
});

describe("P0 record schemas", () => {
  it("accepts complete acquisition, raw, parsed, dedupe, policy, and catalog records", () => {
    expect(
      acquisitionJobSchema.safeParse({
        jobId: "ACQ-20260826-0001",
        sourceId: "SRC-000001",
        objective: "Collect public invoices",
        status: "COMPLETED",
        startedAt: "2026-08-26T12:00:00+08:00",
        counts: { discovered: 1, stored: 1, duplicated: 0, quarantined: 0, failed: 0 },
      }).success,
    ).toBe(true);
    expect(
      rawArtifactRefSchema.safeParse({
        artifactId: "ART-000001",
        sourceIds: ["SRC-000001"],
        acquisitionJobIds: ["ACQ-20260826-0001"],
        rawSha256: "a".repeat(64),
        mimeType: "application/pdf",
        retentionStatus: "retained",
      }).success,
    ).toBe(true);
    expect(
      parsedDocumentSchema.safeParse({
        artifactId: "ART-000001",
        parserName: "mineru",
        parserVersion: "1.0.21",
        parsedAt: "2026-08-26T12:00:00+08:00",
        contentRef: "derived/content.md",
        imageRefs: [],
        contentSha256: "b".repeat(64),
        warnings: [],
      }).success,
    ).toBe(true);
    expect(
      dedupeDecisionSchema.safeParse({
        status: "unique",
        canonicalArtifactId: "ART-000001",
        relatedArtifactIds: [],
      }).success,
    ).toBe(true);
    expect(
      policyDecisionSchema.safeParse({
        itemId: "SAMPLE-000001",
        licenseStatus: "allowed",
        privacyStatus: "passed",
        qualityStatus: "passed",
        action: "catalog",
        reasonCodes: [],
        policyVersion: "p0-policy-1.0",
        decidedAt: "2026-08-26T12:00:00+08:00",
      }).success,
    ).toBe(true);
    expect(
      catalogEntryRefSchema.safeParse({
        entryId: "SAMPLE-000001",
        entryType: "public_sample",
        noteRef: "40_PublicSamples/SAMPLE-000001.md",
        sourceId: "SRC-000001",
        pipelineStatus: "CATALOGED",
      }).success,
    ).toBe(true);
  });

  it("rejects records without required IDs, status, hashes, or policy fields", () => {
    expect(
      acquisitionJobSchema.safeParse({
        sourceId: "SRC-000001",
        objective: "Collect public invoices",
        startedAt: "2026-08-26T12:00:00+08:00",
        counts: {},
      }).success,
    ).toBe(false);
    expect(
      rawArtifactRefSchema.safeParse({
        artifactId: "ART-000001",
        sourceIds: [],
        acquisitionJobIds: [],
        mimeType: "application/pdf",
        retentionStatus: "retained",
      }).success,
    ).toBe(false);
    expect(
      parsedDocumentSchema.safeParse({ artifactId: "ART-000001" }).success,
    ).toBe(false);
    expect(
      dedupeDecisionSchema.safeParse({ canonicalArtifactId: "ART-000001" }).success,
    ).toBe(false);
    expect(
      policyDecisionSchema.safeParse({ itemId: "SAMPLE-000001" }).success,
    ).toBe(false);
    expect(
      catalogEntryRefSchema.safeParse({ entryId: "SAMPLE-000001" }).success,
    ).toBe(false);
  });
});

describe("datasetManifestSchema", () => {
  it("accepts a complete publishable item", () => {
    expect(
      datasetManifestSchema.safeParse({
        schemaVersion: "1.0",
        datasetVersion: "dataset-v0.1",
        createdAt: "2026-08-26T12:00:00+08:00",
        sourcePolicyVersion: "1.0",
        items: [
          {
            itemId: "SAMPLE-000001",
            itemType: "public_sample",
            sourceId: "SRC-000001",
            artifactId: "ART-000001",
            rawSha256: "c".repeat(64),
            licenseStatus: "allowed",
            privacyStatus: "passed",
            qualityStatus: "passed",
            scenarios: ["normal"],
          },
        ],
        checksumsRef: "checksums.sha256",
      }).success,
    ).toBe(true);
  });

  it("rejects an item without a raw SHA-256", () => {
    const result = datasetManifestSchema.safeParse({
      schemaVersion: "1.0",
      datasetVersion: "dataset-v0.1",
      createdAt: "2026-08-26T12:00:00+08:00",
      sourcePolicyVersion: "1.0",
      items: [{ itemId: "SAMPLE-000001" }],
      checksumsRef: "checksums.sha256",
    });
    expect(result.success).toBe(false);
  });
});
