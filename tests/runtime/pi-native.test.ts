import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createControlledProvider, createPiRuntime } from "../../packages/runtime-pi/src/index.ts";

describe("Pi native custom tool path", () => {
  it("executes a real SDK custom tool without enabling built-in file or shell tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-pi-native-"));
    const provider = createControlledProvider([{ toolCall: { name: "native_probe", arguments: {} } }, { text: "done" }]);
    let calls = 0;
    const probe = defineTool({
      name: "native_probe", label: "Native probe", description: "A harmless native runtime probe.", parameters: Type.Object({}),
      async execute() { calls += 1; return { content: [{ type: "text", text: "probe-ok" }], isError: false }; },
    });
    const runtime = await createPiRuntime({ cwd: join(root, "cwd"), agentDir: join(root, "agent"), identity: { jobId: "job", runId: "run", generation: 1, candidateId: "candidate" }, provider, customTools: [probe] });
    try {
      const outcome = await runtime.run({ taskPrompt: "Run the native probe." });
      expect(outcome.kind).toBe("completed");
      expect(calls).toBe(1);
      expect(runtime.toolNames()).toEqual(["native_probe"]);
    } finally {
      await runtime.close();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
