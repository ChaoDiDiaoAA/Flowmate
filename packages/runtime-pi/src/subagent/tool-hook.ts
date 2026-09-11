import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { normalizeNativeAgentInput, SubagentPolicyError } from "./policy.js";
import type { SubagentScope } from "./registry.js";

export const NATIVE_AGENT_TOOL_NAME = "Agent";

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Install the fail-closed policy before the plugin's native Agent executes. */
export function bindDelegationPolicy(pi: ExtensionAPI, scope: SubagentScope): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== NATIVE_AGENT_TOOL_NAME) return;
    try {
      const normalized = normalizeNativeAgentInput(event.input);
      Object.keys(event.input).forEach((key) => {
        if (!(key in normalized)) delete event.input[key];
      });
      Object.assign(event.input, normalized);
      // The child extension binds the actual child Session abort callback once
      // the native plugin creates that Session. Aborting the parent context here
      // would cancel the wrong session and is deliberately not used as a proxy.
      scope.reserve(event.toolCallId, normalized);
      return undefined;
    } catch (error) {
      const reason = reasonOf(error);
      return {
        block: true,
        terminate: true,
        reason,
      };
    }
  });
}

/** Observe native Pi events without introducing a second execution path. */
export function attachSubagentObserver(pi: ExtensionAPI, scope: SubagentScope): void {
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === NATIVE_AGENT_TOOL_NAME) scope.markRunning(event.toolCallId);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === NATIVE_AGENT_TOOL_NAME) scope.recordResult(event);
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === NATIVE_AGENT_TOOL_NAME && event.isError) {
      scope.recordResult({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: true,
        details: { status: "error", error: event.result },
      });
    }
  });
}

export function createSubagentPolicyExtension(scope: SubagentScope): InlineExtension {
  return {
    name: "flowmate-subagent-policy",
    hidden: true,
    factory: (pi) => {
      bindDelegationPolicy(pi, scope);
      attachSubagentObserver(pi, scope);
    },
  };
}

export function policyErrorReason(error: unknown): string {
  return error instanceof SubagentPolicyError ? `${error.code}: ${error.message.replace(`${error.code}: `, "")}` : reasonOf(error);
}
