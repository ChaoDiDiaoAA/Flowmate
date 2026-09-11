import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openStore } from "../../packages/core/src/index.ts";
import { startControlledRun, type ControlledRuntime } from "../../packages/core/src/runtime/controller.ts";

describe("controlled run cancellation", () => {
  it("waits for runtime abort and marks cleanup before reporting cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-cancel-"));
    const store = openStore(root);
    let release: (() => void) | undefined;
    let aborted = false;
    const runtime: ControlledRuntime = {
      async run() { await new Promise<void>((resolve) => { release = resolve; }); return { kind: aborted ? "aborted" : "completed", sessionId: "session" }; },
      async abort() { aborted = true; release?.(); },
      async close() {},
    };
    try {
      const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
      const run = store.startRun(job.id, job.candidateId);
      const handle = startControlledRun({ runtime, store, identity: { jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId }, context: { taskPrompt: "run" } });
      const cleanup = await handle.cancel("user");
      expect(cleanup).toMatchObject({ status: "complete" });
      expect(await handle.done).toMatchObject({ kind: "aborted" });
      expect(store.getJob(job.id).runs[0]).toMatchObject({ status: "cancelled", cleanupStatus: "complete" });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
