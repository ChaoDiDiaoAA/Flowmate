import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createControlledProvider, createPiRuntime } from "../../../packages/runtime-pi/src/index.ts";

describe("P0 memory history", () => {
  it("observes the current facts from the real Pi session history", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-memory-history-"));
    const provider = createControlledProvider([{ text: "SYN-001 amount 42" }]);
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: { jobId: "job-history", runId: "run-history", generation: 1, candidateId: "candidate-history" },
      provider,
    });
    try {
      await expect(runtime.run({ taskPrompt: "Read sample SYN-001." })).resolves.toMatchObject({ kind: "completed" });
      const observations = runtime.memory.observeHistory();
      expect(observations.some((item) => item.role === "user" && item.text.includes("SYN-001"))).toBe(true);
      expect(observations.some((item) => item.role === "assistant" && item.text.includes("amount 42"))).toBe(true);
      expect(observations.every((item) => item.scopeId === runtime.memory.getStatus().scope.scopeId)).toBe(true);
      expect(observations.every((item) => item.sessionId === runtime.sessionId)).toBe(true);
    } finally {
      await runtime.close();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps parent and child session histories in separate scopes", async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), "flowmate-memory-parent-")),
      mkdtemp(join(tmpdir(), "flowmate-memory-child-")),
    ]);
    const providers = [createControlledProvider([{ text: "parent-only" }]), createControlledProvider([{ text: "child-only" }])];
    const identities = [
      { jobId: "job-scope", runId: "run-parent", generation: 1, candidateId: "candidate-scope" },
      { jobId: "job-scope", runId: "run-child", generation: 1, candidateId: "candidate-scope" },
    ] as const;
    const runtimes = await Promise.all(roots.map((root, index) => createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity: identities[index],
      provider: providers[index],
    })));
    try {
      await runtimes[0].run({ taskPrompt: "Parent fact" });
      await runtimes[1].run({ taskPrompt: "Child fact" });
      const parentText = runtimes[0].memory.observeHistory().map((item) => item.text).join("\n");
      const childText = runtimes[1].memory.observeHistory().map((item) => item.text).join("\n");
      expect(parentText).toContain("Parent fact");
      expect(parentText).not.toContain("Child fact");
      expect(childText).toContain("Child fact");
      expect(childText).not.toContain("Parent fact");
      expect(runtimes[0].memory.getStatus().scope.scopeId).not.toBe(runtimes[1].memory.getStatus().scope.scopeId);
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.close()));
      providers.forEach((provider) => provider.close());
      await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });
});
