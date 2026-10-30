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
