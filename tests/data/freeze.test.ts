import { join } from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createProjection, freezeDataset, loadFrozenDataset, readAsset } from "../../packages/data/src/index.ts";
import { withSourceFixture } from "../support/workspace.js";

describe("dataset freezing", () => {
  it("freezes the selected cases even when the source directory later grows", async () => {
    await withSourceFixture("mixed-label", async ({ root, roleMap, addSample }) => {
      const { inspectSource } = await import("../../packages/data/src/index.ts");
      const report = await inspectSource(root, roleMap);
      const frozen = await freezeDataset(report, { "SYN-001": "development" }, { outputRoot: join(root, "frozen") });
      await addSample("SYN-002");
      expect(frozen.cases.map((item) => item.sampleId)).toEqual(["SYN-001"]);
      const projection = await createProjection(frozen, "SYN-001");
      expect(JSON.stringify(projection)).not.toContain("isolatedLabelRef");
      expect(JSON.stringify(projection)).not.toContain("GOLD_SENTINEL_71");
    });
  });

  it("exposes only frozen asset ids and rejects labels or unknown ids", async () => {
    await withSourceFixture("mixed-label", async ({ root, roleMap }) => {
      const { inspectSource } = await import("../../packages/data/src/index.ts");
      const report = await inspectSource(root, roleMap);
      const frozen = await freezeDataset(report, { "SYN-001": "test" }, { outputRoot: join(root, "frozen") });
      const projection = await createProjection(frozen, "SYN-001");
      const original = frozen.cases[0]!.original;
      await expect(readAsset(projection.scope, original.assetId)).resolves.toBeInstanceOf(Uint8Array);
      await expect(readAsset(projection.scope, frozen.cases[0]!.isolatedLabelRef!.assetId)).rejects.toMatchObject({ code: "ASSET_NOT_ALLOWED" });
      await expect(readAsset(projection.scope, "../labels/GOLD_SENTINEL_71")).rejects.toMatchObject({ code: "ASSET_NOT_ALLOWED" });
    });
  });

  it("detects a changed frozen copy instead of returning stale bytes", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const { inspectSource } = await import("../../packages/data/src/index.ts");
      const report = await inspectSource(root, roleMap);
      const frozen = await freezeDataset(report, { "SYN-001": "development" }, { outputRoot: join(root, "frozen") });
      const projection = await createProjection(frozen, "SYN-001");
      const path = projection.scope.assets[frozen.cases[0]!.original.assetId]!.path;
      await appendFile(path, "tampered", "utf8");
      await expect(readAsset(projection.scope, frozen.cases[0]!.original.assetId)).rejects.toMatchObject({ code: "ASSET_HASH_MISMATCH" });
      await expect(readFile(path, "utf8")).resolves.toContain("tampered");
    });
  });

  it("reopens a frozen manifest and projection after the creating process is gone", async () => {
    await withSourceFixture("mixed-label", async ({ root, roleMap }) => {
      const { inspectSource } = await import("../../packages/data/src/index.ts");
      const report = await inspectSource(root, roleMap);
      const frozen = await freezeDataset(report, { "SYN-001": "test" }, { outputRoot: join(root, "frozen") });
      expect(frozen.cases[0]?.sampleId).toBe("SYN-001");
      const reopened = await loadFrozenDataset(join(root, "frozen"));
      const projection = await createProjection(reopened, "SYN-001");
      expect(projection.parsed.sampleId).toBe("SYN-001");
      expect(projection.scope.assets).not.toHaveProperty("labels:fixture-source:SYN-001");
      expect(JSON.stringify(projection)).not.toContain("GOLD_SENTINEL_71");
    });
  });
});
