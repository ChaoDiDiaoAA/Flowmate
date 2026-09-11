import { describe, expect, it } from "vitest";
import {
  bindChildTools,
  createChildToolDefinitions,
} from "../../packages/runtime-pi/src/subagent/child-tools.ts";
import {
  cancelOwnedChildren,
  claimPendingChildScope,
  createSubagentScope,
} from "../../packages/runtime-pi/src/subagent/registry.ts";

const identity = { jobId: "job-child", runId: "run-child", generation: 1, candidateId: "candidate-child" };

describe("Flowmate child scope", () => {
  it("binds read-only tools to the parent identity in the same process", async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown>; requestId: string }> = [];
    const scope = createSubagentScope({
      parentIdentity: identity,
      parentSessionId: "parent-session",
      childCwd: "C:\\flowmate\\child",
      childExtensionPath: "C:\\flowmate\\child-extension.ts",
      invoke: async (toolName, args, requestId) => {
        calls.push({ toolName, args, requestId });
        return { ok: true, value: { sampleId: "SYN-001" }, evidence: [] };
      },
    });
    const reservation = scope.reserve("parent-tool-call", {
      prompt: "read",
      description: "Read evidence",
      subagent_type: "p0-probe",
      run_in_background: false,
    });
    expect(reservation.toolCallId).toBe("parent-tool-call");
    expect(claimPendingChildScope({
      cwd: "C:\\flowmate\\child",
      extensionPath: "C:\\flowmate\\child-extension.ts",
    })).toBe(scope);

    const bindings = bindChildTools({ sessionId: "child-session" }, scope);
    expect(bindings.allowedToolNames).toEqual(["read_parsed_document", "read_evidence"]);
    const tools = createChildToolDefinitions(scope);
    expect(tools.map((tool) => tool.name)).toEqual(["read_parsed_document", "read_evidence"]);
    expect(tools.some((tool) => tool.name === "submit_invoice_candidate")).toBe(false);

    const readEvidence = tools.find((tool) => tool.name === "read_evidence");
    expect(readEvidence).toBeDefined();
    const result = await readEvidence!.execute(
      "child-tool-call",
      { assetId: "original:fixture:SYN-001", blockId: "b1" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({ ok: true });
    expect(calls).toEqual([{
      toolName: "read_evidence",
      args: { assetId: "original:fixture:SYN-001", blockId: "b1" },
      requestId: "child-tool-call",
    }]);
    expect(scope.currentOutcome()?.childSessionId).toBe("child-session");
    scope.recordResult({
      toolCallId: "parent-tool-call",
      toolName: "Agent",
      isError: false,
      details: { agentId: "plugin-agent", status: "completed", toolUses: 1 },
    });
    scope.markChildShutdown();
    expect(scope.currentOutcome()?.cleanupStatus).toBe("complete");
    scope.dispose();
    expect(claimPendingChildScope({
      cwd: "C:\\flowmate\\child",
      extensionPath: "C:\\flowmate\\child-extension.ts",
    })).toBeUndefined();
  });

  it("cancels only the owned child through the registered child Session callback", () => {
    const scope = createSubagentScope({
      parentIdentity: { ...identity, runId: "run-child-cancel" },
      parentSessionId: "parent-session-cancel",
      childCwd: "C:\\flowmate\\child-cancel",
      childExtensionPath: "C:\\flowmate\\child-extension.ts",
      invoke: async () => ({ ok: true, value: null, evidence: [] }),
    });
    let childAbortCount = 0;
    scope.reserve("parent-tool-call-cancel", {
      prompt: "read",
      description: "Read evidence",
      subagent_type: "p0-probe",
      run_in_background: false,
    });
    expect(claimPendingChildScope({
      cwd: "C:\\flowmate\\child-cancel",
      extensionPath: "C:\\flowmate\\child-extension.ts",
    })).toBe(scope);
    bindChildTools({ sessionId: "child-session-cancel", abort: () => { childAbortCount += 1; } }, scope);

    expect(cancelOwnedChildren("run-child-cancel", new AbortController().signal)).toBe(true);
    expect(childAbortCount).toBe(1);
    expect(scope.currentOutcome()).toMatchObject({ status: "cancelled", cleanupStatus: "pending" });
    scope.markChildShutdown();
    expect(scope.currentOutcome()?.cleanupStatus).toBe("complete");
    scope.dispose();
  });
});
