import type { CompactPlan } from '../scoring/judges/compact.ts';

const integer = { type: 'integer', minimum: 0 };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = (items: Record<string, unknown>) => ({ type: 'array', items });
/** The CLI constrains the wire shape; existing semantic validators still own counts and witnesses. */
export function judgeOutputSchema(plan?: CompactPlan): Record<string, unknown> {
    if (!plan) return object({ score: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' } });
    const results = array(object({ metricId: { type: 'string', enum: plan.criteria.map(criterion => criterion.metricId) },
        counts: { anyOf: [{ type: 'null' }, object({ numerator: integer, denominator: integer, unassessable: integer })] },
        failures: array(object({ opportunityIndex: integer, code: { type: 'integer', enum: [1, 2, 3, 4] } })) }));
    if (!plan.criteria.some(criterion => criterion.metricId.startsWith('DR'))) return object({ v: { type: 'integer', enum: [1] }, results });
    const state = { type: 'integer', enum: [0, 1, 2] };
    const witnesses = { atoms: array(object({ block: integer, start: integer, length: { type: 'integer', minimum: 1 }, correct: state,
        needsCitation: { type: 'boolean' }, covered: state, gold: integer, matchUncertain: { type: 'boolean' } })),
        links: array(object({ atom: { type: 'integer', minimum: -1 }, state })), chains: array(state) };
    return object({ v: { type: 'integer', enum: [1] }, results, research: { anyOf: [object(witnesses), object({ ...witnesses, unavailable: { type: 'boolean', enum: [true] } })] } });
}
