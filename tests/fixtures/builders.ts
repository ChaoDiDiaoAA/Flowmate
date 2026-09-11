import { makeInvoiceCandidate as makeContractInvoiceCandidate, makeParsedDocument as makeContractParsedDocument } from "@flowmate/contracts";
import type { InvoiceCandidate, ParsedDocument, RunIdentity } from "@flowmate/contracts";

export function makeParsedDocument(): ParsedDocument {
  return structuredClone(makeContractParsedDocument());
}

export function makeInvoiceCandidate(): InvoiceCandidate {
  return structuredClone(makeContractInvoiceCandidate());
}

export const makeFixtureParsedDocument = makeParsedDocument;
export const makeFixtureInvoiceCandidate = makeInvoiceCandidate;

export function makeIdentity(overrides: Partial<RunIdentity> = {}): RunIdentity {
  return {
    jobId: "job-synthetic",
    runId: "run-synthetic",
    generation: 1,
    candidateId: "candidate-synthetic",
    ...overrides,
  };
}
