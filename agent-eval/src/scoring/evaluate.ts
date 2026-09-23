import type { Check } from '../datasets/local.ts';
import { EvaluatorRegistry, createRegistry } from './registry.ts';
import type { EvaluationContext, EvaluationScore, JudgeCall } from './types.ts';
export async function evaluateAll(context: EvaluationContext, checks: Check[], registry: EvaluatorRegistry = createRegistry()) {
    const scores: EvaluationScore[] = [], judgeCalls: JudgeCall[] = [];
    if (!context.result.started || context.result.status !== 'completed' || !context.result.endpointReached)
        return { scores, judgeCalls };
    const metricKeys = new Set<string>();
    for (const check of checks) {
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
        if (def.kind === 'llm-judge' && !context.judge) {
            scores.push({ ...base, value: null, status: 'NOT_RUN', reason: 'Judge 未配置或关闭' });
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
    return { scores, judgeCalls };
}
