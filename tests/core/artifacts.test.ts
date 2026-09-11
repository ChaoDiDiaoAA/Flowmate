import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openStore } from "../../packages/core/src/index.ts";

describe("artifact store", () => {
  it("stores raw bytes with a stable sha256 reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-artifact-"));
    const store = openStore(root);
    try {
      const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
      const run = store.startRun(job.id, job.candidateId);
      const reference = await store.putArtifact(run.runId, "model.raw", Buffer.from("raw-output"));
      expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(store.getArtifact(reference.assetId).bytes.toString("utf8")).toBe("raw-output");
      store.close();
      const reopened = openStore(root);
      try {
        expect(reopened.getArtifact(reference.assetId).ref).toEqual(reference);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not create an artifact for an unknown run", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-artifact-"));
    const store = openStore(root);
    try {
      await expect(store.putArtifact("missing-run", "model.raw", Buffer.from("x"))).rejects.toThrow("RUN_NOT_FOUND");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
