import { z } from 'zod';
import { RuntimeStrategyPolicySchema } from './ports.ts';

export const EvaluationAgentOverridesSchema = z.object({ systemPrompt: z.string().min(1).optional(),
    controlledReplay: z.literal(true).optional(),
    reasoning: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    strategy: RuntimeStrategyPolicySchema.optional() }).strict();
export type EvaluationAgentOverrides = z.infer<typeof EvaluationAgentOverridesSchema>;

export const CaseEvaluationFaultProfileSchema=z.union([
    z.object({id:z.enum(['case-save-delivery-loss','case-evidence-read-execution-failure']),version:z.literal(1)}).strict(),
    z.object({id:z.literal('case-save-cancel-race'),version:z.literal(1),gate:z.enum(['observe','before-commit','after-commit'])}).strict(),
]).readonly();
export type CaseEvaluationFaultProfile=z.infer<typeof CaseEvaluationFaultProfileSchema>;
