import type { RunIdentity } from "@flowmate/contracts";

export const P0_PROBE_AGENT = "p0-probe" as const;
export const P0_PROBE_ALLOWED_TOOLS = Object.freeze([
  "read_parsed_document",
  "read_evidence",
] as const);

/**
 * P0 intentionally accepts only the fields that the native Agent tool needs
 * for a foreground, one-shot probe. The plugin owns the actual Agent tool;
 * this list is the Flowmate policy boundary applied by Pi's tool_call hook.
 */
export const P0_NATIVE_AGENT_ALLOWED_KEYS = Object.freeze([
  "prompt",
  "description",
  "subagent_type",
  "run_in_background",
] as const);

export type NativeAgentInput = {
  prompt: string;
  description: string;
  subagent_type: typeof P0_PROBE_AGENT;
  run_in_background: false;
};

export type ProbeCall = {
  agent: typeof P0_PROBE_AGENT;
  prompt: string;
  initialContext: "empty";
  session?: never;
  model?: never;
  cwd?: never;
  tools: typeof P0_PROBE_ALLOWED_TOOLS;
};

export type ProbePolicy = {
  role: "subagent";
  maxDepth: 1;
  maxConcurrency: 1;
  allowSubmit: false;
  allowLabels: false;
  allowSession: false;
  allowModelOverride: false;
  allowCwdOverride: false;
  tools: typeof P0_PROBE_ALLOWED_TOOLS;
};

export const P0_PROBE_POLICY: ProbePolicy = Object.freeze({
  role: "subagent",
  maxDepth: 1,
  maxConcurrency: 1,
  allowSubmit: false,
  allowLabels: false,
  allowSession: false,
  allowModelOverride: false,
  allowCwdOverride: false,
  tools: P0_PROBE_ALLOWED_TOOLS,
});

export type SubagentPolicyErrorCode =
  | "SUBAGENT_POLICY_INVALID"
  | "SUBAGENT_TOOL_FORBIDDEN"
  | "SUBAGENT_DEPTH_EXCEEDED"
  | "SUBAGENT_CONCURRENCY_EXCEEDED"
  | "SUBAGENT_BACKGROUND_FORBIDDEN"
  | "SUBAGENT_AGENT_TYPE_FORBIDDEN"
  | "SUBAGENT_CANCELLED"
  | "SUBAGENT_CHILD_BINDING_INVALID";

export class SubagentPolicyError extends Error {
  constructor(readonly code: SubagentPolicyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SubagentPolicyError";
  }
}

export function validateProbeIdentity(identity: RunIdentity): void {
  if (!identity || !identity.jobId || !identity.runId || identity.generation < 1 || !identity.candidateId) {
    throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "parent RunIdentity is incomplete");
  }
}

export function makeProbeCall(prompt: string): ProbeCall {
  if (!prompt.trim()) throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "probe prompt cannot be empty");
  return {
    agent: P0_PROBE_AGENT,
    prompt,
    initialContext: "empty",
    tools: P0_PROBE_ALLOWED_TOOLS,
  };
}

export function assertProbeTool(toolName: string): asserts toolName is (typeof P0_PROBE_ALLOWED_TOOLS)[number] {
  if (!(P0_PROBE_ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
    throw new SubagentPolicyError("SUBAGENT_TOOL_FORBIDDEN", `tool ${toolName} is not allowed for p0-probe`);
  }
}

/** Validate and normalize the plugin's native Agent tool arguments. */
export function normalizeNativeAgentInput(input: unknown): NativeAgentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "Agent input must be an object");
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !(P0_NATIVE_AGENT_ALLOWED_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", `Agent input contains forbidden key(s): ${unknown.join(", ")}`);
  }
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!prompt || !description) {
    throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "prompt and description are required");
  }
  if (record.subagent_type !== P0_PROBE_AGENT) {
    throw new SubagentPolicyError("SUBAGENT_AGENT_TYPE_FORBIDDEN", `only ${P0_PROBE_AGENT} is enabled in P0`);
  }
  if (record.run_in_background === true) {
    throw new SubagentPolicyError("SUBAGENT_BACKGROUND_FORBIDDEN", "P0 requires foreground Agent execution");
  }
  if (record.run_in_background !== undefined && record.run_in_background !== false) {
    throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "run_in_background must be false when provided");
  }
  return {
    prompt,
    description,
    subagent_type: P0_PROBE_AGENT,
    run_in_background: false,
  };
}
