import { z } from "zod";
import { EvalCaseSchema, EvidenceRefSchema, EvalScopeSchema, type EvalCase, type EvidenceRef } from "./schema.js";

export const EvidenceReportSchema = z.object({
  reportId: z.string().min(1),
  caseId: z.string().min(1),
  candidateId: z.string().min(1),
  scope: EvalScopeSchema,
  scenarioId: z.string().min(1),
  variantId: z.string().min(1),
  appSourceHash: z.string().min(1),
  lockHash: z.string().min(1),
  patchHash: z.string().min(1).nullable(),
  inputHash: z.string().min(1),
  fixtureVersion: z.string().min(1).nullable(),
  executedAt: z.string().datetime({ offset: true }),
  assertions: z.array(z.string().min(1)),
  evidenceRefs: z.array(EvidenceRefSchema),
  toolNames: z.array(z.string().min(1)),
}).strict();
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;

export type EvidenceBinding = {
  case: EvalCase;
  candidateId: string;
  scope: EvidenceReport["scope"];
  scenarioId: string;
  variantId: string;
  appSourceHash: string;
  lockHash: string;
  patchHash: string | null;
  inputHash: string;
  fixtureVersion: string | null;
  requiredAssertions: string[];
  requiredToolNames?: string[];
};

export type EvidenceResolution = {
  binding: EvidenceBinding;
  primary: EvidenceReport | null;
  reusable: EvidenceReport[];
  missing: string[];
};

function sameArray(expected: string[], actual: string[]): boolean {
  const set = new Set(actual);
  return expected.every((value) => set.has(value));
}

export function isReusable(reportValue: unknown, binding: EvidenceBinding): boolean {
  const report = EvidenceReportSchema.safeParse(reportValue);
  if (!report.success) return false;
  const value = report.data;
  return value.caseId === binding.case.caseId
    && value.candidateId === binding.candidateId
    && value.scope === binding.scope
    && value.scenarioId === binding.scenarioId
    && value.variantId === binding.variantId
    && value.appSourceHash === binding.appSourceHash
    && value.lockHash === binding.lockHash
    && value.patchHash === binding.patchHash
    && value.inputHash === binding.inputHash
    && value.fixtureVersion === binding.fixtureVersion
    && sameArray(binding.requiredAssertions, value.assertions)
    && sameArray(binding.requiredToolNames ?? [], value.toolNames)
    && value.evidenceRefs.every((ref) => EvidenceRefSchema.safeParse(ref).success);
}

export function resolveEvidence(caseValue: unknown, candidateId: string, reportsValue: unknown[], bindingOverrides: Partial<Omit<EvidenceBinding, "case" | "candidateId">> = {}): EvidenceResolution {
  const caseDef = EvalCaseSchema.parse(caseValue);
  const binding: EvidenceBinding = {
    case: caseDef,
    candidateId,
    scope: bindingOverrides.scope ?? caseDef.scope,
    scenarioId: bindingOverrides.scenarioId ?? caseDef.caseId,
    variantId: bindingOverrides.variantId ?? "default",
    appSourceHash: bindingOverrides.appSourceHash ?? "",
    lockHash: bindingOverrides.lockHash ?? "",
    patchHash: bindingOverrides.patchHash ?? null,
    inputHash: bindingOverrides.inputHash ?? caseDef.inputRef.sha256,
    fixtureVersion: bindingOverrides.fixtureVersion ?? caseDef.fixtureVersion,
    requiredAssertions: bindingOverrides.requiredAssertions ?? caseDef.assertions,
    ...(bindingOverrides.requiredToolNames === undefined ? {} : { requiredToolNames: bindingOverrides.requiredToolNames }),
  };
  const reports = reportsValue.map((report) => EvidenceReportSchema.safeParse(report)).filter((item): item is { success: true; data: EvidenceReport } => item.success).map((item) => item.data);
  const reusable = reports.filter((report) => isReusable(report, binding));
  const primary = reusable[0] ?? null;
  const missing = primary ? [] : [caseDef.caseId];
  return { binding, primary, reusable, missing };
}

export function evidenceRefs(reportValue: unknown): EvidenceRef[] {
  const report = EvidenceReportSchema.parse(reportValue);
  return report.evidenceRefs.map((ref) => EvidenceRefSchema.parse(ref));
}
