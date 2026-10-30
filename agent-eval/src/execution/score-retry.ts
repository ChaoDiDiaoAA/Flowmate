import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { artifactJson } from '../artifacts.ts';
import { EvaluationCalibrationViewSchema } from '../../../packages/contracts/src/evaluation.ts';
import { caseSchema, caseV2Schema, type Check, type LocalCase } from '../dataset-loader/schema.ts';
import { inside } from '../dataset-loader/local.ts';
import { archiveReference, readArchive, readSnapshot, updateArchive } from '../reports/archive.ts';
import { judgeCallSchema, readReport, validateReport, type LocalReport, type TrialReport } from '../reports/store.ts';
import { safeId } from '../reports/paths.ts';
import { deriveTrialStatistics } from '../reports/trial-statistics.ts';
import { aggregate, aggregateTrials } from '../scoring/aggregate.ts';
import type { ScoreAvailabilityContext } from '../scoring/availability.ts';
import { evaluateAll, finalizeEvaluationScores, prepareLocalEvaluation } from '../scoring/evaluate.ts';
import { createRegistry } from '../scoring/registry.ts';
import { compileEvaluatorPlan } from '../scoring/evaluator-plan.ts';
import { prepareSemanticEvaluation } from '../scoring/evaluators/semantic.ts';
import { evaluateFormalMetrics } from '../scoring/evaluators/formal.ts';
import { deriveResearchF1 } from '../scoring/research-f1.ts';
import { compactScores, compactRubricFor, usesSharedText, type CompactPlan } from '../scoring/judges/compact.ts';
import { metricEvaluatorSnapshots, readEvaluatorSnapshots } from '../scoring/judges/evaluators.ts';
import { decodeJudgeInput } from '../scoring/judges/shared-text.ts';
import { judgeConfig, prepareJudge, publicJudgeConfig, type Fetcher, type JudgeConfig } from '../scoring/judges/client.ts';
import { prepareCompactJudgeInput, runJudge, type JudgeCallUpdate } from '../scoring/judges/harness.ts';
import type { ProcessRunner } from '../text-model/codex.ts';
import type { EvaluationContext, EvaluationScore, JudgeCall } from '../scoring/types.ts';
import { scanEvidence } from './evidence-safety.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const inputSchema = z.object({ runId: id, operationId: id.optional(), trialId: id.optional(), failedOnly: z.literal(true) }).strict();
export type ScoringRetryInput = z.infer<typeof inputSchema>;
const state = z.enum(['pending', 'prepared', 'submitted', 'complete', 'submission-unknown']);
const grade = z.enum(['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN']);
const integer = z.number().int().nonnegative();
const scoreSchema = z.object({ metricId: z.string().min(1), name: z.string(), version: integer.positive(), method: z.enum(['deterministic', 'llm-judge']),
    required: z.boolean(), value: z.number().finite().min(0).max(1).nullable(), status: z.enum([...grade.options, 'NOT_APPLICABLE']),
    reason: z.string(), evidence: z.array(z.string()), evaluatorId: id.optional(), evaluatorVersion: integer.positive().optional(),
    category: z.enum(['formal', 'diagnostic', 'guardrail']).optional(), applicabilityReason: z.string().optional(),
    statistics: z.object({ unit: z.string(), numerator: integer.nullable(), denominator: integer.nullable(), missing: integer.nullable() }).strict().optional(),
    judge: z.object({ callId: id, criterion: integer }).strict().optional(), actual: z.unknown().optional(), expected: z.unknown().optional(),
    calibration: EvaluationCalibrationViewSchema.optional() }).strict();
const trialSchema = z.object({ sourceTrialId: id, scoringState: state, judgeCalls: z.array(judgeCallSchema).max(1), scores: z.array(scoreSchema),
    status: grade, reason: z.string(), counts: z.record(integer) }).strict();
const revisionSchema = z.object({ id, operationId: id, createdAt: z.string().datetime(), endedAt: z.string().datetime().nullable(),
    status: z.enum(['running', 'complete', 'blocked']), target: inputSchema.omit({ operationId: true }),
    executions: z.record(z.object({ trials: z.record(trialSchema) }).strict()), error: z.string().optional() }).strict();
export type ScoringRevision = Omit<z.infer<typeof revisionSchema>, 'executions'> & {
    executions: Record<string, { trials: Record<string, Pick<TrialReport, 'judgeCalls' | 'scores' | 'status' | 'reason' | 'counts'> & {
        sourceTrialId: string; scoringState: z.infer<typeof state> }> }>;
};
export type ScoringRetryProgress = { runId: string; revisionId: string; executionId: string; trialId: string;
    scoringState: z.infer<typeof state>; lifecycle?: 'prepared' | 'submitted' | 'ended' };
export type ScoringRetrySummary = { runId: string; revisionId: string; operationId: string; status: ScoringRevision['status'];
    selectedTrials: number; completedTrials: number; blockedTrials: number; judgeCalls: number; states: Record<string, number> };
export type ScoringRetryDependencies = { env?: NodeJS.ProcessEnv; judgeConfig?: JudgeConfig; fetcher?: Fetcher; nativeRunner?: ProcessRunner;
    signal?: AbortSignal; onProgress?: (event: ScoringRetryProgress) => void };

function runFile(repo: string, runId: string) {
    safeId(runId);
    const file = inside(repo, `agent-eval/runs/${runId}/run.json`);
    if (readArchive(file).id !== runId) throw Error('Run identity differs from requested scoring target');
    return file;
}
function summary(revision: ScoringRevision): ScoringRetrySummary {
    const trials = Object.values(revision.executions).flatMap(execution => Object.values(execution.trials));
    return { runId: revision.target.runId, revisionId: revision.id, operationId: revision.operationId, status: revision.status,
        selectedTrials: trials.length, completedTrials: trials.filter(t => t.scoringState === 'complete').length,
        blockedTrials: revision.status === 'blocked' ? trials.filter(t => t.scoringState !== 'complete' || t.scores.some(s => s.status === 'ERROR')).length : 0,
        judgeCalls: trials.reduce((count, trial) => count + trial.judgeCalls.length, 0),
        states: Object.fromEntries([...new Set(trials.map(t => t.scoringState))].map(state => [state, trials.filter(t => t.scoringState === state).length])) };
}
function existingRevision(revisions: Record<string, unknown>, operationId: string, target: ScoringRevision['target']) {
    const revision = Object.values(revisions).map(parseRevision).find(saved => saved.operationId === operationId);
    if (revision && !isDeepStrictEqual(revision.target, target)) throw Error('Scoring operation already exists with a conflicting target');
    return revision;
}
function parseRevision(value: unknown): ScoringRevision { revisionSchema.parse(value); return value as ScoringRevision; }
function failed(trial: TrialReport) {
    return !!trial.execution?.started && !!trial.semanticPlan && (trial.scoringState !== undefined && trial.scoringState !== 'complete' ||
        trial.judgeCalls.some(call => call.error || call.responseComplete === false || !call.endedAt || Object.keys(call.compact?.validationErrors ?? {}).length) ||
        trial.scores.some(score => score.method === 'llm-judge' && ['ERROR', 'NOT_RUN'].includes(score.status)) ||
        !trial.scores.length);
}
function originalTask(report: LocalReport, trial: TrialReport): LocalCase {
    if (report.history || !trial.caseConditions || trial.caseConditions.unavailable || !trial.caseConditions.task)
        throw Error('Verified original Case and Gold conditions are unavailable; historical scoring cannot be retried');
    const saved = z.record(z.unknown()).parse(trial.caseConditions.task);
    const declaration = { ...saved, review: saved.review ?? { status: 'pending' } };
    const task = (saved.contract ? caseV2Schema : caseSchema).parse(declaration);
    if (task.id !== trial.caseId || task.version !== trial.caseVersion || 'contract' in task && !isDeepStrictEqual(task.expected.semantic, trial.semanticPlan))
        throw Error('Saved original Case identity or semantic plan differs from its Trial');
    const execution = trial.execution, cleanup = execution?.evidence.cleanup;
    const stopped = z.object({ stopped: z.literal(true), closed: z.literal(true) }).passthrough().safeParse(cleanup?.actual);
    if (!execution?.started || !execution.endedAt || !cleanup?.present || !stopped.success ||
        ['stop_unconfirmed', 'cleanup_failed'].includes(execution.error?.code ?? ''))
        throw Error('Original Agent stop and close must be confirmed before scoring retry');
    if (report.sourceInvalidation) throw Error('Original execution source conditions were invalidated');
    return task;
}
function sameJudge(original: JudgeCall['configuration'], current: JudgeCall['configuration']) {
    const { rubric: _, ...expected } = original;
    const { rubric: __, ...actual } = current;
    // Older archives did not record the explicit output ceiling; its absence remains unknown.
    if (!Object.hasOwn(expected, 'maxOutputTokens')) delete (actual as Record<string, unknown>).maxOutputTokens;
    if (!isDeepStrictEqual(expected, actual)) throw Error('Judge configuration differs from original saved scoring conditions');
}
function savedRequest(trial: TrialReport) {
    const call = trial.judgeCalls[0];
    if (!call) return undefined;
    if (!call.request || call.request.redacted || !call.compact || call.compact.plan.encoding)
        throw Error('Original combined Judge request is unavailable or legacy read-only');
    const data = decodeJudgeInput<{ plan: CompactPlan; evidence?: { researchFrame?: unknown } }>(call.request.data, usesSharedText(call));
    if (!isDeepStrictEqual(data.plan, call.compact.plan) || call.compact.plan.criteria.some(criterion =>
        !trial.semanticPlan?.criteria.some(original => isDeepStrictEqual(original, criterion))))
        throw Error('Original Judge batch differs from saved Trial criteria');
    if (call.compact.scoringVersion === 2 && !isDeepStrictEqual(readEvaluatorSnapshots(call.compact.plan, data.evidence), metricEvaluatorSnapshots(call.compact.plan)))
        throw Error('Evaluator versions differ from original saved scoring conditions');
    return { call, data };
}
function checksFor(trial: TrialReport, task: LocalCase): Check[] {
    const scoring = z.object({ required: z.array(z.string()) }).passthrough().parse(trial.caseConditions?.scoring);
    return [...scoring.required.map(metric => ({ metric, required: true }) as Check), ...task.expected.checks];
}
function originalEvaluators(file: string, report: LocalReport, trial: TrialReport, task: LocalCase) {
    if (report.contract !== 'flowmate-agent-run/v2') throw Error('Scoring retry requires an original v2 report');
    const snapshot = readSnapshot(archiveReference(file, 'executions', report.executionId));
    const definitions = z.object({ scoring: z.object({ evaluators: z.array(z.object({ id: z.string(), version: integer.positive(),
        rubric: z.unknown().optional() }).passthrough()) }).passthrough() }).passthrough().parse(snapshot).scoring.evaluators;
    const planned = compileEvaluatorPlan(task, checksFor(trial, task)), registry = createRegistry();
    if (trial.evaluatorPlan && !isDeepStrictEqual(trial.evaluatorPlan, planned)) throw Error('Original Evaluator plan differs from current versioned definitions');
    for (const entry of planned) {
        const definition = registry.get(entry.evaluatorId);
        if (definition.version !== entry.version || !definitions.some(saved => saved.id === definition.id && saved.version === definition.version &&
            isDeepStrictEqual(saved.rubric, definition.rubric))) throw Error('Original Evaluator versions are unavailable or differ from current implementation');
    }
}
function finalScores(trial: TrialReport, task: LocalCase, scores: EvaluationScore[], scoringContext: ScoreAvailabilityContext) {
    const context: EvaluationContext = { task, result: trial.execution!, projected: trial.execution!.input, judge: null, semanticPlan: trial.semanticPlan, scoringContext };
    const replace = (score: EvaluationScore | undefined, evaluatorId: string) => {
        if (score) {
            const prior = scores.find(original => original.metricId === score.metricId);
            const updated = { ...prior, ...score, evaluatorId, evaluatorVersion: createRegistry().get(evaluatorId).version };
            scores = scores.some(original => original.metricId === score.metricId) ? scores.map(original => original.metricId === score.metricId ? updated : original) : [...scores, updated];
        }
    };
    replace(deriveResearchF1(trial.metricPlan, scores, trial.execution), 'research-f1');
    replace(evaluateFormalMetrics({ ...context, gradedScores: scores.filter(score => score.metricId !== 'task-success') }).find(score => score.metricId === 'task-success'), 'task-result');
    return scores;
}

/** Explicit, append-only scoring work; this service never prepares or executes an Agent. */
export async function retryScoring(repo: string, rawInput: ScoringRetryInput, deps: ScoringRetryDependencies = {}): Promise<ScoringRetrySummary> {
    const input = inputSchema.parse(rawInput), file = runFile(repo, input.runId), archive = readArchive(file);
    const operationId = input.operationId ?? randomUUID();
    const target: ScoringRevision['target'] = { runId: input.runId, ...(input.trialId ? { trialId: input.trialId } : {}), failedOnly: true };
    const prior = existingRevision(archive.scoringRevisions, operationId, target);
    if (prior) return summary(prior);
    const reports = Object.keys(archive.executions).map(executionId => ({ report: readReport(archiveReference(file, 'executions', executionId)), executionId }));
    if (reports.some(({ report }) => report.contract !== 'flowmate-agent-run/v2')) throw Error('Scoring retry requires original v2 reports; v1 semantic retry is unsupported');
    if (input.trialId && !reports.some(({ report }) => report.trials.some(trial => trial.trialId === input.trialId))) throw Error('Original target Trial not found');
    const selected = reports.flatMap(({ report, executionId }) => report.trials.filter(trial => (!input.trialId || trial.trialId === input.trialId) && failed(trial)).map(trial => {
        const task = originalTask(report, trial), request = savedRequest(trial);
        originalEvaluators(file, report, trial, task);
        if (!request) {
            const rubric = compactRubricFor(trial.semanticPlan!);
            if (!report.scoringConfiguration.rubrics?.some(saved => isDeepStrictEqual(saved, rubric))) throw Error('Original Rubric version is unavailable or differs from current implementation');
        }
        return { report, executionId, trial, task, request };
    }));
    const revision: ScoringRevision = { id: 'Scoring-' + randomUUID(), operationId, target, createdAt: new Date().toISOString(), endedAt: null, status: 'running', executions: {} };
    for (const { executionId, trial } of selected) (revision.executions[executionId] ??= { trials: {} }).trials[trial.trialId] = {
        sourceTrialId: trial.trialId, scoringState: 'pending', judgeCalls: [], scores: structuredClone(trial.scores), status: trial.status, reason: trial.reason, counts: structuredClone(trial.counts) };
    let concurrent: ScoringRevision | undefined;
    updateArchive(file, current => {
        concurrent = existingRevision(current.scoringRevisions, operationId, target);
        if (!concurrent) current.scoringRevisions[revision.id] = structuredClone(revision);
    });
    if (concurrent) return summary(concurrent);
    let saved = structuredClone(revision);
    const persist = () => {
        try {
            revisionSchema.parse(revision);
            updateArchive(file, current => {
                if (!isDeepStrictEqual(current.scoringRevisions[revision.id], saved)) throw Error('Scoring revision changed while saving');
                current.scoringRevisions[revision.id] = structuredClone(revision);
            });
            saved = JSON.parse(JSON.stringify(revision));
        } catch (error) { throw Object.assign(error instanceof Error ? error : Error(String(error)), { evaluationPersistenceFailed: true }); }
    };
    try {
        let judge: JudgeConfig | null = null;
        if (selected.length) {
            judge = deps.judgeConfig ?? judgeConfig(deps.env ?? process.env, repo);
            if (!judge) throw Error('Original Judge configuration is unavailable; no provider fallback');
            judge = await prepareJudge(judge, deps.fetcher, deps.signal);
            for (const { report } of selected) {
                if (!report.scoringConfiguration.judge) throw Error('Original Judge configuration is unavailable');
                sameJudge(report.scoringConfiguration.judge, publicJudgeConfig(judge));
            }
        }
        for (const { report, executionId, trial, task, request } of selected) {
            const result = revision.executions[executionId]!.trials[trial.trialId]!;
            const checkpoint: JudgeCallUpdate = call => {
                result.judgeCalls = [structuredClone(call)];
                result.scoringState = call.submissionUnknown ? 'submission-unknown' : call.lifecycle === 'ended' ? call.attempts ? 'submitted' : 'prepared' : call.lifecycle ?? 'pending';
                persist();
                try { deps.onProgress?.({ runId: input.runId, revisionId: revision.id, executionId, trialId: trial.trialId,
                    scoringState: result.scoringState, lifecycle: call.lifecycle }); }
                catch (error) { throw Object.assign(error instanceof Error ? error : Error(String(error)), { evaluationPersistenceFailed: true }); }
            };
            let scores: EvaluationScore[];
            if (request) {
                const { call } = request;
                const retried = await runJudge(judge!, call.request!.system, call.request!.data, deps.fetcher, deps.signal, call.compact!.plan,
                    request.data.evidence?.researchFrame, deps.nativeRunner, usesSharedText(call) ? 'flowmate-judge-shared-text/v1' : undefined, checkpoint);
                const measured = compactScores(retried);
                scores = trial.scores.map(original => {
                    const replacement = measured.find(score => score.metricId === original.metricId);
                    return original.method === 'llm-judge' && replacement ? { ...original, ...replacement } : structuredClone(original);
                });
                for (const score of measured) if (!scores.some(original => original.metricId === score.metricId)) scores.push(score);
            } else {
                const evaluated = await evaluateAll({ task, result: trial.execution!, projected: trial.execution!.input, judge, fetcher: deps.fetcher,
                    signal: deps.signal, semanticPlan: trial.semanticPlan, onJudgeUpdate: checkpoint, nativeJudgeRunner: deps.nativeRunner }, checksFor(trial, task));
                scores = evaluated.scores;
                result.judgeCalls = evaluated.judgeCalls;
            }
            const scoringContext: ScoreAvailabilityContext = { execution: trial.execution, metricPlan: trial.metricPlan,
                semanticPlan: trial.semanticPlan, evaluatorPlan: trial.evaluatorPlan, judgeCalls: result.judgeCalls };
            result.scores = await finalScores(trial, task, scores, scoringContext);
            Object.assign(result, aggregate(result.scores, trial.execution!, scoringContext));
            result.scoringState = result.judgeCalls.some(call => call.submissionUnknown) ? 'submission-unknown' : result.judgeCalls.every(call => call.lifecycle === 'ended') &&
                !result.scores.some(score => score.method === 'llm-judge' && score.status === 'NOT_RUN') ? 'complete' : 'pending';
            if (report.sourceInvalidation) throw Error('Original source conditions were invalidated');
            persist();
        }
        revision.status = Object.values(revision.executions).flatMap(execution => Object.values(execution.trials)).some(trial =>
            trial.scoringState !== 'complete' || trial.scores.some(score => score.status === 'ERROR')) ? 'blocked' : 'complete';
        revision.endedAt = new Date().toISOString(); persist();
        return summary(revision);
    } catch (error) {
        for (const execution of Object.values(revision.executions)) for (const trial of Object.values(execution.trials))
            if (trial.scoringState === 'submitted') trial.scoringState = 'submission-unknown';
        revision.status = 'blocked'; revision.endedAt = new Date().toISOString();
        revision.error = scanEvidence(error instanceof Error ? error.message : String(error)).value;
        persist();
        throw error;
    }
}

export function readScoringRevision(repo: string, runId: string, revisionId: string): ScoringRevision {
    id.parse(revisionId);
    const revision = parseRevision(readArchive(runFile(repo, runId)).scoringRevisions[revisionId]);
    if (revision.id !== revisionId || revision.target.runId !== runId) throw Error('Scoring revision identity differs from requested target');
    return revision;
}
export function listScoringRevisions(repo: string, runId: string): ScoringRetrySummary[] {
    const revisions = readArchive(runFile(repo, runId)).scoringRevisions;
    return Object.entries(revisions).map(([revisionId, value]) => {
        const revision = parseRevision(value);
        if (revision.id !== revisionId || revision.target.runId !== runId) throw Error('Scoring revision identity differs from requested target');
        return summary(revision);
    });
}

function completedTrial(file: string, report: LocalReport, source: TrialReport, updated: ScoringRevision['executions'][string]['trials'][string], revision: ScoringRevision): TrialReport {
    const task = originalTask(report, source);
    originalEvaluators(file, report, source, task);
    const { sourceTrialId: _, ...scoring } = structuredClone(updated), trial: TrialReport = { ...source, ...scoring };
    const context: EvaluationContext = { task, result: source.execution!, projected: source.execution!.input, judge: null, semanticPlan: source.semanticPlan };
    const prepared = prepareSemanticEvaluation(context, true), call = trial.judgeCalls[0];
    const judged = prepared.eligiblePlan?.criteria.map(criterion => criterion.metricId) ?? [];
    const local = (scores: EvaluationScore[]) => scores.filter(score => !['DR03', 'task-success'].includes(score.metricId) &&
        !(score.method === 'llm-judge' && judged.includes(score.metricId)));
    if (source.scores.length && !isDeepStrictEqual(local(source.scores), local(trial.scores))) throw Error('Scoring revision changed original local or deterministic facts');
    if (!source.scores.length) {
        const deterministic = (scores: EvaluationScore[]) => scores.filter(score => score.method === 'deterministic' && !['DR03', 'task-success'].includes(score.metricId))
            .sort((left, right) => left.metricId.localeCompare(right.metricId));
        const expected = finalizeEvaluationScores(context, [...prepareLocalEvaluation(context, checksFor(source, task)),
            ...prepared.scores.filter(score => score.method === 'deterministic')], createRegistry());
        if (!isDeepStrictEqual(deterministic(trial.scores), deterministic(JSON.parse(artifactJson(expected))))) throw Error('Recovered local scoring differs from the original saved checks and facts');
    }
    if (call) {
        if (!report.scoringConfiguration.judge) throw Error('Original Judge configuration is unavailable');
        sameJudge(report.scoringConfiguration.judge, call.configuration);
        if (!call.request || !prepared.eligiblePlan || !isDeepStrictEqual(call.compact?.plan, prepared.eligiblePlan)) throw Error('Revision Judge differs from the complete original applicable batch');
        if (report.trials.some(original => original.judgeCalls.some(originalCall => originalCall.callId === call.callId))) throw Error('Scoring revision requires its own independent Judge record');
        const actual = decodeJudgeInput(call.request.data, usesSharedText(call));
        const expected = JSON.parse(prepareCompactJudgeInput(prepared.eligiblePlan, prepared.evidence).original);
        if (!isDeepStrictEqual(actual, expected)) throw Error('Revision Judge evidence differs from original saved Case, Gold or execution facts');
        const original = savedRequest(source);
        if (original && (!isDeepStrictEqual(actual, original.data) || call.request.system !== original.call.request!.system)) throw Error('Revision Judge request differs from its original saved request');
    }
    if (!isDeepStrictEqual(trial.scores, finalScores(source, task, structuredClone(trial.scores), trial))) throw Error('Revision derived scores differ from the original scoring rules');
    const grade = aggregate(trial.scores, source.execution!, trial);
    if (!isDeepStrictEqual([trial.status, trial.reason, trial.counts], [grade.status, grade.reason, grade.counts])) throw Error('Revision final grade or counters differ from validated scores');
    const isolated: LocalReport = { ...structuredClone(report), scoring: 'complete', endedAt: report.endedAt ?? revision.endedAt,
        statisticsPolicyVersion: 2, trials: [trial] };
    delete isolated.trialStatistics;
    delete isolated.scoringRevision;
    if (call) { const { rubric: _, ...actual } = call.configuration; isolated.scoringConfiguration.judge = actual; }
    isolated.aggregation = aggregateTrials(isolated);
    validateReport(isolated);
    return trial;
}

/** A caller must name the exact revision; the original reader never selects a revision implicitly. */
export function readScoringRevisionReport(repo: string, runId: string, revisionId: string, executionId: string): LocalReport {
    id.parse(revisionId); safeId(executionId);
    const file = runFile(repo, runId), revision = readScoringRevision(repo, runId, revisionId);
    const report = readReport(archiveReference(file, 'executions', executionId)), selected = revision.executions[executionId];
    if (!selected) throw Error('Execution is not included in requested scoring revision');
    if (report.contract !== 'flowmate-agent-run/v2') throw Error('Scoring revisions require original v2 report provenance');
    if (Object.keys(selected.trials).some(trialId => !report.trials.some(trial => trial.trialId === trialId))) throw Error('Scoring revision refers to a foreign original Trial');
    report.trials = report.trials.map(trial => {
        const updated = selected.trials[trial.trialId];
        if (!updated) return trial;
        if (updated.sourceTrialId !== trial.trialId) throw Error('Scoring revision refers to a foreign original Trial');
        if (updated.scoringState === 'complete') return completedTrial(file, report, trial, updated, revision);
        const { sourceTrialId: _, ...scoring } = structuredClone(updated);
        return { ...trial, ...scoring };
    });
    report.scoring = revision.status !== 'running' && !!revision.endedAt && Object.values(selected.trials).every(trial => trial.scoringState === 'complete') ? 'complete' : 'pending';
    const calls = report.trials.flatMap(trial => trial.judgeCalls);
    const connection = (call: JudgeCall) => {
        const { rubric: _, ...value } = call.configuration;
        const wireLimit = call.capacity?.actualMaxOutputTokens;
        return call.configuration.provider !== 'codex-cli' && !Object.hasOwn(value, 'maxOutputTokens') && typeof wireLimit === 'number'
            ? { ...value, maxOutputTokens: wireLimit } : value;
    };
    const activeCall = Object.values(selected.trials).flatMap(trial => trial.judgeCalls)[0] ?? calls[0];
    const active = activeCall ? connection(activeCall) : undefined;
    if (active) report.scoringConfiguration.judge = active;
    report.scoringRevision = { id: revisionId, conditionsComplete: calls.every(call => {
        const known = call.configuration.provider === 'codex-cli' || Object.hasOwn(call.configuration, 'maxOutputTokens') ||
            typeof call.capacity?.actualMaxOutputTokens === 'number';
        return known && !!active && isDeepStrictEqual(connection(call), active);
    }) };
    report.statisticsPolicyVersion = 2;
    if (report.contract === 'flowmate-agent-run/v2') report.aggregation = aggregateTrials(report);
    report.trialStatistics = deriveTrialStatistics(report);
    report.export = { backend: 'local', status: 'disabled' };
    return report;
}
