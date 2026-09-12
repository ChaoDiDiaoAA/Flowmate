import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { makeInvoiceCandidate } from "../../packages/contracts/src/invoice.ts";
import { inspectSource, freezeDataset } from "../../packages/data/src/index.ts";
import { withSourceFixture } from "../support/workspace.js";
import { freezeCandidate, type CandidateConfig } from "../../packages/core/src/configuration/candidate.ts";
import { createControlledProvider, createPiRuntime } from "../../packages/runtime-pi/src/index.ts";
import { createApplication, createPiRuntimeFactory } from "../../apps/desktop/src/main/composition.ts";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const config: CandidateConfig = {
  schemaVersion: "1", appSourceHash: hash("app"), lockHash: hash("lock"), runtimeLockHash: hash("runtime"), datasetVersion: "pending", modelRef: { provider: "flowmate-controlled", modelId: "controlled" }, modelConfigHash: hash("model"), promptHash: hash("prompt"), toolVersions: { read_parsed_document: "1", read_evidence: "1", submit_invoice_candidate: "1" }, extensionVersions: {}, environment: "local-test", budget: { maxModelRequests: 6, maxToolCalls: 12, wallTimeMs: 20_000 }, eligibility: "test",
};

function candidateForSample() {
  const candidate = makeInvoiceCandidate();
  for (const [key] of Object.entries(candidate.fields)) {
    candidate.fields[key as keyof typeof candidate.fields] = { raw: null, normalized: null, status: "missing", evidence: [] };
  }
  return candidate;
}

describe("P0 extraction application", () => {
  it("does not treat a normal Pi stop without a candidate as a successful extraction", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      const manifest = await freezeDataset(report, { "SYN-001": "development" }, { outputRoot: join(root, "frozen-no-candidate") });
      const candidate = freezeCandidate({ ...config, datasetVersion: manifest.datasetVersion });
      const provider = createControlledProvider([{ text: "I did not submit a candidate" }]);
      const app = createApplication({ dataRoot: join(root, "app-data-no-candidate"), agentRoot: join(root, "app-agent-no-candidate"), manifest, candidate, profile: { profileId: "fixture", environment: "local-test", modelConfigHash: hash("model"), modelRef: { provider: "flowmate-controlled", modelId: "controlled" }, available: true }, runtimeFactory: ({ identity, gateway, cwd, agentDir, budget }) => createPiRuntime({ identity, gateway, cwd, agentDir, budget, provider }) });
      try {
        const started = await app.start({ sampleId: "SYN-001", candidateId: candidate.candidateId, clientRequestId: "no-candidate" });
        await expect(app.wait(started.runId)).resolves.toMatchObject({ kind: "failed", error: "NO_CANDIDATE" });
        expect(app.getJob({ jobId: started.jobId }).job.status).toBe("failed");
      } finally {
        await app.close();
        provider.close();
      }
    });
  });

  it("runs the complete product entry point with real Pi and keeps the result after reopen", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      const manifest = await freezeDataset(report, { "SYN-001": "development" }, { outputRoot: join(root, "frozen") });
      const candidate = freezeCandidate({ ...config, datasetVersion: manifest.datasetVersion });
      const provider = createControlledProvider([
        { toolCall: { name: "read_parsed_document", arguments: {} } },
        { toolCall: { name: "submit_invoice_candidate", arguments: { candidate: candidateForSample() } } },
        { text: "candidate accepted" },
      ]);
      const app = createApplication({ dataRoot: join(root, "app-data"), agentRoot: join(root, "app-agent"), manifest, candidate, profile: { profileId: "fixture", environment: "local-test", modelConfigHash: hash("model"), modelRef: { provider: "flowmate-controlled", modelId: "controlled" }, available: true }, runtimeFactory: createPiRuntimeFactory({ provider }) });
      const started = await app.start({ sampleId: "SYN-001", candidateId: candidate.candidateId, clientRequestId: "click-1" });
      const duplicate = await app.start({ sampleId: "SYN-001", candidateId: candidate.candidateId, clientRequestId: "click-1" });
      expect(duplicate.runId).toBe(started.runId);
      await app.wait(started.runId);
      const completed = app.getJob({ jobId: started.jobId });
      expect(completed.job.status).toBe("candidate_ready");
      expect(completed.candidates).toHaveLength(1);
      expect(completed.runs[0]?.sessionId).toBeTruthy();
      expect(provider.requests[0]?.context.systemPrompt).toContain("Flowmate's invoice extraction agent");
      await expect(app.getEvidence({ jobId: started.jobId, assetId: "original:fixture-source:SYN-001" })).resolves.toMatchObject({ assetId: "original:fixture-source:SYN-001" });
      await app.close();
      provider.close();
      const reopened = createApplication({ dataRoot: join(root, "app-data"), agentRoot: join(root, "app-agent-2"), manifest, candidate, profile: { profileId: "fixture", environment: "local-test", modelConfigHash: hash("model"), modelRef: { provider: "flowmate-controlled", modelId: "controlled" }, available: true }, runtimeFactory: ({ identity, gateway, cwd, agentDir }) => createPiRuntime({ identity, gateway, cwd, agentDir, provider: createControlledProvider([{ text: "unused" }]) }) });
      expect(reopened.getJob({ jobId: started.jobId }).candidates).toHaveLength(1);
      await reopened.close();
    });
  });

  it("rejects a second different client while a run is active", async () => {
    await withSourceFixture("normal", async ({ root, roleMap }) => {
      const report = await inspectSource(root, roleMap);
      const manifest = await freezeDataset(report, { "SYN-001": "development" }, { outputRoot: join(root, "frozen") });
      const candidate = freezeCandidate({ ...config, datasetVersion: manifest.datasetVersion });
      const provider = createControlledProvider([{ text: "done", delayMs: 250 }, { text: "done" }]);
      const app = createApplication({ dataRoot: join(root, "app-data"), agentRoot: join(root, "app-agent"), manifest, candidate, profile: { profileId: "fixture", environment: "local-test", modelConfigHash: hash("model"), modelRef: { provider: "flowmate-controlled", modelId: "controlled" }, available: true }, runtimeFactory: ({ identity, gateway, cwd, agentDir }) => createPiRuntime({ identity, gateway, cwd, agentDir, provider }) });
      try {
        await app.start({ sampleId: "SYN-001", candidateId: candidate.candidateId, clientRequestId: "click-1" });
        await expect(app.start({ sampleId: "SYN-001", candidateId: candidate.candidateId, clientRequestId: "click-2" })).rejects.toThrow("RUN_BUSY");
      } finally {
        await app.close();
        provider.close();
      }
    });
  });
});
