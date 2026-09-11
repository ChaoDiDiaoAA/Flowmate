import type { ParsedDocument } from "@flowmate/contracts";
import { ParsedDocumentSchema } from "@flowmate/contracts";
import type { ParserInputRef } from "./mineru.js";

export type ParserOutputInput = {
  input: ParserInputRef;
  outputPath: string;
  outputBytes: Buffer;
  parser: { name: string; version: string };
};

function evidence(input: ParserInputRef, blockId: string, text: string, value: Record<string, unknown>): ParsedDocument["blocks"][number]["evidence"] {
  const pageValue = value.page ?? value.page_idx;
  const page = typeof pageValue === "number" && Number.isInteger(pageValue) && pageValue >= 0 ? pageValue + (value.page_idx !== undefined ? 1 : 0) : null;
  const bboxValue = value.bbox ?? value.box;
  const bbox = Array.isArray(bboxValue) && bboxValue.length === 4 && bboxValue.every((item) => typeof item === "number") ? bboxValue as [number, number, number, number] : null;
  return { assetId: input.assetId, blockId, page, quote: typeof value.quote === "string" ? value.quote : text, bbox };
}

function mapBlocks(input: ParserInputRef, value: unknown): ParsedDocument["blocks"] {
  const source: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).blocks)
      ? (value as Record<string, unknown>).blocks as unknown[]
      : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).content_list)
        ? (value as Record<string, unknown>).content_list as unknown[]
        : value && typeof value === "object" && typeof (value as Record<string, unknown>).content === "string"
          ? [value]
          : [];
  return source.flatMap((raw, index) => {
    if (typeof raw === "string") {
      const id = "b" + String(index + 1);
      return [{ id, kind: "text" as const, text: raw, evidence: evidence(input, id, raw, {}) }];
    }
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : typeof item.html === "string" ? item.html.replace(/<[^>]+>/g, " ") : "";
    if (!text.trim()) return [];
    const id = typeof item.id === "string" && item.id ? item.id : "b" + String(index + 1);
    const kind = item.kind === "table" || item.type === "table" ? "table" as const : "text" as const;
    return [{ id, kind, text: text.trim(), evidence: evidence(input, id, text.trim(), item) }];
  });
}

export async function mapParserOutput(input: ParserOutputInput): Promise<ParsedDocument> {
  const extension = input.outputPath.toLowerCase().split(".").pop();
  let value: unknown;
  if (extension === "json") {
    value = JSON.parse(input.outputBytes.toString("utf8"));
  } else {
    value = { content: input.outputBytes.toString("utf8") };
  }
  const blocks = mapBlocks(input.input, value);
  const candidate = {
    schemaVersion: "1" as const,
    sampleId: input.input.sampleId,
    sourceId: input.input.sourceId,
    original: { assetId: input.input.assetId, sha256: input.input.sha256, mediaType: input.input.mediaType },
    parser: input.parser,
    blocks,
  };
  const parsed = ParsedDocumentSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("Parsed output validation failed: " + parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; "));
  return parsed.data;
}
