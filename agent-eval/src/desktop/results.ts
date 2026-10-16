import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, evaluationRequests, EvaluationExecutionListSchema, EvaluationExecutionSummarySchema,
    EvaluationExportViewSchema, EvaluationMetricSummarySchema, EvaluationResultSchema, EvaluationScoreViewSchema, EvaluationTrialViewSchema,
    EvaluationComparisonSchema, EvaluationExecutionConditionsSchema, type EvaluationExecutionSummary, type EvaluationResult, type EvaluationRequest, type EvaluationExportView,
    type EvaluationTrialView, type EvaluationScoreView, type EvaluationReadPageSchema } from '@flowmate/contracts';
import { inside } from '../dataset-loader/local.ts';
import { discoverSavedExecutions, reportPath } from '../reports/paths.ts';
import { comparison, inspectReport, readReport, readReportMetadata, judgeCallSchema, sdkJudgeConfigurationSchema, legacyJudgeConfigurationSchema, type ReportInspection, type LocalReport } from '../reports/store.ts';
import { agentModelCapabilitiesSchema } from '../configuration.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { metricCatalog } from '../scoring/catalog.ts';

const clipped = (value: string) => scanEvidence(value).value.slice(0, 2000);
const failure = (code: string, message: string) => fail(appError(code, 'runtime', clipped(message), true));
function conditions(inspection: ReportInspection): Pick<EvaluationExecutionSummary, 'conditions' | 'conditionsIssue'> {
    if (inspection.snapshot.issue) return { conditions: null, conditionsIssue: inspection.snapshot.issue };
    try {
        const raw = z.object({ dataset: z.string().optional(), repeat: z.number().optional(), configuration: z.record(z.unknown()),
            judge: z.unknown().optional(), runtimeSource: z.unknown().optional() }).strip().parse(inspection.snapshot.data);
        if (raw.dataset !== undefined && raw.dataset !== inspection.metadata.dataset.id || raw.repeat !== undefined && raw.repeat !== inspection.metadata.repeat)
            throw Error('Foreign saved conditions');
        const schema = EvaluationExecutionConditionsSchema, config = raw.configuration;
        const agent = schema.shape.agent.strip().parse({ ...config, modelCapabilities: config.modelCapabilities === undefined ? null : agentModelCapabilitiesSchema.parse(config.modelCapabilities) });
        const run = schema.shape.run.strip().parse(config);
        const originalSource = raw.runtimeSource === undefined ? null : z.object({ contract: z.literal('flowmate-execution-source/v1'),
            runtime: schema.shape.source.unwrap().shape.runtime, dependencies: schema.shape.source.unwrap().shape.dependencies,
            files: z.array(z.object({ path: z.string().max(1024), text: z.string() }).strip()) }).strip().parse(raw.runtimeSource);
        const source = originalSource === null ? null : { runtime: originalSource.runtime, dependencies: originalSource.dependencies,
            fileCount: originalSource.files.length, paths: originalSource.files.slice(0, 200).map(file => file.path), pathsTruncated: originalSource.files.length > 200 };
        const judge = raw.judge === undefined ? undefined : raw.judge === null ? null
            : z.union([sdkJudgeConfigurationSchema, legacyJudgeConfigurationSchema]).parse(raw.judge);
        return { conditions: schema.parse(scanEvidence({ agent, run, source, scoring: { version: inspection.metadata.scoringConfiguration.version,
            judgeMode: inspection.metadata.scoringConfiguration.judgeMode }, ...(judge === undefined ? {} : { judge: judge === null ? null : {
                api: 'api' in judge ? judge.api : null, model: judge.model, baseUrl: judge.baseUrl, timeoutMs: judge.timeoutMs } }) }).value), conditionsIssue: null };
    } catch { return { conditions: null, conditionsIssue: 'invalid' }; }
}
export function exportView(value: LocalReport['export'] | null): EvaluationExportView | null {
    if (!value) return null;
    const progress = value.progress;
    return EvaluationExportViewSchema.parse(scanEvidence({ backend: value.backend, status: value.status, target: value.target ?? null,
        progress: progress ? { total: progress.total, accepted: progress.acceptedEventIds.length, rejected: progress.rejectedEventIds.length,
            unconfirmed: progress.total - progress.acceptedEventIds.length - progress.rejectedEventIds.length } : null,
        error: value.error === undefined ? null : clipped(value.error), errorTruncated: (value.error?.length ?? 0) > 2000 }).value);
}
function summary(inspection: Pick<ReportInspection, 'metadata' | 'export'>, evidenceComplete: boolean | null): EvaluationExecutionSummary {
    const metadata = inspection.metadata;
    return EvaluationExecutionSummarySchema.parse(scanEvidence({ executionId: metadata.executionId, dataset: metadata.dataset, selection: metadata.selection,
        environment: metadata.environment, repeat: metadata.repeat, startedAt: metadata.startedAt, endedAt: metadata.endedAt,
        executionComplete: metadata.executionComplete, scoring: metadata.scoring, plannedTrials: metadata.trials.length,
        evidenceComplete, historyGaps: (metadata.history?.gaps ?? []).map(clipped),
        export: exportView(inspection.export) }).value);
}
function trialViews(inspection: ReportInspection): EvaluationTrialView[] {
    return inspection.metadata.trials.map(trial => {
        const full = inspection.fullReport?.trials.find(value => value.trialId === trial.trialId);
        const facts = z.object({ status: z.enum(['completed', 'failed', 'timeout', 'cancelled', 'error', 'not-started']),
            usage: z.record(z.number().finite().nonnegative().nullable()).optional(), artifacts: z.array(z.unknown()).optional() }).passthrough()
            .safeParse(inspection.parts.find(part => part.trialId === trial.trialId && part.kind === 'trial')?.data);
        const observation = z.object({ judgeCalls: z.array(judgeCallSchema).max(1) }).passthrough()
            .safeParse(inspection.parts.find(part => part.trialId === trial.trialId && part.kind === 'observation')?.data);
        const calls = full?.judgeCalls ?? (observation.success ? observation.data.judgeCalls : null);
        return EvaluationTrialViewSchema.parse(scanEvidence({ trialId: trial.trialId, traceId: trial.traceId, caseId: trial.caseId,
            caseVersion: trial.caseVersion, caseName: clipped(trial.caseName), repetition: trial.repetition, status: trial.status,
            reason: clipped(trial.reason), reasonTruncated: trial.reason.length > 2000,
            executionStatus: full ? full.execution?.status ?? 'not-started' : facts.success ? facts.data.status : null,
            judgeGenerations: calls === null ? null : calls.reduce((total, call) => total + call.attempts, 0),
            usage: full ? full.execution?.usage ?? null : facts.success ? facts.data.usage ?? null : null,
            artifactReferences: full ? full.execution?.artifacts.length ?? 0 : facts.success ? facts.data.artifacts?.length ?? (facts.data.status === 'not-started' ? 0 : null) : null,
        }).value);
    });
}
function scoreViews(inspection: ReportInspection, trialId?: string): EvaluationScoreView[] {
    return inspection.metadata.trials.filter(trial => !trialId || trial.trialId === trialId).flatMap(trial => trial.scores.map(score =>
        EvaluationScoreViewSchema.parse(scanEvidence({ trialId: trial.trialId, caseId: trial.caseId, repetition: trial.repetition,
            metricId: score.metricId, name: clipped(score.name), version: score.version, method: score.method, required: score.required,
            status: score.status, value: score.value, reason: clipped(score.reason), reasonTruncated: score.reason.length > 2000,
            evidence: score.evidence.map(clipped), evaluatorId: score.evaluatorId ?? null, evaluatorVersion: score.evaluatorVersion ?? null,
            category: score.category ?? (metricCatalog.some(metric => metric.id === score.metricId) ? 'formal' : null),
            applicabilityReason: score.applicabilityReason === undefined ? null : clipped(score.applicabilityReason), statistics: score.statistics ?? null,
        }).value)));
}
export function page(total: number, offset: number, limit: number, unit: 'rows' | 'characters'): z.infer<typeof EvaluationReadPageSchema> {
    if (offset > total) throw Error('Read offset is beyond the saved view');
    const end = Math.min(offset + limit, total);
    return { offset, limit, total, nextOffset: end < total ? end : null, complete: end === total, unit };
}
function sameSources(file: string, inspection: ReportInspection) {
    return inspection.sources.every(source => {
        let content: string | null;
        try { content = readFileSync(inside(dirname(file), source.reference), 'utf8'); }
        catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
            content = null;
        }
        return content === source.content;
    });
}

export function createEvaluationReader(repo: string, sessionId: string) {
    type ListItem = z.infer<typeof EvaluationExecutionListSchema>['items'][number];
    let list: { viewId: string; locations: ReturnType<typeof discoverSavedExecutions>; shown: Map<string, ListItem> } | null = null;
    const listItem = (location: ReturnType<typeof discoverSavedExecutions>[number]): ListItem => {
        if (location.error || !location.report) return { executionId: location.executionId, summary: null, error: location.error };
        try {
            const metadata = readReportMetadata(location.report);
            if (metadata.metadata.executionId !== location.executionId) throw Error('Saved report identity differs from its directory');
            return { executionId: location.executionId, summary: summary(metadata, null), error: null };
        } catch (error) { return { executionId: location.executionId, summary: null, error: clipped('Saved report read failed: ' + String(error)) }; }
    };
    let view: { viewId: string; file: string; request: Pick<EvaluationRequest<'query_evaluation_result'>, 'executionId' | 'trialId' | 'view'>;
        inspection: ReportInspection; summary: EvaluationExecutionSummary; trials: EvaluationTrialView[]; scores: EvaluationScoreView[]; text: string } | null = null;
    return {
        listExecutions(input: unknown = {}) {
            const checked = evaluationRequests.list_evaluation_executions.safeParse(input);
            if (!checked.success) return failure('input_invalid', '执行列表请求无效。');
            const request = checked.data;
            try {
                if (request.viewId) {
                    if (!list || list.viewId !== request.viewId) return failure('evaluation_view_expired', '原列表视图已失效，请刷新。');
                } else {
                    if (request.offset !== 0) return failure('evaluation_view_expired', '后续分页需要原列表视图身份。');
                    list = { viewId: randomUUID(), locations: discoverSavedExecutions(repo), shown: new Map() };
                }
                const current = list!;
                if (!isDeepStrictEqual(current.locations, discoverSavedExecutions(repo)) || current.locations.some(location =>
                    current.shown.has(location.executionId) && !isDeepStrictEqual(current.shown.get(location.executionId), listItem(location))))
                    return failure('evaluation_view_changed', '报告目录或已显示的摘要已变化，请刷新列表。');
                const paging = page(current.locations.length, request.offset, request.limit, 'rows');
                const items = current.locations.slice(request.offset, request.offset + request.limit).map(location => {
                    const item = current.shown.get(location.executionId) ?? listItem(location); current.shown.set(location.executionId, item); return item;
                });
                return ok(EvaluationExecutionListSchema.parse({ version: 1, sessionId, viewId: current.viewId, page: paging,
                    items }));
            } catch (error) { return failure('evaluation_report_invalid', String(error)); }
        },
        result(input: unknown) {
            const checked = evaluationRequests.query_evaluation_result.safeParse(input);
            if (!checked.success) return failure('input_invalid', '结果读取请求无效。');
            const request = checked.data, identity = { executionId: request.executionId, trialId: request.trialId, view: request.view };
            try {
                if (request.viewId) {
                    if (!view || view.viewId !== request.viewId || !isDeepStrictEqual(view.request, identity)) return failure('evaluation_view_expired', '原结果视图已失效，请刷新。');
                    if (reportPath(repo, request.executionId) !== view.file || !sameSources(view.file, view.inspection))
                        return failure('evaluation_view_changed', '原报告或证据已变化，请刷新结果。');
                } else {
                    if (request.offset !== 0) return failure('evaluation_view_expired', '后续分页需要原结果视图身份。');
                    const file = reportPath(repo, request.executionId), inspection = inspectReport(file);
                    if (inspection.metadata.executionId !== request.executionId) throw Error('Saved report identity differs from the requested Execution');
                    if (request.trialId && !inspection.metadata.trials.some(trial => trial.trialId === request.trialId)) return failure('evaluation_trial_unknown', '该Trial不属于原Execution。');
                    const parts = inspection.parts.filter(part => !request.trialId || part.trialId === request.trialId);
                    const full = inspection.fullReport?.trials.filter(trial => !request.trialId || trial.trialId === request.trialId);
                    const text = request.view === 'summary' ? request.trialId ? JSON.stringify(inspection.metadata.trials.find(trial => trial.trialId === request.trialId), null, 2) : ''
                        : request.view === 'scores' ? '' : JSON.stringify(request.view === 'events' ? full ? full.flatMap(trial => trial.execution?.observations ?? []) : parts.filter(part => part.kind === 'events').map(part => part.data)
                            : request.view === 'artifacts' ? full ? full.flatMap(trial => trial.execution?.artifacts ?? []) : parts.filter(part => part.kind === 'artifact').map(part => part.data)
                                : full ? full.map(trial => ({ trialId: trial.trialId, evidence: trial.execution?.evidence ?? null, judgeCalls: trial.judgeCalls }))
                                    : parts.filter(part => part.kind === 'observation').map(part => ({ trialId: part.trialId, observation: part.data })), null, 2);
                    view = { viewId: randomUUID(), file, request: identity, inspection, summary: summary(inspection, inspection.fullReport !== null),
                        trials: trialViews(inspection), scores: scoreViews(inspection, request.trialId), text: scanEvidence(text).value };
                    Object.assign(view.summary, conditions(inspection));
                }
                const current = view!, rows = request.view === 'summary' && !request.trialId ? current.trials : request.view === 'scores' ? current.scores : null;
                const limit = rows ? Math.min(request.limit, 200) : request.limit, paging = page(rows?.length ?? current.text.length, request.offset, limit, rows ? 'rows' : 'characters');
                const aggregation = z.object({ metrics: z.array(EvaluationMetricSummarySchema.strip()) }).passthrough().safeParse(current.inspection.metadata.aggregation);
                const metrics = aggregation.success ? aggregation.data.metrics : null;
                const result: EvaluationResult = EvaluationResultSchema.parse(scanEvidence({ version: 1, sessionId, viewId: current.viewId,
                    executionId: request.executionId, trialId: request.trialId ?? null, view: request.view, page: paging, summary: current.summary,
                    trials: request.view === 'summary' && !request.trialId ? current.trials.slice(request.offset, request.offset + limit) : [],
                    scores: request.view === 'scores' ? current.scores.slice(request.offset, request.offset + limit) : [], text: rows ? '' : current.text.slice(request.offset, request.offset + limit),
                    metrics, gaps: current.inspection.gaps, sourceInvalidation: current.inspection.metadata.sourceInvalidation ?? null }).value);
                return ok(result);
            } catch (error) { return failure('evaluation_report_invalid', String(error)); }
        },
        compare(input: unknown) {
            const checked = evaluationRequests.compare_evaluation.safeParse(input);
            if (!checked.success) return failure('input_invalid', '报告比较请求无效。');
            try {
                const left = readReport(reportPath(repo, checked.data.left)), right = readReport(reportPath(repo, checked.data.right));
                if (left.executionId !== checked.data.left || right.executionId !== checked.data.right) throw Error('Comparison report identity differs');
                return ok(EvaluationComparisonSchema.parse({ version: 1, sessionId, ...checked.data, rows: comparison(left, right) }));
            } catch (error) { return failure('evaluation_not_comparable', String(error)); }
        },
    };
}
