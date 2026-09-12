import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { freezeAssets } from "../src/assets.js";
import { runEvalCli } from "../src/cli.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ref = (id: string) => ({ id, sha256: digest(id), source: `synthetic/${id}` });

function authoring() {
  return {
    schemaVersion: "1" as const,
    batchId: "cli-batch",
    author: "author",
    reviewer: "reviewer",
    cases: [{
      caseId: "CLI-CASE-1",
      version: "1",
      primaryModule: "tools",
      relatedModules: [],
      runtimeRefs: ["RTC-04-01"],
      benchmarkRefs: ["BM-11"],
      scope: "integration" as const,
      level: "F" as const,
      sourceKind: "synthetic",
      sourceGroup: "cli",
      purpose: "development" as const,
      inputRef: ref("input"),
      fixtureVersion: "fixture-1",
      goldRef: ref("gold"),
      rubricVersion: "rubric-1",
      required: true,
      assertions: ["tool-call"],
      driverId: "product-f" as const,
      gold: [{
        fieldPath: "fields.invoiceNumber",
        sourceValue: "CLI-CASE-1",
        sourceNormalized: "CLI-CASE-1",
        sourceStatus: "present" as const,
        normalized: "CLI-CASE-1",
        valueStatus: "present" as const,
        inputAvailability: "available" as const,
        evidence: [ref("gold")],
        comparison: "text" as const,
        reviewStatus: "verified" as const,
      }],
    }],
  };
}

describe("evaluation CLI preparation commands", () => {
  it("freezes an authoring batch to the requested output", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-eval-cli-"));
    try {
      const authoringDir = join(root, "authoring");
      const output = join(root, "assets", "manifest.json");
      await writeFile(join(root, "authoring.json"), JSON.stringify(authoring()), "utf8");
      // importAuthoring deliberately requires a directory with one JSON file.
      await mkdir(authoringDir, { recursive: true });
      await writeFile(join(authoringDir, "batch.json"), JSON.stringify(authoring()), "utf8");
      const result = await runEvalCli(["freeze", "--input", authoringDir, "--output", output], root);
      expect(result).toMatchObject({ exitCode: 0, code: "READY" });
      await expect(readFile(output, "utf8")).resolves.toContain("CLI-CASE-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports pending catalog assets before a run can be ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-eval-readiness-"));
    try {
      const manifest = freezeAssets(authoring());
      const manifestPath = join(root, "manifest.json");
      const candidatePath = join(root, "candidate.json");
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
      const candidate = {
        candidateId: "candidate-1",
        schemaVersion: "1",
        appSourceHash: digest("app"),
        lockHash: digest("lock"),
        runtimeLockHash: digest("runtime"),
        datasetVersion: "dataset-1",
        modelRef: { provider: "fixture", modelId: "fixture-model" },
        modelConfigHash: digest("model"),
        promptHash: digest("prompt"),
        toolVersions: { read_evidence: "1" },
        extensionVersions: {},
        environment: "local-test",
        budget: { maxModelRequests: 1, maxToolCalls: 1, wallTimeMs: 1_000 },
        eligibility: "test",
      };
      await writeFile(candidatePath, JSON.stringify(candidate), "utf8");
      // The default catalog intentionally contains reserved, not-yet-authored assets.
      const result = await runEvalCli(["check-readiness", "--catalog", join(process.cwd(), "agent-eval", "config", "p0.catalog.json"), "--manifest", manifestPath, "--candidate", candidatePath], root);
      expect(result).toMatchObject({ exitCode: 1, code: "ASSETS_PENDING" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a bounded plan from a frozen manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-eval-plan-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const output = join(root, "plan.json");
      await writeFile(manifestPath, JSON.stringify(freezeAssets(authoring())), "utf8");
      const result = await runEvalCli(["plan", "--manifest", manifestPath, "--candidate", "candidate-1", "--eval-run", "eval-cli", "--attempts", "2", "--output", output], root);
      expect(result).toMatchObject({ exitCode: 0, code: "READY", details: { evalRunId: "eval-cli", cases: 1, attempts: 2 } });
      await expect(readFile(output, "utf8")).resolves.toContain("eval-cli");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
