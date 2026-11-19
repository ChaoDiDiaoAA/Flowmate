import { expect, test } from 'bun:test';
import { ResearchPlanBodySchema } from '@flowmate/contracts';
import { researchPlan } from '../support/research.ts';

const step = { id: 'cost-source', questionIds: ['cost-1'], tool: 'read_research_local', input: { artifactId: 1, documentId: null } };
const plan = { ...researchPlan, sourcePolicy: { ...researchPlan.sourcePolicy, artifactIds: [1] }, steps: [step] };

test('executable research steps bind unique operations to confirmed questions and selected sources', () => {
  expect(ResearchPlanBodySchema.safeParse(plan).success).toBe(true);
  expect(ResearchPlanBodySchema.safeParse({ ...plan, steps: [step, step] }).success).toBe(false);
  expect(ResearchPlanBodySchema.safeParse({ ...plan, steps: [{ ...step, questionIds: ['foreign'] }] }).success).toBe(false);
  expect(ResearchPlanBodySchema.safeParse({ ...plan, steps: [{ ...step, input: { artifactId: 2, documentId: null } }] }).success).toBe(false);
  expect(ResearchPlanBodySchema.safeParse({ ...plan, steps: [{ ...step, input: { artifactId: 1, documentId: 2 } }] }).success).toBe(false);
  expect(ResearchPlanBodySchema.safeParse(researchPlan).success).toBe(true);
});

test('web acquisitions require authorization and a public URL or a bounded search', () => {
  const search = { id: 'cost-web', questionIds: ['cost-1'], tool: 'search_research_web', input: { query: 'Agent hosting cost' } };
  const extract = { id: 'cost-page', questionIds: ['cost-1'], tool: 'read_research_web', input: { url: 'https://example.org/pricing' } };
  const online = { ...plan, sourcePolicy: { ...plan.sourcePolicy, web: true }, steps: [step, search, extract] };
  expect(ResearchPlanBodySchema.safeParse(online).success).toBe(true);
  expect(ResearchPlanBodySchema.safeParse({ ...online, sourcePolicy: plan.sourcePolicy }).success).toBe(false);
  expect(ResearchPlanBodySchema.safeParse({ ...online, steps: [{ ...search, input: { ...search.input, rank: 6 } }] }).success).toBe(false);
  for (const url of ['file:///pricing', 'http://127.1/pricing', 'http://localhost/pricing', 'https://user:pass@example.org/pricing']) {
    expect(ResearchPlanBodySchema.safeParse({ ...online, steps: [{ ...extract, input: { url } }] }).success).toBe(false);
  }
});
