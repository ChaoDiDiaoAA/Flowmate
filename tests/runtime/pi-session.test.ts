import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { makeParsedDocument } from "../../packages/contracts/src/invoice.ts";
import { createGateway } from "../../packages/core/src/tools/gateway.ts";
import { BudgetLedger, openStore } from "../../packages/core/src/index.ts";
import { createControlledProvider, createPiRuntime } from "../../packages/runtime-pi/src/index.ts";

describe("native Pi session integration", () => {
  it("does not silently replace a missing Live model with a controlled provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-model-gate-"));
    try {
      await expect(createPiRuntime({
        cwd: join(root, "cwd"),
        agentDir: join(root, "agent"),
        identity: { jobId: "job", runId: "run", generation: 1, candidateId: "candidate" },
      })).rejects.toThrow("MODEL_CONFIGURATION_REQUIRED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends a real tool result into the next provider request", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-session-"));
    const agentDir = join(root, "agent");
    const store = openStore(join(root, "store"));
    const provider = createControlledProvider([
      { toolCall: { name: "read_parsed_document", arguments: {} } },
      { text: "candidate prepared" },
    ]);
    const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
    const run = store.startRun(job.id, job.candidateId);
    const parsed = makeParsedDocument();
    const gateway = createGateway({ store, input: { sampleId: "SYN-001", parsed, allowedAssetIds: [parsed.original.assetId] } });
    const runtime = await createPiRuntime({ cwd: join(root, "cwd"), agentDir, identity: { jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId }, provider, gateway });
    const events: string[] = [];
    try {
      const outcome = await runtime.run({ taskPrompt: "Read the parsed invoice." }, (event) => events.push(event.type));
      expect(outcome.kind).toBe("completed");
      expect(provider.requests.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(provider.requests[1]!.context.messages)).toContain("SYN-001");
      expect(events).toContain("tool.started");
      expect(events).toContain("tool.finished");
    } finally {
      await runtime.close();
      provider.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops the native loop before a second model request exceeds the shared budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-budget-"));
    const store = openStore(join(root, "store"));
    const provider = createControlledProvider([
      { toolCall: { name: "read_parsed_document", arguments: {} } },
      { text: "second turn must not run" },
    ]);
    const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
    const run = store.startRun(job.id, job.candidateId);
    const budget = new BudgetLedger({ maxModelRequests: 1, maxToolCalls: 4, wallTimeMs: 20_000 });
    const parsed = makeParsedDocument();
    const gateway = createGateway({ store, input: { sampleId: "SYN-001", parsed, allowedAssetIds: [parsed.original.assetId] }, budget });
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: { jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId },
      provider,
      gateway,
      budget,
    });
    try {
      await expect(runtime.run({ taskPrompt: "Run within one model request." })).resolves.toMatchObject({ kind: "failed", error: expect.stringContaining("MODEL_REQUEST_BUDGET_EXCEEDED") });
      // The second scripted response is never requested after the turn budget
      // trips, so the child loop cannot bypass the parent request cap.
      expect(provider.requests).toHaveLength(1);
      expect(budget.remaining().modelRequests).toBe(0);
    } finally {
      await runtime.close();
      provider.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
