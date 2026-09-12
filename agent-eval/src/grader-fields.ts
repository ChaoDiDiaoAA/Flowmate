import { FieldGoldSchema, type AssertionResult, type EvidenceRef, type FieldGold } from "./schema.js";

type CandidateField = {
  raw?: string | null;
  normalized?: string | null;
  status?: string;
  evidence?: Array<Partial<EvidenceRef> & { assetId?: string }>;
};

function fieldAt(candidate: unknown, path: string): CandidateField | null {
  let value: unknown = candidate;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[segment];
  }
  return value && typeof value === "object" ? value as CandidateField : null;
}

function digits(value: string): { sign: -1 | 1; coefficient: bigint; scale: number } | null {
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = match[3] ?? "";
  return { sign: match[1] === "-" ? -1 : 1, coefficient: BigInt(`${match[2]}${fraction}`), scale: fraction.length };
}

/** Exact decimal equality independent of product normalization code. */
export function compareDecimal(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const a = digits(left);
  const b = digits(right);
  if (!a || !b) return false;
  if (a.coefficient === 0n && b.coefficient === 0n) return true;
  if (a.sign !== b.sign) return false;
  if (a.scale === b.scale) return a.coefficient === b.coefficient;
  if (a.scale > b.scale) return a.coefficient === b.coefficient * 10n ** BigInt(a.scale - b.scale);
  return a.coefficient * 10n ** BigInt(b.scale - a.scale) === b.coefficient;
}

function compareDate(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return /^\d{4}-\d{2}-\d{2}$/.test(left) && /^\d{4}-\d{2}-\d{2}$/.test(right) && left === right;
}

function compareValue(left: string | null | undefined, right: string | null, comparison: FieldGold["comparison"]): boolean {
  if (comparison === "decimal") return compareDecimal(left ?? null, right);
  if (comparison === "date") return compareDate(left ?? null, right);
  return (left ?? null) === right;
}

function result(assertionId: string, verdict: AssertionResult["verdict"], critical: boolean, reasonCode: string, evidence: EvidenceRef[] = []): AssertionResult {
  return { assertionId, verdict, critical, reasonCode, evidence };
}

function evidenceMatches(candidate: CandidateField, gold: FieldGold): boolean {
  const expected = new Set(gold.evidence.map((ref) => `${ref.id}:${ref.sha256}`));
  if (expected.size === 0) return true;
  return (candidate.evidence ?? []).some((ref) => {
    const id = typeof ref.assetId === "string" ? ref.assetId : ref.id;
    return typeof id === "string" && typeof ref.sha256 === "string" && expected.has(`${id}:${ref.sha256}`);
  });
}

export function gradeCurrency(candidate: { normalized?: string | null; status?: string }, goldValue: FieldGold): AssertionResult {
  const gold = FieldGoldSchema.parse(goldValue);
  const statusOk = candidate.status === gold.valueStatus;
  const valueOk = compareValue(candidate.normalized, gold.normalized, gold.comparison);
  if (statusOk && valueOk) return result(`field:${gold.fieldPath}`, "PASS", gold.inputAvailability === "available", "FIELD_MATCH", gold.evidence);
  return result(`field:${gold.fieldPath}`, gold.inputAvailability === "uncertain" ? "UNJUDGEABLE" : "FAIL", true, statusOk ? "FIELD_VALUE_MISMATCH" : "FIELD_STATUS_MISMATCH", gold.evidence);
}

export function gradeFields(candidate: unknown, goldValues: FieldGold[], evidence: EvidenceRef[] = []): AssertionResult[] {
  // Evidence supplied at Trial level is retained by the caller for report
  // binding; field-level support is checked against the candidate's own
  // references so a shared trace cannot accidentally satisfy a missing field
  // citation.
  void evidence;
  return goldValues.map((goldValue) => {
    const gold = FieldGoldSchema.parse(goldValue);
    const candidateField = fieldAt(candidate, gold.fieldPath);
    if (!candidateField) return result(`field:${gold.fieldPath}`, gold.inputAvailability === "uncertain" ? "UNJUDGEABLE" : "FAIL", true, "FIELD_MISSING");
    const statusOk = candidateField.status === gold.valueStatus;
    const valueOk = compareValue(candidateField.normalized, gold.normalized, gold.comparison);
    if (!statusOk) return result(`field:${gold.fieldPath}:status`, "FAIL", true, "FIELD_STATUS_MISMATCH", gold.evidence);
    if (!valueOk) return result(`field:${gold.fieldPath}:value`, gold.inputAvailability === "uncertain" ? "UNJUDGEABLE" : "FAIL", true, "FIELD_VALUE_MISMATCH", gold.evidence);
    if (gold.evidence.length > 0 && !evidenceMatches(candidateField, gold)) {
      const hasCandidateEvidence = (candidateField.evidence ?? []).length > 0;
      return result(`field:${gold.fieldPath}:evidence`, hasCandidateEvidence ? "FAIL" : "UNJUDGEABLE", true, "EVIDENCE_MISMATCH", gold.evidence);
    }
    return result(`field:${gold.fieldPath}`, "PASS", gold.inputAvailability === "available", "FIELD_MATCH", gold.evidence);
  });
}

export { compareValue };
