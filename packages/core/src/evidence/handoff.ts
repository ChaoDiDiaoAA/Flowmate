import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { AssetRefSchema, Sha256Schema, TestCandidateSchema, type AssetRef, type TestCandidate } from "@flowmate/contracts";

/**
 * A functional report is an observation made by the product/runtime line.
 * It deliberately contains no quality score.  The evaluation line may bind
 * a case or grader to the report, but cannot turn this object into a verdict.
 */
export const HandoffModeSchema = z.enum(["offline-native-F", "offline-integration-F", "live-functional"]);
export type HandoffMode = z.infer<typeof HandoffModeSchema>;

export const HandoffAssertionSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  message: z.string().min(1),
}).strict();
export type HandoffAssertion = z.infer<typeof HandoffAssertionSchema>;

export const HandoffReportSchema = z.object({
  reportId: z.string().min(1),
  testFile: z.string().min(1),
  caseId: z.string().min(1),
  candidateId: z.string().min(1),
  datasetVersion: z.string().min(1),
  mode: HandoffModeSchema,
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  exitCode: z.number().int(),
  assertions: z.array(HandoffAssertionSchema),
  artifacts: z.array(AssetRefSchema),
  limitations: z.array(z.string().min(1)),
}).strict();
export type HandoffReport = z.infer<typeof HandoffReportSchema>;

export const RuntimeSupportSchema = z.object({
  module: z.string().min(1),
  enabled: z.boolean(),
  implemented: z.boolean(),
  executed: z.boolean(),
  triggered: z.boolean(),
  evidenceRefs: z.array(AssetRefSchema),
  limitations: z.array(z.string().min(1)),
}).strict();
export type RuntimeSupport = z.infer<typeof RuntimeSupportSchema>;

export const HandoffEnvironmentSchema = z.object({
  nodeVersion: z.string().min(1),
  electronVersion: z.string().min(1).nullable(),
  platform: z.string().min(1),
  arch: z.string().min(1),
  runtimeLockHash: Sha256Schema.nullable(),
  appSourceHash: Sha256Schema.nullable(),
}).strict();
export type HandoffEnvironment = z.infer<typeof HandoffEnvironmentSchema>;

export const HandoffManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  handoffId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  candidateId: z.string().min(1),
  datasetVersion: z.string().min(1),
  candidateHash: Sha256Schema,
  inputHashes: z.record(z.string().min(1), Sha256Schema),
  configHashes: z.record(z.string().min(1), Sha256Schema),
  environment: HandoffEnvironmentSchema,
  entrypoints: z.array(z.string().min(1)),
  featureReports: z.array(HandoffReportSchema),
  runtimeSupport: z.array(RuntimeSupportSchema),
  evidenceRefs: z.array(AssetRefSchema),
  missing: z.array(z.string().min(1)),
  manifestHash: Sha256Schema,
}).strict();
export type HandoffManifest = z.infer<typeof HandoffManifestSchema>;

export type HandoffInput = {
  candidate: TestCandidate;
  datasetVersion: string;
  inputHashes?: Record<string, string>;
  configHashes?: Record<string, string>;
  environment?: Partial<HandoffEnvironment>;
  entrypoints?: string[];
  featureReports?: HandoffReport[];
  runtimeSupport?: RuntimeSupport[];
  evidenceRefs?: AssetRef[];
  missing?: string[];
  outputPath?: string;
  handoffId?: string;
};

export type HandoffVerification = {
  ok: boolean;
  manifestHash: string | null;
  errors: string[];
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function withoutManifestHash(manifest: Omit<HandoffManifest, "manifestHash">): Omit<HandoffManifest, "manifestHash"> {
  return manifest;
}

function asHashMap(values: Record<string, string> | undefined, field: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const checked = Sha256Schema.safeParse(value);
    if (!checked.success) throw new Error(`HANDOFF_INVALID_${field.toUpperCase()}_HASH: ${key}`);
    result[key] = checked.data;
  }
  return result;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`HANDOFF_DUPLICATE_${label.toUpperCase()}`);
}

/**
 * Create a quality-neutral handoff manifest from product evidence.  The
 * candidate is validated here so a handoff cannot accidentally point at a
 * production or otherwise malformed candidate.
 */
export async function exportHandoff(candidateId: string, input: HandoffInput): Promise<HandoffManifest> {
  const candidate = TestCandidateSchema.parse(input.candidate);
  if (candidate.candidateId !== candidateId) throw new Error("HANDOFF_CANDIDATE_MISMATCH");
  if (candidate.datasetVersion !== input.datasetVersion) throw new Error("HANDOFF_DATASET_MISMATCH");

  const reports = (input.featureReports ?? []).map((report) => HandoffReportSchema.parse(report));
  const support = (input.runtimeSupport ?? []).map((item) => RuntimeSupportSchema.parse(item));
  assertUnique(reports.map((report) => report.reportId), "REPORT_ID");
  assertUnique(support.map((item) => item.module), "RUNTIME_MODULE");

  const environment: HandoffEnvironment = {
    nodeVersion: input.environment?.nodeVersion ?? process.version,
    electronVersion: input.environment?.electronVersion ?? null,
    platform: input.environment?.platform ?? process.platform,
    arch: input.environment?.arch ?? process.arch,
    runtimeLockHash: input.environment?.runtimeLockHash ?? null,
    appSourceHash: input.environment?.appSourceHash ?? null,
  };
  const base: Omit<HandoffManifest, "manifestHash"> = {
    schemaVersion: "1",
    handoffId: input.handoffId ?? `handoff-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    candidateId,
    datasetVersion: input.datasetVersion,
    candidateHash: digest(candidate),
    inputHashes: asHashMap(input.inputHashes, "input"),
    configHashes: asHashMap(input.configHashes, "config"),
    environment: HandoffEnvironmentSchema.parse(environment),
    entrypoints: [...new Set(input.entrypoints ?? [])].sort(),
    featureReports: reports,
    runtimeSupport: support,
    evidenceRefs: (input.evidenceRefs ?? []).map((ref) => AssetRefSchema.parse(ref)),
    missing: [...new Set(input.missing ?? [])].sort(),
  };
  const manifest = HandoffManifestSchema.parse({ ...withoutManifestHash(base), manifestHash: digest(base) });
  if (input.outputPath) await writeJsonAtomically(input.outputPath, manifest);
  return manifest;
}

export function verifyHandoff(value: unknown): HandoffVerification {
  const parsed = HandoffManifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, manifestHash: null, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  const manifest = parsed.data;
  const errors: string[] = [];
  const { manifestHash: actualHash, ...base } = manifest;
  const expectedHash = digest(base);
  if (actualHash !== expectedHash) errors.push("manifestHash does not match manifest contents");
  const candidateHash = manifest.featureReports.some((report) => report.candidateId !== manifest.candidateId)
    ? "feature report candidateId differs from handoff candidateId"
    : null;
  if (candidateHash) errors.push(candidateHash);
  if (manifest.featureReports.some((report) => report.datasetVersion !== manifest.datasetVersion)) errors.push("feature report datasetVersion differs from handoff datasetVersion");
  if (manifest.candidateHash !== manifest.candidateHash.toLowerCase()) errors.push("candidateHash must be lowercase");
  try {
    assertUnique(manifest.featureReports.map((report) => report.reportId), "REPORT_ID");
    assertUnique(manifest.runtimeSupport.map((item) => item.module), "RUNTIME_MODULE");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "duplicate handoff entries");
  }
  return { ok: errors.length === 0, manifestHash: actualHash, errors };
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, target);
}
