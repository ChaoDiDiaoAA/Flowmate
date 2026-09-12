import {
  MemoryScopeSchema,
  type MemoryObservation,
  type MemoryPolicy,
  type MemoryScope,
  type MemoryStatus,
} from "@flowmate/contracts";
import type { MemorySessionLike } from "./policy.js";
import {
  applyMemoryPolicy,
  assertCapacity,
  buildMemoryStatus,
  DEFAULT_MEMORY_POLICY,
  normalizeMemoryPolicy,
  type MemoryPolicyState,
} from "./policy.js";
import { observeSessionHistory } from "./history.js";

export type { MemorySessionLike } from "./policy.js";
export { DEFAULT_MEMORY_POLICY, normalizeMemoryPolicy, readCapacity, estimateTokens } from "./policy.js";
export type MemoryEvent = {
  type: "memory.attached" | "memory.capacity_checked" | "memory.released";
  scopeId: string;
  sessionId: string;
  at: string;
  details?: Record<string, unknown>;
};

export type MemoryBinding = {
  readonly scope: MemoryScope;
  getStatus(): MemoryStatus;
  observeHistory(): MemoryObservation[];
  assertWithinCapacity(text?: string): void;
  dispose(): void;
};

export type AttachMemoryOptions = {
  policy?: MemoryPolicy;
  onEvent?: (event: MemoryEvent) => void;
};

export function attachMemory(
  session: MemorySessionLike,
  scopeInput: MemoryScope,
  options: AttachMemoryOptions = {},
): MemoryBinding {
  const scope = MemoryScopeSchema.parse(scopeInput);
  const policyState: MemoryPolicyState = applyMemoryPolicy(session, normalizeMemoryPolicy(options.policy ?? DEFAULT_MEMORY_POLICY));
  let released = false;
  const sessionId = session.sessionId ?? session.sessionManager.getSessionId();
  const emit = (type: MemoryEvent["type"], details?: Record<string, unknown>) => {
    options.onEvent?.({ type, scopeId: scope.scopeId, sessionId, at: new Date().toISOString(), ...(details === undefined ? {} : { details }) });
  };
  emit("memory.attached", { policyId: policyState.policy.policyId, policyApplied: policyState.policyApplied });
  const assertActive = () => { if (released) throw new Error("MEMORY_RELEASED"); };
  return {
    scope,
    getStatus() {
      return buildMemoryStatus(session, scope, policyState, released, policyState.policyApplied ? [] : ["session does not expose policy mutators"]);
    },
    observeHistory() {
      assertActive();
      return observeSessionHistory(session, scope);
    },
    assertWithinCapacity(text = "") {
      assertActive();
      assertCapacity(session, policyState.policy, text);
      emit("memory.capacity_checked", { textLength: text.length });
    },
    dispose() {
      if (released) return;
      released = true;
      emit("memory.released");
    },
  };
}
