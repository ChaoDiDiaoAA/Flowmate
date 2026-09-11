import { describe, expect, it } from "vitest";
import {
  InvoiceCandidateSchema,
  makeInvoiceCandidate,
  makeParsedDocument,
  ParsedDocumentSchema,
} from "../../packages/contracts/src/index.js";

describe("P0 public contracts", () => {
  it("accepts a parsed document with stable evidence references", () => {
    const parsed = makeParsedDocument();
    expect(ParsedDocumentSchema.parse(parsed)).toEqual(parsed);
    expect(parsed.blocks[0]?.evidence.page).toBe(1);
  });

  it("keeps a missing tax amount empty instead of turning it into zero", () => {
    const candidate = makeInvoiceCandidate();
    candidate.fields.taxAmount = {
      raw: null,
      normalized: null,
      status: "missing",
      evidence: [],
    };

    const accepted = InvoiceCandidateSchema.parse(candidate);
    expect(accepted.fields.taxAmount.normalized).toBeNull();
    expect(InvoiceCandidateSchema.safeParse({ ...candidate, gold: "answer" }).success).toBe(false);
  });

  it("rejects non-decimal amount strings and unknown fields", () => {
    const candidate = makeInvoiceCandidate();
    candidate.fields.totalAmount.normalized = "1,100.00";
    expect(InvoiceCandidateSchema.safeParse(candidate).success).toBe(false);
    expect(InvoiceCandidateSchema.safeParse({ ...makeInvoiceCandidate(), unexpected: true }).success).toBe(false);
  });
});
