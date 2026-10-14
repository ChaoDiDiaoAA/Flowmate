import { z } from 'zod';
import { NATIVE_TOOL_NAMES } from '../../../packages/contracts/src/tools.ts';
import { INVOICE_TOOL_NAMES } from '../../../packages/contracts/src/invoice.ts';
import { SKILL_RESOURCE_TOOL_NAMES } from '../../../packages/contracts/src/resources.ts';
import { RESEARCH_PLANNING_TOOL_NAMES, RESEARCH_INVESTIGATION_TOOL_NAMES } from '../../../packages/contracts/src/research.ts';
import { SUBAGENT_ROLE } from '../../../packages/contracts/src/subagents.ts';
import { metricCatalog } from '../scoring/catalog.ts';
import { regressionOriginsSchema } from './regression-origin.ts';

const text = z.string().trim().min(1);
const userInput = z.string().refine(value => value.trim().length > 0, 'User input must contain text');
export const turnIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const userTurnSchema = z.object({ id: turnIdSchema, role: z.literal('user'), content: userInput,
    mode: z.enum(['prompt', 'followUp', 'steer']).optional() }).strict();
export type UserTurn = z.infer<typeof userTurnSchema>;
export const difficultySchema = z.enum(['golden', 'difficult', 'long_tail', 'tool_failure', 'regression', 'adversarial']);
export const caseSourceSchema = z.enum(['hand-authored', 'real-trace', 'regression-bug', 'provider-fixture', 'historical-issue']);
export const harnessCategories = ['task', 'tools', 'context', 'memory', 'compaction', 'skills', 'extensions', 'subagents', 'runtime', 'safety', 'research'] as const;
export const toolNames = [...new Set<string>([...NATIVE_TOOL_NAMES, ...INVOICE_TOOL_NAMES, ...SKILL_RESOURCE_TOOL_NAMES,
    ...RESEARCH_PLANNING_TOOL_NAMES, ...RESEARCH_INVESTIGATION_TOOL_NAMES, 'Agent'])];
const tool = text.refine(name => toolNames.includes(name), 'Unknown registered tool capability');
const skill = z.enum(['invoice-header-extraction', 'eval-date-guide-long', 'invoice-review-handoff']);
const metric = text.refine(name => ['fact-check', 'reference-fields', 'line-items'].includes(name) || metricCatalog.some(item => item.id === name), 'Unknown scoring metric');
const unique = <T extends z.ZodTypeAny>(item: T) => z.array(item).min(1).refine(values => new Set(values).size === values.length, 'Duplicate constraint values');
export const constraintShape = {
    maxToolCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    mustHaveEvidence: z.boolean().optional(),
    requiredCapabilities: unique(tool).optional(), optionalCapabilities: unique(tool).optional(), forbiddenCapabilities: unique(tool).optional(),
    expectedAnswerHint: text.optional(), requiredSkills: unique(skill).optional(), forbiddenSkills: unique(skill).optional(),
    requiredSubagentRoles: unique(z.literal(SUBAGENT_ROLE)).optional(), requiredResearchDimensions: unique(text).optional(),
};
export type CaseConstraints = z.infer<z.ZodObject<typeof constraintShape>>;
export function validateConstraints(value: CaseConstraints, context: z.RefinementCtx) {
    const lists = [value.requiredCapabilities ?? [], value.optionalCapabilities ?? [], value.forbiddenCapabilities ?? []];
    const all = lists.flat();
    if (new Set(all).size !== all.length) context.addIssue({ code: 'custom', message: 'Required, optional and forbidden capabilities must not overlap' });
    if (value.requiredSkills?.some(skill => value.forbiddenSkills?.includes(skill)))
        context.addIssue({ code: 'custom', message: 'Required and forbidden Skills must not overlap' });
    if (value.maxToolCalls !== undefined && value.maxToolCalls < (value.requiredCapabilities?.length ?? 0))
        context.addIssue({ code: 'custom', message: 'Tool limit is lower than the minimum required calls' });
}
export const authorCaseSchema = z.object({
    id: z.string().regex(/^FM-\d{3}$/), name: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+){2,}$/),
    category: z.enum(harnessCategories), difficulty: difficultySchema, purpose: z.enum(['capability', 'regression']),
    input: z.object({ prompt: userInput, turns: z.array(userTurnSchema).min(1).optional(),
        fixture: z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict().optional() }).strict(),
    expected: z.object({ success: unique(text), failure: unique(text), ...constraintShape,
        maxToolCalls: constraintShape.maxToolCalls.unwrap(), mustHaveEvidence: z.boolean(), expectedAnswerHint: text }).strict(),
    scoring: z.object({ deterministic: unique(metric), judge: z.array(metric).refine(values => new Set(values).size === values.length), manual: text }).strict(),
    risks: unique(text), tags: unique(text), source: caseSourceSchema,
}).strict().superRefine((value, context) => {
    validateConstraints(value.expected, context);
    if (new Set(value.input.turns?.map(turn => turn.id)).size !== (value.input.turns?.length ?? 0))
        context.addIssue({ code: 'custom', path: ['input', 'turns'], message: 'Duplicate user turn identity' });
    if (/\p{Script=Han}/u.test(JSON.stringify(value))) context.addIssue({ code: 'custom', message: 'Authored Case text must be English' });
});
export type AuthorCase = z.infer<typeof authorCaseSchema>;
export const authorDatasetSchema = z.object({ version: z.literal('v1'), cases: z.array(authorCaseSchema),
    suite: z.enum(['baseline', 'badcase']).optional(), regressionOrigins: regressionOriginsSchema.optional() }).strict()
    .refine(dataset => dataset.cases.length > 0 || dataset.suite === 'badcase', 'Empty baseline Dataset')
    .refine(dataset => new Set(dataset.cases.map(task => task.id)).size === dataset.cases.length, 'Duplicate Case identity')
    .refine(dataset => dataset.suite === 'badcase' ? !!dataset.regressionOrigins &&
        JSON.stringify(Object.keys(dataset.regressionOrigins).sort()) === JSON.stringify(dataset.cases.map(c => c.id).sort()) : !dataset.regressionOrigins,
        'Regression origins must bind exactly the supplemental members');
export type AuthorDataset = z.infer<typeof authorDatasetSchema>;
