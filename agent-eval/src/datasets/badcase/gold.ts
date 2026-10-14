import { goldByCaseId as baseline } from '../gold.ts';
import { flowmateBadcaseDataset } from './cases.ts';

export const independentGold: Record<string, any> = {};
export const goldByCaseId = Object.fromEntries(flowmateBadcaseDataset.cases.map(c => [c.id, independentGold[c.id] ?? baseline[c.id]]));
