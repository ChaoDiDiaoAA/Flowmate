import { z } from "zod";
import { EvidenceRefSchema, EvalTrialSchema, type EvalTrial, type EvidenceRef } from "./schema.js";

export const QualityDecisionSchema = z.object({
  candidateId: z.string().min(1),
  assetVersion: z.string().min(1),
  status: z.enum(["PASS", "FAIL", "INSUFFICIENT_EVIDENCE"]),
  evidenceRefs: z.array(EvidenceRefSchema),
  blockingReasons: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
}).strict();
export type QualityDecision = z.infer<typeof QualityDecisionSchema>;

export type DecisionManifest = {
  candidateId: string;
  assetVersion: string;
  requiredCaseIds: string[];
  requiredEvidenceCaseIds?: string[];
};

export function decide(manifest: DecisionManifest, trialValues: unknown[]): QualityDecision {
  const trials = trialValues.map((value) => EvalTrialSchema.parse(value));
  const required = new Set(manifest.requiredCaseIds);
  const relevant = trials.filter((trial) => required.has(trial.caseId));
  const missing = [...required].filter((caseId) => !relevant.some((trial) => trial.executionStatus === "COMPLETED" || trial.executionStatus === "ERROR"));
  const notRun = relevant.filter((trial) => trial.executionStatus === "NOT_RUN");
  const mismatched = trials.filter((trial) => trial.candidateId !== manifest.candidateId);
  const unauthorized = relevant.flatMap((trial) => trial.assertionResults.filter((item) => (item.reasonCode === "UNAUTHORIZED_ACCESS" || item.reasonCode === "FORBIDDEN_ACTION") && item.verdict === "FAIL"));
  const failed = relevant.filter((trial) => trial.verdict === "FAIL");
  const uncertain = relevant.filter((trial) => trial.verdict === "UNJUDGEABLE" || trial.executionStatus === "ERROR");
  const blockingReasons: string[] = [];
  if (missing.length) blockingReasons.push(`REQUIRED_CASE_MISSING:${missing.join(",")}`);
  if (notRun.length) blockingReasons.push(`REQUIRED_CASE_NOT_RUN:${notRun.map((trial) => trial.caseId).join(",")}`);
  if (mismatched.length) blockingReasons.push("CANDIDATE_MISMATCH");
  if (failed.length) blockingReasons.push(`QUALITY_FAILURE:${failed.map((trial) => trial.caseId).join(",")}`);
  if (unauthorized.length) blockingReasons.push("UNAUTHORIZED_ACCESS");
  if (uncertain.length) blockingReasons.push(`EVIDENCE_INSUFFICIENT:${uncertain.map((trial) => trial.caseId).join(",")}`);
  const missingEvidence = manifest.requiredEvidenceCaseIds?.filter((caseId) => !relevant.some((trial) => trial.caseId === caseId && trial.executionStatus === "COMPLETED")) ?? [];
  if (missingEvidence.length) blockingReasons.push(`MECHANISM_EVIDENCE_MISSING:${missingEvidence.join(",")}`);
  const status = mismatched.length || failed.length || unauthorized.length ? "FAIL" : blockingReasons.length ? "INSUFFICIENT_EVIDENCE" : "PASS";
  const evidenceRefs: EvidenceRef[] = relevant.flatMap((trial) => trial.productReportRefs);
  return QualityDecisionSchema.parse({ candidateId: manifest.candidateId, assetVersion: manifest.assetVersion, status, evidenceRefs, blockingReasons, limitations: missingEvidence.length ? ["some required mechanism evidence is absent"] : [] });
}
