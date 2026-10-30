import { legacyCompactRubric, legacyPlainRubric, legacyPackedRubric } from '../scoring/judges/packed.ts';
import { atomicJson, publicVersions, publicReport, readPublicReport, saveEvidence, executionVersions } from './files.ts';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname, basename } from 'node:path';
import { z } from 'zod';
import { isJsonData } from '../../../packages/contracts/src/tools.ts';
import type { CaseExecutionResult, GradeStatus } from '../types.ts';
import type { EvaluationScore, JudgeCall, MetricPlan } from '../scoring/types.ts';
import {scoreMeasurement} from '../scoring/types.ts';
import type {EvaluatorPlanEntry} from '../scoring/evaluator-plan.ts';
import {scoringMetric} from '../scoring/diagnostic-plans.ts';
import { aggregateTrials, type TrialAggregation } from '../scoring/aggregate.ts';
import { parseJudgment } from '../scoring/judges/harness.ts';
import { compactPlanSchema, compactResultSchema, compactRubric, metricRubrics, metricPolicyFor, metricParsePolicy, normalizeMetricJson, parseStrictMetricJudgment, parseMetricJudgment, parseCompactJudgment,parseLegacyCompactJudgment, compactScores, type CompactPlan } from '../scoring/judges/compact.ts';
import { isDeepStrictEqual } from 'node:util';
import { isSharedTextRubric } from '../scoring/judges/compact.ts';
import { isNamedRubric, isMetricBatchRubric, usesSharedText, metricBatchParsePolicy, parseMetricBatchJudgment, researchWitnessInstructions } from '../scoring/judges/compact.ts';
import { readEvaluatorSnapshots } from '../scoring/judges/evaluators.ts';
import { EvaluationCalibrationViewSchema } from '../../../packages/contracts/src/evaluation.ts';
import { decodeJudgeInput } from '../scoring/judges/shared-text.ts';
import { artifactJson } from '../artifacts.ts';
import { scanEvidence, protectedSecrets } from '../execution/evidence-safety.ts';
import { inside } from '../dataset-loader/local.ts';
import { agentApiSchema, agentModelCapabilitiesSchema, langfuseUrlSchema } from '../configuration.ts';
import {researchFrameSchema,unavailableResearchCounts} from '../scoring/research-judgment.ts';
import {hasNoResearchReport} from '../scoring/research-frame.ts';
import { safeId } from './paths.ts';
import { isSafetyMetric, localSafetyFailure } from '../scoring/safety.ts';
import { regressionOriginListSchema, type RegressionOrigin } from '../dataset-loader/regression-origin.ts';
import { deriveTrialStatistics, type TrialStatistics } from './trial-statistics.ts';
import { archiveFile, archiveReference, isArchiveReference, readArchivePart, writeArchivePart, readSnapshot } from './archive.ts';
export { safeId, reportPath } from './paths.ts';
export type TrialReport = {
    sessionId?: string;
    regressionOrigins?: RegressionOrigin[];
    caseId: string;
    caseVersion: number;
    caseConditions?: Record<string,unknown>;
    purpose?: 'capability'|'regression';
    caseName: string;
    category: string;
    partition: 'smoke' | 'holdout' | 'full' | 'badcase';
    repetition: number;
    trialId: string;
    traceId: string;
    status: GradeStatus;
    reason: string;
    counts: Record<string, number>;
    execution: CaseExecutionResult | null;
    scores: EvaluationScore[];
    metricPlan?: MetricPlan[];
    semanticPlan?: CompactPlan;
    evaluatorPlan?: EvaluatorPlanEntry[];
    judgeCalls: JudgeCall[];
    feedback: 'none';
};
export type LocalReport = {
    history?: {verification:'unverified';gaps:string[]};
    executionKind?: 'controlled' | 'model';
    contract: 'flowmate-agent-run/v1' | 'flowmate-agent-run/v2';
    aggregation?: TrialAggregation;
    trialStatistics?: TrialStatistics;
    executionId: string;
    runId?: string;
    code?: {
        commit?: string;

        release: string;
        dirty: boolean;
    };
    userId?: string;
    dataset: {
        id: string;
        version: number;

        subject: 'agent';
    };
    selection: 'smoke' | 'holdout' | 'full' | 'case';
    environment: string;
    startedAt: string;
    endedAt: string | null;
    repeat: number;
    executionComplete: boolean;
    sourceInvalidation?: {reason:string;paths:string[]};
    scoring: 'pending' | 'complete';
    manualReview: 'none';
    formalAcceptance: 'not-assessed';
    scoringConfiguration: {
        version: number;
        scoringVersion?: 2;
        judgeMode: 'off' | 'auto' | 'required';

        judge?: JudgeCall['configuration'] | null;
        rubrics?: Array<{ id: string; version: number; prompt: string }>;
    };
    trials: TrialReport[];
    export: {
        backend: 'local' | 'langfuse';
        status: 'disabled' | 'pending' | 'complete' | 'partial' | 'error';
        progress?: { total: number; acceptedEventIds: string[]; rejectedEventIds: string[]; scoreTimestamp?: string; knownScoreIds?: string[] };
        target?: { baseUrl: string; projectId: string };
        error?: string;
        url?: string;
    };
};
const text = z.string().min(1), integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), positive = integer.positive();
const reportRevisions = new WeakMap<LocalReport, { path: string; bytes: string }>();
const timestamp = z.string().datetime(), status = z.enum(['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN']);
const inputSchema = z.object({ prompt: z.string(), materials: z.array(z.object({ sample: text, file: text, text: z.string() }).strict()) }).strict();
const scoreSchema = z.object({ metricId: text, name: text, version: positive, method: z.enum(['deterministic', 'llm-judge']), required: z.boolean(),
    evaluatorId:text.optional(),evaluatorVersion:positive.optional(),category:z.enum(['formal','diagnostic','guardrail']).optional(),applicabilityReason:text.optional(),
    calibration:EvaluationCalibrationViewSchema.optional(),
    value: z.number().finite().min(0).max(1).nullable(), status: z.enum([...status.options, 'NOT_APPLICABLE']), reason: z.string(), evidence: z.array(text),
    statistics: z.object({ unit: text, numerator: integer.nullable(), denominator: integer.nullable(), missing: integer.nullable() }).strict().optional(),
    judge: z.object({ callId: text, criterion: integer }).strict().optional(),
    actual: z.unknown().optional(), expected: z.unknown().optional() }).strict().refine(s => (s.value !== null) === ['PASS', 'FAIL'].includes(s.status) ||
        s.value === null && s.status === 'FAIL' && !!s.statistics && ((s.statistics.missing ?? 0) > 0 || s.statistics.denominator===null),
        'Only measured PASS/FAIL scores have a value; a partially assessed failure needs its original compact counts');
const executionSchema = z.object({ identity: z.object({ executionId: text, trialId: text, caseId: text, caseVersion: positive }).strict(),
    started: z.boolean(), status: z.enum(['completed', 'failed', 'timeout', 'cancelled', 'error', 'not-started']), endpointReached: z.boolean(),
    input: inputSchema, answer: z.string().nullable(), artifacts: z.array(z.object({ id: text, kind: text, content: z.unknown() }).strict()),
    observations: z.array(z.object({ id: text, parentId: text.optional(), kind: z.enum(['span', 'generation', 'tool']), name: text,
        startedAt: timestamp, endedAt: timestamp.nullable(), input: z.unknown().optional(), output: z.unknown().optional(), model: text.optional(),
        parameters: z.record(z.unknown()).optional(), usage: z.record(z.number().finite().nonnegative()).optional() }).strict()),
    evidence: z.record(z.object({ present: z.boolean(), actual: z.unknown(), source: text }).strict()
        .refine(f => !f.present || f.actual !== undefined, 'Present evidence requires actual data')),
    configuration: z.record(z.unknown()), usage: z.record(z.number().finite().nonnegative().nullable()),
    startedAt: timestamp.nullable(), endedAt: timestamp.nullable(),
    error: z.object({ code: text, message: z.string(), infrastructure: z.boolean() }).strict().optional() }).strict();
// Legacy v1 calls lack completion metadata; preserve their fields without inventing a modern completion proof.
export const legacyJudgeConfigurationSchema = z.object({ provider: z.enum(['anthropic', 'openai-compatible']), model: text,
    baseUrl: z.string().url(), temperature: z.number().finite().min(0).max(2).optional(), maxTokens: positive.optional(), timeoutMs: positive,
    modelCapabilities: z.object({modelId:text,maxOutputTokens:positive,source:z.enum(['anthropic-models-api','deepseek-models-api'])}).strict().optional(),
    protocolVersion: text.optional(), rubric: z.object({ id: text, version: positive }).strict().optional()
    }).strict();
export const sdkJudgeConfigurationSchema = legacyJudgeConfigurationSchema.omit({temperature:true,maxTokens:true,modelCapabilities:true}).extend({
    provider:z.enum(['anthropic','openai-compatible']).optional(),api:agentApiSchema,
    reasoningEffort:z.enum(['none','minimal','low','medium','high','xhigh','max']).optional(),
    sdk:z.object({codingAgent:text,ai:text}).strict(),modelCapabilities:agentModelCapabilitiesSchema.optional()
});
export const nativeJudgeConfigurationSchema = z.object({ transport: z.literal('codex-cli'), provider: z.literal('codex-cli'), model: text,
    reasoningEffort: z.enum(['none','minimal','low','medium','high','xhigh','max']), timeoutMs: positive,
    protocolVersion: text, rubric: z.object({id:text,version:positive}).strict().optional() }).strict();
export const judgeConfigurationSchema = z.union([sdkJudgeConfigurationSchema,nativeJudgeConfigurationSchema,legacyJudgeConfigurationSchema]);
const judgeCallBase = z.object({ callId: text, startedAt: timestamp, endedAt: timestamp, attempts: integer.max(1),
    usage: z.unknown(), responseModel: z.unknown(), raw: z.string().nullable(), error: z.string().nullable(),
    transportStatus:z.number().int().min(100).max(599).nullable().optional(),
    judgment: z.object({ score: z.number().finite().min(0).max(1), reason: text }).strict().nullable(),
    request: z.object({ system: z.string(), data: z.string(),  redacted: z.boolean() }).strict().optional(),
    compact: z.object({ plan: compactPlanSchema, judgment: compactResultSchema.nullable(), format: z.literal('metric-id/v1').optional(),
        validationErrors: z.record(text).optional(),parsePolicy:z.enum([metricParsePolicy,metricBatchParsePolicy]).optional(),
        scoringVersion:z.literal(2).optional(),inputEncoding:z.literal('flowmate-judge-shared-text/v1').optional(),
        normalization:z.enum(['none','markdown-fence']).optional() }).strict().optional() }).strict();
export const judgeCallSchema = z.union([
    judgeCallBase.extend({ configuration: legacyJudgeConfigurationSchema, finishReason: z.string().nullable().optional(), responseComplete: z.boolean().optional() }),
    judgeCallBase.extend({ configuration: sdkJudgeConfigurationSchema, stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']).nullable(),
        rawStopReason: z.string().nullable(), usageSource: z.enum(['sdk', 'unknown']), responseComplete: z.boolean() }),
    judgeCallBase.extend({ configuration: nativeJudgeConfigurationSchema, stopReason: z.enum(['stop','error','aborted']).nullable(),
        rawStopReason: z.string().nullable(), usageSource: z.enum(['codex-cli','unknown']), responseComplete: z.boolean(),
        cliVersion: text.nullable(), cost: z.null(), internalRetries: z.null() })
]);
const trialSchema = z.object({ sessionId: text.max(199).optional(), caseId: text, caseVersion: positive, caseConditions: z.record(z.unknown()).optional(), caseName: text, category: text, purpose:z.enum(['capability','regression']).optional(),
    partition: z.enum(['smoke', 'holdout', 'full', 'badcase']), regressionOrigins: regressionOriginListSchema.optional(), repetition: positive, trialId: text, traceId: z.string().regex(/^[a-f0-9]{32}$/),
    status, reason: z.string(), counts: z.record(integer), execution: executionSchema.nullable(), scores: z.array(scoreSchema),
    metricPlan: z.array(z.object({ metricId: text, version: positive, unit: text, denominator: integer.nullable().optional(),
        notApplicable: text.optional() }).strict()).optional(), semanticPlan: compactPlanSchema.optional(),
    evaluatorPlan:z.array(z.object({evaluatorId:text,version:positive,kind:z.enum(['deterministic','llm-judge']),applicable:z.boolean(),reason:text,
        outputs:z.array(z.object({metricId:text,category:z.enum(['formal','diagnostic','guardrail']),applicable:z.boolean(),reason:text,required:z.boolean(),denominator:integer.nullable().optional()}).strict())}).strict()).optional(),
    judgeCalls: z.array(judgeCallSchema).max(1), feedback: z.literal('none') }).strict();
const reportSchema = z.object({ contract: z.enum(['flowmate-agent-run/v1', 'flowmate-agent-run/v2']), executionId: text,
    runId: text.optional(),
    executionKind: z.enum(['controlled', 'model']).optional(),
    history:z.object({verification:z.literal('unverified'),gaps:z.array(text).min(1)}).strict().optional(),
    aggregation: z.unknown().optional(),
    trialStatistics: z.unknown().optional(),
    code: z.object({ commit: text.optional(),  release: text, dirty: z.boolean() }).strict().optional(), userId: text.optional(),
    dataset: z.object({ id: text, version: positive,  subject: z.literal('agent') }).strict(), selection: z.enum(['smoke', 'holdout', 'full', 'case']),
    environment: text, startedAt: timestamp, endedAt: timestamp.nullable(), repeat: positive.max(20), executionComplete: z.boolean(),
    sourceInvalidation: z.object({reason:text,paths:z.array(text).min(1).refine(paths=>new Set(paths).size===paths.length)}).strict().optional(),
    scoring: z.enum(['pending', 'complete']), manualReview: z.literal('none'), formalAcceptance: z.literal('not-assessed'),
    scoringConfiguration: z.object({ version: positive, scoringVersion:z.literal(2).optional(), judgeMode: z.enum(['off', 'auto', 'required']),
        judge: judgeConfigurationSchema.nullable().optional(),
        rubrics: z.array(z.object({id:text,version:positive,prompt:text}).strict()).refine(items=>new Set(items.map(r=>r.id)).size===items.length).optional() }).strict(),
    trials: z.array(trialSchema), export: z.object({ backend: z.enum(['local', 'langfuse']), status: z.enum(['disabled', 'pending', 'complete', 'partial', 'error']),
        progress: z.object({ total: integer, acceptedEventIds: z.array(text), rejectedEventIds: z.array(text), scoreTimestamp: timestamp.optional(),
            knownScoreIds: z.array(text).optional() }).strict().refine(p =>
            new Set(p.acceptedEventIds).size === p.acceptedEventIds.length && new Set(p.rejectedEventIds).size === p.rejectedEventIds.length &&
            p.acceptedEventIds.length <= p.total && p.rejectedEventIds.length <= p.total && !p.rejectedEventIds.some(id => p.acceptedEventIds.includes(id)) &&
            (!p.knownScoreIds || new Set(p.knownScoreIds).size === p.knownScoreIds.length && p.knownScoreIds.length <= p.total),
            'Export receipt identities must be unique and disjoint').optional(),
        target: z.object({ baseUrl: langfuseUrlSchema, projectId: text.max(200) }).strict().optional(),
        error: z.string().optional(), url: z.string().optional() }).strict() }).strict();
const publicMetadataSchema = reportSchema.omit({ trials: true, export: true }).extend({
    artifactFormat: z.literal('flowmate-eval-public/v1'),
    trials: z.array(trialSchema.omit({ execution: true, judgeCalls: true }).extend({
        evidence: z.object({ trial: text, observation: text, events: text }).strict(),
        dimensions: z.record(z.object({ status: z.enum([...status.options, 'NOT_APPLICABLE']), counts: z.record(integer) }).strict()).optional(),
    })),
});
type InspectionKind = 'trial' | 'observation' | 'events' | 'artifact' | 'export';
export type ReportInspection = {
    metadata: z.infer<typeof publicMetadataSchema>; fullReport: LocalReport | null; export: LocalReport['export'] | null;
    parts: Array<{ trialId: string | null; kind: InspectionKind; reference: string; data: unknown }>;
    gaps: Array<{ trialId: string | null; kind: InspectionKind; reference: string; reason: 'missing' | 'invalid' }>;
    sources: Array<{ reference: string; content: string | null }>;
    snapshot: { data: unknown | null; issue: 'missing' | 'invalid' | null };
};
function validateReport(value: unknown): asserts value is LocalReport {
    if (!value || typeof value !== 'object' || !('contract' in value) ||
        !['flowmate-agent-run/v1', 'flowmate-agent-run/v2'].includes(String(value.contract)))
        throw new Error('Historical report is read-only; no regrading or new export');
    if (!isJsonData(value)) throw new Error('Report must contain finite JSON data');
    reportSchema.parse(value);
    const report = value as LocalReport, trials = new Set<string>(), traces = new Set<string>(), members = new Set<string>(), calls = new Set<string>();
    if(report.sourceInvalidation && (report.executionComplete || report.endedAt===null || report.trials.some(t=>t.status!=='ERROR')))
        throw Error('Source invalidation contradicts final execution state');
    if (report.selection === 'holdout' && report.trials.some(trial => trial.partition !== 'holdout'))
        throw new Error('Smoke Trial cannot appear in holdout selection');
    safeId(report.executionId);
    for (const trial of report.trials) {
        if (trial.regressionOrigins && !report.executionKind) throw Error('Regression origins require an execution kind');
        if ((trial.partition === 'badcase') !== !!trial.regressionOrigins) throw Error('Supplemental partition requires its original regression links');
        const member = JSON.stringify([trial.caseId, trial.caseVersion, trial.caseConditions, trial.repetition]);
        if (trials.has(trial.trialId) || traces.has(trial.traceId) || members.has(member) || trial.repetition > report.repeat)
            throw new Error('Duplicate or out-of-plan Trial identity');
        trials.add(trial.trialId); traces.add(trial.traceId); members.add(member);
        const id = trial.execution?.identity;
        if (id && (id.executionId !== report.executionId || id.trialId !== trial.trialId || id.caseId !== trial.caseId || id.caseVersion !== trial.caseVersion))
            throw new Error('Original execution identity differs from its Trial');
        if (new Set(trial.scores.map(s => s.metricId)).size !== trial.scores.length) throw new Error('Duplicate score identity');
        for (const criterion of trial.semanticPlan?.criteria ?? []) {
            if(criterion.metricId.startsWith('diagnostic-')){
                const declared=trial.evaluatorPlan?.flatMap(e=>e.outputs).find(o=>o.metricId===criterion.metricId),metric=scoringMetric(criterion.metricId);
                if(!declared?.applicable||declared.category!=='diagnostic'||declared.denominator!==criterion.denominator||
                    declared.required!==criterion.required||criterion.version!==metric.version||criterion.unit!==metric.unit)
                    throw Error('Semantic diagnostic differs from its frozen evaluator plan');
                continue;
            }
            const metric = trial.metricPlan?.find(m => m.metricId === criterion.metricId);
            if (report.contract !== 'flowmate-agent-run/v2' || !metric || metric.notApplicable || metric.version !== criterion.version ||
                metric.unit !== criterion.unit || metric.denominator !== criterion.denominator)
                throw new Error('Declared semantic criterion differs from its metric opportunity plan');
        }
        const deterministic=trial.scores.filter(s=>s.method==='deterministic'&&trial.semanticPlan?.criteria.some(c=>c.metricId===s.metricId));
        for(const score of deterministic.filter(s=>isSafetyMetric(s.metricId))){
            const criterion=trial.semanticPlan!.criteria.find(c=>c.metricId===score.metricId)!;
            const original=trial.execution&&localSafetyFailure(criterion,trial.execution);
            if(!original||!isDeepStrictEqual(scoreMeasurement(score),scoreMeasurement(original)))throw Error('Local safety measurement contradicts its original scoped effects');
        }
        const local=deterministic.filter(s=>!isSafetyMetric(s.metricId));
        if(local.length){
            const frames=local.flatMap(s=>(s.actual as any)?.researchFrame?[(s.actual as any).researchFrame]:[]);
            if(frames.length!==1||!trial.execution?.started||trial.execution.error?.infrastructure)throw Error('Local research measurement lacks its original frame');
            const frame=researchFrameSchema.parse(frames[0]);
            if(!frame.complete||frame.reportId!==null||frame.blocks.length||frame.links.length||
                !hasNoResearchReport(trial.execution.evidence.research))throw Error('Local no-Report proof differs from original collection');
            const counts=unavailableResearchCounts(frame);
            for(const score of local){
                const measured=counts[score.metricId],actual=score.actual as any,criterion=trial.semanticPlan!.criteria.find(c=>c.metricId===score.metricId)!;
                if(!measured||actual?.locallyDerived!==true||score.judge)throw Error('Unsupported local semantic measurement');
                const row=measured.row,value=row&&row[1]>0&&row[2]===0?row[0]/row[1]:null;
                if(score.version!==criterion.version||score.required!==criterion.required||
                    criterion.denominator!==null&&row?.[1]!==criterion.denominator||
                    criterion.trigger==='completed-endpoint'&&(trial.execution.status!=='completed'||!trial.execution.endpointReached))
                    throw Error('Local research measurement differs from its frozen criterion');
                const status=measured.knownFailure?'FAIL':value!==null?'PASS':'UNJUDGEABLE';
                if(!isDeepStrictEqual([score.statistics,actual.row,actual.opportunities,score.value,score.status],
                    [measured.statistics,row,measured.opportunities,value,status]))throw Error('Local research counts contradict original no-Report evidence');
            }
        }
        for (const call of trial.judgeCalls) {
            if (calls.has(call.callId)) throw new Error('Duplicate Judge call identity');
            calls.add(call.callId);
            if(call.transportStatus!==undefined&&(call.attempts===0&&call.transportStatus!==null||
                call.transportStatus!==null&&call.transportStatus>=400&&(call.responseComplete||call.error===null)))
                throw Error('Judge transport status contradicts its original attempt or completion');
            if(report.scoringConfiguration.judge){
                const {rubric:_,...actual}=call.configuration,{rubric:__,...declared}=report.scoringConfiguration.judge;
                if(!isDeepStrictEqual(actual,declared))throw Error('Judge differs from declared scoring configuration');
            }
            if (report.scoringConfiguration.rubrics) {
                const {rubric:_,...actual} = call.configuration;
                const {rubric:___,...declared} = report.scoringConfiguration.judge??{};
                if (!isDeepStrictEqual(actual, declared)) throw Error('Judge differs from frozen connection configuration');
                if (!report.scoringConfiguration.rubrics.some(r=>r.id===call.configuration.rubric?.id && r.version===call.configuration.rubric?.version && r.prompt===call.request?.system))
                    throw Error('Judge template is outside the frozen template set');
            }
            if (call.request && (call.request.redacted &&
                (call.judgment !== null || call.compact?.judgment != null))) throw new Error('Stored Judge input identity or redaction contradicts its judgment');
            if (report.contract === 'flowmate-agent-run/v2') {
                const sdk = call.configuration.sdk !== undefined;
                const native = 'transport' in call.configuration && call.configuration.transport === 'codex-cli';
                if (call.configuration.protocolVersion !== 'flowmate-judge/v2' || (!sdk && !native && call.finishReason === undefined) || call.responseComplete === undefined)
                    throw new Error('Modern Judge completion metadata is missing or unsupported');
                const completed = sdk || native ? call.stopReason === 'stop' : call.configuration.provider === 'anthropic' ? ['end_turn', 'stop_sequence'].includes(call.finishReason ?? '') : call.finishReason === 'stop';
                if (sdk && call.attempts === 1 && !call.configuration.modelCapabilities) throw Error('SDK Judge native capabilities are missing');
                if (call.responseComplete && !completed || call.judgment !== null &&
                    (!call.responseComplete || call.attempts !== 1 || call.error !== null || call.raw === null ||
                        JSON.stringify(parseJudgment(call.raw)) !== JSON.stringify(call.judgment)))
                    throw new Error('Stored Judge judgment contradicts original completion or text');
            }
            if (call.compact) {
                const rubric=[legacyCompactRubric,legacyPlainRubric,legacyPackedRubric,compactRubric,...metricRubrics].find(r=>call.request?.system===r.prompt);
                if (report.contract !== 'flowmate-agent-run/v2' || !call.request || !rubric || call.judgment !== null)
                    throw new Error('Compact Judge needs its original versioned input and exclusive judgment');
                if (call.configuration.rubric && !isDeepStrictEqual(call.configuration.rubric, { id: rubric.id, version: rubric.version }))
                    throw new Error('Compact Judge Rubric differs from declared scoring configuration');
                const named = isNamedRubric(rubric.id);
                const independent = isMetricBatchRubric(rubric.id);
                if(independent !== (call.compact.scoringVersion===2) || !independent && call.compact.inputEncoding)
                    throw Error('Judge scoring version contradicts its original template');
                const parsePolicy=metricPolicyFor(rubric);
                const normalization=call.raw!==null&&call.responseComplete?normalizeMetricJson(call.raw).normalization:'none';
                if(call.compact.parsePolicy!==parsePolicy||(parsePolicy?
                    call.compact.normalization!==normalization||call.transportStatus===undefined:call.compact.normalization!==undefined))
                    throw Error('Judge parsing policy or normalization contradicts the original template and response');
                if (named !== (call.compact.format==='metric-id/v1') || named &&
                    (call.configuration.rubric?.id!==rubric.id || call.configuration.rubric?.version!==rubric.version || !call.compact.validationErrors) ||
                    !named && call.compact.validationErrors!==undefined)
                    throw Error('Judge format or validation errors contradict the original template');
                const wire = JSON.parse(call.request.data);
                if(call.request.data!==JSON.stringify(wire))throw Error('Compact Judge request encoding differs from its original data');
                const input = decodeJudgeInput<{plan:unknown;evidence?:{researchFrame?:unknown}}>(call.request.data,usesSharedText(call));
                const definitions = independent ? readEvaluatorSnapshots(call.compact.plan,input.evidence) : undefined;
                if(independent){
                    const controlled=z.object({plan:compactPlanSchema,evidence:z.unknown(),researchWitnessRubric:z.string().optional()}).strict().parse(input);
                    if(controlled.researchWitnessRubric!==(call.compact.plan.criteria.some(c=>c.metricId.startsWith('DR'))?researchWitnessInstructions:undefined))
                        throw Error('Research protocol differs from its saved batch template');
                }
                if (!isDeepStrictEqual(input.plan, call.compact.plan)) throw new Error('Compact Judge plan differs from its original request');
                const parsed = call.compact.judgment!==null && call.raw!==null ? named
                    ? (independent?parseMetricBatchJudgment:parsePolicy?parseStrictMetricJudgment:parseMetricJudgment)(call.raw,call.compact.plan,input.evidence?.researchFrame)
                    : {judgment:call.request.system === legacyCompactRubric.prompt ? parseLegacyCompactJudgment(call.raw,call.compact.plan) : parseCompactJudgment(call.raw,call.compact.plan,input.evidence?.researchFrame),validationErrors:undefined} : null;
                if (call.compact.judgment !== null && (!call.responseComplete || call.attempts !== 1 || call.error !== null || call.raw === null ||
                    !isDeepStrictEqual(parsed?.judgment, call.compact.judgment) || named && !isDeepStrictEqual(parsed?.validationErrors,call.compact.validationErrors)) ||
                    call.compact.judgment === null && call.error === null)
                    throw new Error('Stored compact judgment contradicts original completion or text');
                const measured = compactScores(call);
                const expectedEncoding=trial.semanticPlan?.encoding;
                const selectedEncoding=expectedEncoding?.research&&!call.compact.plan.criteria.some(c=>c.metricId.startsWith('DR'))
                    ?{...expectedEncoding,research:false,maxFacts:0,maxLinks:0,maxChains:0}:expectedEncoding;
                if(!isDeepStrictEqual(call.compact.plan.encoding,selectedEncoding))throw new Error('Compact output encoding differs from its declared Trial');
                let previous = -1;
                for (const [index, criterion] of call.compact.plan.criteria.entries()) {
                    const position = trial.semanticPlan?.criteria.findIndex(c => c.metricId === criterion.metricId) ?? -1;
                    if (position <= previous || !isDeepStrictEqual(trial.semanticPlan?.criteria[position], criterion))
                        throw new Error('Compact criterion differs from the complete declared semantic plan');
                    previous = position;
                    const expected = measured[index];
                    if(definitions){
                        const score=trial.scores.find(s=>s.metricId===criterion.metricId),definition=definitions[index]!;
                        if(score?.evaluatorId!==definition.id || score.evaluatorVersion!==definition.version ||
                            (trial.evaluatorPlan||report.scoringConfiguration.scoringVersion===2)&&trial.evaluatorPlan?.find(p=>p.evaluatorId===definition.id)?.version!==definition.version)
                            throw Error('Metric score differs from its saved Evaluator definition');
                    }
                    if (!isDeepStrictEqual(scoreMeasurement(trial.scores.find(s => s.judge?.callId === call.callId && s.judge.criterion === index)), scoreMeasurement(expected)))
                        throw new Error('Semantic score differs from its original compact criterion counts');
                }
            }
        }
        if (trial.scores.some(s => s.judge && (s.method !== 'llm-judge' || !trial.judgeCalls.some(call => call.callId === s.judge!.callId &&
                call.compact && s.judge!.criterion < call.compact.plan.criteria.length)) ||
            s.method === 'llm-judge' && !s.judge && s.value !== null && s.value !== trial.judgeCalls[0]?.judgment?.score))
            throw new Error('Semantic score lacks its original Judge judgment');
    }
    if (report.contract === 'flowmate-agent-run/v1' && (report.aggregation !== undefined))
        throw new Error('Legacy v1 report cannot claim inferred v2 aggregation');
    if (report.contract === 'flowmate-agent-run/v2' && JSON.stringify((report.aggregation)) !== JSON.stringify((aggregateTrials(value as LocalReport))))
        throw new Error('Stored aggregation differs from original Trial records');
    if (report.trialStatistics !== undefined && !isDeepStrictEqual((report.trialStatistics), (deriveTrialStatistics(value as LocalReport))))
        throw new Error('Trial statistics differ from original Trial records');
}
export function saveReport(path: string, report: LocalReport) {
    if(report.history)throw Error('Historical reports are read-only; original facts cannot be verified');
    if(report.scoringConfiguration.judge===undefined){const call=report.trials.flatMap(t=>t.judgeCalls)[0];if(call){const{rubric,...connection}=call.configuration;report.scoringConfiguration.judge=connection;}}
    if (report.contract === 'flowmate-agent-run/v2') report.aggregation = aggregateTrials(report);
    JSON.stringify(report, (_, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Report must contain finite JSON data');
        return value;
    });
    validateReport(JSON.parse(JSON.stringify(report)));
    if (isArchiveReference(path)) {
        let previous: LocalReport | undefined;
        try { previous = readArchivePart(path); } catch (error) { if (!missingFile(error)) throw error; }
        if (previous) {
            const facts = ({ export: _, ...value }: LocalReport) => value;
            if (previous.endedAt !== null && !isDeepStrictEqual(facts(previous), facts(report))) throw Error('Completed report facts are immutable');
            const planned = (value: LocalReport) => ({ dataset: value.dataset, executionId: value.executionId, runId: value.runId,
                selection: value.selection, repeat: value.repeat, startedAt: value.startedAt, environment: value.environment,
                scoring: value.scoringConfiguration, trials: value.trials.map(trial => [trial.trialId, trial.traceId, trial.caseId,
                    trial.caseVersion, trial.repetition, trial.caseConditions, trial.metricPlan, trial.semanticPlan, trial.evaluatorPlan]) });
            if (!isDeepStrictEqual(planned(previous), planned(report))) throw Error('Declared report identity or Trial plan cannot be overwritten');
            const revision = reportRevisions.get(report);
            if (previous.endedAt === null && revision && revision.bytes !== artifactJson(previous)) throw Error('Stale open report');
        }
        writeArchivePart(path, report, previous ?? null);
        const stored = readReport(path); reportRevisions.set(report, reportRevisions.get(stored)!); return stored;
    }
    const root=dirname(path), record=publicReport(report);
    if(existsSync(path)) {
        if(lstatSync(path).isSymbolicLink())throw Error('Linked report rejected');
        const bytes=readFileSync(path,'utf8'),prior=JSON.parse(bytes);
        if (removeLegacyMetadata(prior)) throw Error('Historical reports are read-only');
        if(prior.endedAt===null&&reportRevisions.has(report)&&reportRevisions.get(report)!.bytes!==bytes)throw Error('Stale open report');
        const plan=(r:any)=>JSON.stringify({dataset:r.dataset,executionKind:r.executionKind,selection:r.selection,environment:r.environment,startedAt:r.startedAt,repeat:r.repeat,scoring:r.scoringConfiguration,members:r.trials.map((t:any)=>[t.caseId,t.caseVersion,t.repetition,t.trialId,t.traceId,t.metricPlan,t.semanticPlan,t.evaluatorPlan,t.partition,t.regressionOrigins])});
        if(plan(prior)!==plan(record))throw Error('Declared report identity or Trial plan cannot be overwritten');
        if(prior.endedAt!==null&&JSON.stringify(prior)!==JSON.stringify(record))throw Error('Completed report facts are immutable');
        if(prior.endedAt!==null){
            const saved=readPublicReport(path,prior);
            const evidence=(r:LocalReport)=>artifactJson(r.trials.map(t=>({execution:publicVersions(t.execution),judgeCalls:publicVersions(t.judgeCalls),scores:publicVersions(t.scores)})));
            if(!isDeepStrictEqual(JSON.parse(evidence(saved)),JSON.parse(evidence(report))))throw Error('Completed report evidence is immutable');
        }
    }
    saveEvidence(root,report);atomicJson(path,record);const stored=readReport(path);reportRevisions.set(report,reportRevisions.get(stored)!);return stored;
}
// Legacy identity metadata is discarded only at its documented positions; original scores stay unchanged.
function removeLegacyMetadata(report:any) {
    let legacy=report.frozenConditions!==undefined;
    delete report.frozenConditions;
    const drop=(record:any,keys:string[])=>{if(!record||typeof record!=='object')return;for(const key of keys)if(Object.hasOwn(record,key)){delete record[key];legacy=true;}};
    drop(report.code,['workspaceHash']);drop(report.dataset,['hash']);drop(report.scoringConfiguration,['judgeHash']);
    const configuration=(c:any)=>{drop(c,['configHash']);drop(c?.rubric,['hash']);};
    configuration(report.scoringConfiguration?.judge);
    for(const t of report.trials??[]){drop(t,['caseHash']);for(const call of t.judgeCalls??[]){configuration(call.configuration);drop(call.request,['hash']);}}
    for(const c of report.aggregation?.cases??[])drop(c,['caseHash']);
    if(legacy||(report.trials??[]).some((t:any)=>!t.caseConditions))report.history={verification:'unverified',gaps:['Original content conditions are unavailable; historical identity metadata cannot establish equivalence.']};
    return !!report.history;
}
function readReportSnapshot(path: string, bytes: string, readSource?: (reference: string) => string): LocalReport {
    const raw=JSON.parse(bytes);
    const report=raw.artifactFormat==='flowmate-eval-public/v1'?readPublicReport(path,raw,readSource):raw;
    delete report.artifactFormat;
    if(removeLegacyMetadata(report)){
        if(!isJsonData(report))throw Error('Historical report must contain finite JSON data');
        reportSchema.parse(report);
    }else validateReport(report);
    reportRevisions.set(report,{path:resolve(path),bytes});return report;
}
export function readReport(path: string): LocalReport {
    return readReportSnapshot(path, isArchiveReference(path) ? artifactJson(readArchivePart(path)) : readFileSync(path, 'utf8'));
}
const missingFile = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
export function readExportState(path: string, fallback: LocalReport['export']): LocalReport['export'] {
    if (isArchiveReference(path)) {
        try { return reportSchema.shape.export.parse(readArchivePart(archiveReference(archiveFile(path), 'exports', path.split('#executions=')[1]!))); }
        catch (error) { if (missingFile(error)) return structuredClone(fallback); throw error; }
    }
    try { return reportSchema.shape.export.parse(JSON.parse(readFileSync(inside(dirname(path), 'export.json'), 'utf8'))); }
    catch (error) { if (missingFile(error)) return structuredClone(fallback); throw error; }
}
function publicMetadata(raw: unknown) {
    const value = executionVersions(structuredClone(raw)); removeLegacyMetadata(value);
    return publicMetadataSchema.parse(value);
}
export function readReportMetadata(path: string): Pick<ReportInspection, 'metadata' | 'export'> {
    if (isArchiveReference(path)) { const report = readReport(path); return { metadata: publicMetadata(publicReport(report)), export: report.export }; }
    if (lstatSync(path).isSymbolicLink()) throw Error('Linked report rejected');
    const bytes = readFileSync(inside(dirname(path), basename(path)), 'utf8'), raw = JSON.parse(bytes);
    if (!isJsonData(raw)) throw Error('Report must contain finite JSON data');
    if (raw.artifactFormat === 'flowmate-eval-public/v1')
        return { metadata: publicMetadata(raw), export: readExportState(path, { backend: 'local', status: 'disabled' }) };
    const original = readReportSnapshot(path, bytes);
    return { metadata: publicMetadata(publicReport(original)), export: readExportState(path, original.export) };
}

export function inspectReport(path: string): ReportInspection {
    if (isArchiveReference(path)) {
        const file = archiveFile(path), bytes = readFileSync(file, 'utf8'), report = readReport(path), metadata = publicMetadata(publicReport(report));
        const parts: ReportInspection['parts'] = [];
        const root = 'run.json#/executions/' + report.executionId + '/trials/';
        for (const [index, trial] of report.trials.entries()) {
            const reference = root + index, execution = trial.execution;
            metadata.trials[index]!.evidence = { trial: reference + '/execution', observation: reference + '/execution/evidence', events: reference + '/execution/observations' };
            parts.push({ trialId: trial.trialId, kind: 'trial', reference: reference + '/execution', data: execution ?? { status: 'not-started' } },
                { trialId: trial.trialId, kind: 'events', reference: reference + '/execution/observations', data: execution?.observations ?? [] },
                { trialId: trial.trialId, kind: 'observation', reference, data: { evidence: execution?.evidence ?? {}, judgeCalls: trial.judgeCalls,
                    scoringFacts: trial.scores.map(({ metricId, actual, expected }) => ({ metricId, actual, expected })) } });
            for (const [artifactIndex, data] of (execution?.artifacts ?? []).entries()) parts.push({ trialId: trial.trialId, kind: 'artifact',
                reference: reference + '/execution/artifacts/' + artifactIndex, data });
        }
        let snapshot: ReportInspection['snapshot'];
        try { snapshot = { data: readSnapshot(path), issue: null }; } catch (error) { snapshot = { data: null, issue: missingFile(error) ? 'missing' : 'invalid' }; }
        if (readFileSync(file, 'utf8') !== bytes) throw Error('Saved report changed while reading; refresh the view');
        return { metadata, fullReport: report, export: report.export, parts, gaps: [], snapshot, sources: [{ reference: 'run.json', content: bytes }] };
    }
    if (lstatSync(path).isSymbolicLink()) throw Error('Linked report rejected');
    const root = dirname(path), bytes = readFileSync(path, 'utf8'), raw = JSON.parse(bytes);
    if (!isJsonData(raw)) throw Error('Report must contain finite JSON data');
    const sources = new Map<string, string | null>([[basename(path), bytes]]);
    const sourceBytes = (reference: string): string | null => {
        try { return readFileSync(inside(root, reference), 'utf8'); }
        catch (error) { if (missingFile(error)) return null; throw error; }
    };
    const source = (reference: string) => {
        if (!sources.has(reference)) sources.set(reference, sourceBytes(reference));
        return sources.get(reference)!;
    };
    const result = (value: Omit<ReportInspection, 'sources' | 'snapshot'>): ReportInspection => {
        const content = source('snapshot.json');
        let snapshot: ReportInspection['snapshot'] = { data: null, issue: content === null ? 'missing' : 'invalid' };
        if (content !== null) try {
            const data: unknown = executionVersions(JSON.parse(content));
            if (!isJsonData(data) || !data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid saved conditions');
            snapshot = { data, issue: null };
        } catch { /* A missing or invalid optional snapshot does not erase saved evidence. */ }
        for (const [reference, content] of sources) if (sourceBytes(reference) !== content) throw Error('Saved report changed while reading; refresh the view');
        return { ...value, snapshot, sources: [...sources].map(([reference, content]) => ({ reference, content })) };
    };
    const parts: ReportInspection['parts'] = [], gaps: ReportInspection['gaps'] = [];
    const part = <T>(reference: string, trialId: string | null, kind: InspectionKind, schema: z.ZodType<T>): T | null => {
        const content = source(reference);
        if (content === null) { gaps.push({ reference, trialId, kind, reason: 'missing' }); return null; }
        try {
            const data = kind === 'events' ? content.split('\n').filter(Boolean).map(line => executionVersions(JSON.parse(line))) : executionVersions(JSON.parse(content));
            if (!isJsonData(data)) throw Error('Invalid saved JSON data');
            const checked = schema.parse(data); parts.push({ reference, trialId, kind, data: checked }); return checked;
        } catch { gaps.push({ reference, trialId, kind, reason: 'invalid' }); return null; }
    };
    if (raw.artifactFormat !== 'flowmate-eval-public/v1') {
        const fullReport = readReportSnapshot(path, bytes), metadata = publicMetadata(publicReport(fullReport));
        const exported = source('export.json') === null ? fullReport.export : part('export.json', null, 'export', reportSchema.shape.export);
        return result({ metadata, fullReport: gaps.length ? null : fullReport, export: exported, parts, gaps });
    }
    const metadata = publicMetadata(raw), trialIds = new Set<string>(), traceIds = new Set<string>(), members = new Set<string>();
    safeId(metadata.executionId);
    const factsSchema = z.union([executionSchema.omit({ observations: true, evidence: true, artifacts: true }).extend({
        artifacts: z.array(z.object({ id: text, kind: text, file: text }).strict()),
    }), z.object({ version: z.literal('v1'), status: z.literal('not-started'), identity: executionSchema.shape.identity }).strict()]);
    const observationSchema = z.object({ version: z.literal('v1'), evidence: executionSchema.shape.evidence,
        judgeCalls: z.array(judgeCallSchema).max(1), scoringFacts: z.array(z.object({ metricId: text, actual: z.unknown().optional(), expected: z.unknown().optional() }).strict()) }).strict();
    for (const trial of metadata.trials) {
        const member = JSON.stringify([trial.caseId, trial.caseVersion, trial.repetition]);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(trial.trialId) || trialIds.has(trial.trialId) || traceIds.has(trial.traceId) || members.has(member) ||
            trial.repetition > metadata.repeat || new Set(trial.scores.map(score => score.metricId)).size !== trial.scores.length)
            throw Error('Invalid or duplicate saved Trial identity');
        trialIds.add(trial.trialId); traceIds.add(trial.traceId); members.add(member);
        const prefix = `evidence/${trial.trialId}/`;
        if (trial.evidence.trial !== prefix + 'trial.json' || trial.evidence.observation !== prefix + 'observation.json' || trial.evidence.events !== prefix + 'events.jsonl')
            throw Error('Invalid evidence reference');
        const facts = part(trial.evidence.trial, trial.trialId, 'trial', factsSchema);
        if (facts && (facts.identity.executionId !== metadata.executionId || facts.identity.trialId !== trial.trialId ||
            facts.identity.caseId !== trial.caseId || facts.identity.caseVersion !== trial.caseVersion)) throw Error('Foreign Trial evidence identity');
        const observation = part(trial.evidence.observation, trial.trialId, 'observation', observationSchema);
        if (observation && (new Set(observation.scoringFacts.map(fact => fact.metricId)).size !== observation.scoringFacts.length ||
            observation.scoringFacts.some(fact => !trial.scores.some(score => score.metricId === fact.metricId)))) throw Error('Foreign scoring evidence identity');
        part(trial.evidence.events, trial.trialId, 'events', executionSchema.shape.observations);
        if (facts && 'artifacts' in facts) for (const artifact of facts.artifacts) {
            if (!/^artifacts\/artifact-\d+\.json$/.test(artifact.file)) throw Error('Invalid artifact reference');
            const data = part(prefix + artifact.file, trial.trialId, 'artifact', executionSchema.shape.artifacts.element);
            if (data && (data.id !== artifact.id || data.kind !== artifact.kind)) throw Error('Foreign artifact identity');
        }
    }
    const exported = source('export.json') === null ? { backend: 'local' as const, status: 'disabled' as const } : part('export.json', null, 'export', reportSchema.shape.export);
    // Strict hydration consumes the same captured bytes, so a later read cannot mix evidence generations.
    const fullReport = gaps.length ? null : readReportSnapshot(path, bytes, reference => {
        if (!sources.has(reference)) throw Error('Uncaptured saved evidence reference');
        const content = sources.get(reference);
        if (content === null) throw Object.assign(Error('Missing saved evidence'), { code: 'ENOENT' });
        return content!;
    });
    return result({ metadata, fullReport, export: exported, parts, gaps });
}

export function exitCode(report: LocalReport) {
    if (report.trials.some(t => ['FAIL', 'ERROR', 'NOT_RUN'].includes(t.status)))
        return 1;
    if (report.scoring === 'pending' || report.trials.some(t => t.scores.some(s => s.required && s.status === 'NOT_RUN')))
        return 2;
    return !report.executionComplete || !report.trials.length || report.trials.some(t => t.status !== 'PASS') ? 1 : 0;
}
export function summary(report: LocalReport) {
    const count = (trials: TrialReport[]) => ({ planned: trials.length, started: trials.filter(t => t.execution?.started).length,
        completed: trials.filter(t => t.execution?.status === 'completed' && t.execution.endpointReached).length,
        statuses: Object.fromEntries(['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN'].map(s => [s, trials.filter(t => t.status === s).length])) });
    return { capability: count(report.trials.filter(t=>t.purpose==='capability')), regression: count(report.trials.filter(t=>t.purpose==='regression')), all: count(report.trials), smoke: count(report.trials.filter(t => t.partition === 'smoke')), holdout: count(report.trials.filter(t => t.partition === 'holdout')) };
}
export function comparison(left: LocalReport, right: LocalReport) {
    if(left.history||right.history||left.trials.some(t=>!t.caseConditions||t.caseConditions.unavailable)||right.trials.some(t=>!t.caseConditions||t.caseConditions.unavailable))throw Error('Comparison requires verified original content conditions');
    if (left.executionKind !== right.executionKind) throw Error('Comparison requires identical execution kind');
    if (left.contract !== right.contract || !isDeepStrictEqual(left.dataset,right.dataset) || left.repeat !== right.repeat || left.environment !== right.environment ||
        JSON.stringify(left.scoringConfiguration) !== JSON.stringify(right.scoringConfiguration))
        throw new Error('Comparison requires identical data, scoring configuration, environment and repeat plan');
    const key = (t: TrialReport) => JSON.stringify([t.caseId, t.caseVersion, t.caseConditions, t.repetition]);
    const indexed = new Map(right.trials.map(t => [key(t), t]));
    if (indexed.size !== right.trials.length || new Set(left.trials.map(key)).size !== left.trials.length || left.trials.length !== right.trials.length)
        throw new Error('Scoring versions or members differ');
    const scoring = (t: TrialReport) => JSON.stringify({ plan: [...(t.metricPlan ?? [])].sort((a, b) => a.metricId.localeCompare(b.metricId)), semantic: t.semanticPlan,evaluators:t.evaluatorPlan,
        checks: t.scores.map(s => [s.metricId, s.version, s.required,t.semanticPlan?.criteria.some(c=>c.metricId===s.metricId)?'semantic-plan':s.method]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
    const compared=left.trials.map(t => {
        const other = indexed.get(key(t));
        if (!other || scoring(t) !== scoring(other)) throw new Error('Scoring versions or members differ');
        return { caseId: t.caseId, repetition: t.repetition, before: t.status, after: other.status };
    });
    const conditions=z.object({configuration:z.object({model:text,api:agentApiSchema,baseUrl:z.string().url(),modelCapabilities:agentModelCapabilitiesSchema}).passthrough(),
        runtimeSource:z.object({contract:z.literal('flowmate-execution-source/v1'),runtime:z.object({node:text,platform:text,arch:text}).strict(),
            dependencies:z.record(z.string().nullable()),files:z.array(z.object({path:text,text:z.string()}).strict()).min(1)
            .refine(files=>new Set(files.map(file=>file.path)).size===files.length)}).strict()}).passthrough();
    const declaration=(report:LocalReport)=>{
        const path=reportRevisions.get(report)?.path,file=path?join(dirname(path),'snapshot.json'):undefined;
        if(!path||!file||!isArchiveReference(path)&&!existsSync(file))throw Error('Comparison requires original execution conditions: saved source and Agent configuration facts are unavailable');
        const facts=readSnapshot(path);
        if(!conditions.safeParse(facts).success)throw Error('Comparison requires original execution conditions: complete source and Agent configuration facts are unavailable');
        const {runtimeSource,...parameters}=facts;
        if((scanEvidence(parameters).fact.actual as {leaked:boolean}).leaked||
            (scanEvidence(runtimeSource,protectedSecrets().filter(secret=>secret!=='fixture-synthetic-key')).fact.actual as {leaked:boolean}).leaked)
            throw Error('Configured credential in execution conditions; refusing comparison');
        return facts;
    };
    if(!isDeepStrictEqual(declaration(left),declaration(right)))throw Error('Comparison requires identical snapshot declarations and parameters');
    return compared;
}
