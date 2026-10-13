import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { scanEvidence, protectedSecrets } from '../../execution/evidence-safety.ts';
import { requestJudge, publicJudgeConfig, type JudgeConfig, type Fetcher } from './client.ts';
import { hash } from '../../dataset-loader/local.ts';
import { compactPlanSchema, parseCompactJudgment, compactRubricFor, type CompactPlan, type CompactJudgment } from './compact.ts';
import {researchFrameSchema} from '../research-judgment.ts';
export function parseJudgment(text: string) { return z.object({ score: z.number().min(0).max(1), reason: z.string().trim().min(1) }).strict().parse(JSON.parse(text)); }
export async function runJudge(config: JudgeConfig, system: string, data: string, fetcher?: Fetcher, signal?: AbortSignal, plan?: CompactPlan,frame?:unknown) {
    if (plan) plan = compactPlanSchema.parse(plan);
    const secrets = [config.apiKey, ...protectedSecrets()];
    const input = scanEvidence({ system, data }, secrets);
    const record = { callId: randomUUID(), configuration: publicJudgeConfig(config, plan ? compactRubricFor(plan) : undefined), startedAt: new Date().toISOString(), endedAt: '', attempts: 0, usage: null as unknown,
        responseModel: null as unknown, finishReason: null as string | null, responseComplete: false,
        raw: null as string | null, error: null as string | null, judgment: null as ReturnType<typeof parseJudgment> | null,
        request: { ...input.value, hash: hash([input.value.system, input.value.data]), redacted: (input.fact.actual as { leaked: boolean }).leaked },
        compact: plan ? { plan, judgment: null as CompactJudgment | null } : undefined };
    try {
        if (record.request.redacted) throw new Error('Judge input contained configured secret; redacted');
        const result = await requestJudge(config, system, data, (url, init) => { record.attempts++; return (fetcher ?? fetch)(url, init); }, signal);
        record.raw = result.text;
        record.usage = result.usage;
        record.responseModel = result.responseModel;
        record.finishReason = result.finishReason;
        record.responseComplete = result.responseComplete;
        if (!result.responseComplete) throw new Error('Judge response incomplete (' + (result.finishReason ?? 'unknown') + ')');
        if (result.text === null) throw new Error('Judge response text unavailable');
        if (record.compact) record.compact.judgment = parseCompactJudgment(result.text, record.compact.plan,frame);
        else record.judgment = parseJudgment(result.text);
    }
    catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
    }
    record.endedAt = new Date().toISOString();
    const scanned = scanEvidence(record, secrets);
    if (scanned.fact.actual && (scanned.fact.actual as {
        leaked: boolean;
    }).leaked) {
        scanned.value.error = record.request.redacted ? 'Judge input contained configured secret; redacted' : 'Judge response contained configured secret; redacted';
        scanned.value.judgment = null;
        if (scanned.value.compact) scanned.value.compact.judgment = null;
        scanned.value.request.redacted ||= record.request.system !== scanned.value.request.system || record.request.data !== scanned.value.request.data;
        scanned.value.request.hash = hash([scanned.value.request.system, scanned.value.request.data]);
    }
    return scanned.value;
}

export function runCompactJudge(config: JudgeConfig, plan: CompactPlan, evidence: unknown, fetcher?: Fetcher, signal?: AbortSignal) {
    plan = compactPlanSchema.parse(plan);
    if (plan.encoding) throw Error('Legacy packed plans are read-only; regenerate the current plain JSON plan');
    const frame=plan.criteria.some(c=>c.metricId.startsWith('DR'))?researchFrameSchema.parse((evidence as{researchFrame?:unknown})?.researchFrame):undefined;
    return runJudge(config, compactRubricFor(plan).prompt, JSON.stringify({ plan, evidence }), fetcher, signal, plan,frame);
}
