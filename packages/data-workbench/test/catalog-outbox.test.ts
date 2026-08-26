import { describe, expect, it } from "vitest";
import { CatalogOutbox, type CatalogOutboxEntry } from "../src/catalog-outbox.js";
import type { PolicyDecision } from "../src/types.js";

const catalogDecision: PolicyDecision = {
  itemId: "KNOW-000001",
  licenseStatus: "allowed",
  privacyStatus: "passed",
  qualityStatus: "passed",
  action: "catalog",
  reasonCodes: [],
  policyVersion: "p0-policy-1.0",
  decidedAt: "2026-08-26T12:00:00+08:00",
};

const knowledgeEntry: Omit<CatalogOutboxEntry, "status" | "attempts"> = {
  entryId: "KNOW-000001",
  entryType: "knowledge",
  payloadRef: "C:/FlowmateData/catalog-payloads/KNOW-000001.json",
};

describe("CatalogOutbox", () => {
  it("queues an approved catalog entry exactly once when its entry ID is retried", () => {
    const outbox = new CatalogOutbox();

    expect(outbox.enqueue(knowledgeEntry, catalogDecision)).toBe(true);
    expect(outbox.enqueue(knowledgeEntry, catalogDecision)).toBe(false);
    expect(outbox.entries()).toEqual([{ ...knowledgeEntry, status: "pending", attempts: 0 }]);
  });

  it("marks pending entries as written after the catalog writer succeeds", async () => {
    const outbox = new CatalogOutbox();
    outbox.enqueue(knowledgeEntry, catalogDecision);

    await outbox.flush({
      flush: async (entries) => entries.map((entry) => ({
        entryId: entry.entryId,
        entryType: entry.entryType,
        noteRef: `30_PublicKnowledge/${entry.entryId}.md`,
        sourceId: "SRC-000001",
        artifactId: "ART-000001",
        pipelineStatus: "cataloged",
      })),
    });

    expect(outbox.entries()).toEqual([{ ...knowledgeEntry, status: "written", attempts: 1 }]);
  });

  it("retains a pending entry when Markdown writing fails", async () => {
    const outbox = new CatalogOutbox();
    outbox.enqueue(knowledgeEntry, catalogDecision);

    await expect(outbox.flush({
      flush: async () => {
        const error = new Error("access denied");
        Object.assign(error, { code: "EACCES" });
        throw error;
      },
    })).rejects.toThrow("access denied");

    expect(outbox.entries()).toEqual([{
      ...knowledgeEntry,
      status: "pending",
      attempts: 1,
      lastErrorCode: "EACCES",
    }]);
  });

  it("does not queue delete-content decisions for public catalogs", () => {
    const outbox = new CatalogOutbox();
    const deletionDecision: PolicyDecision = {
      ...catalogDecision,
      action: "delete_content_keep_metadata",
      privacyStatus: "delete_content",
    };

    expect(outbox.enqueue(knowledgeEntry, deletionDecision)).toBe(false);
    expect(outbox.enqueue({ ...knowledgeEntry, entryId: "SAMPLE-000001", entryType: "public_sample" }, deletionDecision)).toBe(false);
    expect(outbox.entries()).toEqual([]);
  });
});
