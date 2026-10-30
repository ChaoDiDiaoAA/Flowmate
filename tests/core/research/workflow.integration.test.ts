import { expect, it } from 'bun:test';
import { ToolExecutionFailure, appError } from '@flowmate/contracts';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';

it('tracks real step receipts, retains a failed source write and reuses only successful acquisition on continue', async () => {
  let failed = true;
  const f = await researchFixture((_request, index) => {
    const input = { artifactId: f.task.sourcePolicy.artifactIds[0]!, documentId: null };
    if (index === 1) return { tool: 'save_research_plan', id: 'plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy,
      steps: [{ id: 'local', questionIds: ['cost-1'], tool: 'read_research_local', input },
        { id: 'parsed', questionIds: ['cost-1'], tool: 'read_research_local', input: { artifactId: null, documentId: f.task.sourcePolicy.documentIds[0]! } }] } };
    if (index === 3 || index === 5) return { tools: [
      { tool: 'read_research_local', id: `local-${index}`, args: { ...input, stepId: 'local' } },
      { tool: 'read_research_local', id: `parsed-${index}`, args: { artifactId: null, documentId: f.task.sourcePolicy.documentIds[0]!, stepId: 'parsed' } },
    ] };
    return { text: 'Keep the confirmed evidence and report the unresolved failures.' };
  }, undefined, { material: 'Original local evidence.', parsedDocument: 'Original parsed evidence.',
    toolDefinitions: definitions => definitions.map(definition => definition.name !== 'read_research_local' ? definition : {
      ...definition, async execute(input, call, context) {
        const result = await definition.execute(input, call, context);
        if (input.stepId === 'parsed' && failed) {
          failed = false;
          throw new ToolExecutionFailure(appError('source_receipt_failed', 'tool', 'Controlled failure after saving the source.'));
        }
        return result;
      },
    }) });
  await f.run(f.request(1));
  const saved = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: saved.researchId, planId: saved.currentPlanId! }));
  const intent = { researchId: saved.researchId, phase: 'researching' as const, plan: { planId: plan.planId, revision: plan.revision } };
  await f.run(f.request(2, intent));
  const first = need(await f.app.queryResearchTask(saved.researchId));
  expect(first.workflow?.steps.map(step => [step.id, step.status])).toEqual([['local', 'succeeded'], ['parsed', 'failed']]);
  expect(need(await f.app.listResearchSources({ researchId: saved.researchId })).items).toHaveLength(2);
  expect(JSON.stringify(f.requests[3])).toContain('source_receipt_failed');
  const requests = f.requests.length;
  await f.reopen();
  expect(need(await f.app.queryResearchTask(saved.researchId)).workflow).toEqual(first.workflow);
  expect(f.requests).toHaveLength(requests);
  const resumed = await f.run(f.request(3, { ...intent, continuation: true }));
  expect(need(await f.app.listRunToolCalls({ runId: resumed.accepted.runId, sessionId: f.session.sessionId })).items)
    .toMatchObject([{ toolName: 'read_research_local', status: 'succeeded', errorCode: null }, { toolName: 'read_research_local', status: 'succeeded', errorCode: null }]);
  const continued = need(await f.app.queryResearchTask(saved.researchId));
  expect(continued.workflow?.steps.map(step => step.status)).toEqual(['succeeded', 'succeeded']);
  expect(need(await f.app.listResearchSources({ researchId: saved.researchId })).items).toHaveLength(3);
  expect(continued.workflow?.steps[0]!.sourceSnapshotId).toBe(first.workflow?.steps[0]!.sourceSnapshotId);
});

it('rejects duplicate in-flight and unknown steps without publishing duplicate sources', async () => {
  const f = await researchFixture((_request, index) => {
    const input = { artifactId: f.task.sourcePolicy.artifactIds[0]!, documentId: null };
    if (index === 1) return { tool: 'save_research_plan', id: 'plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy,
      steps: [{ id: 'local', questionIds: ['cost-1'], tool: 'read_research_local', input }] } };
    if (index === 3) return { tools: ['local', 'local', 'foreign'].map((stepId, i) => ({ tool: 'read_research_local', id: `duplicate-${i}`, args: { ...input, stepId } })) };
    return { text: 'Keep the single confirmed source.' };
  }, undefined, { material: 'One source for the confirmed question.' });
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const run = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  const calls = need(await f.app.listRunToolCalls({ runId: run.accepted.runId, sessionId: f.session.sessionId })).items;
  expect(calls.map(call => call.errorCode).filter(Boolean).sort()).toEqual(['research_step_invalid', 'research_step_running']);
  expect(need(await f.app.listResearchSources({ researchId: task.researchId })).items).toHaveLength(1);
  expect(need(await f.app.queryResearchTask(task.researchId)).workflow?.steps[0]!.status).toBe('succeeded');
});

it('gates claims and full reports on acquisition while preserving an explicit partial checkpoint', async () => {
  const partial = { answer: 'Acquisition is unfinished.', sections: [{ title: 'Gap', text: 'The planned source is pending.', claimIds: [] }],
    completeness: 'partial', conflicts: [], limitations: ['The planned source is pending.'], unresolvedQuestions: ['What costs apply?'],
    coverage: [{ questionId: 'cost-1', claimIds: [], status: 'gap', reason: 'The source is pending.' }] };
  const f = await researchFixture((_request, index) => {
    if (index === 1) return { tool: 'save_research_plan', id: 'plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy,
      steps: [{ id: 'local', questionIds: ['cost-1'], tool: 'read_research_local', input: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null } }] } };
    if (index === 3) return { tool: 'save_research_claim', id: 'early-claim', args: { questionId: 'cost-1', text: 'Unverified cost.', dependencies: [], evidence: [],
      verification: { status: 'insufficient', reasons: ['Source pending.'] } } };
    if (index === 4) return { tool: 'save_research_report', id: 'early-full', args: { ...partial, completeness: 'full' } };
    if (index === 5) return { tool: 'save_research_report', id: 'partial', args: partial };
    return { text: 'The partial checkpoint preserves the gap.' };
  }, undefined, { material: 'Unacquired evidence.' });
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const run = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  expect(need(await f.app.listRunToolCalls({ runId: run.accepted.runId, sessionId: f.session.sessionId })).items)
    .toMatchObject([{ toolName: 'save_research_report', status: 'succeeded' },
      { toolName: 'save_research_report', status: 'failed', errorCode: 'research_acquisition_incomplete' },
      { toolName: 'save_research_claim', status: 'failed', errorCode: 'research_acquisition_incomplete' }]);
  const current = need(await f.app.queryResearchTask(task.researchId));
  expect(current.status).toBe('partial');
  expect(current.workflow?.steps[0]!.status).toBe('pending');
  expect(need(await f.app.listResearchClaims({ researchId: task.researchId, planId: plan.planId })).items).toEqual([]);
});
