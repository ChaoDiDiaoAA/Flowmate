import {
  MemoryCapacitySchema,
  MemoryPolicySchema,
  MemoryStatusSchema,
  type MemoryCapacity,
  type MemoryPolicy,
  type MemoryScope,
  type MemoryStatus,
} from "@flowmate/contracts";

export type { MemoryCapacity, MemoryPolicy, MemoryScope, MemoryStatus } from "@flowmate/contracts";

export type MemorySessionLike = {
  readonly sessionId: string;
  readonly sessionManager: {
    getSessionId(): string;
    getEntries(): readonly unknown[];
  };
  readonly model: { contextWindow?: number } | undefined;
  getContextUsage: (() => { tokens: number | null; contextWindow: number; percent: number | null } | undefined) | undefined;
  setAutoCompactionEnabled: ((enabled: boolean) => void) | undefined;
  setAutoRetryEnabled: ((enabled: boolean) => void) | undefined;
};

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = MemoryPolicySchema.parse({
  schemaVersion: "1",
  policyId: "p0-runtime-memory",
  policyVersion: "1",
  autoCompactionEnabled: false,
  autoRetryEnabled: false,
  maxContextTokens: null,
  unknownCapacity: "allow",
  maxHistoryEntries: null,
});

export function normalizeMemoryPolicy(policy?: Partial<MemoryPolicy>): MemoryPolicy {
  return MemoryPolicySchema.parse({ ...DEFAULT_MEMORY_POLICY, ...policy });
}

export type MemoryPolicyState = {
  readonly policy: MemoryPolicy;
  readonly policyApplied: boolean;
};

export function applyMemoryPolicy(session: MemorySessionLike, policy: MemoryPolicy): MemoryPolicyState {
  const canApplyCompaction = typeof session.setAutoCompactionEnabled === "function";
  const canApplyRetry = typeof session.setAutoRetryEnabled === "function";
  session.setAutoCompactionEnabled?.(false);
  session.setAutoRetryEnabled?.(false);
  return { policy, policyApplied: canApplyCompaction && canApplyRetry };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function readCapacity(session: MemorySessionLike, policy: MemoryPolicy): MemoryCapacity {
  const usage = session.getContextUsage?.();
  const usageLimit = positiveInteger(usage?.contextWindow);
  const modelLimit = positiveInteger(session.model?.contextWindow);
  const configuredLimit = policy.maxContextTokens;
  const limitTokens = configuredLimit ?? usageLimit ?? modelLimit;
  const usedTokens = usage?.tokens !== undefined && usage.tokens !== null && Number.isFinite(usage.tokens)
    ? Math.max(0, Math.floor(usage.tokens))
    : null;
  if (limitTokens === null || usedTokens === null) {
    return MemoryCapacitySchema.parse({ state: "unknown", usedTokens, limitTokens, remainingTokens: null });
  }
  const remainingTokens = Math.max(0, limitTokens - usedTokens);
  return MemoryCapacitySchema.parse({
    state: usedTokens > limitTokens ? "exceeded" : "known",
    usedTokens,
    limitTokens,
    remainingTokens,
  });
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function assertCapacity(session: MemorySessionLike, policy: MemoryPolicy, text = ""): void {
  const capacity = readCapacity(session, policy);
  if (capacity.state === "exceeded") throw new Error("CONTEXT_TOO_LARGE");
  if (capacity.state === "unknown" && policy.unknownCapacity === "stop") throw new Error("CONTEXT_CAPACITY_UNKNOWN");
  if (capacity.limitTokens === null || capacity.usedTokens === null || text.length === 0) return;
  if (capacity.usedTokens + estimateTokens(text) > capacity.limitTokens) throw new Error("CONTEXT_TOO_LARGE");
}

export function buildMemoryStatus(
  session: MemorySessionLike,
  scope: MemoryScope,
  state: MemoryPolicyState,
  released: boolean,
  limitations: string[] = [],
): MemoryStatus {
  const entries = session.sessionManager.getEntries();
  return MemoryStatusSchema.parse({
    schemaVersion: "1",
    scope,
    sessionId: session.sessionId ?? session.sessionManager.getSessionId(),
    policyId: state.policy.policyId,
    policyVersion: state.policy.policyVersion,
    autoCompactionEnabled: false,
    autoRetryEnabled: false,
    policyApplied: state.policyApplied,
    capacity: readCapacity(session, state.policy),
    historyEntries: entries.length,
    released,
    limitations,
  });
}
