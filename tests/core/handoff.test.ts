import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { exportHandoff, verifyHandoff } from "../../packages/core/src/evidence/handoff.ts";
import { freezeCandidate } from "../../packages/core/src/configuration/candidate.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function candidate() {
  return freezeCandidate({
    schemaVersion: "1",
    appSourceHash: hash("app"),
    lockHash: hash("lock"),
    runtimeLockHash: hash("runtime"),
    datasetVersion: "p0-fixture",
    modelRef: { provider: "flowmate-controlled", modelId: "controlled" },
    modelConfigHash: hash("model"),
    promptHash: hash("prompt"),
    toolVersions: { read_parsed_document: "1" },
    extensionVersions: {},
    environment: "local-test",
    budget: { maxModelRequests: 2, maxToolCalls: 3, wallTimeMs: 5_000 },
    eligibility: "test",
  });
}

describe("functional handoff", () => {
  it("exports a quality-neutral manifest and verifies its integrity", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-handoff-"));
    const outputPath = join(root, "reports", "handoff.json");
    try {
      const fixed = candidate();
      const report = await exportHandoff(fixed.candidateId, {
        candidate: fixed,
        datasetVersion: fixed.datasetVersion,
        inputHashes: { "SYN-001": hash("input") },
        configHashes: { candidate: fixed.candidateId ? hash(fixed.candidateId) : hash("candidate") },
        entrypoints: ["Application.start", "Application.getEvidence"],
        missing: ["live-main-profile"],
        outputPath,
      });
      expect(report.candidateId).toBe(fixed.candidateId);
      expect(report.featureReports).toEqual([]);
      expect(verifyHandoff(report)).toMatchObject({ ok: true, manifestHash: report.manifestHash, errors: [] });
      expect(JSON.parse(await readFile(outputPath, "utf8")).manifestHash).toBe(report.manifestHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects tampered or cross-candidate functional reports", async () => {
    const fixed = candidate();
    const report = await exportHandoff(fixed.candidateId, { candidate: fixed, datasetVersion: fixed.datasetVersion });
    const tampered = { ...report, missing: ["changed"] };
    expect(verifyHandoff(tampered).ok).toBe(false);
    const cross = {
      ...report,
      featureReports: [{
        reportId: "r1", testFile: "tests/runtime/pi-native.test.ts", caseId: "case-1",
        candidateId: "other-candidate", datasetVersion: fixed.datasetVersion, mode: "offline-native-F" as const,
        startedAt: report.createdAt, endedAt: report.createdAt, exitCode: 0,
        assertions: [{ id: "session", ok: true, message: "session completed" }], artifacts: [], limitations: [],
      }],
    };
    const crossChecked = verifyHandoff(cross);
    expect(crossChecked.ok).toBe(false);
    expect(crossChecked.errors).toContain("feature report candidateId differs from handoff candidateId");
  });
});
