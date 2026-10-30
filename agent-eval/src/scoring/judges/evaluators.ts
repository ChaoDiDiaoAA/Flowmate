import type { CompactPlan } from './compact.ts';
import { taskMetrics } from './metrics/task.ts';
import { toolUseMetrics } from './metrics/tool-use.ts';
import { skillMetrics } from './metrics/skill.ts';
import { contextMetrics } from './metrics/context.ts';
import { memoryMetrics } from './metrics/memory.ts';
import { subagentMetrics } from './metrics/subagent.ts';
import { safetyMetrics } from './metrics/safety.ts';
import { researchGroundednessMetrics } from './metrics/research-groundedness.ts';
import { researchCompletenessMetrics } from './metrics/research-completeness.ts';
import { researchChainMetrics } from './metrics/research-chain.ts';
import type { EvaluatorSnapshot } from './evaluator-snapshot.ts';
export { readEvaluatorSnapshots, evaluatorSnapshotSchema, type EvaluatorSnapshot } from './evaluator-snapshot.ts';

export const semanticEvaluatorDefinitions = [
    ...taskMetrics, ...toolUseMetrics, ...skillMetrics, ...contextMetrics, ...memoryMetrics, ...subagentMetrics, ...safetyMetrics,
    ...researchGroundednessMetrics, ...researchCompletenessMetrics, ...researchChainMetrics,
];
const definitions = new Map(semanticEvaluatorDefinitions.map(def => [def.id, def]));
if (definitions.size !== semanticEvaluatorDefinitions.length) throw Error('Duplicate semantic Metric definition');
export function semanticEvaluator(metricId: string) {
    const definition = definitions.get(metricId);
    if (!definition) throw Error('Unknown semantic Metric: ' + metricId);
    return definition;
}
export function metricEvaluatorSnapshots(plan: CompactPlan): EvaluatorSnapshot[] {
    return plan.criteria.map(c => { const def = semanticEvaluator(c.metricId);
        return { id: def.id, version: def.version, instructions: def.rubric.instructions, metricIds: [def.id] }; });
}
export function evaluatorEvidence(plan: CompactPlan, evidence: unknown) {
    return { ...(evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence : { original: evidence }),
        evaluatorRubrics: metricEvaluatorSnapshots(plan) };
}
