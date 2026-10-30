import type { Check } from '../dataset-loader/local.ts';
import { EvaluatorRegistry, createRegistry } from './registry.ts';
import type { EvaluationContext, EvaluationScore, EvaluationValue, EvaluatorDefinition, JudgeCall } from './types.ts';
import { evaluateSemantic } from './evaluators/semantic.ts';
import {metricCatalog} from './catalog.ts';
import {evaluatorForMetric,compileEvaluatorPlan} from './evaluator-plan.ts';
import type { EvaluatorPlanEntry } from './evaluator-plan.ts';

type CheckedScore = { score: EvaluationScore; call?: JudgeCall };
function evaluateCheck(context: EvaluationContext, check: Check, registry: EvaluatorRegistry, metricKeys: Set<string>): CheckedScore | Promise<CheckedScore> | undefined {
    if (!context.result.started || (context.result.status !== 'completed' || !context.result.endpointReached) && check.trigger !== 'started') return;
    const def = registry.get(check.metric), id = check.metric === 'fact-check' ? [check.metric, check.evidence, ...(check.path ?? [])].join('/') : check.metric;
    if (metricKeys.has(id)) throw new Error('Duplicate metric selection: ' + id);
    metricKeys.add(id);
    const refs = def.evidence(check, context);
    const name = check.metric === 'fact-check' ? def.name + ' · ' + (check.path ?? []).join('/') : def.name;
    const base = { metricId: id, name, version: def.version, method: def.kind, required: check.required, evidence: refs };
    if (def.appliesTo && !def.appliesTo(context, check)) return { score: { ...base, value: null, status: 'NOT_APPLICABLE', reason: '指标不适用于本任务输出' } };
    if (def.kind === 'llm-judge' && (!context.judge || context.signal?.aborted)) return { score: { ...base, value: null, status: 'NOT_RUN',
        reason: context.signal?.aborted ? 'Judge 调用前已取消' : 'Judge 未配置或关闭' } };
    if (refs.some(key => !context.result.evidence[key]?.present || context.result.evidence[key]?.actual === undefined || !context.result.evidence[key]?.source.trim()))
        return { score: { ...base, value: null, status: 'UNJUDGEABLE', reason: '必要证据缺失' } };
    let call: JudgeCall | undefined;
    const finish = (value: EvaluationValue): CheckedScore => {
        const { call: recorded, ...rest } = value; call = recorded;
        if (rest.value !== null && (!Number.isFinite(rest.value) || rest.value < 0 || rest.value > 1)) throw new Error('Invalid score range');
        return { score: { ...base, ...rest }, ...(call ? { call } : {}) };
    };
    const fail = (error: unknown): CheckedScore => ({ score: { ...base, value: null, status: 'ERROR', reason: error instanceof Error ? error.message : String(error) }, ...(call ? { call } : {}) });
    try {
        const value = def.evaluate(context, check);
        return value instanceof Promise ? value.then(finish).catch(fail) : finish(value);
    } catch (error) { return fail(error); }
}
function phaseScores(context: EvaluationContext, definition: EvaluatorDefinition, selected: EvaluatorPlanEntry | undefined, graded: EvaluationScore[]) {
    if (!selected?.applicable) return (selected?.outputs.filter(output => output.category === 'formal' && !output.applicable) ?? []).flatMap<EvaluationScore>(output => {
        if (graded.some(score => score.metricId === output.metricId)) return [];
        const metric = metricCatalog.find(metric => metric.id === output.metricId)!;
        return [{ metricId: metric.id, name: metric.name, version: metric.version, method: definition.kind, required: false,
            value: null, status: 'NOT_APPLICABLE', reason: output.reason, evidence: [], statistics: { unit: metric.unit, numerator: null, denominator: null, missing: null } }];
    });
    return definition.evaluateMany!({ ...context, gradedScores: graded });
}
function appendScores(graded: EvaluationScore[], produced: EvaluationScore[]) {
    for (const score of produced) {
        if (graded.some(original => original.metricId === score.metricId)) throw Error('Duplicate original metric measurement: ' + score.metricId);
        graded.push(score);
    }
}
export function finalizeEvaluationScores(context: EvaluationContext, graded: EvaluationScore[], registry: EvaluatorRegistry): EvaluationScore[] {
    const captureGaps = context.result.evidence['capture-gaps'];
    const captureFailed = captureGaps?.present === false && Array.isArray(captureGaps.actual) && captureGaps.actual.some(gap => typeof gap === 'string' && gap.trim());
    const combined = graded.map(score => {
        if (score.status !== 'UNJUDGEABLE') return score;
        const missing = score.evidence.filter(key => key !== 'research-frame' && !key.startsWith('gold-') && !key.startsWith('judge-') && !context.result.evidence[key]?.present);
        const failed = missing.some(key => {
            const actual = context.result.evidence[key]?.actual;
            return actual !== null && typeof actual === 'object' && 'gap' in actual && typeof actual.gap === 'string' && !!actual.gap.trim();
        });
        if (!failed && !(captureFailed && missing.length)) return score;
        return { ...score, status: 'ERROR' as const, reason: '必要证据采集失败，详见原始采证缺口', evidence: captureFailed ? [...score.evidence, 'capture-gaps'] : score.evidence };
    });
    const measured = combined.filter(score => !score.metricId.startsWith('fact-check/')).map(score => score.metricId);
    if (new Set(measured).size !== measured.length) throw new Error('Duplicate original metric measurement');
    return combined.map(score => {
        const evaluatorId = evaluatorForMetric(context.task, score.metricId), definition = registry.get(evaluatorId);
        const plan = 'contract' in context.task ? context.task.expected.metrics.find(plan => plan.metricId === score.metricId) : undefined;
        return { ...score, evaluatorId, evaluatorVersion: definition.version,
            category: metricCatalog.some(metric => metric.id === score.metricId) ? 'formal' : score.metricId.startsWith('diagnostic-') ? 'diagnostic' : 'guardrail',
            applicabilityReason: score.applicabilityReason ?? plan?.notApplicable ?? (score.status === 'NOT_APPLICABLE' ? score.reason : 'Selected by declared Case requirements') };
    });
}
/** Replay only synchronous local facts from saved v2 inputs; this path never selects a Judge. */
export function prepareLocalEvaluation(context: EvaluationContext, checks: Check[], registry: EvaluatorRegistry = createRegistry()): EvaluationScore[] {
    if (!('contract' in context.task)) throw Error('Local scoring verification requires a v2 Case');
    const scores: EvaluationScore[] = [], metricKeys = new Set<string>(), plan = compileEvaluatorPlan(context.task, checks);
    for (const check of checks) {
        if (registry.get(check.metric).kind !== 'deterministic') throw Error('Local scoring verification cannot invoke a Judge');
        const evaluated = evaluateCheck(context, check, registry, metricKeys);
        if (evaluated instanceof Promise) { void evaluated.catch(() => {}); throw Error('Asynchronous local scoring cannot be verified synchronously'); }
        if (evaluated?.call) throw Error('A local Evaluator returned an unexpected Judge record');
        if (evaluated) scores.push(evaluated.score);
    }
    for (const definition of registry.list().filter(definition => definition.phase === 'local' && definition.evaluateMany)) {
        if (definition.kind !== 'deterministic') throw Error('Local scoring verification cannot invoke a Judge');
        const produced = phaseScores(context, definition, plan.find(entry => entry.evaluatorId === definition.id), scores);
        if (produced instanceof Promise) { void produced.catch(() => {}); throw Error('Asynchronous local scoring cannot be verified synchronously'); }
        appendScores(scores, produced);
    }
    return finalizeEvaluationScores(context, scores, registry);
}
export async function evaluateAll(context: EvaluationContext, checks: Check[], registry: EvaluatorRegistry = createRegistry()) {
    const scores: EvaluationScore[] = [], judgeCalls: JudgeCall[] = [];
    const executionPlan=compileEvaluatorPlan(context.task,checks);
    let explicitScoreCount=0;
    if ((context.semanticPlan || 'contract' in context.task && context.task.expected.semantic) && checks.some(check => registry.get(check.metric).kind === 'llm-judge'))
        throw new Error('Judge may run only once: compact and legacy semantic protocols cannot be combined');
    const runPhase=async(phase:NonNullable<ReturnType<typeof registry.get>['phase']>,graded:EvaluationScore[])=>{
        for(const def of registry.list().filter(d=>d.phase===phase&&d.evaluateMany)){
            appendScores(graded, await phaseScores(context, def, executionPlan.find(entry => entry.evaluatorId === def.id), graded));
        }
    };
    const finish = async (semantic: Awaited<ReturnType<typeof evaluateSemantic>>) => {
        context = { ...context, scoringContext: {
            execution: context.result, metricPlan: 'contract' in context.task ? context.task.expected.metrics : undefined,
            semanticPlan: context.semanticPlan ?? ('contract' in context.task ? context.task.expected.semantic : undefined),
            evaluatorPlan: executionPlan, judgeCalls: [...judgeCalls, ...semantic.judgeCalls],
        } };
        const graded=[...scores.slice(0,explicitScoreCount),...semantic.scores,...scores.slice(explicitScoreCount)];
        await runPhase('semantic',graded);
        await runPhase('derived',graded);
        await runPhase('final',graded);
        return { scores: finalizeEvaluationScores(context, graded, registry), judgeCalls: [...judgeCalls, ...semantic.judgeCalls] };
    };
    if (!context.result.started){
        await runPhase('local',scores);
        return finish(await evaluateSemantic({...context,gradedScores:scores}));
    }
    const metricKeys = new Set<string>();
    for (const check of checks) {
        const evaluated = await evaluateCheck(context, check, registry, metricKeys);
        if (evaluated?.call) judgeCalls.push(evaluated.call);
        if (evaluated) scores.push(evaluated.score);
    }
    explicitScoreCount=scores.length;
    await runPhase('local',scores);
    const semantic = await evaluateSemantic({...context,gradedScores:scores});
    return finish(semantic);
}
