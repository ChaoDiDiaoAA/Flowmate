import { describe, expect, it } from "vitest";
import { inspectSource, importParsed, type SourceIssueCode } from "../../packages/data/src/index.ts";
import { withSourceFixture } from "../support/workspace.js";

function issueCodes(report: { quarantinedEntries: Array<{ issue: { code: SourceIssueCode } }>; errors: Array<{ code: SourceIssueCode }> }): string[] {
  return [...report.quarantinedEntries.map((entry) => entry.issue.code), ...report.errors.map((error) => error.code)];
}

describe("source inspection and parsed import", () => {
  it("accepts a paired original and parsed document", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      expect(report.validEntries).toHaveLength(1);
      const result = await importParsed(report.validEntries[0]!);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sampleId).toBe("SYN-001");
        expect(result.value.original.mediaType).toBe("application/pdf");
        expect(result.value.blocks[0]?.evidence.assetId).toBe(result.value.original.assetId);
      }
    });
  });

  it("drops labels and unknown annotation fields from a mixed source", async () => {
    await withSourceFixture("mixed-label", async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      expect(report.validEntries).toHaveLength(1);
      const result = await importParsed(report.validEntries[0]!);
      expect(JSON.stringify(result)).not.toContain("GOLD_SENTINEL_71");
      expect(result.ok).toBe(true);
    });
  });

  it("imports MinerU-style array blocks and converts zero-based page indexes", async () => {
    await withSourceFixture("array-parsed", async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      const result = await importParsed(report.validEntries[0]!);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.blocks[0]).toMatchObject({ kind: "text", text: "Invoice No: SYN-001", evidence: { page: 1, bbox: [1, 2, 30, 40] } });
      }
    });
  });

  it.each([
    ["empty", "EMPTY_CONTENT"],
    ["missing-original", "SOURCE_PAIR_MISSING"],
    ["hash-mismatch", "HASH_MISMATCH"],
    ["missing-page", "PAGE_MISSING"],
    ["unsupported-format", "UNSUPPORTED_PARSE_FORMAT"],
  ] as const)("quarantines %s input with %s", async (kind, expectedCode) => {
    await withSourceFixture(kind, async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      expect(issueCodes(report)).toContain(expectedCode);
      expect(report.validEntries).toHaveLength(0);
    });
  });

  it("returns an explicit import error for an unstable parsed file", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      const entry = report.validEntries[0]!;
      const result = await importParsed({ ...entry, parsed: { ...entry.parsed, sha256: "0".repeat(64) } });
      expect(result).toMatchObject({ ok: false, error: { code: "HASH_MISMATCH" } });
    });
  });
});
