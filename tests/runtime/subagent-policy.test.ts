import { describe, expect, it } from "vitest";
import {
  P0_NATIVE_AGENT_ALLOWED_KEYS,
  P0_PROBE_AGENT,
  P0_PROBE_ALLOWED_TOOLS,
  assertProbeTool,
  normalizeNativeAgentInput,
  validateProbeIdentity,
} from "../../packages/runtime-pi/src/subagent/policy.ts";

describe("P0 native Agent policy", () => {
  it("normalizes the native foreground call and rejects privileged options", () => {
    expect(normalizeNativeAgentInput({
      prompt: "read evidence",
      description: "Read evidence",
      subagent_type: P0_PROBE_AGENT,
    })).toEqual({
      prompt: "read evidence",
      description: "Read evidence",
      subagent_type: P0_PROBE_AGENT,
      run_in_background: false,
    });
    expect(() => normalizeNativeAgentInput({
      prompt: "read evidence",
      description: "Read evidence",
      subagent_type: P0_PROBE_AGENT,
      run_in_background: true,
    })).toThrow("SUBAGENT_BACKGROUND_FORBIDDEN");
    expect(() => normalizeNativeAgentInput({
      prompt: "read evidence",
      description: "Read evidence",
      subagent_type: P0_PROBE_AGENT,
      model: "provider/private-model",
    })).toThrow("SUBAGENT_POLICY_INVALID");
    expect(() => normalizeNativeAgentInput({
      prompt: "read evidence",
      description: "Read evidence",
      subagent_type: "general-purpose",
    })).toThrow("SUBAGENT_AGENT_TYPE_FORBIDDEN");
    expect(P0_NATIVE_AGENT_ALLOWED_KEYS).toEqual([
      "prompt",
      "description",
      "subagent_type",
      "run_in_background",
    ]);
  });

  it("keeps child tools read-only and validates the parent identity", () => {
    expect(() => assertProbeTool("submit_invoice_candidate")).toThrow("SUBAGENT_TOOL_FORBIDDEN");
    expect(() => validateProbeIdentity({ jobId: "", runId: "run", generation: 1, candidateId: "candidate" })).toThrow("SUBAGENT_POLICY_INVALID");
    expect(P0_PROBE_ALLOWED_TOOLS).toEqual(["read_parsed_document", "read_evidence"]);
  });
});
