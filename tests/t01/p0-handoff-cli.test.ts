import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { makeInvoiceCandidate } from "../../packages/contracts/src/invoice.ts";
import { freezeCandidate } from "../../packages/core/src/configuration/candidate.ts";
import { parseP0Args, runP0Command } from "../../scripts/p0.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("P0 handoff CLI", () => {
  it("exports a quality-neutral manifest from a candidate and evidence input", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-p0-handoff-cli-"));
    const candidate = freezeCandidate({
      schemaVersion: "1",
      appSourceHash: digest("app"),
      lockHash: digest("lock"),
      runtimeLockHash: digest("runtime"),
      datasetVersion: "p0-cli",
      modelRef: { provider: "flowmate-controlled", modelId: "controlled" },
      modelConfigHash: digest("model"),
      promptHash: digest("prompt"),
      toolVersions: { read_parsed_document: "1" },
      extensionVersions: {},
      environment: "local-test",
      budget: { maxModelRequests: 2, maxToolCalls: 3, wallTimeMs: 5_000 },
      eligibility: "test",
    });
    const candidatePath = join(root, "candidate.json");
    const evidencePath = join(root, "evidence.json");
    const outputPath = join(root, "reports", "handoff.json");
    await writeFile(candidatePath, JSON.stringify(candidate), "utf8");
    await writeFile(evidencePath, JSON.stringify({
      inputHashes: { "SYN-001": digest("input") },
      configHashes: { candidate: digest(candidate.candidateId) },
      entrypoints: ["Application.start", "Application.getEvidence"],
      missing: ["live-main-profile"],
    }), "utf8");
    try {
      const command = parseP0Args(["handoff", "--export", "--candidate", candidatePath, "--evidence", evidencePath, "--output", outputPath]);
      expect(command.exportHandoff).toBe(true);
      const result = await runP0Command(command, { cwd: root });
      expect(result).toMatchObject({ code: "READY", exitCode: 0 });
      const manifest = JSON.parse(await readFile(outputPath, "utf8")) as { candidateId: string; datasetVersion: string; manifestHash: string };
      expect(manifest.candidateId).toBe(candidate.candidateId);
      expect(manifest.datasetVersion).toBe(candidate.datasetVersion);
      expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps verification as the default handoff operation", async () => {
    const command = parseP0Args(["handoff"]);
    expect(command.exportHandoff).toBe(false);
    await expect(runP0Command(command, { cwd: process.cwd() })).resolves.toMatchObject({ exitCode: 2 });
  });
});
