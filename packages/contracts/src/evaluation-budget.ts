import { z } from 'zod';
import { RUNTIME_CONFIG } from './runtime-config.ts';

const timeout = z.number().int().min(100).max(RUNTIME_CONFIG.ranges.timeoutMs.max);
export const EvaluationBudgetProfileSchema = z.object({
  trialTimeoutMs: timeout, runTimeoutMs: timeout,
  maxModelCalls: z.number().int().min(1).max(RUNTIME_CONFIG.ranges.maxModelCalls.max),
  prepareTimeoutMs: timeout, captureTimeoutMs: timeout,
  stopGraceMs: z.number().int().min(100).max(RUNTIME_CONFIG.ranges.stopGraceMs.max),
}).strict();
export const EvaluationBudgetProfilesSchema = z.object({
  business: EvaluationBudgetProfileSchema, research: EvaluationBudgetProfileSchema,
}).strict();
export const ResolvedEvaluationBudgetSchema = EvaluationBudgetProfileSchema.extend({
  profile: z.enum(['business', 'research']), source: z.enum(['evaluation-profile', 'explicit-override']),
}).strict();
export type EvaluationBudgetProfiles = z.infer<typeof EvaluationBudgetProfilesSchema>;
export type ResolvedEvaluationBudget = z.infer<typeof ResolvedEvaluationBudgetSchema>;
