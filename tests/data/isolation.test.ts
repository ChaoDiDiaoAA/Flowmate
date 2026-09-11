import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjection, freezeDataset, readAsset } from "../../packages/data/src/index.ts";
import { withSourceFixture } from "../support/workspace.js";

describe("input projection isolation", () => {
  it("cannot read another sample through a projection scope", async () => {
    await withSourceFixture("normal", async ({ root, roleMap, addSample }) => {
      await addSample("SYN-002");
      const { inspectSource } = await import("../../packages/data/src/index.ts");
      const report = await inspectSource(root, roleMap);
      const frozen = await freezeDataset(report, { "SYN-001": "development", "SYN-002": "development" }, { outputRoot: join(root, "frozen") });
      const projection = await createProjection(frozen, "SYN-001");
      const other = frozen.cases.find((item) => item.sampleId === "SYN-002")!;
      await expect(readAsset(projection.scope, other.original.assetId)).rejects.toMatchObject({ code: "ASSET_NOT_ALLOWED" });
    });
  });
});
