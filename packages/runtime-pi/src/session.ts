import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { RunIdentity, RuntimeEvent } from "@flowmate/contracts";
import { createControlledProvider, type ControlledProvider } from "./provider.js";
import { createGatewayTools, type GatewayInvoker } from "./tools.js";
import {
  createRuntimeSubagentScope,
  ensureSubagentResources,
  resolveTintinSubagentsEntry,
  subagentOutcomes,
  type SubagentRuntimeOptions,
} from "./subagent/adapter.js";
import { createSubagentPolicyExtension } from "./subagent/tool-hook.js";
import { SubagentPolicyError } from "./subagent/policy.js";
import { createP0ResourceLoader } from "./resources.js";
import { toRuntimeEvent } from "./events.js";

export type RuntimeOutcome =
  | { kind: "completed"; sessionId: string; lastAssistantText?: string }
  | { kind: "aborted"; sessionId: string }
  | { kind: "failed"; sessionId: string; error: string };

/** Structural seam so runtime-pi can enforce a shared core BudgetLedger without importing core. */
export type RuntimeBudget = {
  reserveModelRequest(): void;
  reserveToolCall(): void;
  recordUsage?(sample: { inputTokens: number | null; outputTokens: number | null }): void;
};

export type AgentRuntime = {
  readonly sessionId: string;
  toolNames(): string[];
  systemPrompt(): string;
  subagentOutcomes(): ReturnType<typeof subagentOutcomes>;
  run(context: PiContext, onEvent?: (event: RuntimeEvent) => void): Promise<RuntimeOutcome>;
  abort(): Promise<void>;
  close(): Promise<void>;
};

export type PiRuntimeOptions = {
  cwd: string;
  agentDir: string;
  identity: RunIdentity;
  model?: Model<any>;
  /** Resolve a model from the supplied ModelRuntime without registering a test provider. */
  modelRef?: { provider: string; modelId: string };
  modelRuntime?: ModelRuntime;
  /** Explicit credential store for a Live Profile; never supplied by Renderer input. */
  authPath?: string;
  /** Explicit Pi models.json path for custom or OpenAI-compatible providers. */
  modelsPath?: string | null;
  provider?: ControlledProvider;
  customTools?: ToolDefinition[];
  gateway?: GatewayInvoker;
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  resourceLoader?: ResourceLoader;
  systemPrompt?: string;
  budget?: RuntimeBudget;
  subagent?: SubagentRuntimeOptions;
};

export type PiContext = { taskPrompt: string };

function lastAssistantText(session: AgentSession): string | undefined {
  const messages = session.messages;
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  if (!last || last.role !== "assistant") return undefined;
  return last.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function lastAssistantMessage(session: AgentSession): Extract<AgentSession["messages"][number], { role: "assistant" }> | undefined {
  const message = [...session.messages].reverse().find((item) => item.role === "assistant");
  return message?.role === "assistant" ? message : undefined;
}

let activeSubagentRuntime = false;

function defaultChildExtensionPath(): string {
  const source = fileURLToPath(new URL("./subagent/child-extension.ts", import.meta.url));
  if (existsSync(source)) return source;
  return fileURLToPath(new URL("./subagent/child-extension.js", import.meta.url));
}

export async function createPiRuntime(options: PiRuntimeOptions): Promise<AgentRuntime> {
  await mkdir(options.cwd, { recursive: true });
  await mkdir(options.agentDir, { recursive: true });
  let subagentScope: ReturnType<typeof createRuntimeSubagentScope> | undefined;
  let restoreAgentDir: string | undefined;
  let claimedSubagentRuntime = false;
  if (options.subagent) {
    if (activeSubagentRuntime) throw new SubagentPolicyError("SUBAGENT_CONCURRENCY_EXCEEDED", "P0 allows one active parent subagent runtime");
    activeSubagentRuntime = true;
    claimedSubagentRuntime = true;
    restoreAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = options.agentDir;
  }
  const provider = options.provider;
  try {
    const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      authPath: options.authPath ?? join(options.agentDir, "auth.json"),
      modelsPath: options.modelsPath ?? null,
      refreshOnCreate: false,
    });
    if (provider) modelRuntime.registerNativeProvider(provider.provider);
    const model = options.model
      ?? (provider ? provider.model : options.modelRef ? modelRuntime.getModel(options.modelRef.provider, options.modelRef.modelId) : undefined);
    if (!model) throw new Error("MODEL_CONFIGURATION_REQUIRED: provide a Model, modelRef, or controlled Provider");
    const settingsManager = options.settingsManager ?? SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, compaction: { enabled: false }, retry: { enabled: false }, defaultTools: [] }, { projectTrusted: true });
    const sessionManager = options.sessionManager ?? SessionManager.inMemory(options.cwd, { id: `flowmate-${randomUUID()}` });
    let resourceLoader: ResourceLoader;
    if (options.subagent) {
      if (options.resourceLoader) throw new SubagentPolicyError("SUBAGENT_POLICY_INVALID", "subagent runtime requires Flowmate-controlled ResourceLoader");
      const childExtensionPath = options.subagent.childExtensionPath ?? defaultChildExtensionPath();
      await ensureSubagentResources(options.agentDir, childExtensionPath);
      subagentScope = createRuntimeSubagentScope({
        parentIdentity: options.identity,
        parentSessionId: sessionManager.getSessionId(),
        cwd: options.cwd,
        childExtensionPath,
        ...(options.subagent.invoke === undefined ? {} : { invoke: options.subagent.invoke }),
        ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.subagent.maxToolCalls === undefined ? {} : { maxToolCalls: options.subagent.maxToolCalls }),
      });
      resourceLoader = createP0ResourceLoader({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        extensionPaths: [resolveTintinSubagentsEntry()],
        extensionFactories: [createSubagentPolicyExtension(subagentScope)],
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      });
    } else {
      resourceLoader = options.resourceLoader ?? createP0ResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager, ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}) });
    }
    await resourceLoader.reload();
    const customTools = [...(options.customTools ?? []), ...(options.gateway ? createGatewayTools(options.gateway, options.identity) : [])];
    // `builtin` suppresses Pi's read/bash/edit/write tools while preserving the
    // explicitly registered Flowmate tools. `all` would also suppress custom
    // tools and silently turn the model loop into a no-op.
    const created = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, modelRuntime, model, settingsManager, sessionManager, resourceLoader, noTools: "builtin", customTools });
    const session = created.session;
    // The SDK separates session construction from extension binding. Binding is
    // what activates ExtensionAPI hooks (including session_start) and makes the
    // native extension lifecycle observable in headless/RPC-style runs.
    await session.bindExtensions({ mode: "rpc" });
    if (subagentScope) {
      session.setActiveToolsByName([...new Set([...customTools.map((tool) => tool.name), "Agent"])]);
    }
    session.setAutoCompactionEnabled(false);
    session.setAutoRetryEnabled(false);
    let seq = 0;
    let aborted = false;
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const emit = (event: AgentSessionEvent, onEvent?: (event: RuntimeEvent) => void) => {
      if (!onEvent) return;
      const runtimeEvent = toRuntimeEvent(options.identity, session.sessionId, seq++, event);
      onEvent(runtimeEvent);
    };
    return {
      get sessionId() { return session.sessionId; },
      toolNames() { return session.getActiveToolNames(); },
      systemPrompt() { return session.systemPrompt; },
      subagentOutcomes() { return subagentScope ? subagentOutcomes(subagentScope) : []; },
      async run(context, onEvent) {
        seq = 0;
        aborted = false;
        let budgetError: Error | undefined;
        unsubscribe?.();
        unsubscribe = session.subscribe((event) => {
          if (options.budget && !budgetError) {
            try {
              if (event.type === "turn_start") options.budget.reserveModelRequest();
              // Business tools are charged by the Gateway. The native Agent
              // tool has no Gateway request, so charge it at its execution edge.
              if (event.type === "tool_execution_start" && event.toolName === "Agent") options.budget.reserveToolCall();
              // Pi's finalized assistant message is the authoritative usage
              // record. Streaming updates are deliberately ignored so a
              // provider's cumulative usage is not counted twice.
              if (event.type === "message_end" && event.message.role === "assistant") {
                const usage = event.message.usage;
                options.budget.recordUsage?.({
                  inputTokens: Number.isFinite(usage.input) ? usage.input : null,
                  outputTokens: Number.isFinite(usage.output) ? usage.output : null,
                });
              }
            } catch (error) {
              budgetError = error instanceof Error ? error : new Error("runtime budget exceeded");
              void session.abort();
            }
          }
          emit(event, onEvent);
        });
        try {
          await session.prompt(context.taskPrompt);
          if (aborted) return { kind: "aborted", sessionId: session.sessionId };
          if (budgetError) return { kind: "failed", sessionId: session.sessionId, error: budgetError.message };
          const assistant = lastAssistantMessage(session);
          if (assistant?.stopReason === "error") {
            return { kind: "failed", sessionId: session.sessionId, error: assistant.errorMessage ?? "Pi model request failed" };
          }
          if (assistant?.stopReason === "aborted") return { kind: "aborted", sessionId: session.sessionId };
          const text = lastAssistantText(session);
          return text === undefined ? { kind: "completed", sessionId: session.sessionId } : { kind: "completed", sessionId: session.sessionId, lastAssistantText: text };
        } catch (error) {
          if (budgetError) return { kind: "failed", sessionId: session.sessionId, error: budgetError.message };
          if (aborted) return { kind: "aborted", sessionId: session.sessionId };
          return { kind: "failed", sessionId: session.sessionId, error: error instanceof Error ? error.message : "Pi session failed" };
        }
      },
      async abort() { aborted = true; subagentScope?.revoke("parent runtime aborted"); await session.abort(); },
      async close() {
        if (closed) return;
        closed = true;
        subagentScope?.revoke("parent runtime closed");
        // AgentSession.dispose() invalidates the runner but does not itself emit
        // the shutdown lifecycle event (the SDK emits it for reload only). Do
        // so through the native ExtensionRunner before disposal.
        try {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          try { session.dispose(); } finally {
            unsubscribe?.();
            unsubscribe = undefined;
            subagentScope?.dispose();
            if (claimedSubagentRuntime) {
              if (restoreAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
              else process.env.PI_CODING_AGENT_DIR = restoreAgentDir;
              activeSubagentRuntime = false;
            }
          }
        }
      },
    };
  } catch (error) {
    subagentScope?.dispose();
    if (claimedSubagentRuntime) {
      if (restoreAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = restoreAgentDir;
      activeSubagentRuntime = false;
    }
    throw error;
  }
}

export { createControlledProvider } from "./provider.js";
