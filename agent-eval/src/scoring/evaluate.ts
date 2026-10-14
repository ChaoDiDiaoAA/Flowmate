import type { Check } from '../dataset-loader/local.ts';
import { EvaluatorRegistry, createRegistry } from './registry.ts';
import type { EvaluationContext, EvaluationScore, JudgeCall } from './types.ts';
import { evaluateSemantic } from './evaluators/semantic.ts';
import {metricCatalog} from './catalog.ts';
import {evaluatorForMetric,compileEvaluatorPlan} from './evaluator-plan.ts';
export async function evaluateAll(context: EvaluationContext, checks: Check[], registry: EvaluatorRegistry = createRegistry()) {
    const scores: EvaluationScore[] = [], judgeCalls: JudgeCall[] = [];
    const executionPlan=compileEvaluatorPlan(context.task,checks);
    let explicitScoreCount=0;
    if ((context.semanticPlan || 'contract' in context.task && context.task.expected.semantic) && checks.some(check => registry.get(check.metric).kind === 'llm-judge'))
        throw new Error('Judge may run only once: compact and legacy semantic protocols cannot be combined');
    const runPhase=async(phase:NonNullable<ReturnType<typeof registry.get>['phase']>,graded:EvaluationScore[])=>{
        for(const def of registry.list().filter(d=>d.phase===phase&&d.evaluateMany)){
            const selected=executionPlan.find(p=>p.evaluatorId===def.id);
            if(!selected?.applicable){
                for(const output of selected?.outputs.filter(o=>o.category==='formal'&&!o.applicable)??[]){
                    if(graded.some(s=>s.metricId===output.metricId))continue;
                    const metric=metricCatalog.find(m=>m.id===output.metricId)!;
                    graded.push({metricId:metric.id,name:metric.name,version:metric.version,method:def.kind,required:false,
                        value:null,status:'NOT_APPLICABLE',reason:output.reason,evidence:[],statistics:{unit:metric.unit,numerator:null,denominator:null,missing:null}});
                }
                continue;
            }
            const produced=await def.evaluateMany!({...context,gradedScores:graded});
            for(const score of produced){
                if(graded.some(s=>s.metricId===score.metricId))throw Error('Duplicate original metric measurement: '+score.metricId);
                graded.push(score);
            }
        }
    };
    const finish = async (semantic: Awaited<ReturnType<typeof evaluateSemantic>>) => {
        const graded=[...scores.slice(0,explicitScoreCount),...semantic.scores,...scores.slice(explicitScoreCount)];
        await runPhase('semantic',graded);
        await runPhase('derived',graded);
        await runPhase('final',graded);
        const captureGaps = context.result.evidence['capture-gaps'];
        const captureFailed = captureGaps?.present === false && Array.isArray(captureGaps.actual) &&
            captureGaps.actual.some(gap => typeof gap === 'string' && gap.trim());
        const combined = graded.map(score => {
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
        return { scores: combined.map(score=>{
            const evaluatorId=evaluatorForMetric(context.task,score.metricId),def=registry.get(evaluatorId);
            const plan='contract'in context.task?context.task.expected.metrics.find(m=>m.metricId===score.metricId):undefined;
            return{...score,evaluatorId,evaluatorVersion:def.version,
                category:metricCatalog.some(m=>m.id===score.metricId)?'formal' as const:score.metricId.startsWith('diagnostic-')?'diagnostic' as const:'guardrail' as const,
                applicabilityReason:score.applicabilityReason??plan?.notApplicable??(score.status==='NOT_APPLICABLE'?score.reason:'Selected by declared Case requirements')};
        }), judgeCalls: [...judgeCalls, ...semantic.judgeCalls] };
    };
    if (!context.result.started){
        await runPhase('local',scores);
        return finish(await evaluateSemantic({...context,gradedScores:scores}));
    }
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
    explicitScoreCount=scores.length;
    await runPhase('local',scores);
    const semantic = await evaluateSemantic({...context,gradedScores:scores});
    return finish(semantic);
}
