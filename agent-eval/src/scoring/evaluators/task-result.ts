import { verdict, type EvaluatorDefinition } from '../types.ts';
export const definition: EvaluatorDefinition = {
    id: 'task-result', name: '完整任务终点', kind: 'deterministic', version: 1, evidence: () => ['task-endpoint'],
    evaluate: ({ result }) => typeof result.evidence['task-endpoint']!.actual !== 'boolean'
        ? { value: null, status: 'UNJUDGEABLE', reason: '终点证据结构缺失' }
        : verdict(result.endpointReached && result.evidence['task-endpoint']!.actual === true, '核对整个任务终点，不以非空回答代替', result.evidence['task-endpoint']!.actual, true)
};
