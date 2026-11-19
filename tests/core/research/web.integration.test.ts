import { expect, it } from 'bun:test';
import { acquireTavilyPage } from '../../../packages/core/src/research/tavily.ts';
import { citedSentence, researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';

const webUrl = 'https://example.org/policy';
const pricingUrl = 'https://example.org/pricing';
const query = 'current deployment pricing';
const webSteps = [
  { id: 'search', tool: 'search_research_web', questionIds: ['cost-1'], input: { query, timeRange: 'week', rank: 2 } },
  { id: 'extract', tool: 'read_research_web', questionIds: ['cost-1'], input: { url: webUrl } },
];

it('executes only confirmed web steps, publishes evidence and retries a failed extraction on Continue', async () => {
  const outgoing: { path: string; body: { max_age_hours?: number; urls?: string[] } }[] = [];
  let localArgs: { artifactId: number; documentId: null; stepId: string };
  let planId: number, revision: number;
  const f = await researchFixture(async (request, index) => {
    const names = request.tools?.map(tool => tool.function.name);
    if (index <= 2) expect(names).not.toContain('search_research_web');
    else expect(names).toEqual(expect.arrayContaining(['search_research_web', 'read_research_web']));
    if (index === 1) return { tool: 'save_research_plan', id: 'plan', args: { ...researchPlan,
      sourcePolicy: f.task.sourcePolicy, steps: [
        { id: 'local', tool: 'read_research_local', questionIds: ['cost-1'], input: { artifactId: localArgs.artifactId, documentId: null } },
        ...webSteps,
      ] } };
    if (index === 3) return { tools: [
      { tool: 'read_research_local', id: 'local', args: localArgs },
      { tool: 'read_research_web', id: 'mismatch', args: { stepId: 'search' } },
      { tool: 'search_research_web', id: 'search', args: { stepId: 'search' } },
      { tool: 'read_research_web', id: 'extract', args: { stepId: 'extract' } },
    ] };
    if (index === 4) {
      const sources = need(await f.app.listResearchSources({ researchId: f.task.researchId })).items;
      const evidence = await Promise.all(sources.map(async source => {
        const { excerpt: locator } = need(await f.app.queryResearchEvidence({ researchId: f.task.researchId, sourceSnapshotId: source.sourceSnapshotId }));
        return { relation: 'supports', ref: { researchId: f.task.researchId, planId, revision, runId: source.runId,
          toolCallId: source.toolCallId, sourceSnapshotId: source.sourceSnapshotId, locator } };
      }));
      expect(evidence).toHaveLength(2);
      return { tool: 'save_research_claim', id: 'claim', args: { questionId: 'cost-1', text: 'Deployment costs are public.',
        dependencies: [], evidence, verification: { status: 'supported', reasons: ['Both sources agree.'] } } };
    }
    if (index === 5) {
      const claim = need(await f.app.listResearchClaims({ researchId: f.task.researchId, planId })).items[0]!;
      return { tool: 'save_research_report', id: 'report', args: { formatVersion: 3, answer: [{
        text: 'Deployment costs are public.', citations: [{ claimId: claim.claimId, evidenceIndex: 0 }, { claimId: claim.claimId, evidenceIndex: 1 }],
      }],
        sections: [{ title: 'Cost', sentences: [citedSentence(claim.text, [claim.claimId], 1)] }], completeness: 'partial', conflicts: [],
        limitations: ['The specified page was unavailable.'], unresolvedQuestions: ['Confirm the page independently.'],
        coverage: [{ questionId: 'cost-1', status: 'covered', claimIds: [claim.claimId], reason: 'Two sources agree.' }] } };
    }
    if (index === 7) return { tools: [
      { tool: 'search_research_web', id: 'search-again', args: { stepId: 'search' } },
      { tool: 'read_research_web', id: 'extract-again', args: { stepId: 'extract' } },
    ] };
    return { text: 'Saved the available evidence.' };
  }, undefined, { material: 'Team policy lists the costs.', web: true, researchWeb: {
    apiKey: 'synthetic-tavily-key', fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      outgoing.push({ path, body });
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-tavily-key');
      if (path === '/search') return Response.json({ results: body.max_age_hours === 0 ? [] : [
        { url: 'https://example.org/other', title: 'Other' },
        { url: pricingUrl, title: 'Pricing', published_date: '2026-11-17' },
      ], request_id: 'search-test', usage: { credits: 1 } });
      if (body.urls?.[0] === pricingUrl)
        return Response.json({ results: [{ url: pricingUrl, raw_content: 'Official web pricing.' }], failed_results: [] });
      if (outgoing.filter(item => item.body.urls?.[0] === webUrl).length === 1)
        return Response.json({ results: [], failed_results: [{ url: webUrl, error: 'unavailable' }] });
      return Response.json({ results: [{ url: webUrl, raw_content: 'Published deployment policy.' }], failed_results: [] });
    },
  } });
  localArgs = { artifactId: f.task.sourcePolicy.artifactIds[0]!, documentId: null, stepId: 'local' };
  await f.run(f.request(1));
  expect(outgoing).toEqual([]);
  const plan = need(await f.app.queryResearchPlan({ researchId: f.task.researchId,
    planId: need(await f.app.queryResearchTask(f.task.researchId)).currentPlanId! }));
  ({ planId, revision } = plan);
  const intent = { researchId: f.task.researchId, phase: 'researching' as const, plan: { planId, revision } };
  const first = await f.run(f.request(2, intent));
  const calls = need(await f.app.listRunToolCalls({ runId: first.accepted.runId, sessionId: f.session.sessionId })).items;
  expect(calls.map(call => call.errorCode)).toContain('research_step_invalid');
  expect(outgoing).toHaveLength(4);
  const searches = outgoing.filter(item => item.path === '/search');
  expect(searches[0]?.body).toMatchObject({ query, time_range: 'week', max_age_hours: 0, max_results: 5, include_raw_content: 'text' });
  expect(searches[1]?.body).toMatchObject({ query, time_range: 'week', max_results: 5, include_raw_content: false });
  expect(searches[1]?.body).not.toHaveProperty('max_age_hours');
  expect(outgoing).toContainEqual({ path: '/extract', body: expect.objectContaining({ urls: [pricingUrl] }) });
  expect(outgoing).toContainEqual({ path: '/extract', body: expect.objectContaining({ urls: [webUrl] }) });
  const partial = need(await f.app.queryResearchTask(f.task.researchId));
  expect(partial.status).toBe('partial');
  expect(partial.workflow?.steps.map(step => step.status)).toEqual(['succeeded', 'succeeded', 'failed']);
  const reportRequest = { researchId: partial.researchId, reportId: partial.currentReportId! };
  const document = need(await f.app.queryResearchReportDocument(reportRequest));
  expect(document.references[0]).toMatchObject({ source: { address: pricingUrl } });
  expect(document.references[1]).toMatchObject({ source: { artifactId: localArgs.artifactId } });
  expect(document.references[0]!.source.toolCallId).not.toBe(document.references[1]!.source.toolCallId);
  const exported = need(await f.app.exportResearchReport(reportRequest));
  for (const value of ['https://example.org/pricing', 'Official web pricing.', 'Team policy lists the costs.', '2026-11-17'])
    expect(exported.markdown).toContain(value);
  await f.reopen();
  await f.run(f.request(3, { ...intent, continuation: true }));
  expect(outgoing).toHaveLength(5);
  const continued = need(await f.app.queryResearchTask(f.task.researchId));
  expect(continued.workflow?.steps.map(step => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(continued.workflow?.steps[1]?.sourceSnapshotId).toBe(partial.workflow?.steps[1]?.sourceSnapshotId);
  const requestCount = f.requests.length, webCount = outgoing.length;
  const localOnly = need(await f.app.updateResearchWebAccess({ researchId: f.task.researchId, web: false, expectedWeb: true }));
  expect(localOnly).toMatchObject({ researchId: f.task.researchId, sessionId: f.session.sessionId,
    sourcePolicy: { ...f.task.sourcePolicy, web: false }, currentPlanId: null, currentRunId: null, currentReportId: partial.currentReportId });
  expect(f.requests).toHaveLength(requestCount);
  expect(outgoing).toHaveLength(webCount);
  expect(need(await f.app.queryResearchReportDocument(reportRequest))).toEqual(document);
  expect(need(await f.app.exportResearchReport(reportRequest))).toEqual(exported);
  expect(need(await f.app.queryResearchEvidence({ researchId: f.task.researchId,
    sourceSnapshotId: document.references[0]!.source.sourceSnapshotId })).excerpt.quote).toBe('Official web pricing.');
  expect(await f.app.submitInput(f.request(4, { ...intent, continuation: true }))).toMatchObject({ ok: false, error: { code: 'research_plan_stale' } });
  expect(outgoing).toHaveLength(webCount);
});

it.each([true, false])('uses the live ranked result and extracts only if its body is missing (%s)', async withBody => {
  const requests: Array<{ endpoint: string; body: object }> = [];
  const page = await acquireTavilyPage({ apiKey: 'synthetic-tavily-key', fetch: async (url, init) => {
    const endpoint = new URL(url).pathname;
    requests.push({ endpoint, body: JSON.parse(String(init.body)) });
    if (endpoint === '/search') return Response.json({ results: [
      { url: webUrl, raw_content: 'Unselected result.' },
      { url: pricingUrl, title: 'Pricing', raw_content: withBody ? 'Official web pricing.' : null, published_date: '2026-11-17' },
    ], request_id: 'live-listing', usage: { credits: 1 } });
    return Response.json({ results: [{ url: pricingUrl, raw_content: 'Official web pricing.' }], request_id: 'extract-page', usage: { credits: 0 } });
  } }, { id: 'search', tool: 'search_research_web', questionIds: ['cost-1'], input: { query, rank: 2 } },
  { nativeToolCallId: 'search', signal: new AbortController().signal });
  expect(requests.map(request => request.endpoint)).toEqual(withBody ? ['/search'] : ['/search', '/extract']);
  if (!withBody) expect(requests[1]?.body).toMatchObject({ urls: [pricingUrl] });
  expect(page).toMatchObject({ address: pricingUrl, text: 'Official web pricing.', title: 'Pricing',
    publishedAt: '2026-11-17T00:00:00.000Z', usage: { requestId: withBody ? 'live-listing' : 'extract-page', credits: 1 } });
});

it('cancels active Tavily requests and never sends the queued acquisition', async () => {
  let requests = 0, aborted = 0, ready!: () => void;
  const active = new Promise<void>(resolve => { ready = resolve; });
  const steps = ['one', 'two', 'three'].map(id => ({ id, tool: 'search_research_web', questionIds: ['cost-1'], input: { query: id } }));
  const f = await researchFixture((_request, index) => index === 1 ? { tool: 'save_research_plan', id: 'plan',
    args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy, steps } } : index === 3 ? {
    tools: steps.map(({ id }) => ({ id, tool: 'search_research_web', args: { stepId: id } })),
  } : { text: 'Done.' }, undefined, { web: true, researchWeb: {
    apiKey: 'synthetic-tavily-key', fetch: async (_url: string, init: RequestInit) => {
      if (++requests === 2) ready();
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => {
        aborted++;
        reject(init.signal!.reason);
      }, { once: true }));
    },
  } });
  await f.run(f.request(1));
  const task = need(await f.app.queryResearchTask(f.task.researchId));
  const plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const started = await f.start(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  await active;
  expect(need(await f.app.cancelRun(need(started.accepted).runId)).accepted).toBe(true);
  await started.completion;
  expect(requests).toBe(2);
  expect(aborted).toBe(2);
  expect(need(await f.app.listResearchSources({ researchId: task.researchId })).items).toEqual([]);
});

it('denies plan escalation even when a key is configured', async () => {
  const f = await researchFixture((request, index) => {
    expect(request.tools?.map(tool => tool.function.name)).not.toContain('search_research_web');
    return index === 1 ? { tool: 'save_research_plan', id: 'escalation', args: { ...researchPlan,
      sourcePolicy: { ...researchPlan.sourcePolicy, web: true }, steps: webSteps } } : { text: 'Permission was denied.' };
  }, undefined, { researchWeb: { apiKey: 'synthetic-tavily-key', fetch: async () => { throw new Error('Unexpected Tavily request'); } } });
  const result = await f.run(f.request(1));
  const calls = need(await f.app.listRunToolCalls({ runId: result.accepted.runId, sessionId: f.session.sessionId })).items;
  expect(calls.map(call => call.errorCode)).toContain('research_source_denied');
});
