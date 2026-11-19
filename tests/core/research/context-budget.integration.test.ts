import { expect, test } from 'bun:test';
import { researchFixture, researchNeed as need, researchPlan, citedSentence, supportedResearchReviewResponse } from '../../support/research.ts';

async function investigate(maxModelCalls: number, failScan = false) {
  const text = 'Revenue rose 20%. ' + 'Saved full context. '.repeat(32000);
  let f!: Awaited<ReturnType<typeof researchFixture>>;
  f = await researchFixture(async (_, index) => {
    if (index === 1) return { tool: 'save_research_plan', id: 'plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy,
      execution: { ...researchPlan.execution, timeoutMs: 300000, budget: { ...researchPlan.execution.budget, maxModelCalls, toolTimeoutMs: 60000 } } } };
    if (index === 3) return { tool: 'read_research_local', id: 'read', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null } };
    const task = need(await f.app.queryResearchTask(f.task.researchId));
    if (index === 4) {
      const source = need(await f.app.listResearchSources({ researchId: task.researchId })).items[0]!;
      return { tool: 'save_research_claim', id: 'claim', args: { questionId: 'cost-1', text: 'Revenue rose 20%.', dependencies: [],
        verification: { status: 'supported', reasons: ['Synthetic source states this.'] }, evidence: [{ relation: 'supports', ref: {
          researchId: task.researchId, planId: task.currentPlanId!, revision: 1, runId: source.runId, toolCallId: source.toolCallId,
          sourceSnapshotId: source.sourceSnapshotId, locator: { start: 0, end: 17, quote: text.slice(0, 17) },
        } }] } };
    }
    if (index === 5) {
      const claim = need(await f.app.listResearchClaims({ researchId: task.researchId, planId: task.currentPlanId! })).items[0]!;
      return { tool: 'save_research_report', id: 'report', args: { formatVersion: 3,
        answer: [citedSentence('Revenue rose 20%.', [claim.claimId])], sections: [], completeness: 'partial',
        conflicts: [], limitations: [], unresolvedQuestions: [],
        coverage: [{ questionId: 'cost-1', claimIds: [], status: 'gap', reason: 'Only revenue was investigated.' }] } };
    }
    return { text: 'Inspect the saved result.' };
  }, undefined, { material: text, review: payload => {
    const input = JSON.parse(payload.trimStart().startsWith('{') ? payload : payload.slice(payload.indexOf('\n\n') + 2));
    if (input.segment) return { sourceSnapshotId: input.segment.sourceSnapshotId, start: input.segment.start,
      end: input.segment.end, complete: !failScan, findings: [] };
    return supportedResearchReviewResponse(payload);
  } });
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: task.currentPlanId!, revision: 1 } }));
  return { f, task: need(await f.app.queryResearchTask(task.researchId)) };
}

test('counts full-context stages against the real shared model budget and saves their receipt together', async () => {
  const { f, task } = await investigate(12);
  expect(task.currentReportId).not.toBeNull();
  const report = need(await f.app.queryResearchReport({ researchId: task.researchId, reportId: task.currentReportId! }));
  expect(report.semanticReview?.context?.mode).toBe('segmented');
  expect(report.semanticReview?.stages?.length).toBeGreaterThan(2);
  expect(f.reviewRequests.length).toBe(report.semanticReview!.stages!.length);
  if (report.semanticReview?.status !== 'verified') throw new Error('Expected a saved verified review.');
  expect(report.semanticReview.usage.attempts).toBe(f.reviewRequests.length);
});

test('denies the first scan before HTTP when the complete review and final response cannot fit the shared budget', async () => {
  const { f, task } = await investigate(5);
  expect(task.currentReportId).toBeNull();
  expect(f.reviewRequests).toHaveLength(0);
});

test('does not save or request the final review after an incomplete context scan', async () => {
  const { f, task } = await investigate(12, true);
  expect(task.currentReportId).toBeNull();
  expect(f.reviewRequests).toHaveLength(1);
});
