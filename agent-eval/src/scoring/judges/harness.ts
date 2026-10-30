import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { scanEvidence, protectedSecrets } from '../../execution/evidence-safety.ts';
import { requestJudge, prepareJudge, publicJudgeConfig, type JudgeConfig, type Fetcher } from './client.ts';
import type { StopReason } from '@earendil-works/pi-ai';
import { compactPlanSchema, parseCompactJudgment, parseMetricJudgment, parseStrictMetricJudgment, normalizeMetricJson, metricPolicyFor, metricRubrics, compactRubric, compactRubricFor, type CompactPlan, type CompactJudgment } from './compact.ts';
import {researchFrameSchema} from '../research-judgment.ts';
import {evaluatorEvidence} from './evaluators.ts';
import { judgeOutputSchema } from '../../text-model/judge-schema.ts';
import type { ProcessRunner } from '../../text-model/codex.ts';
import { encodeSharedTextInput, nativeJudgeMaxInputChars } from './shared-text.ts';
import { isNamedRubric, isMetricBatchRubric, parseMetricBatchJudgment, researchWitnessInstructions } from './compact.ts';
export function parseJudgment(text: string) { return z.object({ score: z.number().min(0).max(1), reason: z.string().trim().min(1) }).strict().parse(JSON.parse(text)); }
export async function runJudge(config: JudgeConfig, system: string, data: string, fetcher?: Fetcher, signal?: AbortSignal, plan?: CompactPlan,frame?:unknown,nativeRunner?:ProcessRunner,inputEncoding?:'flowmate-judge-shared-text/v1') {
    if (plan) plan = compactPlanSchema.parse(plan);
    const rubric = plan ? [compactRubric, ...metricRubrics, compactRubricFor(plan)].find(r=>r.prompt===system) ?? {id:'semantic-batch',version:1,prompt:system} : undefined;
    const named = isNamedRubric(rubric?.id);
    const parsePolicy=rubric?metricPolicyFor(rubric):undefined;
    const secrets = [...(config.provider === 'codex-cli' ? [] : [config.apiKey]), ...protectedSecrets()];
    const input = scanEvidence({ system, data }, secrets);
    const record = { callId: randomUUID(), configuration: publicJudgeConfig(config, rubric), startedAt: new Date().toISOString(), endedAt: '', attempts: 0, usage: null as unknown,
        responseModel: null as unknown, stopReason: null as StopReason | null, rawStopReason: null as string | null, responseComplete: false,
        usageSource: 'unknown' as 'sdk' | 'codex-cli' | 'unknown', transportStatus:null as number|null,
        ...(config.provider === 'codex-cli' ? { cost: null, internalRetries: null, cliVersion: null as string | null } : {}),
        raw: null as string | null, error: null as string | null, judgment: null as ReturnType<typeof parseJudgment> | null,
        request: { ...input.value,  redacted: (input.fact.actual as { leaked: boolean }).leaked },
        compact: plan ? { plan, judgment: null as CompactJudgment | null,
            ...(isMetricBatchRubric(rubric?.id) ? {scoringVersion:2 as const,...(inputEncoding?{inputEncoding}:{})} : {}),
            ...(named ? {format:'metric-id/v1' as const, validationErrors:{} as Record<string,string>} : {}),
            ...(parsePolicy?{parsePolicy,normalization:'none' as 'none'|'markdown-fence'}:{}) } : undefined };
    try {
        if (record.request.redacted) throw new Error('Judge input contained configured secret; redacted');
        if(config.provider==='codex-cli'&&data.length>nativeJudgeMaxInputChars)
            throw Error('Native Judge input exceeds '+nativeJudgeMaxInputChars+' characters after lossless projection; necessary evidence retained, no model submission');
        config = await prepareJudge(config, fetcher, signal);
        record.configuration = publicJudgeConfig(config, rubric);
        record.attempts = 1;
        const result = await requestJudge(config, system, data, fetcher, signal, judgeOutputSchema(plan), nativeRunner);
        if ('cliVersion' in result) record.cliVersion = result.cliVersion;
        record.raw = result.text;
        record.usage = result.usage;
        record.responseModel = result.responseModel;
        record.usageSource = result.usageSource;
        record.stopReason = result.stopReason;
        record.rawStopReason = result.rawStopReason;
        record.responseComplete = result.responseComplete;
        record.transportStatus=result.transportStatus;
        if (result.error) throw new Error(result.error);
        if (!result.responseComplete) throw new Error('Judge response incomplete (' + result.stopReason + ')');
        if (result.text === null) throw new Error('Judge response text unavailable');
        if (record.compact) {
            if (record.compact.parsePolicy){
                record.compact.normalization=normalizeMetricJson(result.text).normalization;
                Object.assign(record.compact,(isMetricBatchRubric(rubric?.id)?parseMetricBatchJudgment:parseStrictMetricJudgment)(result.text,record.compact.plan,frame));
            }
            else if (record.compact.format) Object.assign(record.compact, parseMetricJudgment(result.text, record.compact.plan, frame));
            else record.compact.judgment = parseCompactJudgment(result.text, record.compact.plan,frame);
        }
        else record.judgment = parseJudgment(result.text);
    }
    catch (error) {
        if(error instanceof Error&&'transportStatus'in error)record.transportStatus=error.transportStatus as number|null;
        if(error instanceof Error&&'cliVersion'in error&&(error.cliVersion===null||typeof error.cliVersion==='string'))record.cliVersion=error.cliVersion;
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
    }
    return scanned.value;
}

export function runCompactJudge(config: JudgeConfig, plan: CompactPlan, evidence: unknown, fetcher?: Fetcher, signal?: AbortSignal,nativeRunner?:ProcessRunner) {
    plan = compactPlanSchema.parse(plan);
    if (plan.encoding) throw Error('Legacy packed plans are read-only; regenerate the current plain JSON plan');
    const frame=plan.criteria.some(c=>c.metricId.startsWith('DR'))?researchFrameSchema.parse((evidence as{researchFrame?:unknown})?.researchFrame):undefined;
    const original=JSON.stringify({ plan, evidence:evaluatorEvidence(plan,evidence),...(frame?{researchWitnessRubric:researchWitnessInstructions}:{}) });
    const sharedText=config.provider==='codex-cli'&&original.length>nativeJudgeMaxInputChars;
    const data=sharedText?encodeSharedTextInput(original):original;
    return runJudge(config, compactRubricFor(plan,sharedText).prompt, data, fetcher, signal, plan,frame,nativeRunner,sharedText?'flowmate-judge-shared-text/v1':undefined);
}
