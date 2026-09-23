import { verdict, type EvaluatorDefinition } from '../types.ts';
export const definition: EvaluatorDefinition = {
    id: 'reference-fields', name: '核验字段一致性', kind: 'deterministic', version: 1, evidence: () => ['candidate-fields'],
    evaluate: ({ task, result }) => {
        if (task.expected.reference?.status !== 'verified')
            return { value: null, status: 'UNJUDGEABLE', reason: '参考字段尚未独立核验，不能作为 Gold' };
        const actual = result.evidence['candidate-fields']!.actual as Record<string, unknown>;
        return verdict(!!actual && Object.entries(task.expected.reference.fields).every(([k, v]) => actual[k] === v), '按可见材料核验的字段比较', actual, task.expected.reference.fields);
    }
};
