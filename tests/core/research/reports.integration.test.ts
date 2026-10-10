import { expect, it } from 'bun:test';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';
import type { ResearchClaimBody } from '@flowmate/contracts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

async function fixture(alter?: (claim: ResearchClaimBody, bodyPath: string) => ResearchClaimBody,
  options: { partial?: boolean; failReport?: boolean } = {}) {
  const text = ('Official usage cost is metered. ' + 'More public documentation. '.repeat(190)).slice(0, 4000)
    + 'Metered usage is billed by published usage units.';
  let f!: Awaited<ReturnType<typeof researchFixture>>;
  f = await researchFixture(async (_request, index) => {
    if (index === 1) return { tool: 'save_research_plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy }, id: 'plan' };
    if (index === 3) return { tool: 'read_research_local', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null }, id: 'source' };
    const source = index >= 4 ? need(await f.app.listResearchSources({ researchId: f.task.researchId })).items[0]! : null;
    if (index === 4) return { tool: 'query_research_evidence', args: { sourceSnapshotId: source!.sourceSnapshotId, offset: 4000, limit: 600 }, id: 'read-evidence',
      note: 'Coverage gap for cost-1: the initial excerpt omits the billing units. Read the remaining authorized passage within the confirmed scope and budget.' };
    if (index === 5) {
      const planId = need(await f.app.queryResearchTask(f.task.researchId)).currentPlanId!;
      const claim: ResearchClaimBody = { questionId: 'cost-1', text: 'Usage cost is metered.', dependencies: [], evidence: [{ relation: 'supports',
        ref: { researchId: f.task.researchId, planId, revision: 1, runId: source!.runId, toolCallId: source!.toolCallId,
          sourceSnapshotId: source!.sourceSnapshotId, locator: { start: 0, end: 30, quote: text.slice(0, 30) } } },
        { relation: 'supports', ref: { researchId: f.task.researchId, planId, revision: 1, runId: source!.runId, toolCallId: source!.toolCallId,
          sourceSnapshotId: source!.sourceSnapshotId, locator: { start: 4000, end: text.length, quote: text.slice(4000) } } }],
        verification: { status: 'supported', reasons: ['The official passage states the same cost condition; no conflicting evidence was found.'] } };
      return { tool: 'save_research_claim', args: alter ? alter(claim, join(f.paths.root, source!.relativePath)) : claim, id: 'claim' };
    }
    if (index === 6) {
      const task = need(await f.app.queryResearchTask(f.task.researchId));
      const claims = need(await f.app.listResearchClaims({ researchId: task.researchId, planId: task.currentPlanId! })).items;
      const claimIds = claims.map(claim => claim.claimId);
      return { tool: 'save_research_report', args: { answer: 'Usage cost is metered.',
        sections: [{ title: 'Cost', text: 'The saved official source states that usage is metered.', claimIds }], completeness: options.partial ? 'partial' : 'full',
        conflicts: [], limitations: ['This engineering fixture does not establish a real deployment recommendation.'], unresolvedQuestions: options.partial ? ['Version-specific pricing is missing.'] : [],
        coverage: [{ questionId: 'cost-1', claimIds, status: options.partial ? 'gap' : 'covered', reason: options.partial
          ? 'Version-specific pricing is missing.' : 'The planned cost condition has supporting evidence.' }] }, id: 'report' };
    }
    return { text: 'The fixture is finished. Inspect saved facts for its result.' };
  }, options.failReport ? db => db.run("CREATE TRIGGER fail_report BEFORE UPDATE OF current_report_id ON research_tasks WHEN NEW.current_report_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture_report_save'); END") : undefined,
  { material: text });
  const planning = await f.run(f.request(1));
  expect(planning.terminal.result).toMatchObject({ ok: true, data: { status: 'completed', stopped: true } });
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const investigation = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  return { ...f, investigation, text, task: need(await f.app.queryResearchTask(task.researchId)), plan };
}

it('records a coverage gap, reads one bounded supplementary passage and saves its evidence-backed report through the actual SDK', async () => {
  const f = await fixture();
  expect(f.task.currentReportId).not.toBeNull();
  const report = need(await f.app.queryResearchReport({ researchId: f.task.researchId, reportId: f.task.currentReportId! }));
  expect(report.completeness).toBe('full'); expect(report.planId).toBe(f.plan.planId); expect(report.runId).toBe(f.investigation.accepted.runId);
  const claim = need(await f.app.queryResearchClaim({ researchId: f.task.researchId, claimId: report.sections[0]!.claimIds[0]! }));
  expect(claim.verification.status).toBe('supported'); expect(claim.evidence[0]!.ref.locator.quote).toBe(f.text.slice(0, 30));
  expect(JSON.stringify(f.requests[3]!.messages)).not.toContain('Metered usage is billed by published usage units.');
  expect(JSON.stringify(f.requests[4]!.messages)).toContain('Coverage gap for cost-1');
  expect(JSON.stringify(f.requests[4]!.messages)).toContain(f.text.slice(4000, 4600));
  expect(claim.evidence[1]!.ref.locator.quote).toBe(f.text.slice(4000));
  expect(need(await f.app.listRunToolCalls({ runId: report.runId, sessionId: f.session.sessionId })).items
    .filter(call => call.toolName === 'query_research_evidence')).toHaveLength(1);
  expect(need(await f.app.listRunToolCalls({ runId: report.runId, sessionId: f.session.sessionId })).items.map(call => call.toolName))
    .toContain('save_research_report');
  expect(f.task.status).toBe('completed');
  const source = claim.evidence[0]!.ref.sourceSnapshotId;
  const evidence = need(await f.app.queryResearchEvidence({ researchId: f.task.researchId, sourceSnapshotId: source, offset: 4000, limit: 600 }));
  expect(evidence.excerpt.quote).toBe(f.text.slice(4000, 4600));
  const requestsBefore = f.requests.length, query = { researchId: f.task.researchId, reportId: report.reportId };
  const exported = need(await f.app.exportResearchReport(query));
  expect(exported.markdown).toContain('Claim verification'); expect(exported.markdown).toContain(claim.evidence[0]!.ref.locator.quote);
  expect(exported.markdown).toContain(`Run ${claim.evidence[0]!.ref.runId} / ToolCall ${claim.evidence[0]!.ref.toolCallId}`);
  expect(need(await f.app.exportResearchReport(query))).toEqual(exported);
  expect(f.requests.length).toBe(requestsBefore);
  await f.run(f.request(3));
  expect(need(await f.app.queryResearchTask(f.task.researchId)).currentReportId).toBe(report.reportId);
  expect(need(await f.app.exportResearchReport(query))).toEqual(exported);
  expect(await f.app.queryResearchEvidence({ researchId: f.task.researchId + 1, sourceSnapshotId: source })).toMatchObject({ ok: false });
  const savedSource = need(await f.app.queryResearchSource({ researchId: f.task.researchId, sourceSnapshotId: source }));
  writeFileSync(join(f.paths.root, savedSource.relativePath), 'changed body');
  expect(await f.app.exportResearchReport(query)).toMatchObject({ ok: false, error: { code: 'research_source_unavailable' } });
});

it('rejects a fabricated quote and refuses a full report with no supported claim', async () => {
  const f = await fixture(claim => ({ ...claim, evidence: claim.evidence.map(item => ({ ...item,
    ref: { ...item.ref, locator: { ...item.ref.locator, quote: 'X'.repeat(item.ref.locator.end - item.ref.locator.start) } } })) }));
  expect(need(await f.app.listResearchClaims({ researchId: f.task.researchId, planId: f.plan.planId })).items).toEqual([]);
  expect(f.task.currentReportId).toBeNull();
  const calls = need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId })).items;
  expect(calls.find(call => call.toolName === 'save_research_claim')).toMatchObject({ status: 'failed', errorCode: 'research_evidence_mismatch' });
  expect(calls.find(call => call.toolName === 'save_research_report')).toMatchObject({ status: 'failed', errorCode: 'research_evidence_incomplete' });
});

it('preserves an insufficient claim and a partial report independently of a completed Run', async () => {
  const f = await fixture(claim => ({ ...claim, verification: { status: 'insufficient', reasons: ['The version-specific condition remains unsupported.'] } }), { partial: true });
  expect(f.task.status).toBe('partial');
  expect(need(await f.app.queryRun(f.investigation.accepted.runId)).status).toBe('completed');
  const report = need(await f.app.queryResearchReport({ researchId: f.task.researchId, reportId: f.task.currentReportId! }));
  expect(report.completeness).toBe('partial'); expect(report.coverage[0]!.status).toBe('gap');
  expect(report.unresolvedQuestions).toEqual(['Version-specific pricing is missing.']);
});

it('rejects evidence whose saved body changed before the claim is committed', async () => {
  const f = await fixture((claim, path) => { writeFileSync(path, 'Changed body'); return claim; });
  expect(f.task.currentReportId).toBeNull();
  expect(need(await f.app.listResearchClaims({ researchId: f.task.researchId, planId: f.plan.planId })).items).toEqual([]);
  expect(need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId })).items
    .find(call => call.toolName === 'save_research_claim')).toMatchObject({ status: 'failed', errorCode: 'research_source_unavailable' });
});

it('rolls back report insertion on pointer save failure while preserving sources and claims', async () => {
  const f = await fixture(undefined, { failReport: true });
  expect(f.task.currentReportId).toBeNull();
  expect(need(await f.app.listResearchReports({ researchId: f.task.researchId })).items).toEqual([]);
  expect(need(await f.app.listResearchClaims({ researchId: f.task.researchId, planId: f.plan.planId })).items).toHaveLength(1);
  expect(need(await f.app.listResearchSources({ researchId: f.task.researchId })).items).toHaveLength(1);
  expect(need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId })).items
    .find(call => call.toolName === 'save_research_report')).toMatchObject({ status: 'failed', errorCode: 'research_write_failed' });
});
