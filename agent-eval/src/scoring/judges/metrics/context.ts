import { defineSemanticMetric as metric } from '../metric.ts';
export const contextMetrics = [
    metric('context-coverage', 'context', 1, 'Compare necessary available facts and sources with the context actually sent. Preserve missing or unverified facts; a supported feature flag is not evidence of coverage.'),
    metric('current-fact-use', 'context', 1, 'Check the actual use of necessary current facts in subsequent reasoning, actions and output. Context delivery alone does not prove adoption.'),
];
