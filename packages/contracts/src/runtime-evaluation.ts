import { z } from 'zod';

export const CaseEvaluationFaultProfileSchema=z.union([
    z.object({id:z.enum(['case-save-delivery-loss','case-evidence-read-execution-failure']),version:z.literal(1)}).strict(),
    z.object({id:z.literal('case-save-cancel-race'),version:z.literal(1),gate:z.enum(['observe','before-commit','after-commit'])}).strict(),
]).readonly();
export type CaseEvaluationFaultProfile=z.infer<typeof CaseEvaluationFaultProfileSchema>;
