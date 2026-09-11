import { createHash } from "node:crypto";
import { TextEncoder } from "node:util";
import { z } from "zod";
import { InvoiceCandidateSchema, type InvoiceCandidate, type ParsedDocument, type RunIdentity, type ToolResult } from "@flowmate/contracts";
import type { Store } from "../jobs/repository.js";
import type { BudgetLedger } from "../runtime/budget.js";
import { isToolName, TOOL_VERSIONS, type ToolName } from "./registry.js";

const ReadDocumentArgsSchema = z.object({}).strict();
const ReadEvidenceArgsSchema = z.object({ assetId: z.string().min(1), blockId: z.string().min(1) }).strict();
const SubmitArgsSchema = z.object({ candidate: InvoiceCandidateSchema }).strict();

export type GatewayInput = {
  sampleId: string;
  parsed: ParsedDocument;
  allowedAssetIds: string[];
};

export type ToolRequest = { requestId: string; toolName: string; toolVersion: string; args: unknown };
export type ToolGateway = { invoke(identity: RunIdentity, request: ToolRequest, signal: AbortSignal): Promise<ToolResult<unknown>> };
export type GatewayOptions = { store: Store; input: GatewayInput; maxResultBytes?: number; budget?: BudgetLedger };

function fail<T>(code: string, message: string, retryable = false): ToolResult<T> {
  return { ok: false, error: { code, retryable, message } };
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function requestHash(request: ToolRequest): string {
  return createHash("sha256").update(canonical({ toolName: request.toolName, toolVersion: request.toolVersion, args: request.args })).digest("hex");
}

function boundRun(store: Store, identity: RunIdentity): { cancelled?: ToolResult<never> } | ToolResult<never> {
  try {
    const snapshot = store.getJob(identity.jobId);
    const run = snapshot.runs.find((item) => item.runId === identity.runId);
    if (!run || run.jobId !== identity.jobId || run.generation !== identity.generation || run.candidateId !== identity.candidateId || snapshot.job.currentRunId !== identity.runId) return fail("STALE_RUN", "run identity is not the current execution");
    if (snapshot.job.cancelRequested || ["cancelling", "cancelled", "interrupted"].includes(run.status)) return { cancelled: fail("RUN_CANCELLED", "run cancellation has been requested") };
    return {};
  } catch {
    return fail("RUN_NOT_FOUND", "run identity is unknown");
  }
}

function checkEvidence(candidate: InvoiceCandidate, parsed: ParsedDocument, allowed: Set<string>): boolean {
  const blocks = new Map(parsed.blocks.map((block) => [block.id, block]));
  const fields = [...Object.values(candidate.fields), ...candidate.lines.flatMap((line) => Object.values(line))];
  for (const field of fields) {
    for (const evidence of field.evidence) {
      if (!allowed.has(evidence.assetId) || evidence.assetId !== parsed.original.assetId || !evidence.blockId) return false;
      const block = blocks.get(evidence.blockId);
      if (!block) return false;
      if (evidence.quote !== null && !block.text.includes(evidence.quote)) return false;
      if (evidence.page !== null && block.evidence.page !== null && evidence.page !== block.evidence.page) return false;
    }
  }
  return true;
}

export function createGateway(options: GatewayOptions): ToolGateway {
  const maxResultBytes = options.maxResultBytes ?? 256 * 1024;
  const input = options.input;
  const allowed = new Set(input.allowedAssetIds);
  return {
    async invoke(identity, request, signal) {
      const bound = boundRun(options.store, identity);
      if ("ok" in bound) return bound;
      if (bound.cancelled) return bound.cancelled;
      if (signal.aborted) return fail("RUN_CANCELLED", "tool call was cancelled");
      if (!request.requestId) return fail("INVALID_TOOL_ARGS", "request id is required");
      const job = options.store.getJob(identity.jobId).job;
      if (job.sampleId !== input.sampleId) return fail("SAMPLE_MISMATCH", "input is not bound to the current job");
      const digest = requestHash(request);
      const previous = options.store.getToolCalls(identity.runId).find((call) => call.requestId === request.requestId);
      if (previous && previous.requestHash === digest && previous.resultAssetId) {
        try {
          return JSON.parse(options.store.getArtifact(previous.resultAssetId).bytes.toString("utf8")) as ToolResult<unknown>;
        } catch {
          return fail("REQUEST_REPLAY_UNAVAILABLE", "the previous tool result cannot be replayed");
        }
      }
      if (options.budget) {
        try {
          options.budget.reserveToolCall();
        } catch (error) {
          const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "TOOL_CALL_BUDGET_EXCEEDED";
          return fail(code, error instanceof Error ? error.message : "tool call budget exceeded");
        }
      }

      let rawRef;
      try {
        rawRef = await options.store.putArtifact(identity.runId, "tool.request", Buffer.from(JSON.stringify({ requestId: request.requestId, toolName: request.toolName, toolVersion: request.toolVersion, args: request.args }), "utf8"));
      } catch {
        return fail("RUN_NOT_FOUND", "request could not be attached to the run");
      }
      const record = async (result: ToolResult<unknown>): Promise<ToolResult<unknown>> => {
        const resultRef = await options.store.putArtifact(identity.runId, "tool.result", Buffer.from(JSON.stringify(result), "utf8"));
        options.store.recordToolCall({ runId: identity.runId, requestId: request.requestId, requestHash: digest, toolName: request.toolName, toolVersion: request.toolVersion, status: result.ok ? "succeeded" : `failed:${result.error.code}`, requestAssetId: rawRef.assetId, resultAssetId: resultRef.assetId });
        return result;
      };
      if (previous && previous.requestHash !== digest) return record(fail("REQUEST_CONFLICT", "request id was already used with different tool input"));
      if (!isToolName(request.toolName)) return record(fail("UNKNOWN_TOOL", "tool is not registered"));
      const toolName: ToolName = request.toolName;
      if (TOOL_VERSIONS[toolName] !== request.toolVersion) return record(fail("TOOL_VERSION_UNSUPPORTED", "tool version is not enabled for this candidate"));

      let result: ToolResult<unknown>;
      if (toolName === "read_parsed_document") {
        const parsed = ReadDocumentArgsSchema.safeParse(request.args);
        result = parsed.success ? { ok: true, value: input.parsed, evidence: [input.parsed.original] } : fail("INVALID_TOOL_ARGS", "read_parsed_document accepts no arguments");
      } else if (toolName === "read_evidence") {
        const parsedArgs = ReadEvidenceArgsSchema.safeParse(request.args);
        if (!parsedArgs.success) {
          result = fail("INVALID_TOOL_ARGS", "read_evidence requires an assetId and blockId");
        } else if (!allowed.has(parsedArgs.data.assetId) || parsedArgs.data.assetId !== input.parsed.original.assetId) {
          result = fail("ASSET_NOT_ALLOWED", "asset is outside the current input scope");
        } else {
          const block = input.parsed.blocks.find((item) => item.id === parsedArgs.data.blockId);
          result = block ? { ok: true, value: { block }, evidence: [input.parsed.original] } : fail("EVIDENCE_NOT_FOUND", "evidence block is not in the current parsed document");
        }
      } else {
        const parsedArgs = SubmitArgsSchema.safeParse(request.args);
        if (!parsedArgs.success) {
          result = fail("INVALID_TOOL_ARGS", "submit_invoice_candidate arguments do not satisfy the invoice contract");
        } else if (parsedArgs.data.candidate.sampleId !== input.sampleId || parsedArgs.data.candidate.sampleId !== job.sampleId) {
          result = fail("SAMPLE_MISMATCH", "candidate sample does not match the bound job");
        } else if (!checkEvidence(parsedArgs.data.candidate, input.parsed, allowed)) {
          result = fail("EVIDENCE_MISMATCH", "candidate evidence is not supported by the bound parsed document");
        } else {
          try {
            const accepted = options.store.acceptCandidate(identity, request.requestId, rawRef, parsedArgs.data.candidate);
            result = { ok: true, value: accepted, evidence: [input.parsed.original, rawRef] };
          } catch (error) {
            const message = error instanceof Error ? error.message : "candidate could not be accepted";
            result = fail(message, "candidate was rejected by the execution store");
          }
        }
      }
      if (jsonBytes(result) > maxResultBytes) return record(fail("TOOL_RESULT_TOO_LARGE", "tool result exceeds the configured response limit"));
      return record(result);
    },
  };
}
