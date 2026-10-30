import type { CaseExecutionResult, GradeStatus } from '../types.ts';
import type { EvaluationScore, MetricPlan, MetricStatistics } from './types.ts';
import {isRequiredScore} from './types.ts';
import { scoreAvailability, type ScoreAvailabilityContext } from './availability.ts';
import type { LocalReport } from '../reports/store.ts';
import { metricCatalog, formalMetric } from './catalog.ts';
import { claimF1, assertResearchF1 } from './research-f1.ts';
const statuses: GradeStatus[] = ['PASS', 'FAIL', 'UNJUDGEABLE', 'ERROR', 'NOT_RUN'];
export type MetricSource = MetricStatistics & {
    executionId: string; trialId: string; repetition: number; metricId: string;
    scoreIndex: number | null; status: EvaluationScore['status']; reason: string; evidence: string[];
    unplanned: boolean;
};
export type MetricTotal = {
    metricId: string; version: number; unit: string; formula: string;
    numerator: number | null; denominator: number | null; missing: number; value: number | null;
    unknownDenominators: number; unknownMissing: number; zeroDenominators: number;
    unplannedTrials: number; notApplicable: number; sources: MetricSource[];
    derivedFrom?: string[];
    missingUnit?: 'Trial';
};
export type TrialAggregation = {
    contract: 'flowmate-trial-aggregation/v1'; executionId: string;
    cases: Array<{ caseId: string; caseVersion: number; caseConditions?: Record<string,unknown>;
        planned: number; started: number; statuses: Record<GradeStatus, number>;
        trials: Array<{ executionId: string; trialId: string; repetition: number; status: GradeStatus; reason: string }>;
        metrics: MetricTotal[] }>;
    metrics: MetricTotal[];
};
function validatePlan(plan: MetricPlan) {
    const metric = formalMetric(plan.metricId);
    if (plan.version !== metric.version || plan.unit !== metric.unit) throw new Error('Metric version or unit differs from declared catalog');
    if (plan.notApplicable !== undefined) {
        if (!plan.notApplicable.trim() || plan.denominator !== undefined) throw new Error('Non-applicability needs a reason and no denominator');
    } else if (plan.denominator !== null && (!Number.isSafeInteger(plan.denominator) || plan.denominator! < 0))
        throw new Error('Metric opportunity denominator must be a nonnegative integer or null');
}
function validateCounts(counts: MetricStatistics) {
    for (const value of [counts.numerator, counts.denominator, counts.missing])
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid metric opportunity counts');
    if (counts.denominator !== null && ((counts.numerator ?? 0) + (counts.missing ?? 0) > counts.denominator))
        throw new Error('Metric counts exceed opportunity denominator');
}
function totals(sources: MetricSource[]): MetricTotal[] {
    const metrics: MetricTotal[] = metricCatalog.map(metric => {
        const own = sources.filter(s => s.metricId === metric.id), applicable = own.filter(s => s.status !== 'NOT_APPLICABLE');
        const sum = (key: 'numerator' | 'denominator' | 'missing') => {
            const value = applicable.reduce((total, source) => total + (source[key] ?? 0), 0);
            if (!Number.isSafeInteger(value)) throw new Error('Metric aggregate exceeds safe integer range');
            return value;
        };
        const numerator = sum('numerator'), denominator = sum('denominator');
        const unknownDenominators = applicable.filter(s => s.denominator === null).length;
        return { metricId: metric.id, version: metric.version, unit: metric.unit, formula: metric.formula,
            numerator, denominator, missing: sum('missing'), value: unknownDenominators || !denominator ? null : numerator / denominator,
            unknownDenominators, unknownMissing: applicable.filter(s => s.missing === null).length,
            zeroDenominators: applicable.filter(s => s.denominator === 0).length,
            unplannedTrials: own.filter(s => s.unplanned).length, notApplicable: own.length - applicable.length, sources: own };
    });
    const precision = metrics.find(m => m.metricId === 'DR01')!, recall = metrics.find(m => m.metricId === 'DR02')!;
    const f1 = metrics.find(m => m.metricId === 'DR03')!;
    const records = precision.sources.map((p, i) => [p, recall.sources[i]!, f1.sources[i]!] as const);
    const excluded = ([p, r, own]: typeof records[number]) => own.status === 'NOT_APPLICABLE' ||
        own.unplanned && p.status === 'NOT_APPLICABLE' && r.status === 'NOT_APPLICABLE';
    const pairs = records.filter(record => !excluded(record)), omitted = records.filter(excluded);
    const paired = pairs.length > 0 && pairs.every(([p, r, own]) => r && p.trialId === r.trialId && !p.unplanned && !r.unplanned &&
        [p, r].every(s => ['PASS', 'FAIL'].includes(s.status)) && (own.unplanned || ['PASS', 'FAIL'].includes(own.status)));
    const ratio = (sources: MetricSource[]) => {
        if (sources.some(s => s.numerator === null || s.denominator === null || s.missing === null || s.missing > 0)) return null;
        const numerator = sources.reduce((n, s) => n + s.numerator!, 0), denominator = sources.reduce((n, s) => n + s.denominator!, 0);
        return denominator ? numerator / denominator : null;
    };
    const p = ratio(pairs.map(pair => pair[0])), r = ratio(pairs.map(pair => pair[1]));
    f1.value = paired && p !== null && r !== null ? claimF1(p, r) : null;
    // F1 has no count denominator of its own: keep the P/R sources instead of inventing opportunities.
    f1.sources = [...pairs.map(pair => pair[0]), ...pairs.map(pair => pair[1]),
        ...omitted.flatMap(([p, r, own]) => own.unplanned ? [p, r] : [own])];
    f1.numerator = null; f1.denominator = null; f1.derivedFrom = ['DR01', 'DR02'];
    const affected = (check: (s: MetricSource) => boolean) => pairs.filter(pair => pair.slice(0, 2).some(s => check(s))).length;
    f1.unplannedTrials = affected(s => s.unplanned);
    f1.unknownDenominators = affected(s => s.denominator === null);
    f1.unknownMissing = affected(s => s.missing === null);
    f1.zeroDenominators = affected(s => s.denominator === 0);
    f1.missing = affected(s => s.missing !== null && s.missing > 0); f1.missingUnit = 'Trial';
    f1.notApplicable = omitted.length;
    return metrics;
}
export function aggregateTrials(report: LocalReport): TrialAggregation {
    if (report.contract !== 'flowmate-agent-run/v2')
        throw new Error('Aggregation requires v2 Trial records; legacy counts cannot be inferred');
    const seen = new Set<string>(), groups = new Map<string, TrialAggregation['cases'][number]>(), allSources: MetricSource[] = [];
    for (const trial of report.trials) {
        if (!statuses.includes(trial.status)) throw new Error('Invalid Trial status');
        if (!trial.trialId || !trial.caseId || !Number.isSafeInteger(trial.caseVersion) || trial.caseVersion < 1 ||
            !Number.isSafeInteger(trial.repetition) || trial.repetition < 1) throw new Error('Invalid Trial identity');
        if (seen.has(trial.trialId)) throw new Error('Duplicate Trial identity');
        seen.add(trial.trialId);
        if (trial.execution && trial.execution.identity.executionId !== report.executionId) throw new Error('Trial belongs to another Execution');
        const plan = trial.metricPlan ?? [];
        plan.forEach(validatePlan);
        if (!trial.scoringState || trial.scoringState === 'complete' || trial.scores.length > 0)
            assertResearchF1(plan, trial.scores, trial.execution);
        if (new Set(plan.map(p => p.metricId)).size !== plan.length) throw new Error('Duplicate metric opportunity plan');
        const key = JSON.stringify([trial.caseId, trial.caseVersion, trial.caseConditions, [...plan].sort((a, b) => a.metricId.localeCompare(b.metricId))]);
        let group = groups.get(key);
        if (!group) {
            group = { caseId: trial.caseId, caseVersion: trial.caseVersion, caseConditions: trial.caseConditions,
                planned: 0, started: 0, statuses: Object.fromEntries(statuses.map(s => [s, 0])) as Record<GradeStatus, number>, trials: [], metrics: [] };
            groups.set(key, group);
        }
        if (group.trials.some(t => t.repetition === trial.repetition)) throw new Error('Duplicate Case repetition');
        group.planned++;
        if (trial.execution?.started) group.started++;
        group.statuses[trial.status]++;
        group.trials.push({ executionId: report.executionId, trialId: trial.trialId, repetition: trial.repetition, status: trial.status, reason: trial.reason });
        const sources: MetricSource[] = [];
        for (const metric of metricCatalog) {
            const opportunity = plan.find(p => p.metricId === metric.id);
            const indexes = trial.scores.flatMap((s, i) => s.metricId === metric.id ? [i] : []);
            if (indexes.length > 1) throw new Error('Duplicate metric measurement');
            const scoreIndex = indexes[0] ?? null, score = scoreIndex === null ? null : trial.scores[scoreIndex]!;
            if (score && (!opportunity || score.version !== opportunity.version)) throw new Error('Measurement differs from declared metric plan');
            let counts: MetricStatistics = { unit: metric.unit, numerator: 0, denominator: opportunity?.denominator ?? null, missing: opportunity?.denominator ?? null };
            let status: EvaluationScore['status'] = score?.status ?? (trial.status === 'PASS' ? 'UNJUDGEABLE' : trial.status);
            let reason = score?.reason ?? 'Necessary metric measurement missing';
            if (opportunity?.notApplicable) {
                if (score && score.status !== 'NOT_APPLICABLE') throw new Error('Measurement contradicts declared non-applicability');
                counts = { unit: metric.unit, numerator: null, denominator: null, missing: null };
                status = 'NOT_APPLICABLE'; reason = opportunity.notApplicable;
            } else if (metric.id === 'task-success' && opportunity) {
                if (opportunity.denominator !== 1) throw new Error('Task success requires one opportunity per Trial');
                counts = { unit: 'Trial', numerator: trial.status === 'PASS' ? 1 : 0, denominator: 1,
                    missing: ['ERROR', 'UNJUDGEABLE', 'NOT_RUN'].includes(trial.status) ? 1 : 0 };
                status = trial.status; reason = trial.reason;
            } else if (score?.statistics) {
                counts = score.statistics;
                if (counts.unit !== metric.unit || opportunity?.denominator !== null && counts.denominator !== opportunity?.denominator)
                    throw new Error('Measurement unit or denominator differs from declared plan');
                if (score.status === 'NOT_APPLICABLE') throw new Error('Non-applicability was not declared');
            }
            validateCounts(counts);
            if (metric.id !== 'DR03' && score?.statistics && score.value !== null && (counts.numerator === null || !counts.denominator ||
                !Number.isFinite(score.value) || Math.abs(score.value - counts.numerator / counts.denominator) > 1e-12))
                throw new Error('Score ratio differs from original metric counts');
            sources.push({ ...counts, executionId: report.executionId, trialId: trial.trialId, repetition: trial.repetition, metricId: metric.id,
                scoreIndex, status, reason, evidence: score?.evidence ?? [], unplanned: !opportunity });
        }
        allSources.push(...sources);
    }
    const cases = [...groups.values()];
    for (const group of cases) {
        const ids = new Set(group.trials.map(t => t.trialId));
        group.metrics = totals(allSources.filter(s => ids.has(s.trialId)));
    }
    return { contract: 'flowmate-trial-aggregation/v1', executionId: report.executionId, cases, metrics: totals(allSources) };
}
export function aggregate(scores: EvaluationScore[], execution: CaseExecutionResult, context?: ScoreAvailabilityContext): {
    status: GradeStatus;
    reason: string;
    counts: Record<string, number>;
} {
    const counts: Record<string, number> = {};
    for (const s of scores)
        counts[s.status] = (counts[s.status] ?? 0) + 1;
    const finish = (status: GradeStatus, reason: string) => ({ status, reason, counts });
    if (!execution.started)
        return finish('NOT_RUN', execution.error?.message ?? '任务未启动');
    const required = scores.filter(score => isRequiredScore(score, context));
    if (required.some(s => s.status === 'FAIL'))
        return finish('FAIL', '必要任务或安全判据失败');
    if (execution.status === 'cancelled')
        return finish('UNJUDGEABLE', '用户中止，运行记录保留；不代表质量通过');
    if (execution.status === 'error' || execution.error?.infrastructure)
        return finish('ERROR', execution.error?.message ?? '设施错误');
    const controller = execution.evidence['case-controller'];
    if (controller && !controller.present && (controller.actual as { exposure?: { verified?: boolean } } | null)?.exposure?.verified !== true)
        return finish('UNJUDGEABLE', '题目控制条件未证实触发，不能推定任务效果');
    if (execution.status !== 'completed' || !execution.endpointReached)
        return finish('FAIL', '已启动任务未到达预定终点');
    if (required.some(s => s.status === 'ERROR'))
        return finish('ERROR', '必要评分出错');
    if (!required.length || required.some(s => s.status !== 'PASS' || scoreAvailability(s, context).state !== 'measured'))
        return finish('UNJUDGEABLE', '必要评分或证据尚未齐全');
    return finish('PASS', '必要自动检查通过；不等于正式验收');
}
export function dimensions(scores:EvaluationScore[],started=true,context?:ScoreAvailabilityContext) {
    const dimension=(score:EvaluationScore)=>{
        const group=metricCatalog.find(m=>m.id===score.metricId)?.group;
        return group==='safety'||['input-isolation','environment-isolation','no-secret','case-forbidden-capabilities','fact-check/forbidden-skills'].includes(score.metricId)?'safety':
            ['task','research'].includes(group??'')||['task-result','reference-fields','line-items','fact-check','answer-relevance','case-evidence-required'].includes(score.metricId)?'result':'process';
    };
    return Object.fromEntries(['result','process','safety'].map(name=>{
        const own=scores.filter(s=>dimension(s)===name&&!['not-applicable','no-opportunity'].includes(scoreAvailability(s,context).state)),
            required=own.filter(score=>isRequiredScore(score,context));
        const status=!own.length?started?'NOT_APPLICABLE':'NOT_RUN':required.some(s=>s.status==='FAIL')?'FAIL':required.some(s=>s.status==='ERROR')?'ERROR':
            own.some(s=>['missing-evidence','not-run'].includes(scoreAvailability(s,context).state))?'UNJUDGEABLE':'PASS';
        return[name,{status,counts:Object.fromEntries(['PASS','FAIL','UNJUDGEABLE','ERROR','NOT_RUN'].map(s=>[s,own.filter(v=>v.status===s).length]))}];
    }));
}
