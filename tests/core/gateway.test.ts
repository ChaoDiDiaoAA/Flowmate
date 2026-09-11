import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { makeInvoiceCandidate, makeParsedDocument } from "../../packages/contracts/src/invoice.ts";
import type { RunIdentity } from "../../packages/contracts/src/execution.ts";
import { createGateway, type GatewayInput } from "../../packages/core/src/tools/gateway.ts";
import { openStore } from "../../packages/core/src/index.ts";

function candidateWithOnlyInvoiceNumber(): ReturnType<typeof makeInvoiceCandidate> {
  const candidate = makeInvoiceCandidate();
  for (const [key, value] of Object.entries(candidate.fields)) {
    if (key !== "invoiceNumber") {
      candidate.fields[key as keyof typeof candidate.fields] = { raw: null, normalized: null, status: "missing", evidence: [] };
    }
  }
  candidate.fields.invoiceNumber.evidence = [{ assetId: candidate.fields.invoiceNumber.evidence[0]!.assetId, blockId: "b1", page: 1, quote: "Invoice No: SYN-001", bbox: null }];
  return candidate;
}

async function setup(): Promise<{ root: string; store: ReturnType<typeof openStore>; identity: RunIdentity; input: GatewayInput; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "flowmate-gateway-"));
  const store = openStore(root);
  const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
  const run = store.startRun(job.id, job.candidateId);
  const parsed = makeParsedDocument();
  const input: GatewayInput = { sampleId: "SYN-001", parsed, allowedAssetIds: [parsed.original.assetId] };
  const identity: RunIdentity = { jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId };
  return { root, store, identity, input, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("Flowmate Tool Gateway", () => {
  it("reads only the bound parsed document and accepts a cited candidate", async () => {
    const setupValue = await setup();
    try {
      const gateway = createGateway({ store: setupValue.store, input: setupValue.input });
      const read = await gateway.invoke(setupValue.identity, { requestId: "r-read", toolName: "read_parsed_document", toolVersion: "1", args: {} }, new AbortController().signal);
      expect(read).toMatchObject({ ok: true, value: { sampleId: "SYN-001" } });
      const submitted = await gateway.invoke(setupValue.identity, { requestId: "r-submit", toolName: "submit_invoice_candidate", toolVersion: "1", args: { candidate: candidateWithOnlyInvoiceNumber() } }, new AbortController().signal);
      expect(submitted).toMatchObject({ ok: true });
      expect(setupValue.store.getJob(setupValue.identity.jobId).candidates).toHaveLength(1);
      expect(setupValue.store.getToolCalls(setupValue.identity.runId).map((call) => call.status)).toEqual(["succeeded", "succeeded"]);
    } finally {
      await setupValue.close();
    }
  });

  it("rejects unknown tools, self-declared scope and unsupported versions", async () => {
    const setupValue = await setup();
    try {
      const gateway = createGateway({ store: setupValue.store, input: setupValue.input });
      const signal = new AbortController().signal;
      await expect(gateway.invoke(setupValue.identity, { requestId: "u1", toolName: "read_secret", toolVersion: "1", args: {} }, signal)).resolves.toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
      await expect(gateway.invoke(setupValue.identity, { requestId: "u2", toolName: "read_parsed_document", toolVersion: "2", args: {} }, signal)).resolves.toMatchObject({ ok: false, error: { code: "TOOL_VERSION_UNSUPPORTED" } });
      await expect(gateway.invoke(setupValue.identity, { requestId: "u3", toolName: "read_parsed_document", toolVersion: "1", args: { sampleId: "OTHER" } }, signal)).resolves.toMatchObject({ ok: false, error: { code: "INVALID_TOOL_ARGS" } });
    } finally {
      await setupValue.close();
    }
  });

  it("rejects evidence that does not belong to the bound original block", async () => {
    const setupValue = await setup();
    try {
      const gateway = createGateway({ store: setupValue.store, input: setupValue.input });
      const candidate = candidateWithOnlyInvoiceNumber();
      candidate.fields.invoiceNumber.evidence[0]!.assetId = "other-asset";
      await expect(gateway.invoke(setupValue.identity, { requestId: "bad-evidence", toolName: "submit_invoice_candidate", toolVersion: "1", args: { candidate } }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: "EVIDENCE_MISMATCH" } });
      expect(setupValue.store.getJob(setupValue.identity.jobId).candidates).toHaveLength(0);
    } finally {
      await setupValue.close();
    }
  });

  it("replays an identical request and rejects a conflicting request id", async () => {
    const setupValue = await setup();
    try {
      const gateway = createGateway({ store: setupValue.store, input: setupValue.input });
      const signal = new AbortController().signal;
      const request = { requestId: "replay", toolName: "read_evidence", toolVersion: "1", args: { assetId: setupValue.input.parsed.original.assetId, blockId: "b1" } };
      const first = await gateway.invoke(setupValue.identity, request, signal);
      const replay = await gateway.invoke(setupValue.identity, request, signal);
      expect(replay).toEqual(first);
      expect(setupValue.store.getToolCalls(setupValue.identity.runId)).toHaveLength(1);
      await expect(gateway.invoke(setupValue.identity, { ...request, args: { assetId: setupValue.input.parsed.original.assetId, blockId: "missing" } }, signal)).resolves.toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
      expect(setupValue.store.getToolCalls(setupValue.identity.runId)).toHaveLength(2);
    } finally {
      await setupValue.close();
    }
  });

  it("does not silently truncate an oversized tool result", async () => {
    const setupValue = await setup();
    try {
      setupValue.input.parsed.blocks[0]!.text = "x".repeat(300_000);
      const gateway = createGateway({ store: setupValue.store, input: setupValue.input, maxResultBytes: 256 * 1024 });
      await expect(gateway.invoke(setupValue.identity, { requestId: "large", toolName: "read_parsed_document", toolVersion: "1", args: {} }, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: "TOOL_RESULT_TOO_LARGE" } });
    } finally {
      await setupValue.close();
    }
  });
});
