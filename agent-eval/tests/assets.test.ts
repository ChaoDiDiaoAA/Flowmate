import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { freezeAssets, importAuthoring, assertAssetManifest } from "../src/assets.js";
import { validateCatalog, type EvalCatalog } from "../src/schema.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ref = (id: string) => ({ id, sha256: hash(id), source: `synthetic/${id}` });

function authoring(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    batchId: "p0-seed",
    author: "eval-author",
    reviewer: "eval-reviewer",
    cases: [{
      caseId: "P0-A-04-SYN-N",
      version: "1",
      primaryModule: "memory",
      relatedModules: ["loop"],
      runtimeRefs: ["P0-RT-MEM-02"],
      benchmarkRefs: ["BM-01"],
      scope: "integration",
      level: "A",
      sourceKind: "synthetic",
      sourceGroup: "synthetic-001",
      purpose: "development",
      inputRef: ref("input-001"),
      fixtureVersion: "fixture-1",
      goldRef: ref("gold-001"),
      rubricVersion: "rubric-1",
      required: true,
      assertions: ["currency-missing"],
      driverId: "product-a",
      gold: [{
        fieldPath: "fields.currency",
        sourceValue: null,
        sourceNormalized: null,
        sourceStatus: "missing",
        normalized: null,
        valueStatus: "missing",
        inputAvailability: "available",
        evidence: [],
        comparison: "status",
        reviewStatus: "verified",
      }],
    }],
    ...overrides,
  };
}

describe("evaluation asset contracts", () => {
  it("validates a catalog and reports required unexecuted variants", () => {
    const catalog = {
      schemaVersion: "1",
      catalogVersion: "p0-1",
      items: [{
        caseId: "P0-RT-SUB-01-I",
        version: "1",
        primaryModule: "subagent",
        relatedModules: [],
        runtimeRefs: ["RTC-17-01"],
        benchmarkRefs: ["BM-12"],
        scope: "integration",
        level: "F",
        sourceKind: "synthetic",
        sourceGroup: "subagent-synthetic",
        purpose: "development",
        inputRef: ref("sub-input"),
        fixtureVersion: "fixture-1",
        goldRef: ref("sub-gold"),
        rubricVersion: "rubric-1",
        required: true,
        assertions: ["child-session"],
        driverId: "product-f",
        owner: "runtime-owner",
        productTasks: ["T12"],
        testFile: "tests/runtime/subagent-native.test.ts",
        variants: [{ variantId: "electron", required: true, scope: "integration", level: "F", implemented: true, executed: false, triggered: false, owner: "runtime-owner" }],
      }],
    } satisfies EvalCatalog;
    const check = validateCatalog(catalog);
    expect(check.ok).toBe(false);
    expect(check.missingVariants).toContain("P0-RT-SUB-01-I-electron");
  });

  it("freezes only reviewed Gold and rejects source-group leakage", () => {
    expect(() => freezeAssets(authoring({ cases: [{ ...authoring().cases[0], purpose: "holdout" }, { ...authoring().cases[0], caseId: "P0-A-05-SYN-N", purpose: "development" }] }))).toThrow("SOURCE_GROUP_LEAKAGE");
    const manifest = freezeAssets(authoring());
    expect(manifest.cases).toHaveLength(1);
    expect(assertAssetManifest(manifest).manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("imports one explicit authoring JSON file", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-eval-assets-"));
    try {
      await writeFile(join(root, "batch.json"), JSON.stringify(authoring()), "utf8");
      await expect(importAuthoring(root)).resolves.toMatchObject({ batchId: "p0-seed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
