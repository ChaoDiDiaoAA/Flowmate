import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RunIdentity, ToolResult } from "@flowmate/contracts";
import {
  assertProbeTool,
  P0_PROBE_AGENT,
  P0_PROBE_ALLOWED_TOOLS,
  type NativeAgentInput,
  SubagentPolicyError,
  validateProbeIdentity,
} from "./policy.js";

export type DelegationStatus = "reserved" | "running" | "succeeded" | "failed" | "cancelled";
export type CleanupStatus = "pending" | "complete" | "incomplete";
export type DelegationUsage = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
  contextTokens: number | null;
  turns: number | null;
  toolUses: number | null;
  raw?: unknown;
};

export type SubagentBudget = {
  reserveModelRequest(): void;
  reserveToolCall(): void;
};

export type DelegationOutcome = {
  delegationId: string;
  parentRunId: string;
  toolCallId: string;
  pluginAgentId: string | null;
  parentSessionId: string;
  childSessionId: string | null;
  role: typeof P0_PROBE_AGENT;
  revision: string;
  startedAt: string;
  endedAt: string | null;
  status: DelegationStatus;
  cleanupStatus: CleanupStatus;
  usage: DelegationUsage;
  resultRef: string | null;
  error?: string;
};

export type ChildGatewayInvoker = (
  toolName: (typeof P0_PROBE_ALLOWED_TOOLS)[number],
  args: Record<string, unknown>,
  requestId: string,
  identity: RunIdentity,
  signal: AbortSignal,
) => Promise<ToolResult<unknown>>;

export type SubagentScopeOptions = {
  parentIdentity: RunIdentity;
  parentSessionId: string;
  childCwd: string;
  childExtensionPath: string;
  invoke: ChildGatewayInvoker;
  budget?: SubagentBudget;
  maxToolCalls?: number;
};

type AgentResultLike = {
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  content?: unknown;
  isError?: boolean;
  details?: unknown;
  usage?: unknown;
};

type GlobalScopeRegistry = { pending?: SubagentScope; byRunId?: Map<string, SubagentScope> };
const GLOBAL_SCOPE_KEY = Symbol.for("flowmate.subagent.scope");

function globalRegistry(): GlobalScopeRegistry {
  const root = globalThis as typeof globalThis & { [GLOBAL_SCOPE_KEY]?: GlobalScopeRegistry };
  if (!root[GLOBAL_SCOPE_KEY]) root[GLOBAL_SCOPE_KEY] = {};
  const registry = root[GLOBAL_SCOPE_KEY]!;
  registry.byRunId ??= new Map<string, SubagentScope>();
  return registry;
}

function now(): string {
  return new Date().toISOString();
}

function emptyUsage(raw?: unknown): DelegationUsage {
  return {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    cost: null,
    contextTokens: null,
    turns: null,
    toolUses: null,
    ...(raw === undefined ? {} : { raw }),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUsage(details: unknown, eventUsage: unknown): DelegationUsage {
  const source = details && typeof details === "object" ? details as Record<string, unknown> : {};
  const usage = eventUsage && typeof eventUsage === "object" ? eventUsage as Record<string, unknown> : {};
  const nested = usage.usage && typeof usage.usage === "object" ? usage.usage as Record<string, unknown> : usage;
  return {
    input: numberOrNull(nested.input),
    output: numberOrNull(nested.output),
    cacheRead: numberOrNull(nested.cacheRead),
    cacheWrite: numberOrNull(nested.cacheWrite),
    cost: numberOrNull(source.cost ?? nested.cost),
    contextTokens: numberOrNull(source.contextTokens ?? nested.contextTokens),
    turns: numberOrNull(source.turnCount ?? nested.turns),
    toolUses: numberOrNull(source.toolUses),
    raw: details ?? eventUsage,
  };
}

function terminalStatus(event: AgentResultLike): Exclude<DelegationStatus, "reserved" | "running"> {
  const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
  const status = typeof details.status === "string" ? details.status : undefined;
  if (event.isError || status === "error" || status === "stopped") return "failed";
  if (status === "aborted" || status === "cancelled" || status === "canceled") return "cancelled";
  return "succeeded";
}

/**
 * One parent Run's native Agent policy state. The object is deliberately
 * process-local: tintinweb creates child sessions in this process, so a
 * Symbol.for registry lets the trusted child extension claim the exact
 * reservation without an HTTP token or a second worker protocol.
 */
export class SubagentScope {
  readonly parentIdentity: RunIdentity;
  readonly parentSessionId: string;
  readonly childCwd: string;
  readonly childExtensionPath: string;
  readonly maxToolCalls: number;
  private readonly invoke: ChildGatewayInvoker;
  private readonly budget: SubagentBudget | undefined;
  private readonly history: DelegationOutcome[] = [];
  private current: DelegationOutcome | undefined;
  private childClaimed = false;
  private childShutdown = false;
  private revoked = false;
  private disposed = false;
  private abortChild: (() => void) | undefined;
  private toolCalls = 0;

  constructor(options: SubagentScopeOptions) {
    validateProbeIdentity(options.parentIdentity);
    if (!options.parentSessionId.trim()) throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "parent Session ID is required");
    this.parentIdentity = options.parentIdentity;
    this.parentSessionId = options.parentSessionId;
    this.childCwd = resolve(options.childCwd);
    this.childExtensionPath = resolve(options.childExtensionPath);
    this.invoke = options.invoke;
    this.budget = options.budget;
    this.maxToolCalls = options.maxToolCalls ?? 8;
    if (!Number.isInteger(this.maxToolCalls) || this.maxToolCalls < 1) {
      throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "maxToolCalls must be a positive integer");
    }
  }

  reserve(toolCallId: string, input: NativeAgentInput, abortChild?: () => void): DelegationOutcome {
    if (this.disposed) throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "subagent scope is disposed");
    if (this.revoked) throw new SubagentPolicyError("SUBAGENT_CANCELLED", "subagent scope is cancelled");
    if (!toolCallId.trim()) throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "Agent toolCallId is required");
    if (this.current && (this.current.status === "reserved" || this.current.status === "running")) {
      throw new SubagentPolicyError("SUBAGENT_CONCURRENCY_EXCEEDED", "P0 allows one active child execution");
    }
    const global = globalRegistry();
    if (global.pending && global.pending !== this) {
      throw new SubagentPolicyError("SUBAGENT_CONCURRENCY_EXCEEDED", "another Flowmate child is already reserved");
    }
    this.childClaimed = false;
    this.childShutdown = false;
    this.toolCalls = 0;
    this.abortChild = abortChild;
    const outcome: DelegationOutcome = {
      delegationId: randomUUID(),
      parentRunId: this.parentIdentity.runId,
      toolCallId,
      pluginAgentId: null,
      parentSessionId: this.parentSessionId,
      childSessionId: null,
      role: input.subagent_type,
      revision: "1",
      startedAt: now(),
      endedAt: null,
      status: "reserved",
      cleanupStatus: "pending",
      usage: emptyUsage(),
      resultRef: null,
    };
    this.current = outcome;
    this.history.push(outcome);
    global.pending = this;
    global.byRunId!.set(this.parentIdentity.runId, this);
    return outcome;
  }

  markRunning(toolCallId: string): void {
    if (this.current?.toolCallId !== toolCallId) return;
    if (this.current.status === "reserved") this.current.status = "running";
  }

  claimChild(cwd: string, extensionPath: string): SubagentScope {
    const current = this.current;
    if (!current || (current.status !== "reserved" && current.status !== "running")) {
      throw new SubagentPolicyError("SUBAGENT_CHILD_BINDING_INVALID", "no active Agent reservation");
    }
    if (resolve(cwd) !== this.childCwd || resolve(extensionPath) !== this.childExtensionPath) {
      throw new SubagentPolicyError("SUBAGENT_CHILD_BINDING_INVALID", "child resource binding does not match the reservation");
    }
    if (this.childClaimed) throw new SubagentPolicyError("SUBAGENT_CHILD_BINDING_INVALID", "child scope was already claimed");
    this.childClaimed = true;
    this.markRunning(current.toolCallId);
    return this;
  }

  bindChildSession(sessionId: string, abortChild?: () => void): void {
    if (!sessionId.trim() || sessionId === this.parentSessionId) {
      throw new SubagentPolicyError("SUBAGENT_CHILD_BINDING_INVALID", "child Session ID must be distinct from the parent");
    }
    if (!this.current || !this.childClaimed) {
      throw new SubagentPolicyError("SUBAGENT_CHILD_BINDING_INVALID", "child scope must be claimed before binding a Session");
    }
    if (this.current.childSessionId && this.current.childSessionId !== sessionId) {
      throw new SubagentPolicyError("SUBAGENT_CHILD_BINDING_INVALID", "multiple child Sessions were bound");
    }
    this.current.childSessionId = sessionId;
    this.abortChild = abortChild;
  }

  async invokeChildTool(toolName: string, args: Record<string, unknown>, requestId: string, signal?: AbortSignal): Promise<ToolResult<unknown>> {
    assertProbeTool(toolName);
    const current = this.current;
    if (!current || (current.status !== "reserved" && current.status !== "running") || !this.childClaimed) {
      throw new SubagentPolicyError("SUBAGENT_CHILD_BINDING_INVALID", "child tool scope is not active");
    }
    if (this.revoked || signal?.aborted) throw new SubagentPolicyError("SUBAGENT_CANCELLED", "child tool call was cancelled");
    this.toolCalls += 1;
    if (this.toolCalls > this.maxToolCalls) {
      throw new SubagentPolicyError("SUBAGENT_CONCURRENCY_EXCEEDED", "child tool budget exhausted");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.invoke(toolName, args, requestId, this.parentIdentity, controller.signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  reserveChildModelRequest(): void {
    this.budget?.reserveModelRequest();
  }

  recordResult(event: AgentResultLike): void {
    const current = this.current;
    if (!current || current.toolCallId !== event.toolCallId) return;
    const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
    if (typeof details.agentId === "string") current.pluginAgentId = details.agentId;
    current.status = terminalStatus(event);
    current.endedAt = now();
    current.usage = normalizeUsage(event.details, event.usage);
    if (current.status === "cancelled" || this.revoked) current.status = "cancelled";
    if (current.cleanupStatus === "pending" && (this.childShutdown || current.childSessionId !== null)) current.cleanupStatus = "complete";
    if (event.isError && typeof details.error === "string") current.error = details.error;
    this.releaseGlobalReservation();
  }

  markChildShutdown(): void {
    this.childShutdown = true;
    if (this.current && this.current.status !== "reserved" && this.current.status !== "running") {
      this.current.cleanupStatus = "complete";
    }
    if (this.current?.status === "reserved" || this.current?.status === "running") {
      this.current.cleanupStatus = "incomplete";
    }
    this.releaseGlobalReservation();
  }

  revoke(reason = "parent cancelled"): void {
    this.revoked = true;
    this.abortChild?.();
    if (this.current && (this.current.status === "reserved" || this.current.status === "running")) {
      this.current.status = "cancelled";
      this.current.error = reason;
      this.current.endedAt = now();
      this.current.cleanupStatus = "pending";
    }
    this.releaseGlobalReservation();
  }

  currentOutcome(): DelegationOutcome | undefined {
    return this.current;
  }

  outcomes(): DelegationOutcome[] {
    return this.history.map((item) => ({ ...item, usage: { ...item.usage } }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current && (this.current.status === "reserved" || this.current.status === "running")) {
      this.current.status = "cancelled";
      this.current.endedAt = now();
      this.current.cleanupStatus = "incomplete";
    }
    this.releaseGlobalReservation();
  }

  private releaseGlobalReservation(): void {
    const global = globalRegistry();
    if (global.pending === this && this.current && this.current.status !== "reserved" && this.current.status !== "running") {
      delete global.pending;
    }
    if (global.byRunId?.get(this.parentIdentity.runId) === this && this.current && this.current.status !== "reserved" && this.current.status !== "running") {
      global.byRunId.delete(this.parentIdentity.runId);
    }
  }
}

export function createSubagentScope(options: SubagentScopeOptions): SubagentScope {
  return new SubagentScope(options);
}

export function claimPendingChildScope(match: { cwd: string; extensionPath: string }): SubagentScope | undefined {
  const scope = globalRegistry().pending;
  if (!scope) return undefined;
  return scope.claimChild(match.cwd, match.extensionPath);
}

export function cancelOwnedChildren(parentRunId: string, signal?: AbortSignal, reason = "parent cancelled"): boolean {
  const scope = globalRegistry().byRunId?.get(parentRunId);
  if (!scope) return false;
  scope.revoke(reason);
  if (signal && !signal.aborted) {
    signal.addEventListener("abort", () => scope.revoke(reason), { once: true });
  }
  return true;
}
