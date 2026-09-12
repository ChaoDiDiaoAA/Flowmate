import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createControlledProvider, createPiRuntime } from "../../../packages/runtime-pi/src/index.ts";

describe("P0 memory policy", () => {
  it("applies the explicit P0 policy to a real Pi session", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-memory-policy-"));
    const provider = createControlledProvider([{ text: "ready" }]);
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: { jobId: "job-memory", runId: "run-memory", generation: 1, candidateId: "candidate-memory" },
      provider,
    });
    try {
      const status = runtime.memory.getStatus();
      expect(status.policyId).toBe("p0-runtime-memory");
      expect(status.autoCompactionEnabled).toBe(false);
      expect(status.autoRetryEnabled).toBe(false);
      expect(status.policyApplied).toBe(true);
      expect(status.released).toBe(false);
      expect(status.scope.scopeId).toContain("run-memory");
    } finally {
      await runtime.close();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unknown capacity before the Pi session has measured context", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-memory-capacity-"));
    const provider = createControlledProvider([]);
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: { jobId: "job-memory-cap", runId: "run-memory-cap", generation: 1, candidateId: "candidate-memory-cap" },
      provider,
    });
    try {
      const status = runtime.memory.getStatus();
      expect(["known", "unknown"]).toContain(status.capacity.state);
      expect(status.capacity.limitTokens).toBeTypeOf("number");
      expect(() => runtime.memory.observeHistory()).not.toThrow();
    } finally {
      await runtime.close();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a released binding and rejects observations after close", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-memory-release-"));
    const provider = createControlledProvider([{ text: "ready" }]);
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: { jobId: "job-memory-release", runId: "run-memory-release", generation: 1, candidateId: "candidate-memory-release" },
      provider,
    });
    const memory = runtime.memory;
    await runtime.close();
    provider.close();
    try {
      expect(memory.getStatus().released).toBe(true);
      expect(() => memory.observeHistory()).toThrow("MEMORY_RELEASED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
