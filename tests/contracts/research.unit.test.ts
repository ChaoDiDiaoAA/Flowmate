import { describe, expect, it } from 'bun:test';
import * as contracts from '@flowmate/contracts';

const plan = {
  question: 'Compare three Agent deployment options.', scope: 'Public documentation and selected local constraints.',
  dimensions: [{ id: 'cost', title: 'Cost', questions: [{ id: 'cost-1', question: 'What costs apply?', evidenceNeeded: ['Official pricing'] }] }],
  sourcePolicy: { web: false, domains: [], artifactIds: [], documentIds: [] },
  stopConditions: ['Each dimension has evidence or an explicit gap.'],
  execution: { budget: { maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 },
};

describe('Deep Research contracts', () => {
  it('accepts bounded problem-driven plans and rejects ambiguous subquestion identities', () => {
    expect(contracts.ResearchPlanBodySchema?.safeParse(plan).success).toBe(true);
    expect(contracts.ResearchPlanBodySchema.safeParse({ ...plan, dimensions: [plan.dimensions[0], plan.dimensions[0]] }).success).toBe(false);
    expect(contracts.ResearchPlanBodySchema.safeParse({ ...plan, execution: { ...plan.execution, budget: { maxToolCalls: 1000000 } } }).success).toBe(false);
    expect(contracts.ResearchPlanBodySchema.safeParse({ ...plan, sourcePolicy: { ...plan.sourcePolicy, apiKey: 'secret' } }).success).toBe(false);
  });

  it('rejects online acquisition in every public research policy', () => {
    expect(contracts.ResearchSourcePolicySchema.safeParse({ ...plan.sourcePolicy, web: true }).success).toBe(false);
    expect(contracts.ResearchSourcePolicySchema.safeParse({ ...plan.sourcePolicy, domains: ['example.com'] }).success).toBe(false);
    expect(contracts.ResearchPlanBodySchema.safeParse({ ...plan, sourcePolicy: { ...plan.sourcePolicy, web: true } }).success).toBe(false);
    expect(contracts.RESEARCH_INVESTIGATION_TOOL_NAMES).not.toContain('search_research_sources');
    expect(contracts.RESEARCH_INVESTIGATION_TOOL_NAMES).not.toContain('read_research_web');
  });

  it('requires nonempty, bounded evidence locators and complete actual execution identities', () => {
    const ref = { researchId: 1, planId: 2, revision: 1, runId: 3, toolCallId: 4, sourceSnapshotId: 5,
      locator: { start: 0, end: 4, quote: 'Cost' } };
    expect(contracts.EvidenceRefSchema?.safeParse(ref).success).toBe(true);
    expect(contracts.EvidenceRefSchema.safeParse({ ...ref, toolCallId: undefined }).success).toBe(false);
    expect(contracts.EvidenceRefSchema.safeParse({ ...ref, locator: { start: 4, end: 0, quote: 'Cost' } }).success).toBe(false);
    expect(contracts.EvidenceRefSchema.safeParse({ ...ref, locator: { start: 0, end: 0, quote: '' } }).success).toBe(false);
  });

  it('accepts explicit planning or exact-version confirmation without granting invoice context', () => {
    const config = { version: 1, name: 'Research fixture', revision: 1,
      modelRef: { provider: 'fixture', model: 'fixture' }, native: { authPath: 'D:/research-unused-auth.json', modelsPath: null },
      connection: { baseUrl: 'http://127.0.0.1:1234/v1', api: 'openai-completions', contextWindow: 64000, maxTokens: 4096 },
      parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    const request = { sessionId: 1, clientSequence: 1, mode: 'prompt', text: 'Plan this research.', config,
      research: { researchId: 1, phase: 'planning', plan: null } };
    expect(contracts.normalizeSessionInputRequest(request)).toMatchObject({ ok: true, data: { goalMode: 'answer', research: request.research } });
    expect(contracts.normalizeAgentRunRequest({ ...request, clientSequence: undefined, mode: undefined })).toMatchObject({ ok: false });
    const { clientSequence: _sequence, mode: _mode, ...run } = request;
    expect(contracts.normalizeAgentRunRequest(run)).toMatchObject({ ok: true, data: { research: request.research } });
    expect(contracts.normalizeSessionInputRequest({ ...request, research: { researchId: 1, phase: 'researching', plan: null } })).toMatchObject({ ok: false });
    expect(contracts.normalizeSessionInputRequest({ ...request, workspace: { revision: 0, sessionId: 1, documentRef: null, jobId: null, candidateRef: null } })).toMatchObject({ ok: false });
    expect(contracts.normalizeSessionInputRequest({ ...request, goalMode: 'save-candidate' })).toMatchObject({ ok: false });
  });

  it('requires an explicit bounded execution budget in a confirmable plan', () => {
    expect(contracts.ResearchPlanBodySchema.safeParse({ ...plan, execution: {} }).success).toBe(false);
    expect(contracts.ResearchPlanBodySchema.safeParse({ ...plan, execution: { ...plan.execution, budget: { maxModelCalls: 12 } } }).success).toBe(false);
  });
});

export { plan };
