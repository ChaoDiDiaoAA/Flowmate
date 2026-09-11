import { createHash } from "node:crypto";
import { TestCandidateSchema, type TestCandidate } from "@flowmate/contracts";

export type CandidateConfig = Omit<TestCandidate, "candidateId"> & { candidateId?: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function freezeCandidate(config: CandidateConfig): TestCandidate {
  const { candidateId: _ignored, ...withoutId } = config;
  const parsed = TestCandidateSchema.omit({ candidateId: true }).parse(withoutId);
  const candidateId = `candidate-${createHash("sha256").update(canonical(parsed)).digest("hex")}`;
  const candidate = TestCandidateSchema.parse({ ...parsed, candidateId });
  return deepFreeze(candidate);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export { canonical as canonicalJson };
