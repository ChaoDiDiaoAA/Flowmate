import type { Check } from '../dataset-loader/local.ts';
import { EvaluatorRegistry, createRegistry } from './registry.ts';
import type { EvaluationContext, EvaluationScore, JudgeCall } from './types.ts';
import { evaluateSemantic } from './evaluators/semantic.ts';
import { deriveResearchF1 } from './research-f1.ts';
import {evaluateFormalMetrics} from './evaluators/formal.ts';
import {formalMetric} from './catalog.ts';
import { evaluateCaseConstraints } from './case-constraints.ts';
export async function evaluateAll(context: EvaluationContext, checks: Check[], registry: EvaluatorRegistry = createRegistry()) {
    const scores: EvaluationScore[] = [], judgeCalls: JudgeCall[] = [];
    if ((context.semanticPlan || 'contract' in context.task && context.task.expected.semantic) && checks.some(check => registry.get(check.metric).kind === 'llm-judge'))
        throw new Error('Judge may run only once: compact and legacy semantic protocols cannot be combined');
    const finish = (semantic: Awaited<ReturnType<typeof evaluateSemantic>>) => {
        const researchGaps:EvaluationScore[]='contract'in context.task?context.task.expected.metrics.flatMap(plan=>{
            if(!plan.metricId.startsWith('DR')||semantic.scores.some(score=>score.metricId===plan.metricId)||plan.metricId==='DR03'&&!plan.notApplicable)return[];
            const metric=formalMetric(plan.metricId);
            return[{metricId:metric.id,name:metric.name,version:metric.version,method:metric.id==='DR03'?'deterministic':'llm-judge',required:!plan.notApplicable,
                value:null,status:plan.notApplicable?'NOT_APPLICABLE':context.result.error?.infrastructure?'ERROR':'NOT_RUN',reason:plan.notApplicable??'适用研究判据尚未声明，独立匹配尚未执行',evidence:['research','gold-research'],
                statistics:{unit:metric.unit,numerator:null,denominator:plan.denominator??null,missing:plan.denominator??null}}];
        }):[];
        const graded = [...scores, ...semantic.scores,...researchGaps, ...evaluateCaseConstraints(context)];
        const captureGaps = context.result.evidence['capture-gaps'];
        const captureFailed = captureGaps?.present === false && Array.isArray(captureGaps.actual) &&
            captureGaps.actual.some(gap => typeof gap === 'string' && gap.trim());
        const combined = [...graded,...evaluateFormalMetrics({...context,gradedScores:graded})].map(score => {
            if (score.status !== 'UNJUDGEABLE') return score;
            const missing = score.evidence.filter(key => key !== 'research-frame' && !key.startsWith('gold-') && !key.startsWith('judge-') && !context.result.evidence[key]?.present);
            const failed = missing.some(key => {
                const actual = context.result.evidence[key]?.actual;
                return actual !== null && typeof actual === 'object' && 'gap' in actual && typeof actual.gap === 'string' && !!actual.gap.trim();
            });
            if (!failed && !(captureFailed && missing.length)) return score;
            return { ...score, status: 'ERROR' as const, reason: '必要证据采集失败，详见原始采证缺口',
                evidence: captureFailed ? [...score.evidence, 'capture-gaps'] : score.evidence };
        });
        const measured=combined.filter(s=>!s.metricId.startsWith('fact-check/')).map(s=>s.metricId);
        if(new Set(measured).size!==measured.length)throw new Error('Duplicate original metric measurement');
        const f1 = deriveResearchF1('contract' in context.task ? context.task.expected.metrics : undefined, combined, context.result);
        return { scores: f1 ? [...combined, f1] : combined, judgeCalls: [...judgeCalls, ...semantic.judgeCalls] };
    };
    if (!context.result.started)
        return finish(await evaluateSemantic(context));
    const metricKeys = new Set<string>();
    for (const check of checks) {
        if((context.result.status!=='completed'||!context.result.endpointReached)&&check.trigger!=='started')continue;
        const def = registry.get(check.metric), id = check.metric === 'fact-check' ? [check.metric, check.evidence, ...(check.path ?? [])].join('/') : check.metric;
        if (metricKeys.has(id))
            throw new Error('Duplicate metric selection: ' + id);
        metricKeys.add(id);
        const refs = def.evidence(check, context);
        const name = check.metric === 'fact-check' ? def.name + ' · ' + (check.path ?? []).join('/') : def.name;
        const base = { metricId: id, name, version: def.version, method: def.kind, required: check.required, evidence: refs };
        if (def.appliesTo && !def.appliesTo(context, check)) {
            scores.push({ ...base, value: null, status: 'NOT_APPLICABLE', reason: '指标不适用于本任务输出' });
            continue;
        }
        if (def.kind === 'llm-judge' && (!context.judge || context.signal?.aborted)) {
            scores.push({ ...base, value: null, status: 'NOT_RUN', reason: context.signal?.aborted ? 'Judge 调用前已取消' : 'Judge 未配置或关闭' });
            continue;
        }
        if (refs.some(key => !context.result.evidence[key]?.present || context.result.evidence[key]?.actual === undefined || !context.result.evidence[key]?.source.trim())) {
            scores.push({ ...base, value: null, status: 'UNJUDGEABLE', reason: '必要证据缺失' });
            continue;
        }
        try {
            const value = await def.evaluate(context, check), { call, ...rest } = value;
            if (call)
                judgeCalls.push(call);
            if (rest.value !== null && (!Number.isFinite(rest.value) || rest.value < 0 || rest.value > 1))
                throw new Error('Invalid score range');
            scores.push({ ...base, ...rest });
        }
        catch (error) {
            scores.push({ ...base, value: null, status: 'ERROR', reason: error instanceof Error ? error.message : String(error) });
        }
    }
    const semantic = await evaluateSemantic(context);
    return finish(semantic);
}
