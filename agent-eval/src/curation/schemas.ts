import { z } from 'zod';
import { CurationFeedbackRequestSchema } from '../../../packages/contracts/src/evaluation-loop.ts';
import { candidateCaseSchema, constraintShape } from '../dataset-loader/authoring.ts';
import { caseMaterialSchema, checkSchema, controllerStepsSchema } from '../dataset-loader/schema.ts';
import { isDeepStrictEqual } from 'node:util';
import { goldByCaseId } from '../datasets/gold.ts';

export const uuid = z.string().uuid();
export const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const label = z.string().trim().min(1);
export const kindSchema = z.enum(['gold', 'bad', 'regression']);
export const safePath = z.string().min(1).refine(path => !path.includes('\\') && path.split('/').every(part =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..'), 'Invalid relative material path');
export const goldSchema = z.object({ values: z.record(z.unknown()).superRefine((values,context)=>{
    for(const key of [...Object.keys(constraintShape),'success','failure','checks','metrics','semantic'])
        if(Object.hasOwn(values,key))context.addIssue({code:'custom',path:[key],message:'Gold must not overwrite Case constraint: '+key});
}), checks: z.array(checkSchema).min(1),
    opportunities: z.record(z.number().int().nonnegative().nullable()), sources: z.array(safePath).min(1),
    basis: z.union([label, z.record(z.unknown()).refine(value => Object.keys(value).length > 0, 'Gold basis must contain source evidence')]) }).strict();
// This accepts unchanged formal data only; expansion still requires resolver-proven Case reuse.
export const formalGoldSchema = goldSchema.extend({ values: z.record(z.unknown()), sources: z.array(safePath) }).refine(value =>
    Object.values(goldByCaseId).some(original => isDeepStrictEqual(value, original)),
    'Gold must exactly match an unchanged formal original');
export const scenarioSchema = z.object({ requires: z.array(z.enum(['agent', 'invoice', 'workspace', 'research', 'skill', 'history', 'compaction', 'extension', 'subagent'])).min(1),
    source: label.optional(),
    materials: z.array(caseMaterialSchema), steps: controllerStepsSchema,
    selection: z.object({ enabledSkills: z.array(z.string()), enabledExtensions: z.array(z.string()) }).strict(),
    setup: z.record(z.unknown()).optional(), files: z.record(z.object({ text: z.string().optional(), json: z.unknown().optional() }).strict()).optional() }).strict();
export const bindingSchema = z.object({ materialId: label, quote: z.string().min(1), label,
    target: z.object({ kind: z.enum(['success', 'failure', 'answer']), text: label }).strict() }).strict();
const control = z.object({ label, evidence: z.record(z.object({ present: z.boolean(), actual: z.unknown(), source: label }).strict()) }).strict();
const factPath = z.array(z.union([z.string().min(1), z.number().int().nonnegative()]));
export const controlBindingSchema = z.object({ control: z.enum(['negative', 'positive']), evidence: label, path: factPath,
    source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('trace'), path: factPath }).strict(),
        z.object({ kind: z.literal('material'), materialId: label, quote: z.string().min(1) }).strict()]) }).strict();
export const validationSchema = z.object({ revision: positive, at: z.string().datetime(), status: z.enum(['PASS', 'BLOCKED']), issues: z.array(z.string()),
    controls: z.object({ negative: z.string(), positive: z.string() }).strict(),
    replay: z.object({ status: z.enum(['PASS', 'FAIL', 'ERROR', 'NOT_RUN']), kind: z.literal('controlled'), reason: z.string(), evidence: z.unknown().optional() }).strict(),
    conditions: z.unknown() }).strict();
export const candidateSchema = z.object({ contract: z.literal('flowmate-evaluation-candidate/v1').default('flowmate-evaluation-candidate/v1'), id: uuid, revision: positive,
    kind: kindSchema, status: z.enum(['draft', 'blocked', 'validated']).default('draft'), traceRef: z.object({ id: uuid, revision: positive }).strict(),
    createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional(), sourceLabels: z.array(label).min(1), reason: label,
    case: candidateCaseSchema.optional(), gold: z.union([goldSchema, formalGoldSchema]).optional(), review: z.record(z.unknown()).optional(), scenario: scenarioSchema.optional(),
    bindings: z.array(bindingSchema).default([]), controls: z.object({ negative: control.optional(), positive: control.optional() }).strict().optional(),
    controlBindings: z.array(controlBindingSchema).default([]),
    reuseCaseId: z.string().regex(/^FM-\d{3}$/).optional(),
    reviseCase: z.object({ id: z.string().regex(/^FM-\d{3}$/), version: positive }).strict().optional(),
    validation: validationSchema.optional() }).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export type Validation = z.infer<typeof validationSchema>;
export const feedbackRequestSchema = CurationFeedbackRequestSchema;
export const feedbackSchema = feedbackRequestSchema.omit({ operationId: true }).extend({ id: uuid, at: z.string().datetime(), conditions: z.unknown() }).strict();
export type CurationFeedback = z.infer<typeof feedbackSchema>;
export const mineRequestSchema = z.object({ operationId: uuid, traceId: uuid, expectedRevision: positive, kind: kindSchema }).strict();
export const publishRequestSchema = z.object({ operationId: uuid, benchmarkId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .refine(value => !['flowmate-agent-v1', 'flowmate-research-v1', 'all', 'baseline'].includes(value), 'Benchmark identity is reserved'),
    candidateIds: z.array(uuid).min(1).refine(items => new Set(items).size === items.length), approvals: z.array(uuid).min(1),
    smokeCaseIds: z.array(z.string().regex(/^FM-\d{3}$/)).default([]) }).strict();
export const publicationSchema = z.object({ contract: z.literal('flowmate-published-benchmark/v1'), id: publishRequestSchema.shape.benchmarkId, revision: positive,
    operationId: uuid, at: z.string().datetime(), request: publishRequestSchema,
    members: z.array(z.object({ caseId: z.string().regex(/^FM-\d{3}$/), caseVersion: positive, candidateId: uuid, candidateRevision: positive, approvalId: uuid,
        kind: kindSchema, traceRef: z.object({ id: uuid, revision: positive }).strict(), reused: z.boolean() }).strict()).min(1),
    regressionCaseIds: z.array(z.string().regex(/^FM-\d{3}$/)), smokeCaseIds: z.array(z.string().regex(/^FM-\d{3}$/)) }).strict();
export type Publication = z.infer<typeof publicationSchema>;
