import { defineSemanticMetric as metric } from '../metric.ts';
export const researchChainMetrics = [
    metric('DR06', 'research-chain', 1, 'Check every required connected multi-hop chain, intermediate entity, expressed hop and actual citation. Preserve missing or uncertain hops and derive chain coverage locally.'),
];
