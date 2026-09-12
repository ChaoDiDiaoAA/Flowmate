import type { AssertionResult, EvidenceRef } from "./schema.js";

export type RuntimeTraceEvent = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  sessionId?: string;
  childSessionId?: string | null;
  cleanupStatus?: "complete" | "incomplete" | "pending";
  details?: Record<string, unknown>;
  evidence?: EvidenceRef[];
};

export type RuntimeTrace = {
  events: RuntimeTraceEvent[];
  processAlive?: boolean;
};

export type RuntimeOracle = {
  oracleId: string;
  requiredEvents?: string[];
  forbiddenEvents?: string[];
  requiredTools?: string[];
  requireDistinctChildSession?: boolean;
  requireCleanup?: boolean;
  critical?: boolean;
};

function result(assertionId: string, verdict: AssertionResult["verdict"], reasonCode: string, evidence: EvidenceRef[] = [], critical = true): AssertionResult {
  return { assertionId, verdict, reasonCode, evidence, critical };
}

export function gradeRuntime(trace: RuntimeTrace, oracle: RuntimeOracle): AssertionResult[] {
  const events = trace.events;
  const results: AssertionResult[] = [];
  for (const type of oracle.requiredEvents ?? []) {
    const matching = events.filter((event) => event.type === type);
    results.push(result(`${oracle.oracleId}:event:${type}`, matching.length > 0 ? "PASS" : "FAIL", matching.length > 0 ? "EVENT_PRESENT" : "EVENT_MISSING", matching.flatMap((event) => event.evidence ?? []), oracle.critical ?? true));
  }
  const requiredEventOrder = oracle.requiredEvents ?? [];
  const firstIndexes = requiredEventOrder.map((type) => events.findIndex((event) => event.type === type));
  const orderIsValid = firstIndexes.every((index, position) => index < 0 || position === 0 || firstIndexes[position - 1]! < 0 || index >= firstIndexes[position - 1]!);
  if (requiredEventOrder.length > 1) {
    results.push(result(`${oracle.oracleId}:event-order`, orderIsValid ? "PASS" : "FAIL", orderIsValid ? "EVENT_ORDER_VALID" : "EVENT_ORDER_INVALID", [], oracle.critical ?? true));
  }
  for (const type of oracle.forbiddenEvents ?? []) {
    const matching = events.filter((event) => event.type === type);
    results.push(result(`${oracle.oracleId}:forbidden:${type}`, matching.length === 0 ? "PASS" : "FAIL", matching.length === 0 ? "FORBIDDEN_ABSENT" : "FORBIDDEN_PRESENT", matching.flatMap((event) => event.evidence ?? []), oracle.critical ?? true));
  }
  for (const tool of oracle.requiredTools ?? []) {
    const matching = events.filter((event) => event.type === "tool.finished" && event.toolName === tool);
    results.push(result(`${oracle.oracleId}:tool:${tool}`, matching.length > 0 ? "PASS" : "FAIL", matching.length > 0 ? "TOOL_EXECUTED" : "TOOL_NOT_EXECUTED", matching.flatMap((event) => event.evidence ?? []), oracle.critical ?? true));
  }
  if (oracle.requireDistinctChildSession) {
    const parent = events.find((event) => event.sessionId)?.sessionId;
    const child = events.find((event) => event.childSessionId)?.childSessionId;
    const ok = Boolean(parent && child && parent !== child);
    results.push(result(`${oracle.oracleId}:child-session`, ok ? "PASS" : "FAIL", ok ? "CHILD_SESSION_BOUND" : "CHILD_SESSION_INVALID", [], oracle.critical ?? true));
  }
  if (oracle.requireCleanup) {
    const cleanup = events.filter((event) => event.type === "runtime.finished" || event.type === "delegation.finished").at(-1);
    const cleanupAssertion = cleanup?.cleanupStatus === "complete"
      ? trace.processAlive === false
        ? result(`${oracle.oracleId}:cleanup`, "PASS", "CLEANUP_COMPLETE", cleanup.evidence ?? [], oracle.critical ?? true)
        : trace.processAlive === undefined
          ? result(`${oracle.oracleId}:cleanup`, "UNJUDGEABLE", "CLEANUP_EVIDENCE_MISSING", cleanup.evidence ?? [], oracle.critical ?? true)
          : result(`${oracle.oracleId}:cleanup`, "FAIL", "CLEANUP_INCOMPLETE", cleanup.evidence ?? [], oracle.critical ?? true)
      : result(`${oracle.oracleId}:cleanup`, "FAIL", "CLEANUP_INCOMPLETE", cleanup?.evidence ?? [], oracle.critical ?? true);
    results.push(cleanupAssertion);
  }
  return results;
}

export function verdictFor(results: AssertionResult[]): AssertionResult["verdict"] {
  if (results.some((item) => item.verdict === "FAIL")) return "FAIL";
  if (results.some((item) => item.verdict === "UNJUDGEABLE")) return "UNJUDGEABLE";
  return "PASS";
}
