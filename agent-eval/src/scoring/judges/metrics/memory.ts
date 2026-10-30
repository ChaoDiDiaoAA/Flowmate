import { defineSemanticMetric as metric } from '../metric.ts';
export const memoryMetrics = [
    metric('history-use', 'memory', 1, 'Verify use of relevant actual prior turns and their sources. Planned future turns and merely retained history do not prove use.'),
    metric('user-correction', 'memory', 1, 'Check adoption of the latest valid user correction at the point it was consumed. Preserve the corrected object, value and scope; do not use future unconsumed corrections.'),
    metric('compaction-retention', 'memory', 1, 'Compare required pre-compaction facts and sources with observed native compaction and subsequent accessible context. A configured compaction policy is not an actual compaction event.'),
    metric('post-compaction-success', 'memory', 1, 'Verify required outcomes after an observed native compaction against original retained facts and actual business results. Do not infer success from a summary alone.'),
];
