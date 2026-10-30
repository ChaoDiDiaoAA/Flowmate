import { z } from 'zod';

const text=z.string().min(1),positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const measurementStatus=z.enum(['PASS','FAIL','UNJUDGEABLE','ERROR','NOT_RUN','NOT_APPLICABLE']);
export const experimentMetricDeltaSchema=z.object({metricId:text,before:z.number().finite().min(0).max(1).nullable(),after:z.number().finite().min(0).max(1).nullable(),
  direction:z.enum(['up','down']),delta:z.number().finite().nullable(),applicable:z.boolean(),evidenceRefs:z.array(text),threshold:z.number().finite().min(0).max(1).optional(),
  notApplicable:text.optional(),gated:z.boolean().optional(),gateReason:text.optional(),statuses:z.object({before:z.array(z.string()),after:z.array(z.string())}).strict().optional()}).strict();
export type ExperimentMetricDelta=z.infer<typeof experimentMetricDeltaSchema>;
export const experimentAssertionSchema=z.object({caseId:text,metricId:text,before:count,after:count,required:z.boolean(),regression:z.boolean(),repeats:positive,evidenceRefs:z.array(text)}).strict();
export type ExperimentAssertion=z.infer<typeof experimentAssertionSchema>;
export const baselineReferenceSchema=z.object({metrics:z.array(experimentMetricDeltaSchema).min(1),assertions:z.array(experimentAssertionSchema).min(1),
  measurements:z.array(z.object({executionId:text,trialId:text,caseId:text,caseVersion:positive,repetition:positive,status:measurementStatus,
    scores:z.array(z.object({metricId:text,version:positive,method:z.enum(['deterministic','llm-judge']),required:z.boolean(),status:measurementStatus,value:z.number().finite().min(0).max(1).nullable(),
      evaluatorId:text.optional(),evaluatorVersion:positive.optional(),category:z.enum(['formal','diagnostic','guardrail']).optional(),
      statistics:z.object({unit:text,numerator:count.nullable(),denominator:count.nullable(),missing:count.nullable()}).strict().optional(),
      judge:z.object({callId:text,criterion:count}).strict().optional()}).strict()).min(1)}).strict()).min(1)}).strict();
export type BaselineReference=z.infer<typeof baselineReferenceSchema>;
export const gateThresholdsSchema=z.object({metricDeclines:z.array(z.object({metricId:text,maximumAbsoluteDecline:z.number().finite().min(0).max(1)}).strict())
  .refine(rows=>new Set(rows.map(row=>row.metricId)).size===rows.length,'Duplicate metric threshold'),requiredAssertionPassDecline:z.literal(0),
  regressionPasses:z.literal('all-applicable'),actualLeakageMaximum:z.literal(0),forbiddenSideEffectsMaximum:z.literal(0)}).strict();
export type GateThresholds=z.infer<typeof gateThresholdsSchema>;
