import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createControlledProvider, createPiRuntime } from "../../packages/runtime-pi/src/index.ts";

describe("Pi resource boundary", () => {
  it("uses an isolated agent directory and does not discover parent resource files", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-resource-"));
    await writeFile(join(root, "AGENTS.md"), "GLOBAL_SENTINEL_RESOURCE", "utf8");
    const provider = createControlledProvider([{ text: "done" }]);
    const runtime = await createPiRuntime({ cwd: join(root, "cwd"), agentDir: join(root, "agent"), identity: { jobId: "job", runId: "run", generation: 1, candidateId: "candidate" }, provider });
    try {
      expect(runtime.toolNames()).toEqual([]);
      expect(runtime.systemPrompt()).not.toContain("GLOBAL_SENTINEL_RESOURCE");
      expect(await runtime.run({ taskPrompt: "Finish." })).toMatchObject({ kind: "completed" });
    } finally {
      await runtime.close();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
