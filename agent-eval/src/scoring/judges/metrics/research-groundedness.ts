import { defineSemanticMetric as metric } from '../metric.ts';
export const researchGroundednessMetrics = [
    metric('DR01', 'research-groundedness', 1, 'Witness every original factual assertion for precision, including extra facts outside Gold. Check entities, dates, conditions and conflicts against independent sources; derive the ratio locally.'),
    metric('DR04', 'research-groundedness', 1, 'Check every original citation for actual entailment of its attached claim using the complete citation group. A valid address or retrieved page does not prove support; derive the ratio locally.'),
    metric('DR05', 'research-groundedness', 1, 'Check effective coverage of claims requiring evidence, including necessary connected hops and actual citations. Unlinked or report-external evidence is insufficient; derive the ratio locally.'),
];
