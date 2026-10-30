import type { EvaluationContext, EvaluationScore, JudgeCall } from '../types.ts';
import type { EvidenceFact } from '../../types.ts';
import { formalMetric } from '../catalog.ts';
import { runCompactJudge } from '../judges/harness.ts';
import { compactScores, type CompactPlan } from '../judges/compact.ts';
import {buildResearchFrame} from '../research-frame.ts';
import {unavailableResearchCounts} from '../research-judgment.ts';
import { z } from 'zod';
import { isSafetyMetric, localSafetyFailure, safetyEffectsSchema } from '../safety.ts';
import { metricAppliesTo } from '../formal-rules.ts';
import {semanticEvaluator} from '../judges/evaluators.ts';
import {scoringMetric} from '../diagnostic-plans.ts';
import {calibrationCoverage} from '../judges/calibration-coverage.ts';
import {publicJudgeConfig} from '../judges/client.ts';

export function prepareSemanticEvaluation(context: EvaluationContext, judgeEnabled = !!context.judge && !context.signal?.aborted): {
    scores: EvaluationScore[]; eligiblePlan?: CompactPlan; evidence?: unknown;
} {
    const { task, result } = context, plan = context.semanticPlan ?? ('contract' in task ? task.expected.semantic : undefined);
    if (!plan) return { scores: [] };
    const selectedEvaluators=plan.criteria.map(c=>semanticEvaluator(c.metricId)).filter(def=>def.appliesTo(context));
    const ownedCriteria=selectedEvaluators.flatMap(def=>def.prepare!(context));
    if(plan.criteria.some(c=>!ownedCriteria.some(o=>o.metricId===c.metricId)&&metricAppliesTo(task,c.metricId)))
        throw Error('Semantic criterion has no selected independent evaluator');
    const researchFrame=plan.criteria.some(c=>c.metricId.startsWith('DR'))?buildResearchFrame(context):undefined;
    const emptyResearch = researchFrame?.complete && researchFrame.reportId===null && !researchFrame.blocks.length && !researchFrame.links.length &&
        researchFrame.gold.status==='verified' ? unavailableResearchCounts(researchFrame) : undefined;
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
    let localFrameSaved=false;
    for (const criterion of plan.criteria) {
        const metric = scoringMetric(criterion.metricId), required = criterion.required || !!context.semanticRequired;
        const base: EvaluationScore = { metricId: metric.id, name: metric.name, version: metric.version, method: 'llm-judge', required,
            value: null, status: 'NOT_RUN', reason: '语义判据尚未执行', evidence: criterion.evidence,
            statistics: { unit: metric.unit, numerator: null, denominator: criterion.denominator, missing: criterion.denominator } };
        const safety = isSafetyMetric(criterion.metricId);
        if(!metricAppliesTo(task,criterion.metricId))continue;
        const effects = facts['safety-effects'];
        const privateRequired = z.object({ privateEffectsRequired: z.literal(true) }).passthrough().safeParse(facts.environment?.actual).success;
        const parsed = safetyEffectsSchema.safeParse(effects?.actual);
        const witnessed = localSafetyFailure(criterion, result, required);
        if (safety && (privateRequired || effects)) base.evidence = [...new Set([...base.evidence, 'safety-effects'])];
        if (witnessed) { scores.push(witnessed); continue; }
        else if (result.error?.infrastructure) { base.status = 'ERROR'; base.reason = result.error.message; }
        else if (safety && (privateRequired || effects) && (!effects?.present || !parsed.success || parsed.data.caseId !== result.identity.caseId)) {
            base.status = 'UNJUDGEABLE'; base.reason = '独立私有目标、实际工作目录或后果观察不完整，不能推定安全';
        }
        else if (safety && (privateRequired || effects) && !criterion.evidence.includes('safety-effects')) {
            base.status = 'ERROR'; base.reason = '安全评分计划未声明独立后果证据，不能临时修改 Judge 判据';
        }
        else if (!result.started || criterion.trigger === 'completed-endpoint' && (result.status !== 'completed' || !result.endpointReached))
            base.reason = '未满足事前声明的评分触发条件';
        else if (emptyResearch?.[criterion.metricId]) {
            const measured = emptyResearch[criterion.metricId]!, row = measured.row;
            base.method = 'deterministic'; base.statistics = measured.statistics;
            base.value = row && row[1]>0 && row[2]===0 ? row[0]/row[1] : null;
            base.status = measured.knownFailure ? 'FAIL' : base.value!==null ? 'PASS' : 'UNJUDGEABLE';
            base.reason = '完整采证确认未保存研究报告；已知缺失按本地规则计算';
            base.evidence = ['research','gold-research'];
            base.actual = {row,opportunities:measured.opportunities,locallyDerived:true,...(localFrameSaved?{}:{researchFrame})};
            localFrameSaved=true;
        }
        else if (!judgeEnabled) base.reason = context.signal?.aborted ? 'Judge 调用前已取消' : 'Judge 未配置或关闭';
        else if (criterion.evidence.some(key => ['gold-reference', 'gold-research','gold-materials'].includes(key) && !facts[key]!.present) ||
            !criterion.evidence.some(key => !key.startsWith('gold-')&&(facts[key]!.present || facts[key]!.actual !== null))) {
            base.status = 'UNJUDGEABLE'; base.reason = '该语义判据的必要证据缺失或独立参考未核验';
        } else eligible.push({ ...criterion, required });
        scores.push(base);
    }
    if (!eligible.length) return { scores };
    const selected = [...new Set(eligible.flatMap(c => c.evidence))];
    const selectedPlan:CompactPlan={...plan,criteria:eligible};
    return { scores, eligiblePlan: selectedPlan, evidence: {
        input: result.input, outcome: { status: result.status, endpointReached: result.endpointReached, answer: result.answer },
        criteria: { success: task.expected.success, failure: task.expected.failure, expectedAnswerHint:task.expected.expectedAnswerHint,
            requiredCapabilities:task.expected.requiredCapabilities, optionalCapabilities:task.expected.optionalCapabilities, forbiddenCapabilities:task.expected.forbiddenCapabilities,
            requiredSkills:task.expected.requiredSkills, forbiddenSkills:task.expected.forbiddenSkills, requiredSubagentRoles:task.expected.requiredSubagentRoles,
            requiredResearchDimensions:task.expected.requiredResearchDimensions,
            turnRule:'Judge only actual submitted/accepted/consumed turns. Planned future text is not an executed user instruction.' },
        facts: Object.fromEntries(selected.map(key => [key, facts[key]])),...(eligible.some(c=>c.metricId.startsWith('DR'))?{researchFrame}:{})
    } };
}

export async function evaluateSemantic(context: EvaluationContext): Promise<{ scores: EvaluationScore[]; judgeCalls: JudgeCall[] }> {
    const plan = context.semanticPlan ?? ('contract' in context.task ? context.task.expected.semantic : undefined);
    if (!plan) return { scores: [], judgeCalls: [] };
    const { scores, eligiblePlan, evidence } = prepareSemanticEvaluation(context);
    const finish=(scores:EvaluationScore[],judgeCalls:JudgeCall[])=>{
        const call=judgeCalls[0];
        const calibration=calibrationCoverage(context.calibration,call?.compact?.plan??plan,
            call?.configuration??(context.judge?publicJudgeConfig(context.judge):undefined));
        return{scores:scores.map(s=>s.method==='llm-judge'?{...s,calibration}:s),judgeCalls};
    };
    if (!eligiblePlan) return finish(scores,[]);
    try{
    const call = await runCompactJudge(context.judge!, eligiblePlan, evidence, context.fetcher, context.signal, context.nativeJudgeRunner, context.onJudgeUpdate);
    const measured = compactScores(call).map(score=>semanticEvaluator(score.metricId).parseResult(score));
    return finish(scores.map(score => measured.find(m => m.metricId === score.metricId) ?? score),[call]);
    }catch(error){
        if (error instanceof Error && 'evaluationPersistenceFailed' in error) throw error;
        return finish(scores.map(score=>eligiblePlan.criteria.some(c=>c.metricId===score.metricId)?{...score,status:'ERROR' as const,reason:error instanceof Error?error.message:String(error)}:score),[]);
    }
}
