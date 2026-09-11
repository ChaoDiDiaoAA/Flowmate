import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunIdentity, ToolResult } from "@flowmate/contracts";
import type { GatewayInvoker } from "../tools.js";
import {
  createSubagentScope,
  type ChildGatewayInvoker,
  type DelegationOutcome,
  type SubagentBudget,
  type SubagentScope,
} from "./registry.js";

const require = createRequire(import.meta.url);

export type SubagentRuntimeOptions = {
  childExtensionPath?: string;
  invoke?: ChildGatewayInvoker;
  maxToolCalls?: number;
};

export type PreparedSubagentResources = {
  agentDir: string;
  childExtensionPath: string;
  probeAgentPath: string;
  settingsPath: string;
};

export function resolveTintinSubagentsEntry(): string {
  return require.resolve("@tintinweb/pi-subagents/dist/index.js");
}

function toYamlPath(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

/** Write a private, deterministic P0 plugin configuration and probe role. */
export async function ensureSubagentResources(agentDir: string, childExtensionPath: string): Promise<PreparedSubagentResources> {
  const resolvedAgentDir = resolve(agentDir);
  const resolvedChildExtension = resolve(childExtensionPath);
  const agentsDir = join(resolvedAgentDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  const settingsPath = join(resolvedAgentDir, "subagents.json");
  await writeFile(settingsPath, JSON.stringify({
    maxConcurrent: 1,
    maxConcurrentForeground: 1,
    maxSubagentDepth: 1,
    fallbackSubagent: "none",
    backgroundByDefault: false,
    schedulingEnabled: false,
    workflowsEnabled: false,
    agentMentions: "off",
    rememberAgents: false,
    outputTranscript: false,
    widgetMode: "off",
    worktreeIsolation: false,
  }, null, 2) + "\n", "utf8");
  const probeAgentPath = join(agentsDir, "p0-probe.md");
  const extensionPath = toYamlPath(resolvedChildExtension);
  await writeFile(probeAgentPath, `---
name: p0-probe
description: Flowmate read-only child probe
extensions: ["${extensionPath}"]
tools: none
skills: false
inherit_context: false
run_in_background: false
isolated: false
isolation: off
persist_session: false
output_transcript: false
---

You are a read-only Flowmate evidence probe. Use only the provided read_parsed_document or read_evidence tools. Never write files, use a shell or network, submit a candidate, or delegate another agent. Report the evidence you were able to read.
`, "utf8");
  return { agentDir: resolvedAgentDir, childExtensionPath: resolvedChildExtension, probeAgentPath, settingsPath };
}

export type CreateSubagentScopeOptions = {
  parentIdentity: RunIdentity;
  parentSessionId: string;
  cwd: string;
  childExtensionPath: string;
  invoke?: ChildGatewayInvoker;
  gateway?: GatewayInvoker;
  budget?: SubagentBudget;
  maxToolCalls?: number;
};

function gatewayInvoker(gateway: GatewayInvoker): ChildGatewayInvoker {
  return async (toolName, args, requestId, identity, signal) => gateway.invoke(identity, {
    requestId,
    toolName,
    toolVersion: "1",
    args,
  }, signal);
}

function unavailableInvoker(): ChildGatewayInvoker {
  return async () => ({
    ok: false,
    error: {
      code: "SUBAGENT_GATEWAY_NOT_CONFIGURED",
      retryable: false,
      message: "A Flowmate Gateway is required for child read tools",
    },
  });
}

export function createRuntimeSubagentScope(options: CreateSubagentScopeOptions): SubagentScope {
  const invoke = options.invoke ?? (options.gateway ? gatewayInvoker(options.gateway) : unavailableInvoker());
  return createSubagentScope({
    parentIdentity: options.parentIdentity,
    parentSessionId: options.parentSessionId,
    childCwd: options.cwd,
    childExtensionPath: options.childExtensionPath,
    invoke,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
  });
}

export function subagentOutcomes(scope: SubagentScope): DelegationOutcome[] {
  return scope.outcomes();
}

export type SubagentGatewayResult = ToolResult<unknown>;
