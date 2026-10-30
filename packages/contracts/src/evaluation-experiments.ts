import { z } from 'zod';
import { EvaluationConnectionSchema } from './evaluation.ts';
import { RuntimeStrategyPolicySchema } from './ports.ts';
import { ResourceSelectionSchema } from './resources.ts';
import { EvaluationBudgetProfilesSchema } from './evaluation-budget.ts';
import type { ExperimentMetricDelta,ExperimentAssertion,BaselineReference,GateThresholds } from './evaluation-baseline.ts';
export { experimentMetricDeltaSchema,experimentAssertionSchema,baselineReferenceSchema,gateThresholdsSchema } from './evaluation-baseline.ts';
export type { ExperimentMetricDelta,ExperimentAssertion,BaselineReference,GateThresholds } from './evaluation-baseline.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const experimentAxisSchema = z.enum(['model', 'prompt', 'strategy', 'code']);
export type ExperimentAxis = z.infer<typeof experimentAxisSchema>;
export const experimentArmSchema = z.object({ id, model: EvaluationConnectionSchema.extend({
  reasoning: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional() }).optional(),
  systemPrompt: z.string().min(1).optional(), strategy: RuntimeStrategyPolicySchema.optional(),
  resources: ResourceSelectionSchema.optional(), codeRef: z.string().min(1).max(256).refine(s => !s.startsWith('-')).optional(),
}).strict();
export const experimentPlanSchema = z.object({ id: id.optional(), benchmark: z.object({ id,
  revision: z.number().int().positive(), selection: z.enum(['smoke', 'full']) }).strict(),
  repeats: z.number().int().min(1).max(20).default(1), environment: id.default('development'),
  axes: z.array(experimentAxisSchema).min(1).max(4), control: experimentArmSchema,
  candidates: z.array(experimentArmSchema).min(1).max(10),
  evaluationBudgets: EvaluationBudgetProfilesSchema.optional(),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.axes).size !== plan.axes.length) ctx.addIssue({ code: 'custom', message: 'Duplicate experiment axes' });
  const arms = [plan.control, ...plan.candidates];
  if (new Set(arms.map(a => a.id)).size !== arms.length) ctx.addIssue({ code: 'custom', message: 'Duplicate arm identities' });
  for (const candidate of plan.candidates) for (const [axis, fields] of Object.entries({ model: ['model'], prompt: ['systemPrompt'],
    strategy: ['strategy', 'resources'], code: ['codeRef'] })) {
    if (!plan.axes.includes(axis as ExperimentAxis) && fields.some(field =>
      JSON.stringify(plan.control[field as keyof typeof plan.control]) !== JSON.stringify(candidate[field as keyof typeof candidate])))
      ctx.addIssue({ code: 'custom', message: 'Undeclared experiment axis: ' + axis });
  }
  if (plan.axes.includes('code') && arms.some(arm => !arm.codeRef))
    ctx.addIssue({ code: 'custom', message: 'Code experiments require existing explicit Git refs for every arm' });
});
export type ExperimentPlan = z.infer<typeof experimentPlanSchema>;
export type ExperimentArm = z.infer<typeof experimentArmSchema>;
export type ExperimentArmRecord = { id: string; status: 'pending' | 'running' | 'complete' | 'blocked' | 'stopped';
  executionIds: string[]; reason?: string; runtimeRepository?: string; sourceCommit?: string };
export type ExperimentRecord = { contract: 'flowmate-experiment/v1'; id: string; createdAt: string;
  plan: ExperimentPlan; attribution: 'single-axis' | 'combination'; status: 'running' | 'complete' | 'blocked' | 'stopped';
  arms: ExperimentArmRecord[]; reason?: string };
export type GateReason = { code: string; message: string; evidenceRefs: string[]; metricId?: string; caseId?: string;
  stage?: 'prepare' | 'execute' | 'capture' | 'judge' | 'compare' | 'upload';
  before?: number; after?: number; delta?: number; threshold?: number };
export type ExperimentComparison = { status: 'comparable' | 'blocked'; reasons: GateReason[]; metrics: ExperimentMetricDelta[];
  safetyViolations?: GateReason[];
  assertions: ExperimentAssertion[]; scope: { selection: string; datasets: string[]; cases: number; trials: number;
      expectedCases?: number; coverageRate?: number };
  attribution: 'single-axis' | 'combination'; evidenceKind: 'model' | 'controlled' | 'unknown' };
export type GateResult = { id?: string; baselineId?: string; experimentId?: string; armId?: string;
  status: 'pass' | 'fail' | 'blocked'; exitCode: 0 | 1 | 2; fullRelease: boolean;
  scope: ExperimentComparison['scope']; reasons: GateReason[]; deltas: ExperimentMetricDelta[] };
export type BaselineRecord = { contract: 'flowmate-baseline/v1'; id: string; createdAt: string; experimentId: string; armId: string;
  executionIds: string[]; scoringRevision?: string; plan: ExperimentPlan; conditions: unknown[]; evidenceKind: ExperimentComparison['evidenceKind'];
  reference?:BaselineReference;thresholds?:GateThresholds };
