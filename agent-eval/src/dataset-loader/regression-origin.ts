import { z } from 'zod';

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const regressionOriginSchema = z.object({
    batch: identity, issueId: identity, sourceExecutionId: identity, sourceTrialId: identity,
    sourceCaseId: z.string().regex(/^FM-\d{3}$/), sourceCaseVersion: z.number().int().positive(),
    metricIds: z.array(z.string().trim().min(1).max(256)).min(1).refine(items => new Set(items).size === items.length),
    verification: z.object({ kind: z.enum(['engineering', 'human']), reviewer: z.string().trim().min(1), at: z.string().datetime(),
        basis: z.string().trim().min(1).max(2000) }).strict()
}).strict();
export type RegressionOrigin = z.infer<typeof regressionOriginSchema>;
export const regressionOriginListSchema = z.array(regressionOriginSchema).min(1).refine(origins => new Set(origins.map(origin =>
    JSON.stringify([origin.batch, origin.issueId, origin.sourceExecutionId, origin.sourceTrialId]))).size === origins.length, 'Duplicate regression origin');
export const regressionOriginsSchema = z.record(regressionOriginListSchema);
