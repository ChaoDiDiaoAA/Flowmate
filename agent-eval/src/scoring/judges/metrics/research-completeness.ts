import { defineSemanticMetric as metric } from '../metric.ts';
export const researchCompletenessMetrics = [
    metric('DR02', 'research-completeness', 1, 'Compare every independently required Gold fact with original asserted facts. Preserve omissions and required dimensions; match each Gold at most once and derive recall locally.'),
];
