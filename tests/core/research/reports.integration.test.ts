import { expect, it } from 'bun:test';
import { citedSentence, researchFixture, researchPlan, researchNeed as need, supportedResearchReviewResponse } from '../../support/research.ts';
import type { ResearchClaimBody } from '@flowmate/contracts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { PiProviderAdapter } from '@flowmate/runtime-pi';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ok, type ProviderPort } from '@flowmate/contracts';

function unsupportedReview(text: string, unsupported: string, reason: string) {
  const response = supportedResearchReviewResponse(text);
  if (!response.sentences) throw new Error('Expected a final review request.');
  return { sentences: response.sentences.map(row => row.facts[0]?.text !== unsupported ? row : {
    ...row, facts: row.facts.map(fact => ({ ...fact, citations: [], verdict: 'unsupported', reason })),
    citationReviews: row.citationReviews.map(review => ({ ...review, verdict: 'irrelevant', reason, contributions: [] })),
  }) };
}

async function fixture(alter?: (claim: ResearchClaimBody, bodyPath: string) => ResearchClaimBody,
  options: { partial?: boolean; failReport?: boolean; invalidCitation?: boolean; changeSourceBeforeReport?: boolean;
    review?: (text: string) => object | Promise<object>; maxModelCalls?: number; metricDrift?: boolean;
    changeSourceDuringReview?: boolean; toolTimeoutMs?: number; stopGraceMs?: number; provider?: ProviderPort } = {}) {
  const text = ((options.metricDrift ? '该公司营业收入同比增长 20%。' : 'Official usage cost is metered. ') + 'More public documentation. '.repeat(190)).slice(0, 4000)
    + 'Metered usage is billed by published usage units.';
  let f!: Awaited<ReturnType<typeof researchFixture>>;
  f = await researchFixture(async (_request, index) => {
    if (index === 1) return { tool: 'save_research_plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy,
      execution: { ...researchPlan.execution, stopGraceMs: options.stopGraceMs ?? researchPlan.execution.stopGraceMs, budget: { ...researchPlan.execution.budget,
        toolTimeoutMs: options.toolTimeoutMs ?? 10000, maxModelCalls: options.maxModelCalls ?? 12 } } }, id: 'plan' };
    if (index === 3) return { tool: 'read_research_local', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null }, id: 'source' };
    const source = index >= 4 ? need(await f.app.listResearchSources({ researchId: f.task.researchId })).items[0]! : null;
    if (index === 4) return { tool: 'query_research_evidence', args: { sourceSnapshotId: source!.sourceSnapshotId, offset: 4000, limit: 600 }, id: 'read-evidence',
      note: 'Coverage gap for cost-1: the initial excerpt omits the billing units. Read the remaining authorized passage within the confirmed scope and budget.' };
    if (index === 5) {
      const planId = need(await f.app.queryResearchTask(f.task.researchId)).currentPlanId!;
      const claim: ResearchClaimBody = { questionId: 'cost-1', text: options.metricDrift ? '该公司营业收入同比增长 20%。' : 'Usage cost is metered.', dependencies: [], evidence: [{ relation: 'supports',
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
      if (options.changeSourceBeforeReport) writeFileSync(join(f.paths.root, source!.relativePath), text.replace('Official', 'Modified'));
      return { tool: 'save_research_report', args: { formatVersion: 3, answer: [citedSentence(options.metricDrift ? '该公司净利润同比增长 20%。' : 'Usage cost is metered.', claimIds.length ? claimIds : [1], options.invalidCitation ? 2 : 0),
        citedSentence('Costs depend on published usage units.', claimIds.length ? claimIds : [1], 1)],
        sections: [{ title: 'Cost', sentences: [citedSentence('The saved official source states that usage is metered.', claimIds.length ? claimIds : [1], 1)] }], completeness: options.partial ? 'partial' : 'full',
        conflicts: [], limitations: ['This engineering fixture does not establish a real deployment recommendation.'], unresolvedQuestions: options.partial ? ['Version-specific pricing is missing.'] : [],
        coverage: [{ questionId: 'cost-1', claimIds, status: options.partial ? 'gap' : 'covered', reason: options.partial
          ? 'Version-specific pricing is missing.' : 'The planned cost condition has supporting evidence.' }] }, id: 'report' };
    }
    return { text: 'The fixture is finished. Inspect saved facts for its result.' };
  }, options.failReport ? db => db.run("CREATE TRIGGER fail_report BEFORE UPDATE OF current_report_id ON research_tasks WHEN NEW.current_report_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture_report_save'); END") : undefined,
  { material: text, provider: options.provider, review: async payload => {
    if (options.changeSourceDuringReview) {
      const source = need(await f.app.listResearchSources({ researchId: f.task.researchId })).items[0]!;
      writeFileSync(join(f.paths.root, source.relativePath), text.replace('Official', 'Modified'));
    }
    return options.review ? await options.review(payload) : supportedResearchReviewResponse(payload);
  } });
  const planning = await f.run(f.request(1));
  expect(planning.terminal.result).toMatchObject({ ok: true, data: { status: 'completed', stopped: true } });
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const investigation = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  return { ...f, get app() { return f.app; }, investigation, text, task: need(await f.app.queryResearchTask(task.researchId)), plan };
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
  expect(report.cited?.answer).toHaveLength(2);
  expect(report.semanticReview).toMatchObject({ status: 'verified', sentences: [{ verdict: 'supported' }, { verdict: 'supported' }, { verdict: 'supported' }] });
  expect(f.reviewRequests).toHaveLength(1);
  expect(f.requests).toHaveLength(7);
  const document = need(await f.app.queryResearchReportDocument({ researchId: f.task.researchId, reportId: report.reportId }));
  expect(document.references.map(reference => [reference.number, reference.evidenceIndex])).toEqual([[1, 0], [2, 1]]);
  expect(document.references[1]).toMatchObject({ claimId: claim.claimId, source: {
    sourceSnapshotId: claim.evidence[1]!.ref.sourceSnapshotId, runId: claim.evidence[1]!.ref.runId, toolCallId: claim.evidence[1]!.ref.toolCallId },
    locator: claim.evidence[1]!.ref.locator });
  const source = claim.evidence[0]!.ref.sourceSnapshotId;
  const evidence = need(await f.app.queryResearchEvidence({ researchId: f.task.researchId, sourceSnapshotId: source, offset: 4000, limit: 600 }));
  expect(evidence.excerpt.quote).toBe(f.text.slice(4000, 4600));
  const requestsBefore = f.requests.length, query = { researchId: f.task.researchId, reportId: report.reportId };
  const exported = need(await f.app.exportResearchReport(query));
  const [reportMarkdown, reviewMarkdown] = exported.markdown.split('\n## Semantic review\n');
  expect(reportMarkdown).toContain('[[1]](#reference-1)');
  expect(reportMarkdown!.match(/\[\[2\]\]\(#reference-2\)/g)).toHaveLength(2);
  expect(reviewMarkdown).toContain('**Citation contributions**');
  expect(reviewMarkdown!.match(/\[Reference 2\]\(#reference-2\)/g)).toHaveLength(4);
  expect(exported.markdown).toContain('Claim verification'); expect(exported.markdown).toContain(claim.evidence[0]!.ref.locator.quote);
  expect(exported.markdown).toContain(`Run ${claim.evidence[0]!.ref.runId} / ToolCall ${claim.evidence[0]!.ref.toolCallId}`);
  expect(need(await f.app.exportResearchReport(query))).toEqual(exported);
  expect(f.requests.length).toBe(requestsBefore);
  await f.reopen();
  expect(need(await f.app.queryResearchReportDocument(query))).toEqual(document);
  await f.run(f.request(3));
  expect(need(await f.app.queryResearchTask(f.task.researchId)).currentReportId).toBe(report.reportId);
  expect(need(await f.app.exportResearchReport(query))).toEqual(exported);
  expect(await f.app.queryResearchEvidence({ researchId: f.task.researchId + 1, sourceSnapshotId: source })).toMatchObject({ ok: false });
  const savedSource = need(await f.app.queryResearchSource({ researchId: f.task.researchId, sourceSnapshotId: source }));
  writeFileSync(join(f.paths.root, savedSource.relativePath), 'changed body');
  expect(await f.app.exportResearchReport(query)).toMatchObject({ ok: false, error: { code: 'research_source_unavailable' } });
});

it('rejects semantic drift through the actual reviewer request even when the Claim and exact quote are supported', async () => {
  const f = await fixture(undefined, { metricDrift: true, review: text => {
    expect(text).toContain('该公司营业收入同比增长 20%。');
    expect(text).toContain('该公司净利润同比增长 20%。');
    return unsupportedReview(text, '该公司净利润同比增长 20%。', 'The quotation concerns revenue, not net profit.');
  } });
  expect(f.reviewRequests).toHaveLength(1);
  expect(f.task.currentReportId).toBeNull();
  const call = need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId }))
    .items.find(item => item.toolName === 'save_research_report')!;
  expect(call).toMatchObject({ status: 'failed', errorCode: 'research_semantic_rejected' });
  const evidence = need(await f.app.queryRunToolEvidence({ runId: call.runId, sessionId: call.sessionId, toolCallId: call.toolCallId, limit: 32768 }));
  expect(evidence.nextOffset).toBeNull();
  const saved = JSON.parse(evidence.chunk);
  expect(saved.result.data.semanticReview.status).toBe('rejected');
  expect(saved.result.data.semanticReview.sentences[0]).toMatchObject({ verdict: 'unsupported' });
  expect(saved.result.error.message).toContain('net profit');
});

it('reviews corrected wording in a new save call and binds only its successful decision to the saved report', async () => {
  const sourceText = '该公司营业收入同比增长 20%。', wrongText = '该公司净利润同比增长 20%。';
  let f!: Awaited<ReturnType<typeof researchFixture>>, feedback = '';
  f = await researchFixture(async (request, index) => {
    if (index === 1) return { tool: 'save_research_plan', id: 'plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy } };
    if (index === 3) return { tool: 'read_research_local', id: 'source', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null } };
    const task = need(await f.app.queryResearchTask(f.task.researchId));
    if (index === 4) {
      const source = need(await f.app.listResearchSources({ researchId: task.researchId })).items[0]!;
      return { tool: 'save_research_claim', id: 'claim', args: {
        questionId: 'cost-1', text: sourceText, dependencies: [], evidence: [{ relation: 'supports', ref: {
          researchId: task.researchId, planId: task.currentPlanId!, revision: 1, runId: source.runId,
          toolCallId: source.toolCallId, sourceSnapshotId: source.sourceSnapshotId, locator: { start: 0, end: sourceText.length, quote: sourceText },
        } }], verification: { status: 'supported', reasons: ['The release states the revenue figure.'] },
      } };
    }
    if (index === 5 || index === 6) {
      const claim = need(await f.app.listResearchClaims({ researchId: task.researchId, planId: task.currentPlanId! })).items[0]!;
      if (index === 6) {
        feedback = String(request.messages.filter(message => message.role === 'tool').at(-1)!.content);
        expect(task.currentReportId).toBeNull();
      }
      return { tool: 'save_research_report', id: index === 5 ? 'wrong-report' : 'corrected-report', args: {
        formatVersion: 3, answer: [citedSentence(index === 5 ? wrongText : sourceText, [claim.claimId])], sections: [],
        completeness: 'partial', conflicts: [], limitations: [], unresolvedQuestions: [],
        coverage: [{ questionId: 'cost-1', claimIds: [claim.claimId], status: 'covered', reason: 'Revenue is documented.' }],
      } };
    }
    return { text: 'The corrected report is saved.' };
  }, undefined, { material: sourceText, review: text => unsupportedReview(text, wrongText, 'The release reports revenue, not profit.') });
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const run = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  expect(feedback).toContain('Sentence 1, fact 1: unsupported');
  expect(feedback).toContain('revenue, not profit');
  expect(f.reviewRequests).toHaveLength(2);
  const reports = need(await f.app.listResearchReports({ researchId: task.researchId })).items;
  expect(reports).toHaveLength(1);
  const [saved] = reports, calls = need(await f.app.listRunToolCalls({ runId: run.accepted.runId, sessionId: f.session.sessionId })).items;
  const refused = calls.find(call => call.toolName === 'save_research_report' && call.status === 'failed')!;
  const accepted = calls.find(call => call.toolName === 'save_research_report' && call.status === 'succeeded')!;
  expect(refused.errorCode).toBe('research_semantic_rejected');
  expect(accepted.toolCallId).not.toBe(refused.toolCallId);
  expect(saved).toMatchObject({ answer: sourceText, toolCallId: accepted.toolCallId,
    semanticReview: { status: 'verified', toolCallId: accepted.toolCallId, sentences: [{ text: sourceText }] } });
  await f.reopen();
  expect(need(await f.app.queryResearchReport({ researchId: task.researchId, reportId: saved!.reportId }))).toEqual(saved!);
});

it('keeps a call for the parent response and denies the reviewer before HTTP when the shared budget is exhausted', async () => {
  const f = await fixture(undefined, { maxModelCalls: 4 });
  expect(f.reviewRequests).toHaveLength(0);
  expect(f.task.currentReportId).toBeNull();
  expect(need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId })).items
    .find(item => item.toolName === 'save_research_report')).toMatchObject({ status: 'failed', errorCode: 'agent_model_call_budget' });
});

it('rechecks the saved body at commit after a successful semantic decision', async () => {
  const f = await fixture(undefined, { changeSourceDuringReview: true });
  expect(f.reviewRequests).toHaveLength(1);
  expect(f.task.currentReportId).toBeNull();
  expect(need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId })).items
    .find(item => item.toolName === 'save_research_report')).toMatchObject({ status: 'failed', errorCode: 'research_source_unavailable' });
});

it('does not commit when the reviewer exceeds the confirmed tool deadline', async () => {
  const f = await fixture(undefined, { toolTimeoutMs: 1000, review: async text => {
    await new Promise(resolve => setTimeout(resolve, 1400));
    return supportedResearchReviewResponse(text);
  } });
  expect(f.reviewRequests).toHaveLength(1);
  expect(f.task.currentReportId).toBeNull();
  expect(need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId })).items
    .find(item => item.toolName === 'save_research_report')).toMatchObject({ status: 'failed', errorCode: 'tool_timeout' });
});

it('stops and blocks the root when reviewer termination is unconfirmed', async () => {
  const actual = new PiProviderAdapter({ credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-research-key' });
  const provider: ProviderPort = { close: () => actual.close(), prepare: async (...args) => {
    const prepared = await actual.prepare(...args);
    return prepared.ok ? ok({ ...prepared.data, execute: async (...input) => ({
      ...await prepared.data.execute(...input), stopped: false,
    }) }) : prepared;
  } };
  const f = await fixture(undefined, { provider });
  expect(f.task.currentReportId).toBeNull();
  const run = need(await f.app.queryRun(f.investigation.accepted.runId));
  expect(run).toMatchObject({ status: 'failed', stoppedAt: null, error: { code: 'stop_not_confirmed' } });
  expect(need(await f.app.listRunToolCalls({ runId: run.runId, sessionId: f.session.sessionId })).items
    .find(item => item.toolName === 'save_research_report')).toMatchObject({ stopped: false, errorCode: 'stop_not_confirmed' });
});

it('keeps the root blocked and usage incomplete when review does not settle within stop grace', async () => {
  const actual = new PiProviderAdapter({ credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-research-key' });
  const held = Promise.withResolvers<void>(), returned = Promise.withResolvers<void>();
  let dispatched = false;
  const provider: ProviderPort = { close: () => actual.close(), prepare: async (...args) => {
    const prepared = await actual.prepare(...args);
    return prepared.ok ? ok({ ...prepared.data, execute: async (...input) => {
      const result = await prepared.data.execute(...input);
      dispatched = true;
      await held.promise;
      returned.resolve();
      return result;
    } }) : prepared;
  } };
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(undefined, { toolTimeoutMs: 1000, stopGraceMs: 100, provider });
    expect(dispatched).toBe(true);
    expect(f.task.currentReportId).toBeNull();
    const run = need(await f.app.queryRun(f.investigation.accepted.runId));
    expect(run).toMatchObject({ status: 'failed', stoppedAt: null, error: { code: 'stop_not_confirmed' },
      usage: { source: 'unknown', attemptsComplete: false }, tokens: { usageComplete: false } });
    expect(run.usage.version === 2 && run.usage.calls.some(call => call.usage.reason === 'research-review-stop-unconfirmed')).toBe(true);
    const requestCount = f.requests.length;
    const nextSession = need(await f.app.createSession({ title: 'Unconfirmed reviewer must block fresh execution' }));
    const nextTask = need(await f.app.createResearchTask({ sessionId: nextSession.sessionId, title: 'Another isolated task',
      sourcePolicy: { web: false, domains: [], artifactIds: [], documentIds: [] } }));
    expect(await f.app.submitInput({ ...f.request(1), sessionId: nextSession.sessionId,
      research: { researchId: nextTask.researchId, phase: 'planning', plan: null } })).toMatchObject({
        ok: false, error: { code: 'runtime_unusable' },
      });
    expect(f.requests).toHaveLength(requestCount);
  } finally {
    held.resolve();
    if (dispatched) await returned.promise;
  }
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

it.each([
  [{ invalidCitation: true }, 'research_evidence_incomplete'],
  [{ changeSourceBeforeReport: true }, 'research_source_unavailable'],
] as const)('refuses to save a report with unverifiable references (%o)', async (options, errorCode) => {
  const f = await fixture(undefined, options);
  expect(f.task.currentReportId).toBeNull();
  expect(need(await f.app.listResearchReports({ researchId: f.task.researchId })).items).toEqual([]);
  expect(need(await f.app.listRunToolCalls({ runId: f.investigation.accepted.runId, sessionId: f.session.sessionId })).items
    .find(call => call.toolName === 'save_research_report')).toMatchObject({ status: 'failed', errorCode });
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
