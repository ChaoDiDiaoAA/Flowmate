import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunIdentity, ToolResult } from "@flowmate/contracts";

export type GatewayInvoker = { invoke(identity: RunIdentity, request: { requestId: string; toolName: string; toolVersion: string; args: unknown }, signal: AbortSignal): Promise<ToolResult<unknown>> };

export function createGatewayTools(gateway: GatewayInvoker, identity: RunIdentity): ToolDefinition[] {
  const execute = (name: string, version: string, toolCallId: string, params: unknown, signal: AbortSignal | undefined) => gateway.invoke(identity, { requestId: toolCallId, toolName: name, toolVersion: version, args: params }, signal ?? new AbortController().signal);
  return [
    defineTool({
      name: "read_parsed_document",
      label: "Read parsed invoice",
      description: "Read the parsed document bound to this run.",
      promptSnippet: "Read the bound parsed invoice document",
      parameters: Type.Object({}),
      async execute(toolCallId, params, signal) {
        const result = await execute("read_parsed_document", "1", toolCallId, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }),
    defineTool({
      name: "read_evidence",
      label: "Read invoice evidence",
      description: "Read one evidence block from the bound parsed invoice.",
      parameters: Type.Object({ assetId: Type.String(), blockId: Type.String() }),
      async execute(toolCallId, params, signal) {
        const result = await execute("read_evidence", "1", toolCallId, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }),
    defineTool({
      name: "submit_invoice_candidate",
      label: "Submit invoice candidate",
      description: "Submit one structured invoice candidate with evidence.",
      parameters: Type.Object({ candidate: Type.Any() }),
      async execute(toolCallId, params, signal) {
        const result = await execute("submit_invoice_candidate", "1", toolCallId, params, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }),
  ];
}
