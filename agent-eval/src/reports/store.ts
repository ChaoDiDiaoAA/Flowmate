import { legacyCompactRubric, legacyPlainRubric } from '../scoring/judges/packed.ts';
import { atomicJson, publicVersions, publicReport, readPublicReport, saveEvidence } from './files.ts';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import { isJsonData } from '../../../packages/contracts/src/tools.ts';
import type { CaseExecutionResult, GradeStatus } from '../types.ts';
import type { EvaluationScore, JudgeCall, MetricPlan } from '../scoring/types.ts';
import { aggregateTrials, type TrialAggregation } from '../scoring/aggregate.ts';
import { hash } from '../dataset-loader/local.ts';
import { parseJudgment } from '../scoring/judges/harness.ts';
import { compactPlanSchema, compactResultSchema, compactRubricFor, parseCompactJudgment,parseLegacyCompactJudgment, compactScores, type CompactPlan } from '../scoring/judges/compact.ts';
import { isDeepStrictEqual } from 'node:util';
import { artifactJson, withoutHashes } from '../artifacts.ts';
import { agentApiSchema, agentModelCapabilitiesSchema } from '../configuration.ts';
export type TrialReport = {
    caseId: string;
    caseVersion: number;
    caseHash: string;
    purpose?: 'capability'|'regression';
    caseName: string;
    category: string;
    partition: 'smoke' | 'holdout';
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
    judgeCalls: JudgeCall[];
    feedback: 'none';
};
export type LocalReport = {
    contract: 'flowmate-agent-run/v1' | 'flowmate-agent-run/v2';
    aggregation?: TrialAggregation;
    executionId: string;
    code?: {
        commit: string;
        workspaceHash: string;
        release: string;
        dirty: boolean;
    };
    userId?: string;
    dataset: {
        id: string;
        version: number;
        hash: string;
        subject: 'agent';
    };
    selection: 'smoke' | 'holdout' | 'full' | 'case';
    environment: string;
    startedAt: string;
    endedAt: string | null;
    repeat: number;
    executionComplete: boolean;
    scoring: 'pending' | 'complete';
    manualReview: 'none';
    formalAcceptance: 'not-assessed';
    scoringConfiguration: {
        version: number;
        judgeMode: 'off' | 'auto' | 'required';
        judgeHash: string | null;
    };
    trials: TrialReport[];
    export: {
        backend: 'local' | 'langfuse';
        status: 'disabled' | 'pending' | 'complete' | 'partial' | 'error';
        progress?: { total: number; acceptedEventIds: string[]; rejectedEventIds: string[] };
        error?: string;
        url?: string;
    };
};
const text = z.string().min(1), integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), positive = integer.positive();
const reportRevisions = new WeakMap<LocalReport, { path: string; hash: string }>();
const timestamp = z.string().datetime(), status = z.enum(['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN']);
const inputSchema = z.object({ prompt: z.string(), materials: z.array(z.object({ sample: text, file: text, text: z.string() }).strict()) }).strict();
const scoreSchema = z.object({ metricId: text, name: text, version: positive, method: z.enum(['deterministic', 'llm-judge']), required: z.boolean(),
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
const legacyJudgeConfigurationSchema = z.object({ provider: z.enum(['anthropic', 'openai-compatible']), model: text,
    baseUrl: z.string().url(), temperature: z.number().finite().min(0).max(2).optional(), maxTokens: positive.optional(), timeoutMs: positive, configHash: text.optional(),
    modelCapabilities: z.object({modelId:text,maxOutputTokens:positive,source:z.enum(['anthropic-models-api','deepseek-models-api'])}).strict().optional(),
    protocolVersion: text.optional(), rubric: z.object({ id: text, version: positive, hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional()
    }).strict();
const judgeCallBase = z.object({ callId: text, startedAt: timestamp, endedAt: timestamp, attempts: integer.max(1),
    usage: z.unknown(), responseModel: z.unknown(), raw: z.string().nullable(), error: z.string().nullable(),
    judgment: z.object({ score: z.number().finite().min(0).max(1), reason: text }).strict().nullable(),
    request: z.object({ system: z.string(), data: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), redacted: z.boolean() }).strict().optional(),
    compact: z.object({ plan: compactPlanSchema, judgment: compactResultSchema.nullable() }).strict().optional() }).strict();
const judgeCallSchema = z.union([
    judgeCallBase.extend({ configuration: legacyJudgeConfigurationSchema, finishReason: z.string().nullable().optional(), responseComplete: z.boolean().optional() }),
    judgeCallBase.extend({ configuration: legacyJudgeConfigurationSchema.omit({ temperature: true, maxTokens: true, modelCapabilities: true }).extend({
        provider: z.enum(['anthropic', 'openai-compatible']).optional(), api: agentApiSchema,
        sdk: z.object({ codingAgent: text, ai: text }).strict(), modelCapabilities: agentModelCapabilitiesSchema.optional()
    }), stopReason: z.enum(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']).nullable(),
        rawStopReason: z.string().nullable(), usageSource: z.enum(['sdk', 'unknown']), responseComplete: z.boolean() })
]);
const trialSchema = z.object({ caseId: text, caseVersion: positive, caseHash: text.optional(), caseName: text, category: text, purpose:z.enum(['capability','regression']).optional(),
    partition: z.enum(['smoke', 'holdout']), repetition: positive, trialId: text, traceId: z.string().regex(/^[a-f0-9]{32}$/),
    status, reason: z.string(), counts: z.record(integer), execution: executionSchema.nullable(), scores: z.array(scoreSchema),
    metricPlan: z.array(z.object({ metricId: text, version: positive, unit: text, denominator: integer.nullable().optional(),
        notApplicable: text.optional() }).strict()).optional(), semanticPlan: compactPlanSchema.optional(),
    judgeCalls: z.array(judgeCallSchema).max(1), feedback: z.literal('none') }).strict();
const reportSchema = z.object({ contract: z.enum(['flowmate-agent-run/v1', 'flowmate-agent-run/v2']), executionId: text,
    aggregation: z.unknown().optional(),
    code: z.object({ commit: text.optional(), workspaceHash: text.optional(), release: text, dirty: z.boolean() }).strict().optional(), userId: text.optional(),
    dataset: z.object({ id: text, version: positive, hash: text.optional(), subject: z.literal('agent') }).strict(), selection: z.enum(['smoke', 'holdout', 'full', 'case']),
    environment: text, startedAt: timestamp, endedAt: timestamp.nullable(), repeat: positive.max(20), executionComplete: z.boolean(),
    scoring: z.enum(['pending', 'complete']), manualReview: z.literal('none'), formalAcceptance: z.literal('not-assessed'),
    scoringConfiguration: z.object({ version: positive, judgeMode: z.enum(['off', 'auto', 'required']), judgeHash: text.nullable().optional() }).strict(),
    trials: z.array(trialSchema), export: z.object({ backend: z.enum(['local', 'langfuse']), status: z.enum(['disabled', 'pending', 'complete', 'partial', 'error']),
        progress: z.object({ total: integer, acceptedEventIds: z.array(text), rejectedEventIds: z.array(text) }).strict().refine(p =>
            new Set(p.acceptedEventIds).size === p.acceptedEventIds.length && new Set(p.rejectedEventIds).size === p.rejectedEventIds.length &&
            p.acceptedEventIds.length <= p.total && p.rejectedEventIds.length <= p.total && !p.rejectedEventIds.some(id => p.acceptedEventIds.includes(id)),
            'Export receipt identities must be unique and disjoint').optional(),
        error: z.string().optional(), url: z.string().optional() }).strict() }).strict();
function validateReport(value: unknown): asserts value is LocalReport {
    if (!value || typeof value !== 'object' || !('contract' in value) ||
        !['flowmate-agent-run/v1', 'flowmate-agent-run/v2'].includes(String(value.contract)))
        throw new Error('Historical report is read-only; no regrading or new export');
    if (!isJsonData(value)) throw new Error('Report must contain finite JSON data');
    reportSchema.parse(value);
    const report = value as LocalReport, trials = new Set<string>(), traces = new Set<string>(), members = new Set<string>(), calls = new Set<string>();
    if (report.selection === 'holdout' && report.trials.some(trial => trial.partition !== 'holdout'))
        throw new Error('Smoke Trial cannot appear in holdout selection');
    safeId(report.executionId);
    for (const trial of report.trials) {
        const member = JSON.stringify([trial.caseId, trial.caseVersion, trial.caseHash, trial.repetition]);
        if (trials.has(trial.trialId) || traces.has(trial.traceId) || members.has(member) || trial.repetition > report.repeat)
            throw new Error('Duplicate or out-of-plan Trial identity');
        trials.add(trial.trialId); traces.add(trial.traceId); members.add(member);
        const id = trial.execution?.identity;
        if (id && (id.executionId !== report.executionId || id.trialId !== trial.trialId || id.caseId !== trial.caseId || id.caseVersion !== trial.caseVersion))
            throw new Error('Original execution identity differs from its Trial');
        if (new Set(trial.scores.map(s => s.metricId)).size !== trial.scores.length) throw new Error('Duplicate score identity');
        for (const criterion of trial.semanticPlan?.criteria ?? []) {
            const metric = trial.metricPlan?.find(m => m.metricId === criterion.metricId);
            if (report.contract !== 'flowmate-agent-run/v2' || !metric || metric.notApplicable || metric.version !== criterion.version ||
                metric.unit !== criterion.unit || metric.denominator !== criterion.denominator)
                throw new Error('Declared semantic criterion differs from its metric opportunity plan');
        }
        for (const call of trial.judgeCalls) {
            if (calls.has(call.callId)) throw new Error('Duplicate Judge call identity');
            calls.add(call.callId);
            const { configHash, ...parameters } = call.configuration;
            if (configHash && hash(parameters) !== configHash) throw new Error('Stored Judge configuration hash does not match its parameters');
            if (report.scoringConfiguration.judgeHash && call.configuration.configHash !== report.scoringConfiguration.judgeHash) throw new Error('Judge differs from declared scoring configuration');
            if (call.request && (call.request.hash && hash([call.request.system, call.request.data]) !== call.request.hash || call.request.redacted &&
                (call.judgment !== null || call.compact?.judgment != null))) throw new Error('Stored Judge input identity or redaction contradicts its judgment');
            if (report.contract === 'flowmate-agent-run/v2') {
                const sdk = call.configuration.sdk !== undefined;
                if (call.configuration.protocolVersion !== 'flowmate-judge/v2' || (!sdk && call.finishReason === undefined) || call.responseComplete === undefined)
                    throw new Error('Modern Judge completion metadata is missing or unsupported');
                const completed = sdk ? call.stopReason === 'stop' : call.configuration.provider === 'anthropic' ? ['end_turn', 'stop_sequence'].includes(call.finishReason ?? '') : call.finishReason === 'stop';
                if (sdk && call.attempts === 1 && !call.configuration.modelCapabilities) throw Error('SDK Judge native capabilities are missing');
                if (call.responseComplete && !completed || call.judgment !== null &&
                    (!call.responseComplete || call.attempts !== 1 || call.error !== null || call.raw === null ||
                        JSON.stringify(parseJudgment(call.raw)) !== JSON.stringify(call.judgment)))
                    throw new Error('Stored Judge judgment contradicts original completion or text');
            }
            if (call.compact) {
                const rubric=[legacyCompactRubric,legacyPlainRubric].find(r=>call.request?.system===r.prompt)??compactRubricFor(call.compact.plan);
                if (report.contract !== 'flowmate-agent-run/v2' || !call.request || call.request.system !== rubric.prompt || call.judgment !== null)
                    throw new Error('Compact Judge needs its original versioned input and exclusive judgment');
                if (call.configuration.rubric?.hash && !isDeepStrictEqual(call.configuration.rubric, { id: rubric.id, version: rubric.version, hash: hash(call.request.system) }))
                    throw new Error('Compact Judge Rubric differs from declared scoring configuration');
                const input = JSON.parse(call.request.data);
                if (!isDeepStrictEqual(input.plan, call.compact.plan)) throw new Error('Compact Judge plan differs from its original request');
                if (call.compact.judgment !== null && (!call.responseComplete || call.attempts !== 1 || call.error !== null || call.raw === null ||
                    !isDeepStrictEqual((call.request.system === legacyCompactRubric.prompt ? parseLegacyCompactJudgment(call.raw,call.compact.plan) : parseCompactJudgment(call.raw, call.compact.plan,input.evidence?.researchFrame)), call.compact.judgment)) ||
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
                    if (!isDeepStrictEqual(trial.scores.find(s => s.judge?.callId === call.callId && s.judge.criterion === index), expected))
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
    if (report.contract === 'flowmate-agent-run/v2' && JSON.stringify(withoutHashes(report.aggregation)) !== JSON.stringify(withoutHashes(aggregateTrials(value as LocalReport))))
        throw new Error('Stored aggregation differs from original Trial records');
}
export function safeId(value: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
        throw new Error('Invalid execution ID');
    return value;
}
export function reportPath(repo: string, id: string) { const root=join(repo,'agent-eval/runs',safeId(id));return existsSync(join(root,'report.json'))?join(root,'report.json'):join(root,'summary.json'); }
export function saveReport(path: string, report: LocalReport) {
    if (report.contract === 'flowmate-agent-run/v2') report.aggregation = aggregateTrials(report);
    JSON.stringify(report, (_, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Report must contain finite JSON data');
        return value;
    });
    validateReport(JSON.parse(JSON.stringify(report)));
    const root=dirname(path), record=publicReport(report);
    if(existsSync(path)) {
        if(lstatSync(path).isSymbolicLink())throw Error('Linked report rejected');
        const bytes=readFileSync(path,'utf8'),prior=JSON.parse(bytes);
        if (removeLegacyMetadata(prior)) throw Error('Historical reports are read-only');
        if(prior.endedAt===null&&reportRevisions.has(report)&&reportRevisions.get(report)!.hash!==hash(bytes))throw Error('Stale open report');
        const plan=(r:any)=>JSON.stringify({dataset:r.dataset,selection:r.selection,environment:r.environment,startedAt:r.startedAt,repeat:r.repeat,scoring:r.scoringConfiguration,members:r.trials.map((t:any)=>[t.caseId,t.caseVersion,t.repetition,t.trialId,t.traceId,t.metricPlan,t.semanticPlan])});
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
// Historical fields are accepted only while reading, never required by a new execution.
function removeLegacyMetadata(report: any) {
    if (report.frozenConditions !== undefined) {
        z.object({configurationHash:text.optional(),strategyGroup:text,producer:z.enum(['productAgent','engineering-fixture']).optional()}).strict().parse(report.frozenConditions);
        delete report.frozenConditions;
        return true;
    }
    return false;
}
export function readReport(path: string): LocalReport {
    const bytes=readFileSync(path,'utf8'), raw=JSON.parse(bytes);
    if(raw.artifactFormat==='flowmate-eval-public/v1'&&raw.dataset?.version==='v1'){const report=readPublicReport(path,raw);removeLegacyMetadata(report);validateReport(report);reportRevisions.set(report,{path:resolve(path),hash:hash(bytes)});return report;}
    // Legacy files retain their original validation and remain readable.
    if(raw.artifactFormat)delete raw.artifactFormat;
    removeLegacyMetadata(raw);validateReport(raw);reportRevisions.set(raw,{path:resolve(path),hash:hash(bytes)});return raw;
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
    const declaration=(report:LocalReport)=>{const root=reportRevisions.get(report)?.path;if(!root)return undefined;const file=join(dirname(root),'snapshot.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;};
    const l=declaration(left),r=declaration(right);if((l||r)&&!isDeepStrictEqual(l,r))throw Error('Comparison requires identical snapshot declarations and parameters');
    if (left.contract !== right.contract || left.dataset.hash !== right.dataset.hash || left.repeat !== right.repeat || left.environment !== right.environment ||
        JSON.stringify(left.scoringConfiguration) !== JSON.stringify(right.scoringConfiguration))
        throw new Error('Comparison requires identical data, scoring configuration, environment and repeat plan');
    const key = (t: TrialReport) => JSON.stringify([t.caseId, t.caseVersion, t.caseHash, t.repetition]);
    const indexed = new Map(right.trials.map(t => [key(t), t]));
    if (indexed.size !== right.trials.length || new Set(left.trials.map(key)).size !== left.trials.length || left.trials.length !== right.trials.length)
        throw new Error('Scoring versions or members differ');
    const scoring = (t: TrialReport) => JSON.stringify({ plan: [...(t.metricPlan ?? [])].sort((a, b) => a.metricId.localeCompare(b.metricId)), semantic: t.semanticPlan,
        checks: t.scores.map(s => [s.metricId, s.version, s.required, s.method]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) });
    return left.trials.map(t => {
        const other = indexed.get(key(t));
        if (!other || scoring(t) !== scoring(other)) throw new Error('Scoring versions or members differ');
        return { caseId: t.caseId, repetition: t.repetition, before: t.status, after: other.status };
    });
}
