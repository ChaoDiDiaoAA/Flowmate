import { isDeepStrictEqual } from 'node:util';
import type { TrialReport } from '../reports/store.ts';
import type { EvaluationScore } from './types.ts';
import { hasNoResearchReport } from './research-frame.ts';

export type ScoreAvailabilityContext = Pick<TrialReport, 'metricPlan' | 'semanticPlan' | 'evaluatorPlan' | 'judgeCalls' | 'execution'>;
export type ScoreAvailability = { state: 'measured' | 'not-applicable' | 'no-opportunity' | 'missing-evidence' | 'error' | 'not-run'; reason: string };

function noOpportunityReason(score: EvaluationScore, context?: ScoreAvailabilityContext): string | undefined {
    const counts = score.statistics;
    if (!context?.execution?.started || score.status !== 'UNJUDGEABLE' || score.value !== null ||
        counts?.numerator !== 0 || counts.denominator !== 0 || counts.missing !== 0) return;
    const declarations = context.semanticPlan?.criteria.filter(criterion => criterion.metricId === score.metricId) ?? [];
    if (declarations.length !== 1) return;
    const declared = declarations[0]!, opportunity = context.metricPlan?.find(plan => plan.metricId === score.metricId);
    if (declared.denominator !== null || declared.version !== score.version || declared.unit !== counts.unit || declared.required !== score.required ||
        opportunity && (opportunity.denominator !== null || opportunity.version !== score.version || opportunity.unit !== counts.unit) ||
        declared.trigger === 'completed-endpoint' && (context.execution.status !== 'completed' || !context.execution.endpointReached) ||
        declared.evidence.some(key => {
            const fact = context.execution!.evidence[key];
            return fact && !fact.present;
        })) return;
    const actual = score.actual;
    if (score.method === 'deterministic' && ['DR01', 'DR04', 'DR05'].includes(score.metricId) && !score.judge &&
        hasNoResearchReport(context.execution.evidence.research) && actual && typeof actual === 'object' &&
        'locallyDerived' in actual && actual.locallyDerived === true && 'row' in actual && isDeepStrictEqual(actual.row, [0, 0, 0]) &&
        'opportunities' in actual && Array.isArray(actual.opportunities) && actual.opportunities.length === 0)
        return 'Complete original Report capture confirms no Report and no opportunities; original undefined research ratio is retained';
    const reference = score.judge;
    if (score.method !== 'llm-judge' || !reference || !Number.isSafeInteger(reference.criterion) || reference.criterion < 0) return;
    const calls = context.judgeCalls.filter(call => call.callId === reference.callId);
    if (calls.length !== 1) return;
    const call = calls[0]!, compact = call.compact;
    if (!compact || !isDeepStrictEqual(compact.plan.criteria[reference.criterion], declared)) return;
    const completed = call.stopReason === undefined ? ['stop', 'end_turn', 'stop_sequence'].includes(call.finishReason ?? '') : call.stopReason === 'stop';
    if (!completed || !(call.attempts > 0) || call.responseComplete !== true || call.error !== null ||
        call.transportStatus != null && (call.transportStatus < 200 || call.transportStatus >= 300) ||
        Object.keys(compact.validationErrors ?? {}).length || compact.judgment?.research?.unavailable === true ||
        !isDeepStrictEqual(compact.judgment?.r[reference.criterion], [0, 0, 0]) ||
        compact.judgment?.f.some(failure => failure[0] === reference.criterion)) return;
    return 'Completed Judge confirms zero opportunities for the declared dynamic criterion; original UNJUDGEABLE 0/0 with missing=0 is retained';
}

/** Availability projects original evidence without changing its status, value or counts. */
export function scoreAvailability(score: EvaluationScore, context?: ScoreAvailabilityContext): ScoreAvailability {
    if (score.status === 'ERROR') return { state: 'error', reason: score.reason };
    if (score.status === 'NOT_RUN') return { state: 'not-run', reason: score.reason };
    if (score.status === 'NOT_APPLICABLE') {
        const plan = context?.metricPlan?.find(plan => plan.metricId === score.metricId && plan.version === score.version && plan.notApplicable?.trim());
        const output = context?.evaluatorPlan?.flatMap(plan => plan.outputs).find(output => output.metricId === score.metricId && !output.applicable && output.reason.trim());
        return plan || output ? { state: 'not-applicable', reason: 'Declared non-applicability: ' + (plan?.notApplicable ?? output!.reason) }
            : { state: 'missing-evidence', reason: 'Metric non-applicability lacks an original declaration' };
    }
    const reason = noOpportunityReason(score, context);
    if (reason) return { state: 'no-opportunity', reason };
    const counts = score.statistics;
    const validCounts = !counts || score.metricId === 'DR03' || counts.numerator !== null && counts.denominator !== null && counts.missing === 0 &&
        Number.isSafeInteger(counts.numerator) && Number.isSafeInteger(counts.denominator) && counts.denominator > 0 &&
        counts.numerator >= 0 && counts.numerator <= counts.denominator && score.value !== null &&
        Math.abs(score.value - counts.numerator / counts.denominator) <= 1e-12;
    return ['PASS', 'FAIL'].includes(score.status) && score.value !== null && Number.isFinite(score.value) && score.value >= 0 && score.value <= 1 && validCounts
        ? { state: 'measured', reason: score.reason }
        : { state: 'missing-evidence', reason: 'Necessary measurement or original opportunity evidence is unavailable: ' + score.reason };
}
