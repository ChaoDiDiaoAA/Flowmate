import { Type } from "typebox";
import { defineTool, type AgentToolResult, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { P0_PROBE_ALLOWED_TOOLS, type SubagentPolicyError } from "./policy.js";
import type { SubagentScope } from "./registry.js";

type ChildSessionLike = { sessionId?: string; getSessionId?: () => string; abort?: () => void };

function sessionIdOf(session: ChildSessionLike): string {
  const id = typeof session.getSessionId === "function" ? session.getSessionId() : session.sessionId;
  if (!id) throw new Error("SUBAGENT_CHILD_BINDING_INVALID: child Session ID is unavailable");
  return id;
}

function errorResult(error: unknown): { ok: false; error: { code: string; retryable: boolean; message: string } } {
  const value = error as Partial<SubagentPolicyError>;
  const code = typeof value.code === "string" ? value.code : "SUBAGENT_TOOL_FAILED";
  const message = error instanceof Error ? error.message.replace(`${code}: `, "") : String(error);
  return { ok: false, error: { code, retryable: false, message } };
}

function resultEnvelope(result: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
  };
}

export function bindChildTools(childSession: ChildSessionLike, scope: SubagentScope): { allowedToolNames: readonly string[]; tools: ToolDefinition[] } {
  scope.bindChildSession(sessionIdOf(childSession), childSession.abort);
  return { allowedToolNames: P0_PROBE_ALLOWED_TOOLS, tools: createChildToolDefinitions(scope) };
}

export function createChildToolDefinitions(scope: SubagentScope): ToolDefinition[] {
  const invoke = async (toolName: (typeof P0_PROBE_ALLOWED_TOOLS)[number], toolCallId: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> => {
    try {
      return resultEnvelope(await scope.invokeChildTool(toolName, args, toolCallId, signal));
    } catch (error) {
      return resultEnvelope(errorResult(error));
    }
  };
  return [
    defineTool({
      name: "read_parsed_document",
      label: "Read parsed invoice",
      description: "Read the parsed document bound to the parent Flowmate run.",
      promptSnippet: "Read the bound parsed invoice document",
      parameters: Type.Object({}),
      async execute(toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
        return invoke("read_parsed_document", toolCallId, params as Record<string, unknown>, signal);
      },
    }),
    defineTool({
      name: "read_evidence",
      label: "Read invoice evidence",
      description: "Read one evidence block bound to the parent Flowmate run.",
      promptSnippet: "Read one approved invoice evidence block",
      parameters: Type.Object({ assetId: Type.String(), blockId: Type.String() }),
      async execute(toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
        return invoke("read_evidence", toolCallId, params as Record<string, unknown>, signal);
      },
    }),
  ];
}
