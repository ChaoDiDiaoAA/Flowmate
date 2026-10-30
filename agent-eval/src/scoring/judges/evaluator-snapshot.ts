import { z } from 'zod';
import type { CompactPlan } from './compact.ts';

export const evaluatorSnapshotSchema = z.object({ id: z.string().min(1), version: z.number().int().positive(),
    instructions: z.string().trim().min(1), metricIds: z.tuple([z.string().min(1)]) }).strict();
export type EvaluatorSnapshot = z.infer<typeof evaluatorSnapshotSchema>;

/** Saved definitions are read without consulting today's Evaluator implementation. */
export function readEvaluatorSnapshots(plan: CompactPlan, evidence: unknown): EvaluatorSnapshot[] {
    const { evaluatorRubrics } = z.object({ evaluatorRubrics: z.array(evaluatorSnapshotSchema) }).passthrough().parse(evidence);
    if (evaluatorRubrics.length !== plan.criteria.length || evaluatorRubrics.some((r, i) =>
        r.id !== plan.criteria[i]!.metricId || r.metricIds[0] !== r.id)) throw Error('Evaluator snapshots differ from selected Metric identities');
    return evaluatorRubrics;
}
