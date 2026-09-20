import { describe, expect, it } from 'vitest';
import { buildP0FReport } from '../../packages/contracts/src/index.ts';

describe('P0 F evidence contract', () => {
  it('does not let missing status or N/A rows appear as a pass', () => {
    const binding = { codeCommit: 'local', dirtyDiffSha256: null, lockSha256: '0'.repeat(64), configSha256: '1'.repeat(64), policySha256: '2'.repeat(64), inputManifestSha256: '3'.repeat(64), productSpecSha256: '4'.repeat(64), evalSpecSha256: '5'.repeat(64), caseSetSha256: '6'.repeat(64), oracleSha256: '7'.repeat(64), mapperVersion: 'p0', migrationChecksums: [], os: 'test', architecture: 'x64', bunVersion: '1.4.0', nodeVersion: '24', instanceId: 'i_test', workspaceId: 'w_test', processInstanceIds: ['p_test'], purpose: 'development' as const };
    const report = buildP0FReport({ executionId: 'e_test', phase: 'P0', evidenceKind: 'F', scope: 'product', executionEligibility: 'ready', blockers: [], window: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }, files: [], checks: [
      { checkId: 'F-01', caseVariantId: 'normal', capabilityIds: ['P0-C05'], metricIds: [], required: true, applicable: true, reason: 'missing', evidencePaths: [] },
      { checkId: 'F-02', caseVariantId: 'na', capabilityIds: ['P0-C05'], metricIds: [], required: false, applicable: false, status: 'PASS', reason: 'wrong', evidencePaths: [] },
    ], caseCounts: { planned: 2, applicable: 1, executed: 0, confirmedPass: 0 }, binding });
    expect(report.executionEligibility).toBe('blocked');
    expect(report.counts.pass).toBe(0);
    expect(report.counts.notRun).toBe(1);
    expect(report.blockers.length).toBe(2);
  });
});
