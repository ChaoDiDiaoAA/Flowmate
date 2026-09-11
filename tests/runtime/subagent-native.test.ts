import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createControlledProvider, createPiRuntime } from "../../packages/runtime-pi/src/index.ts";

const childExtension = fileURLToPath(new URL("../../packages/runtime-pi/src/subagent/child-extension.ts", import.meta.url));

const identity = { jobId: "job-native", runId: "run-native", generation: 1, candidateId: "candidate-native" };

describe("native pi-subagents Agent tool", () => {
  it("runs the real parent Loop through the native Agent tool and a child Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-subagent-native-"));
    const calls: Array<{ toolName: string; args: Record<string, unknown>; identity: typeof identity }> = [];
    const provider = createControlledProvider([
      {
        toolCall: {
          name: "Agent",
          arguments: {
            prompt: "Read approved evidence for asset original:fixture:SYN-001 block b1.",
            description: "Read evidence",
            subagent_type: "p0-probe",
            run_in_background: false,
          },
        },
      },
      { toolCall: { name: "read_evidence", arguments: { assetId: "original:fixture:SYN-001", blockId: "b1" } } },
      { text: "child evidence complete" },
      { text: "parent observed child evidence" },
    ]);
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity,
      provider,
      subagent: {
        childExtensionPath: childExtension,
        invoke: async (toolName, args, requestId, childIdentity) => {
          calls.push({ toolName, args, identity: childIdentity });
          return { ok: true, value: { assetId: args.assetId, text: "synthetic evidence" }, evidence: [] };
        },
      },
    });
    try {
      expect(runtime.toolNames()).toContain("Agent");
      expect(runtime.toolNames()).not.toContain("get_subagent_result");
      expect(runtime.toolNames()).not.toContain("steer_subagent");
      const outcome = await runtime.run({ taskPrompt: "Use the native Agent to verify the evidence." });
      expect(outcome.kind).toBe("completed");
      expect(calls).toEqual([{
        toolName: "read_evidence",
        args: { assetId: "original:fixture:SYN-001", blockId: "b1" },
        identity,
      }]);
      const delegations = runtime.subagentOutcomes();
      expect(delegations).toHaveLength(1);
      expect(delegations[0]).toMatchObject({
        parentRunId: identity.runId,
        toolCallId: expect.any(String),
        pluginAgentId: expect.any(String),
        parentSessionId: runtime.sessionId,
        childSessionId: expect.any(String),
        role: "p0-probe",
        status: "succeeded",
        cleanupStatus: "complete",
      });
      expect(delegations[0]!.childSessionId).not.toBe(runtime.sessionId);
      expect(provider.requests.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(provider.requests.at(-1)!.context.messages)).toContain("child evidence complete");
    } finally {
      await runtime.close();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not create a child when the parent never calls Agent or policy blocks it", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-subagent-negative-"));
    const provider = createControlledProvider([{ text: "no delegation" }]);
    const runtime = await createPiRuntime({
      cwd: join(root, "cwd"),
      agentDir: join(root, "agent"),
      identity,
      provider,
      subagent: { childExtensionPath: childExtension, invoke: async () => ({ ok: true, value: null, evidence: [] }) },
    });
    try {
      await expect(runtime.run({ taskPrompt: "Answer directly." })).resolves.toMatchObject({ kind: "completed" });
      expect(runtime.subagentOutcomes()).toEqual([]);
    } finally {
      await runtime.close();
      provider.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
