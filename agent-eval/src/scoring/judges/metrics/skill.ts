import { defineSemanticMetric as metric } from '../metric.ts';
export const skillMetrics = [
    metric('skill-selection', 'skill', 1, 'Judge selection and non-selection of relevant Skills against task needs and available resources. Allow legitimate alternatives; discovery is not actual use.'),
    metric('skill-guidance', 'skill', 1, 'Compare actual actions with relevant Skill guidance that was really read. Naming or loading a Skill does not demonstrate following it.'),
    metric('progressive-reading', 'skill', 1, 'Check required discovery and progressive reading against original resource receipts and necessary guidance. Do not infer reading from resource availability or self-claims.'),
];
