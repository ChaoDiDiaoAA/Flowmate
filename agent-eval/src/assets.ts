import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import {
  EvalCaseSchema,
  FieldGoldSchema,
  EvidenceRefSchema,
  type EvalCase,
  type FieldGold,
  type EvidenceRef,
} from "./schema.js";

const AuthoringCaseSchema = EvalCaseSchema.extend({
  gold: z.array(FieldGoldSchema),
}).strict();
type AuthoringCase = z.infer<typeof AuthoringCaseSchema>;

const AuthoringBatchSchema = z.object({
  schemaVersion: z.literal("1"),
  batchId: z.string().min(1),
  author: z.string().min(1),
  reviewer: z.string().min(1),
  cases: z.array(AuthoringCaseSchema),
}).strict();
export type AuthoringBatch = z.infer<typeof AuthoringBatchSchema>;

export const AssetManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  assetVersion: z.string().min(1),
  batchId: z.string().min(1),
  author: z.string().min(1),
  reviewer: z.string().min(1),
  sourceGroups: z.record(z.string().min(1), z.string().min(1)),
  cases: z.array(EvalCaseSchema),
  gold: z.record(z.string().min(1), z.array(FieldGoldSchema)),
  inputRefs: z.array(EvidenceRefSchema),
  goldRefs: z.array(EvidenceRefSchema),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export type AssetBatch = AuthoringBatch;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function assertEvidence(ref: EvidenceRef, field: string): void {
  const checked = EvidenceRefSchema.safeParse(ref);
  if (!checked.success) throw new Error(`ASSET_EVIDENCE_INVALID: ${field}`);
}

/** Load only explicit JSON authoring batches from a quality-owned directory. */
export async function importAuthoring(directory: string): Promise<AssetBatch> {
  const root = resolve(directory);
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (names.length !== 1) throw new Error("AUTHORING_BATCH_AMBIGUOUS");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, names[0]!), "utf8")) as unknown;
  } catch {
    throw new Error("AUTHORING_BATCH_INVALID");
  }
  return AuthoringBatchSchema.parse(value);
}

function assertNoSourceGroupLeakage(cases: AuthoringCase[]): void {
  const purposes = new Map<string, Set<string>>();
  for (const item of cases) {
    const values = purposes.get(item.sourceGroup) ?? new Set<string>();
    values.add(item.purpose);
    purposes.set(item.sourceGroup, values);
  }
  for (const [sourceGroup, values] of purposes) {
    if (values.has("holdout") && values.size > 1) throw new Error(`SOURCE_GROUP_LEAKAGE: ${sourceGroup}`);
  }
}

/** Freeze reviewed authoring into a versioned, quality-only manifest. */
export function freezeAssets(batchValue: unknown, assetVersion = "p0-seed-1"): AssetManifest {
  const batch = AuthoringBatchSchema.parse(batchValue);
  const ids = new Set<string>();
  assertNoSourceGroupLeakage(batch.cases);
  for (const item of batch.cases) {
    if (ids.has(item.caseId)) throw new Error(`DUPLICATE_CASE_ID: ${item.caseId}`);
    ids.add(item.caseId);
    assertEvidence(item.inputRef, `${item.caseId}.inputRef`);
    assertEvidence(item.goldRef, `${item.caseId}.goldRef`);
    const requiredGold = item.required || item.gold.some((field) => field.reviewStatus === "verified");
    if (requiredGold && item.gold.some((field) => field.reviewStatus !== "verified")) {
      throw new Error(`GOLD_NOT_VERIFIED: ${item.caseId}`);
    }
    for (const [index, field] of item.gold.entries()) {
      if (field.evidence.length === 0) {
        assertEvidence(item.goldRef, `${item.caseId}.gold[${index}].evidence`);
      } else {
        for (const [evidenceIndex, evidence] of field.evidence.entries()) {
          assertEvidence(evidence, `${item.caseId}.gold[${index}].evidence[${evidenceIndex}]`);
        }
      }
    }
  }
  const cases: EvalCase[] = batch.cases.map(({ gold: _gold, ...item }) => EvalCaseSchema.parse(item));
  const gold = Object.fromEntries(batch.cases.map((item) => [item.caseId, item.gold.map((field) => FieldGoldSchema.parse(field))]));
  const sourceGroups = Object.fromEntries(batch.cases.map((item) => [item.caseId, item.sourceGroup]));
  const inputRefs = batch.cases.map((item) => item.inputRef);
  const goldRefs = batch.cases.map((item) => item.goldRef);
  const base = { schemaVersion: "1" as const, assetVersion, batchId: batch.batchId, author: batch.author, reviewer: batch.reviewer, sourceGroups, cases, gold, inputRefs, goldRefs };
  return AssetManifestSchema.parse({ ...base, manifestHash: digest(base) });
}

export function assetManifestHash(manifest: AssetManifest): string {
  const { manifestHash: _ignored, ...base } = manifest;
  return digest(base);
}

export function assertAssetManifest(value: unknown): AssetManifest {
  const manifest = AssetManifestSchema.parse(value);
  if (assetManifestHash(manifest) !== manifest.manifestHash) throw new Error("ASSET_MANIFEST_HASH_MISMATCH");
  return manifest;
}

export function fieldGoldFor(manifest: AssetManifest, caseId: string): FieldGold[] {
  const fields = manifest.gold[caseId];
  if (!fields) throw new Error(`GOLD_NOT_FOUND: ${caseId}`);
  return fields.map((field) => FieldGoldSchema.parse(field));
}

export function sourceRefFor(manifest: AssetManifest, caseId: string): EvidenceRef {
  const item = manifest.cases.find((candidate) => candidate.caseId === caseId);
  if (!item) throw new Error(`CASE_NOT_FOUND: ${caseId}`);
  return EvidenceRefSchema.parse(item.inputRef);
}

export function authoringFileName(batch: AssetBatch): string {
  return `${basename(batch.batchId)}.json`;
}
