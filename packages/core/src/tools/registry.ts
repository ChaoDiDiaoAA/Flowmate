export const TOOL_VERSIONS = {
  read_parsed_document: "1",
  read_evidence: "1",
  submit_invoice_candidate: "1",
} as const;

export type ToolName = keyof typeof TOOL_VERSIONS;
export function isToolName(value: string): value is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_VERSIONS, value);
}
