import { z } from "zod";
import { Sha256Schema } from "@flowmate/contracts";

export const VerdictSchema = z.enum(["PASS", "FAIL", "UNJUDGEABLE"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ExecutionStatusSchema = z.enum(["COMPLETED", "NOT_RUN", "ERROR"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const EvalScopeSchema = z.enum(["native", "integration", "parser-result", "eval-infra"]);
export type EvalScope = z.infer<typeof EvalScopeSchema>;

export const EvalLevelSchema = z.enum(["F", "A", "B"]);
export type EvalLevel = z.infer<typeof EvalLevelSchema>;

export const EvalPurposeSchema = z.enum(["development", "regression", "holdout"]);
export type EvalPurpose = z.infer<typeof EvalPurposeSchema>;

export const DriverIdSchema = z.enum(["native-f", "product-f", "product-a", "parser-result"]);
export type DriverId = z.infer<typeof DriverIdSchema>;

export const EvidenceRefSchema = z.object({
  id: z.string().min(1),
  sha256: Sha256Schema,
  source: z.string().min(1),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const EvalCaseSchema = z.object({
  caseId: z.string().min(1),
  version: z.string().min(1),
  primaryModule: z.string().min(1),
  relatedModules: z.array(z.string().min(1)),
  runtimeRefs: z.array(z.string().min(1)),
  benchmarkRefs: z.array(z.string().min(1)),
  scope: EvalScopeSchema,
  level: EvalLevelSchema,
  sourceKind: z.string().min(1),
  sourceGroup: z.string().min(1),
  purpose: EvalPurposeSchema,
  inputRef: EvidenceRefSchema,
  fixtureVersion: z.string().min(1).nullable(),
  goldRef: EvidenceRefSchema,
  rubricVersion: z.string().min(1),
  required: z.boolean(),
  assertions: z.array(z.string().min(1)),
  driverId: DriverIdSchema,
}).strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const FieldComparisonSchema = z.enum(["identifier", "text", "decimal", "date", "status"]);
export type FieldComparison = z.infer<typeof FieldComparisonSchema>;

export const FieldReviewStatusSchema = z.enum(["verified", "pending", "disputed"]);
export type FieldReviewStatus = z.infer<typeof FieldReviewStatusSchema>;

export const InputAvailabilitySchema = z.enum(["available", "unavailable", "uncertain"]);
export type InputAvailability = z.infer<typeof InputAvailabilitySchema>;

export const FieldStatusSchema = z.enum(["present", "missing", "ambiguous", "conflict"]);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

export const FieldGoldSchema = z.object({
  fieldPath: z.string().min(1),
  sourceValue: z.string().nullable(),
  sourceNormalized: z.string().nullable(),
  sourceStatus: FieldStatusSchema,
  normalized: z.string().nullable(),
  valueStatus: FieldStatusSchema,
  inputAvailability: InputAvailabilitySchema,
  evidence: z.array(EvidenceRefSchema),
  comparison: FieldComparisonSchema,
  reviewStatus: FieldReviewStatusSchema,
}).strict();
export type FieldGold = z.infer<typeof FieldGoldSchema>;

export const AssertionResultSchema = z.object({
  assertionId: z.string().min(1),
  verdict: VerdictSchema,
  critical: z.boolean(),
  evidence: z.array(EvidenceRefSchema),
  reasonCode: z.string().min(1),
}).strict();
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const CatalogVariantSchema = z.object({
  variantId: z.string().min(1),
  required: z.boolean(),
  scope: EvalScopeSchema,
  level: EvalLevelSchema,
  implemented: z.boolean(),
  executed: z.boolean(),
  triggered: z.boolean(),
  owner: z.string().min(1),
}).strict();
export type CatalogVariant = z.infer<typeof CatalogVariantSchema>;

/** A catalog may reserve a case before its private input/Gold asset exists. */
export const CatalogEvidenceRefSchema = z.object({
  id: z.string().min(1),
  sha256: Sha256Schema.nullable(),
  source: z.string().min(1),
}).strict();
export type CatalogEvidenceRef = z.infer<typeof CatalogEvidenceRefSchema>;

export const CatalogItemSchema = EvalCaseSchema.extend({
  inputRef: CatalogEvidenceRefSchema,
  goldRef: CatalogEvidenceRefSchema,
  owner: z.string().min(1),
  productTasks: z.array(z.string().min(1)),
  testFile: z.string().min(1),
  variants: z.array(CatalogVariantSchema),
}).strict();
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const EvalCatalogSchema = z.object({
  schemaVersion: z.literal("1"),
  catalogVersion: z.string().min(1),
  items: z.array(CatalogItemSchema),
}).strict();
export type EvalCatalog = z.infer<typeof EvalCatalogSchema>;

export const EvalTrialSchema = z.object({
  evalRunId: z.string().min(1),
  trialId: z.string().min(1),
  caseId: z.string().min(1),
  candidateId: z.string().min(1),
  caseHash: Sha256Schema,
  goldHash: Sha256Schema,
  graderHash: Sha256Schema,
  attemptIndex: z.number().int().positive(),
  executionStatus: ExecutionStatusSchema,
  jobId: z.string().min(1).nullable(),
  runIds: z.array(z.string().min(1)),
  childRunIds: z.array(z.string().min(1)),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  usage: z.object({
    inputTokens: z.number().nonnegative().nullable(),
    outputTokens: z.number().nonnegative().nullable(),
    cost: z.number().nonnegative().nullable(),
    unknown: z.boolean(),
  }).strict(),
  assertionResults: z.array(AssertionResultSchema),
  verdict: VerdictSchema.nullable(),
  errorKind: z.string().min(1).nullable(),
  upstreamBlocked: z.boolean(),
  productReportRefs: z.array(EvidenceRefSchema),
}).strict();
export type EvalTrial = z.infer<typeof EvalTrialSchema>;

export type CatalogCheck = {
  ok: boolean;
  missingVariants: string[];
  duplicateIds: string[];
  unassignedOwners: string[];
  invalidMappings: string[];
};

export function validateCatalog(value: unknown): CatalogCheck {
  const parsed = EvalCatalogSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      missingVariants: [],
      duplicateIds: [],
      unassignedOwners: [],
      invalidMappings: parsed.error.issues.map((issue) => issue.path.join(".") || "catalog"),
    };
  }
  const ids = parsed.data.items.map((item) => item.caseId);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
  const missingVariants: string[] = [];
  const unassignedOwners: string[] = [];
  const invalidMappings: string[] = [];
  for (const item of parsed.data.items) {
    if (!item.owner.trim()) unassignedOwners.push(item.caseId);
    if (!item.productTasks.length || !item.testFile.trim()) invalidMappings.push(`${item.caseId}:product-mapping`);
    for (const variant of item.variants) {
      if (!variant.owner.trim()) unassignedOwners.push(`${item.caseId}:${variant.variantId}`);
      if (variant.required && (!variant.implemented || !variant.executed || !variant.triggered)) {
        missingVariants.push(`${item.caseId}-${variant.variantId}`);
      }
      if (variant.scope !== item.scope || variant.level !== item.level) {
        invalidMappings.push(`${item.caseId}:${variant.variantId}:scope-level`);
      }
    }
  }
  return {
    ok: duplicateIds.length === 0 && missingVariants.length === 0 && unassignedOwners.length === 0 && invalidMappings.length === 0,
    missingVariants: [...new Set(missingVariants)].sort(),
    duplicateIds,
    unassignedOwners: [...new Set(unassignedOwners)].sort(),
    invalidMappings: [...new Set(invalidMappings)].sort(),
  };
}
