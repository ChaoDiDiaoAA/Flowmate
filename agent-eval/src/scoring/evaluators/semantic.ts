import type { EvaluationContext, EvaluationScore, JudgeCall } from '../types.ts';
import type { EvidenceFact } from '../../types.ts';
import { formalMetric } from '../catalog.ts';
import { runCompactJudge } from '../judges/harness.ts';
import { compactScores, type CompactPlan } from '../judges/compact.ts';
import {buildResearchFrame} from '../research-frame.ts';

export async function evaluateSemantic(context: EvaluationContext): Promise<{ scores: EvaluationScore[]; judgeCalls: JudgeCall[] }> {
    const { task, result } = context, plan = context.semanticPlan ?? ('contract' in task ? task.expected.semantic : undefined);
    if (!plan) return { scores: [], judgeCalls: [] };
    const researchFrame=plan.criteria.some(c=>c.metricId.startsWith('DR'))?buildResearchFrame(context):undefined;
    const reference = (actual: { status: string } | undefined): EvidenceFact => ({ present: actual?.status === 'verified', actual: actual ?? null,
        source: 'Declared independent Case reference; quality side only' });
    const facts: Record<string, EvidenceFact> = { ...result.evidence, 'gold-reference': reference(task.expected.reference),
        'gold-research': reference('research' in task.expected ? task.expected.research : undefined),
        'gold-materials':{present:'contract'in task&&!!task.expected.materialReferences?.length&&task.expected.materialReferences.every(r=>r.reference.status==='verified'),
            actual:'contract'in task?task.expected.materialReferences??null:null,source:'Declared independent per-material references; quality side only'},
        'research-frame':{present:researchFrame!==undefined,actual:researchFrame??null,source:'Independent quality-side original Report/Claim/source and Gold numbering; controller queries do not prove model reading'},
        'gold-task':{present:true,actual:{requires:task.requires,steps:task.steps??[],success:task.expected.success,failure:task.expected.failure,
            expectedAnswerHint:task.expected.expectedAnswerHint, requiredSkills:task.expected.requiredSkills, forbiddenSkills:task.expected.forbiddenSkills,
            requiredSubagentRoles:task.expected.requiredSubagentRoles, requiredResearchDimensions:task.expected.requiredResearchDimensions,
            plannedTurns:task.input.turns??[], turnConsumption:result.evidence['user-turns']??null},
            source:'Declared Case task and planned opportunity boundaries; quality side only'} };
    for (const key of plan.criteria.flatMap(c => c.evidence)) {
        if (!facts[key]?.source.trim() || facts[key]?.actual === undefined)
            facts[key] = { present: false, actual: null, source: 'Original evidence unavailable' };
    }
    const eligible: CompactPlan['criteria'] = [], scores: EvaluationScore[] = [];
    for (const criterion of plan.criteria) {
        const metric = formalMetric(criterion.metricId), required = criterion.required || !!context.semanticRequired;
        const base: EvaluationScore = { metricId: metric.id, name: metric.name, version: metric.version, method: 'llm-judge', required,
            value: null, status: 'NOT_RUN', reason: '语义判据尚未执行', evidence: criterion.evidence,
            statistics: { unit: metric.unit, numerator: null, denominator: criterion.denominator, missing: criterion.denominator } };
        if (result.error?.infrastructure) { base.status = 'ERROR'; base.reason = result.error.message; }
        else if (!result.started || criterion.trigger === 'completed-endpoint' && (result.status !== 'completed' || !result.endpointReached))
            base.reason = '未满足事前冻结的评分触发条件';
        else if (!context.judge || context.signal?.aborted) base.reason = context.signal?.aborted ? 'Judge 调用前已取消' : 'Judge 未配置或关闭';
        else if (criterion.evidence.some(key => ['gold-reference', 'gold-research','gold-materials'].includes(key) && !facts[key]!.present) ||
            !criterion.evidence.some(key => !key.startsWith('gold-')&&(facts[key]!.present || facts[key]!.actual !== null))) {
            base.status = 'UNJUDGEABLE'; base.reason = '该语义判据的必要证据缺失或独立参考未核验';
        } else eligible.push({ ...criterion, required });
        scores.push(base);
    }
    if (!eligible.length) return { scores, judgeCalls: [] };
    const selected = [...new Set(eligible.flatMap(c => c.evidence))];
    const selectedPlan:CompactPlan={...plan,criteria:eligible};
    try{
    const call = await runCompactJudge(context.judge!, selectedPlan, {
        input: result.input, outcome: { status: result.status, endpointReached: result.endpointReached, answer: result.answer },
        criteria: { success: task.expected.success, failure: task.expected.failure, expectedAnswerHint:task.expected.expectedAnswerHint,
            requiredCapabilities:task.expected.requiredCapabilities, optionalCapabilities:task.expected.optionalCapabilities, forbiddenCapabilities:task.expected.forbiddenCapabilities,
            requiredSkills:task.expected.requiredSkills, forbiddenSkills:task.expected.forbiddenSkills, requiredSubagentRoles:task.expected.requiredSubagentRoles,
            requiredResearchDimensions:task.expected.requiredResearchDimensions,
            turnRule:'Judge only actual submitted/accepted/consumed turns. Planned future text is not an executed user instruction.' },
        facts: Object.fromEntries(selected.map(key => [key, facts[key]])),...(researchFrame?{researchFrame}:{})
    }, context.fetcher, context.signal);
    const measured = compactScores(call);
    return { scores: scores.map(score => measured.find(m => m.metricId === score.metricId) ?? score), judgeCalls: [call] };
    }catch(error){
        return{scores:scores.map(score=>eligible.some(c=>c.metricId===score.metricId)?{...score,status:'ERROR' as const,reason:error instanceof Error?error.message:String(error)}:score),judgeCalls:[]};
    }
}
