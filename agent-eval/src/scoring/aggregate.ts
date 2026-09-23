import type { CaseExecutionResult, GradeStatus } from '../types.ts';
import type { EvaluationScore } from './types.ts';
export function aggregate(scores: EvaluationScore[], execution: CaseExecutionResult): {
    status: GradeStatus;
    reason: string;
    counts: Record<string, number>;
} {
    const counts: Record<string, number> = {};
    for (const s of scores)
        counts[s.status] = (counts[s.status] ?? 0) + 1;
    const finish = (status: GradeStatus, reason: string) => ({ status, reason, counts });
    if (!execution.started)
        return finish('NOT_RUN', execution.error?.message ?? '任务未启动');
    if (execution.status === 'cancelled')
        return finish('UNJUDGEABLE', '用户中止，运行记录保留；不代表质量通过');
    if (execution.status === 'error' || execution.error?.infrastructure)
        return finish('ERROR', execution.error?.message ?? '设施错误');
    if (execution.status !== 'completed' || !execution.endpointReached)
        return finish('FAIL', '已启动任务未到达预定终点');
    const required = scores.filter(s => s.required && s.status !== 'NOT_APPLICABLE');
    if (required.some(s => s.status === 'FAIL'))
        return finish('FAIL', '必要任务判据失败');
    if (required.some(s => s.status === 'ERROR'))
        return finish('ERROR', '必要评分出错');
    if (!required.length || required.some(s => s.value === null || s.status !== 'PASS'))
        return finish('UNJUDGEABLE', '必要评分或证据尚未齐全');
    return finish('PASS', '必要自动检查通过；不等于正式验收');
}
