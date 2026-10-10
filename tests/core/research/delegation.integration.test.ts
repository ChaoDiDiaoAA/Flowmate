import { expect, it } from 'bun:test';
import { ok } from '@flowmate/contracts';
import type { ExtensionRef } from '@flowmate/contracts';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';
import { deferCleanup, waitFor } from '../../support/resources.ts';

it('shares the confirmed model budget with the actual research child and retains its source when the budget ends', async () => {
  let refs: ExtensionRef[] = [], planning = 0, parent = 0;
  const bounded = { ...researchPlan, execution: { ...researchPlan.execution, budget: { ...researchPlan.execution.budget, maxModelCalls: 3 } } };
  const f = await researchFixture(request => {
    const system = String(request.messages[0]?.content);
    if (system.includes('research planning agent')) return ++planning === 1 ? { tool: 'save_research_plan', args: { ...bounded, sourcePolicy: f.task.sourcePolicy }, id: 'plan' } : { text: 'Confirm this plan.' };
    if (system.includes('Investigate the assigned research subquestions')) return { tool: 'read_research_local', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null }, id: 'bounded-source' };
    return ++parent === 1 ? { tool: 'Agent', args: { prompt: 'Investigate cost-1 and preserve exact saved evidence.', description: 'Bounded cost investigation', subagent_type: 'research-investigator' }, id: 'bounded-agent' }
      : { text: 'The child exhausted its budget. Cost-1 remains incomplete; its saved source is retained.' };
  }, undefined, { material: 'Cost depends on deployment usage.', resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: refs } }) });
  refs = [need(await f.app.listExtensions()).items.find(item => item.ref.id === 'subagents')!.ref];
  await f.run(f.request(1)); const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const result = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  expect(f.requests).toHaveLength(5); expect(need(await f.app.queryRun(result.accepted.runId)).status).toBe('completed');
  const child = need(await f.app.listSubagents({ parentRunId: result.accepted.runId, parentSessionId: f.session.sessionId })).items[0]!;
  expect(child.status).toBe('failed'); expect(need(await f.app.querySubagent({ parentRunId: result.accepted.runId, parentSessionId: f.session.sessionId, childRunId: child.childRunId })).stopConfirmed).toBe(true);
  expect(need(await f.app.listResearchSources({ researchId: task.researchId })).items).toHaveLength(1);
  expect(need(await f.app.queryResearchTask(task.researchId)).currentReportId).toBeNull();
  expect(need(await f.app.queryResearchTask(task.researchId)).status).toBe('failed');
  expect(need(await f.app.listRunToolCalls({ runId: result.accepted.runId, sessionId: f.session.sessionId })).items.find(call => call.toolName === 'Agent')?.status).toBe('failed');
  expect(need(await f.app.queryRuntimeState()).active).toBeNull();
});

it('delegates a confirmed subquestion through the actual SDK and returns saved source identities to the parent', async () => {
  let refs: ExtensionRef[] = [], planning = 0, parent = 0, child = 0;
  const body = 'Official cost is metered by deployment usage.';
  const f = await researchFixture(request => {
    const system = String(request.messages[0]?.content);
    if (system.startsWith('Investigate the assigned research subquestions')) {
      return ++child === 1 ? { tool: 'read_research_local', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null }, id: 'child-read' }
        : { text: JSON.stringify({ questionId: 'cost-1', findings: ['Metered cost.'], evidence: ['sourceSnapshotId:1'],
          conflicts: [], gaps: ['Version-specific price remains unknown.'], failures: [] }) };
    }
    if (system.includes('research planning agent')) return ++planning === 1
      ? { tool: 'save_research_plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy }, id: 'plan' } : { text: 'Confirm the saved plan.' };
    return ++parent === 1 ? { tool: 'Agent', args: { prompt: 'Investigate cost-1 using the selected local materials. Return source identities, exact excerpts, conflicts and gaps.',
      description: 'Research local deployment cost', subagent_type: 'research-investigator' }, id: 'research-delegate' }
      : { text: 'The child supplied evidence and an explicit version gap.' };
  }, undefined, { material: body, resourceDefaults: () => ok({ revision: 1,
    selection: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: refs } }) });
  const role = need(await f.app.getSubagentDefinition({ id: 'research-investigator' }));
  expect(role.tools).toEqual(['read_research_local', 'query_research_evidence']);
  const catalog = need(await f.app.listResources());
  expect(catalog.items.some(item => item.ref.id === 'research' && item.ref.kind === 'prompt' && item.available)).toBe(true);
  expect(catalog.items.some(item => item.ref.id === 'deep-research' && item.ref.kind === 'skill' && item.available)).toBe(true);
  refs = [need(await f.app.listExtensions()).items.find(item => item.ref.id === 'subagents')!.ref];
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId)), plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const investigation = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  const children = need(await f.app.listSubagents({ parentRunId: investigation.accepted.runId, parentSessionId: f.session.sessionId })).items;
  expect(children).toHaveLength(1); expect(child).toBe(2); expect(parent).toBe(2);
  expect(children[0]!.status).toBe('completed');
  const source = need(await f.app.listResearchSources({ researchId: task.researchId })).items[0]!;
  expect(source.runId).toBe(children[0]!.childRunId); expect(source.runId).not.toBe(investigation.accepted.runId);
  const childRequest = f.requests.find(request => String(request.messages[0]?.content).startsWith('Investigate the assigned research subquestions'))!;
  expect(childRequest.tools!.map(tool => tool.function.name).sort()).toEqual([...role.tools].sort());
  expect(JSON.stringify(childRequest.messages)).toContain(`rootRunId`);
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('Version-specific price remains unknown.');
  expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('sourceSnapshotId');
  expect(need(await f.app.listRunToolCalls({ runId: source.runId, sessionId: children[0]!.childSessionId })).items)
    .toMatchObject([{ toolName: 'read_research_local', status: 'succeeded' }]);
});

for (const stop of ['one', 'all'] as const) it(`owns at most four research children, rejects the fifth and stops ${stop} without replay`, async () => {
  let refs: ExtensionRef[] = [], planning = 0, parent = 0, childrenStarted = 0, release!: () => void;
  const held = new Promise<void>(resolve => release = resolve); deferCleanup(() => release());
  const f = await researchFixture(async request => {
    const system = String(request.messages[0]?.content);
    if (system.startsWith('Investigate the assigned research subquestions')) {
      childrenStarted++; await held;
      return { text: JSON.stringify({ questionId: 'cost-1', findings: [], evidence: [], conflicts: [], gaps: ['Fixture returned no external evidence.'], failures: [] }) };
    }
    if (system.includes('research planning agent')) return ++planning === 1
      ? { tool: 'save_research_plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy }, id: 'plan' } : { text: 'Confirm the plan.' };
    return ++parent === 1 ? { tools: Array.from({ length: 5 }, (_, index) => ({ tool: 'Agent', id: `delegate-${index}`,
      args: { prompt: `Investigate independent cost condition ${index} for cost-1. Return evidence or explicit gaps.`,
        description: `Cost condition ${index}`, subagent_type: 'research-investigator' } })) }
      : { text: 'The completed, cancelled and rejected investigations remain distinct.' };
  }, undefined, { resourceDefaults: () => ok({ revision: 1, selection: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: refs } }) });
  refs = [need(await f.app.listExtensions()).items.find(item => item.ref.id === 'subagents')!.ref];
  await f.run(f.request(1)); const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const started = await f.start(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  const accepted = need(started.accepted);
  try {
    await waitFor(async () => childrenStarted === 4 && need(await f.app.listRunToolCalls({ runId: accepted.runId, sessionId: f.session.sessionId })).items
      .some(call => call.errorCode === 'subagent_busy'));
  } catch {
    const facts = { childrenStarted, calls: need(await f.app.listRunToolCalls({ runId: accepted.runId, sessionId: f.session.sessionId })).items,
      children: need(await f.app.listSubagents({ parentRunId: accepted.runId, parentSessionId: f.session.sessionId })).items };
    release(); await started.completion;
    throw new Error(JSON.stringify(facts));
  }
  const children = need(await f.app.listSubagents({ parentRunId: accepted.runId, parentSessionId: f.session.sessionId })).items;
  expect(children).toHaveLength(4);
  expect((stop === 'one' ? need(await f.app.cancelSubagent({ parentRunId: accepted.runId, childRunId: children[0]!.childRunId }))
    : need(await f.app.cancelRun(accepted.runId))).accepted).toBe(true);
  await waitFor(async () => need(await f.app.querySubagent({ parentRunId: accepted.runId, parentSessionId: f.session.sessionId,
    childRunId: children[0]!.childRunId })).stopConfirmed);
  release(); await started.completion;
  const final = need(await f.app.listSubagents({ parentRunId: accepted.runId, parentSessionId: f.session.sessionId })).items;
  expect(final.filter(child => child.status === 'cancelled')).toHaveLength(stop === 'one' ? 1 : 4);
  expect(final.filter(child => child.status === 'completed')).toHaveLength(stop === 'one' ? 3 : 0);
  expect(childrenStarted).toBe(4); expect(need(await f.app.queryRuntimeState())).toMatchObject({ active: null, blocked: false });
  if (stop === 'one') expect(JSON.stringify(f.requests.at(-1)!.messages)).toContain('subagent_busy');
}, 20_000);
