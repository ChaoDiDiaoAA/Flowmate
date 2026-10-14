import type { RegressionOrigin } from '../../dataset-loader/regression-origin.ts';

const business = 'agent-1791945436356-2b5c304a', research = 'agent-1791945957213-cd826271';
const verified = { kind: 'engineering' as const, reviewer: 'Codex', at: '2026-10-14T10:28:55Z',
    basis: 'Saved original effects and independent source declarations checked; positive/negative reference controls are engineering checks, not human approval or a new model evaluation.' };
const members: Array<[string, string, string, string[]]> = [
    ['FM-045', business, 'BC-12', ['line-items']],
    ['FM-051', research, 'BC-13', ['DR02', 'task-success']]
];
export const regressionOrigins: Record<string, RegressionOrigin[]> = Object.fromEntries(members.map(([caseId, executionId, issueId, metricIds]) => [caseId, [{ batch: '2026-10-14-smoke-repair', issueId,
    sourceExecutionId: executionId, sourceTrialId: `${executionId}-${caseId}-trial-1`, sourceCaseId: caseId, sourceCaseVersion: 1, metricIds, verification: verified }]]));
