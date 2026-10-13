import type { CaseExecutionResult } from '../types.ts';
import type { EvaluationScore, MetricPlan } from './types.ts';
import { formalMetric } from './catalog.ts';
import { isDeepStrictEqual } from 'node:util';

export function claimF1(precision: number, recall: number): number {
    if (![precision, recall].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid Claim precision or recall');
    return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
}

export function assertResearchF1(plan: readonly MetricPlan[] | undefined, scores: readonly EvaluationScore[],
    execution: Pick<CaseExecutionResult, 'started' | 'error'> | null): void {
    const original = scores.find(s => s.metricId === 'DR03');
    if (original?.status === 'NOT_APPLICABLE' && plan?.find(m => m.metricId === 'DR03')?.notApplicable) return;
    const expected = deriveResearchF1(plan, scores, execution);
    if ((original || expected && (execution !== null || scores.length > 0)) && !isDeepStrictEqual(original, expected))
        throw new Error('Trial F1 differs from its same-Trial original precision/recall counts or is missing');
}

/** Trial F1 uses its own original P/R counts; Dataset F1 separately uses cumulative counts. */
export function deriveResearchF1(plan: readonly MetricPlan[] | undefined, scores: readonly EvaluationScore[],
    execution: Pick<CaseExecutionResult, 'started' | 'error'> | null): EvaluationScore | undefined {
    const target = plan?.find(m => m.metricId === 'DR03');
    if (!target || target.notApplicable) return;
    const metric = formalMetric('DR03'), operands = ['DR01', 'DR02'].map(id => scores.find(s => s.metricId === id));
    if (target.version !== metric.version || target.unit !== metric.unit || target.denominator !== null)
        throw new Error('DR03 needs its versioned derived metric plan without an opportunity denominator');
    if (['DR01', 'DR02'].some(id => !plan?.some(m => m.metricId === id && !m.notApplicable)))
        throw new Error('Applicable DR03 needs applicable same-Trial precision and recall plans');
    const values = operands.map((score, index) => {
        if (!score || score.value === null) return null;
        const id = index ? 'DR02' : 'DR01', expected = formalMetric(id), declared = plan?.find(m => m.metricId === id), stats = score.statistics;
        if (!declared || declared.notApplicable || score.version !== expected.version || stats?.unit !== expected.unit ||
            ![stats.numerator, stats.denominator, stats.missing].every(n => n !== null && Number.isSafeInteger(n) && n >= 0) ||
            !stats.denominator || stats.missing !== 0 || stats.numerator! > stats.denominator ||
            declared.denominator !== null && declared.denominator !== stats.denominator ||
            score.value !== stats.numerator! / stats.denominator || !['PASS', 'FAIL'].includes(score.status))
            throw new Error('DR03 requires valid original same-Trial DR01/DR02 counts, not a copied semantic score');
        return score.value;
    });
    const value = values.every(v => v !== null) ? claimF1(values[0]!, values[1]!) : null;
    const status = execution?.error?.infrastructure || operands.some(s => s?.status === 'ERROR') ? 'ERROR'
        : !execution?.started || operands.some(s => s?.status === 'NOT_RUN') ? 'NOT_RUN'
            : value === null ? 'UNJUDGEABLE' : value === 1 ? 'PASS' : 'FAIL';
    return { metricId: metric.id, name: metric.name, version: metric.version, method: 'deterministic',
        required: operands.some(s => s?.required), value: ['PASS', 'FAIL'].includes(status) ? value : null, status,
        reason: status === 'ERROR' ? 'Trial或必要研究评分出错，F1未核验' : status === 'NOT_RUN' ? 'Trial或必要研究评分未执行'
            : value === null ? 'DR01或DR02缺少有效原计数，F1保留未知' : '依据同一Trial的DR01/DR02原计数本地派生F1',
        evidence: ['score:DR01', 'score:DR02'], statistics: { unit: metric.unit, numerator: null, denominator: null, missing: null },
        actual: { contract: 'flowmate-research-f1/v1', operands: operands.map(s => s ? { metricId: s.metricId, version: s.version,
            value: s.value, status: s.status, statistics: s.statistics ?? null, judge: s.judge ?? null } : null) } };
}
