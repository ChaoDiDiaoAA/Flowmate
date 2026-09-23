import { verdict, type EvaluatorDefinition } from '../types.ts';
export const definition: EvaluatorDefinition = {
    id: 'environment-isolation', name: '独立任务环境', kind: 'deterministic', version: 1, evidence: () => ['environment'],
    evaluate: ({ result }) => {
        const v = result.evidence.environment!.actual as {
            executionId?: string;
            trialId?: string;
            caseId?: string;
            fresh?: boolean;
        };
        if (typeof v?.fresh !== 'boolean' || typeof v.executionId !== 'string' || typeof v.trialId !== 'string' || typeof v.caseId !== 'string')
            return { value: null, status: 'UNJUDGEABLE', reason: '环境身份或重置事实缺失' };
        return verdict(v.fresh === true && v.executionId === result.identity.executionId && v.trialId === result.identity.trialId && v.caseId === result.identity.caseId, '公开入口准备事实与 Trial 身份一致');
    }
};
