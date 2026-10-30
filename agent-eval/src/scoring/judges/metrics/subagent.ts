import { defineSemanticMetric as metric } from '../metric.ts';
export const subagentMetrics = [
    metric('delegation-decision', 'subagent', 1, 'Judge delegation and non-delegation against planned task goals, authorization and available capabilities. Do not reduce planned opportunities to children that happened to start.'),
    metric('subtask-success', 'subagent', 1, 'Compare every independently planned child goal with actual child outcomes. Missing or failed children remain opportunities rather than disappearing from the denominator.'),
    metric('subtask-result-use', 'subagent', 1, 'Check parent adoption of relevant child results against original child evidence and the final parent outcome. Child completion alone does not prove adoption.'),
];
