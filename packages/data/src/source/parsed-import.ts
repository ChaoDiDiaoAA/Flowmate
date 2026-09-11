import { extname } from "node:path";
import { ParsedDocumentSchema, type ParsedDocument, type ToolResult } from "@flowmate/contracts";
import { readStableFile } from "./inspect.js";
import { mediaTypeForPath, type SourceEntry } from "./role-map.js";

function failure<T>(code: string, message: string, retryable = false): ToolResult<T> {
  return { ok: false, error: { code, retryable, message } };
}

function assetId(entry: SourceEntry): string {
  return `original:${entry.sourceId}:${entry.sampleId}`;
}

function evidence(entry: SourceEntry, blockId: string, text: string, raw: unknown): ParsedDocument["blocks"][number]["evidence"] {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const pageValue = value.page;
  const page = typeof pageValue === "number" && Number.isInteger(pageValue) && pageValue > 0 ? pageValue : null;
  const bboxValue = value.bbox;
  const bbox = Array.isArray(bboxValue) && bboxValue.length === 4 && bboxValue.every((item) => typeof item === "number")
    ? bboxValue as [number, number, number, number]
    : null;
  const quote = typeof value.quote === "string" ? value.quote : text;
  return { assetId: assetId(entry), blockId, page, quote, bbox };
}

function jsonBlocks(entry: SourceEntry, value: Record<string, unknown>): ParsedDocument["blocks"] {
  const candidates: unknown[] = Array.isArray(value.blocks)
    ? value.blocks
    : typeof value.content === "string" ? [{ id: "b1", kind: "text", text: value.content }] : [];
  return candidates.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `b${index + 1}`;
    const kind = item.kind === "table" ? "table" : "text";
    return [{ id, kind, text, evidence: evidence(entry, id, text, item.evidence ?? item) }];
  });
}

function markdownBlocks(entry: SourceEntry, source: string): ParsedDocument["blocks"] {
  let text = source.replace(/<!--[\s\S]*?-->/g, "");
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) text = text.slice(end + "\n---".length);
  }
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean);
  return paragraphs.map((part, index) => {
    const id = `md-${index + 1}`;
    return { id, kind: "text" as const, text: part, evidence: evidence(entry, id, part, {}) };
  });
}

export async function importParsed(entry: SourceEntry): Promise<ToolResult<ParsedDocument>> {
  const originalRead = await readStableFile(entry.original.path);
  if ("code" in originalRead) return failure(originalRead.code, originalRead.message, true);
  if (originalRead.sha256 !== entry.original.sha256) return failure("HASH_MISMATCH", "original file digest differs from the inspected entry");
  const parsedRead = await readStableFile(entry.parsed.path);
  if ("code" in parsedRead) return failure(parsedRead.code, parsedRead.message, true);
  if (parsedRead.sha256 !== entry.parsed.sha256) return failure("HASH_MISMATCH", "parsed file digest differs from the inspected entry");
  if (parsedRead.size === 0) return failure("EMPTY_CONTENT", "parsed file is empty");
  const extension = extname(entry.parsed.path).toLowerCase();
  if (![".json", ".md", ".markdown"].includes(extension)) return failure("UNSUPPORTED_PARSE_FORMAT", "parsed file format is not supported");

  let value: Record<string, unknown> | null = null;
  let blocks: ParsedDocument["blocks"];
  if (extension === ".json") {
    try {
      const parsed = JSON.parse(parsedRead.bytes.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure("INVALID_PARSE_JSON", "parsed JSON root must be an object");
      value = parsed as Record<string, unknown>;
      blocks = jsonBlocks(entry, value);
      const declaredSample = value.sampleId;
      if (typeof declaredSample === "string" && declaredSample !== entry.sampleId) return failure("SAMPLE_ID_MISMATCH", "parsed sample id differs from the inspected entry");
      const declaredSource = value.sourceId;
      if (typeof declaredSource === "string" && declaredSource !== entry.sourceId) return failure("SOURCE_ID_MISMATCH", "parsed source id differs from the inspected role map");
    } catch {
      return failure("INVALID_PARSE_JSON", "parsed JSON could not be decoded");
    }
  } else {
    blocks = markdownBlocks(entry, parsedRead.bytes.toString("utf8"));
  }
  if (blocks.length === 0 || blocks.every((block) => block.text.trim().length === 0)) return failure("EMPTY_CONTENT", "parsed output contains no usable blocks");
  const parserValue = value?.parser;
  const parser = parserValue && typeof parserValue === "object" ? parserValue as Record<string, unknown> : {};
  const candidate = {
    schemaVersion: "1" as const,
    sampleId: entry.sampleId,
    sourceId: entry.sourceId,
    original: { assetId: assetId(entry), sha256: originalRead.sha256, mediaType: mediaTypeForPath(entry.original.path) },
    parser: {
      name: typeof parser.name === "string" && parser.name.length > 0 ? parser.name : "structured-import",
      version: typeof parser.version === "string" && parser.version.length > 0 ? parser.version : entry.parserVersion,
    },
    blocks,
  };
  const parsedDocument = ParsedDocumentSchema.safeParse(candidate);
  if (!parsedDocument.success) return failure("INVALID_PARSED_DOCUMENT", "parsed output does not satisfy the Flowmate document contract");
  return { ok: true, value: parsedDocument.data, evidence: [candidate.original] };
}
