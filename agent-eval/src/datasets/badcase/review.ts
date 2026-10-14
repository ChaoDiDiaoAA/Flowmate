import { reviewByCaseId as baseline } from '../review.ts';
import { flowmateBadcaseDataset } from './cases.ts';

export const independentReviews: Record<string, any> = {};
export const reviewByCaseId = Object.fromEntries(flowmateBadcaseDataset.cases.map(c => [c.id, independentReviews[c.id] ?? baseline[c.id]]));
