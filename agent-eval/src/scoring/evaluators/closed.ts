import { verdict, type EvaluatorDefinition } from '../types.ts';
export const definition: EvaluatorDefinition = {
    id: 'closed', name: '任务执行已释放', kind: 'deterministic', version: 1, evidence: () => ['cleanup'],
    evaluate: ({ result }) => {
        const v = result.evidence.cleanup!.actual as {
            closed?: boolean;
            stopped?: boolean;
        };
        if (typeof v?.closed !== 'boolean' || typeof v.stopped !== 'boolean')
            return { value: null, status: 'UNJUDGEABLE', reason: '清理或停止事实缺失' };
        return verdict(v.closed === true && v.stopped === true, '清理与实际停止必须都有证据');
    }
};
