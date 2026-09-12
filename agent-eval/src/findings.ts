import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EvidenceRefSchema, type EvidenceRef } from "./schema.js";

export const FindingClassificationSchema = z.enum(["good", "bad"]);
export type FindingClassification = z.infer<typeof FindingClassificationSchema>;

export const FindingSchema = z.object({
  findingId: z.string().min(1),
  caseId: z.string().min(1),
  trialId: z.string().min(1),
  executionStatus: z.enum(["COMPLETED", "NOT_RUN", "ERROR"]),
  classification: FindingClassificationSchema,
  verdict: z.enum(["PASS", "FAIL", "UNJUDGEABLE"]).nullable(),
  rootCause: z.enum(["product", "runtime", "model", "data", "grader", "unknown"]).nullable(),
  causeConfidence: z.enum(["confirmed", "hypothesis", "unresolved"]),
  evidence: z.array(EvidenceRefSchema),
  history: z.array(z.object({
    at: z.string().datetime({ offset: true }),
    action: z.enum(["created", "reviewed", "regression-linked"]),
    classification: FindingClassificationSchema,
    trialId: z.string().min(1),
    note: z.string().min(1),
  }).strict()),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;

const findings = new Map<string, Finding>();

export type RecordFindingInput = Omit<Finding, "findingId" | "history"> & { findingId?: string };

export function recordFinding(input: RecordFindingInput): Finding {
  if (input.executionStatus !== "COMPLETED") throw new Error("OBSERVATION_REQUIRED");
  const value = FindingSchema.parse({ ...input, findingId: input.findingId ?? `finding-${randomUUID()}`, history: [{ at: new Date().toISOString(), action: "created", classification: input.classification, trialId: input.trialId, note: "observed trial" }] });
  findings.set(value.findingId, value);
  return value;
}

export function reviewFinding(findingId: string, decision: { classification: FindingClassification; rootCause?: Finding["rootCause"]; causeConfidence?: Finding["causeConfidence"]; note: string }): Finding {
  const current = findings.get(findingId);
  if (!current || current.executionStatus !== "COMPLETED") throw new Error("OBSERVATION_REQUIRED");
  const next = FindingSchema.parse({
    ...current,
    classification: decision.classification,
    rootCause: decision.rootCause === undefined ? current.rootCause : decision.rootCause,
    causeConfidence: decision.causeConfidence ?? current.causeConfidence,
    history: [...current.history, { at: new Date().toISOString(), action: "reviewed", classification: decision.classification, trialId: current.trialId, note: decision.note }],
  });
  findings.set(findingId, next);
  return next;
}

export function linkRegression(findingId: string, fixedTrial: { trialId: string; executionStatus: "COMPLETED" | "NOT_RUN" | "ERROR"; verdict: Finding["verdict"]; evidence?: EvidenceRef[] }): Finding {
  const current = findings.get(findingId);
  if (!current || current.executionStatus !== "COMPLETED" || fixedTrial.executionStatus !== "COMPLETED") throw new Error("OBSERVATION_REQUIRED");
  const next = FindingSchema.parse({
    ...current,
    history: [...current.history, { at: new Date().toISOString(), action: "regression-linked", classification: current.classification, trialId: fixedTrial.trialId, note: fixedTrial.verdict === "PASS" ? "fixed trial linked" : "follow-up trial remains non-passing" }],
    evidence: [...current.evidence, ...(fixedTrial.evidence ?? [])],
  });
  findings.set(findingId, next);
  return next;
}

export function getFinding(findingId: string): Finding | null {
  return findings.get(findingId) ?? null;
}
