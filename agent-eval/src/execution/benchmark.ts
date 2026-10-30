import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { agentConfig, evaluationEnv, langfuseConfig, localAgentCredential, type LangfuseConnection } from '../configuration.ts';
import { judgeConfig } from '../scoring/judges/client.ts';
import { experimentPlanSchema, type ExperimentRecord } from '../../../packages/contracts/src/evaluation-experiments.ts';
import { runExperiment, compareExperiment, createBaseline, checkGate, listBaselines, type ExperimentDependencies } from '../experiments/index.ts';
import { archiveFile, archiveReference, findArchive, readArchive, readArchivePart, updateArchive } from '../reports/archive.ts';
import { readReport, reportPath, exitCode, type LocalReport } from '../reports/store.ts';
import { writeRunReadme, runProgress } from '../reports/readme.ts';
import { exportReport } from '../langfuse/export.ts';
import type { EvaluationConnection } from '../../../packages/contracts/src/evaluation.ts';
import { findDataset } from './plan.ts';
import { selectCases } from '../dataset-loader/local.ts';
import { scanEvidence } from './evidence-safety.ts';

export function createBenchmarkPlan(selection: 'smoke' | 'full', candidate: EvaluationConnection & { reasoning?: string },
    control: EvaluationConnection & { reasoning?: string }) {
    if (candidate.model !== 'gpt-6-luna' || candidate.reasoning !== 'max' || !localAgentCredential(candidate))
        throw Error('Benchmark candidate requires local-gateway gpt-6-luna / max');
    if (control.model !== 'gpt-6.1-sol' || control.reasoning !== 'max' || !localAgentCredential(control))
        throw Error('Benchmark control requires local-gateway gpt-6.1-sol / max');
    return experimentPlanSchema.parse({ benchmark: { id: 'baseline', revision: 1, selection }, repeats: 1, axes: ['model'],
        control: { id: 'sol', model: { model: control.model, api: control.api, baseUrl: control.baseUrl, reasoning: 'max' } },
        candidates: [{ id: 'luna', model: { model: candidate.model, api: candidate.api, baseUrl: candidate.baseUrl, reasoning: 'max' } }] });
}
export function benchmarkExitCode(record: ExperimentRecord, reports: LocalReport[], gate: 'pass' | 'fail' | 'blocked', exported: boolean): 0 | 1 | 2 {
    const ids = record.arms.flatMap(arm => arm.executionIds), candidateIds = record.arms.find(arm => arm.id === record.plan.candidates[0]?.id)?.executionIds ?? [];
    if (record.status !== 'complete' || !ids.length || !candidateIds.length || ids.some(id => !reports.some(report => report.executionId === id)) ||
        reports.some(report => !report.executionComplete || report.scoring !== 'complete') || gate === 'blocked' || !exported) return 2;
    return gate === 'fail' || reports.some(report => candidateIds.includes(report.executionId) && exitCode(report) !== 0) ? 1 : 0;
}
async function projectPreflight(connection: LangfuseConnection, signal?: AbortSignal) {
    const response = await fetch(connection.baseUrl + '/api/public/projects', { headers: { Authorization: 'Basic ' +
        Buffer.from(connection.publicKey + ':' + connection.secretKey).toString('base64') },
        signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw Error('Langfuse project preflight failed (' + response.status + ')');
    z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()).length(1) }).parse(await response.json());
}
export type BenchmarkSummary = { runId: string; selection: 'smoke' | 'full'; expectedCases: number; plannedTrials: number; observedTrials: number;
    progress: ReturnType<typeof runProgress>;
    executionComplete: boolean; scoringComplete: boolean; exportComplete: boolean; gate: 'pass' | 'fail' | 'blocked'; exitCode: 0 | 1 | 2;
    reportPath: string; readmePath: string };
export async function finalizeBenchmark(repo: string, runId: string, options: { signal?: AbortSignal; connection?: LangfuseConnection } = {}): Promise<BenchmarkSummary> {
    const file = findArchive(repo, runId), initial = readArchive(file), record = initial.experiment as ExperimentRecord;
    if (!record || !['smoke', 'full'].includes(record.plan.benchmark.selection)) throw Error('Run is not an executable Benchmark experiment');
    if (record.status === 'running') throw Error('A running Benchmark cannot be finalized by an upload retry');
    const selection = record.plan.benchmark.selection, expectedCases = selection === 'smoke' ? 7 : 62;
    const reports = record.arms.flatMap(arm => arm.executionIds.map(id => readReport(reportPath(repo, id))));
    for (const report of reports) {
        if (options.signal?.aborted) break;
        if (!report.endedAt || report.scoring !== 'complete') continue;
        try { await exportReport(report, reportPath(repo, report.executionId), undefined, repo,
            options.connection ? { connection: options.connection } : {}); }
        catch (error) {
            updateArchive(file, archive => {
                const previous = archive.exports[report.executionId] as LocalReport['export'] | undefined;
                archive.exports[report.executionId] = { ...previous, backend: 'langfuse', status: previous?.progress?.acceptedEventIds.length ? 'partial' : 'error',
                    error: scanEvidence(error instanceof Error ? error.message : String(error)).value };
            });
        }
    }
    const comparisons = compareExperiment(repo, record.id);
    let gate: 'pass' | 'fail' | 'blocked' = 'blocked';
    const baselineIds: string[] = [];
    if (record.status === 'complete') {
        try {
            const baselineId = 'Baseline-' + initial.id.replace(/^Run-/, '') + '-' + record.plan.control.id;
            const baseline = listBaselines(repo).find(value => value.id === baselineId) ?? createBaseline(repo,
                { experimentId: record.id, armId: record.plan.control.id, baselineId });
            baselineIds.push(baseline.id);
            const old = Object.values(readArchive(file).gates).find(value => {
                const saved = value as { baselineId?: string; armId?: string }; return saved.baselineId === baseline.id && saved.armId === record.plan.candidates[0]!.id;
            }) as { status: 'pass' | 'fail' | 'blocked' } | undefined;
            gate = old?.status ?? checkGate(repo, { baselineId: baseline.id, experimentId: record.id, armId: record.plan.candidates[0]!.id,
                fullRelease: selection === 'full' }).status;
            if (selection === 'full') {
                const lunaId = 'Baseline-' + initial.id.replace(/^Run-/, '') + '-luna-observed';
                const luna = listBaselines(repo).find(value => value.id === lunaId) ?? createBaseline(repo,
                    { experimentId: record.id, armId: record.plan.candidates[0]!.id, baselineId: lunaId });
                baselineIds.push(luna.id);
            }
        } catch (error) {
            gate = 'blocked';
            updateArchive(file, archive => { archive.gates['baseline-unavailable'] = { status: 'blocked', exitCode: 2, fullRelease: false,
                scope: comparisons[0]?.scope ?? { selection, cases: 0, trials: 0, datasets: [] }, deltas: [],
                reasons: [{ code: 'baseline-unavailable', message: scanEvidence(error instanceof Error ? error.message : String(error)).value, evidenceRefs: [file] }] }; });
        }
    }
    const latest = record.arms.flatMap(arm => arm.executionIds.map(id => readReport(reportPath(repo, id))));
    const progress = runProgress(latest), observedTrials = progress.startedTrials;
    const executionComplete = record.status === 'complete' && observedTrials === expectedCases * 2 && progress.endedTrials === observedTrials
        && progress.stopConfirmedTrials === observedTrials && latest.every(report => report.executionComplete);
    const scoringComplete = latest.length > 0 && latest.every(report => report.scoring === 'complete');
    const exportComplete = latest.length > 0 && latest.every(report => report.export.status === 'complete');
    const code = executionComplete && comparisons.every(value => value.status === 'comparable')
        ? benchmarkExitCode(record, latest, gate, exportComplete) : 2;
    const summary: BenchmarkSummary = { runId: initial.id, selection, expectedCases, plannedTrials: expectedCases * 2, observedTrials, progress,
        executionComplete, scoringComplete, exportComplete, gate, exitCode: code, reportPath: relative(repo, file).replaceAll('\\', '/'),
        readmePath: relative(repo, join(dirname(file), 'README.md')).replaceAll('\\', '/') };
    updateArchive(file, archive => {
        const previous = archive.workflow && typeof archive.workflow === 'object' ? archive.workflow : {};
        archive.workflow = { ...previous, summary, baselineIds }; archive.status = record.status === 'stopped' ? 'stopped' : code === 2 ? 'blocked' : 'complete'; archive.endedAt = new Date().toISOString();
    });
    writeRunReadme(file); return summary;
}
export async function runBenchmarkWorkflow(repo: string, selection: 'smoke' | 'full', deps: ExperimentDependencies = {}) {
    const env = evaluationEnv(repo, deps.env ?? process.env), agent = agentConfig(repo, env), judge = judgeConfig(env, repo);
    if (judge?.provider !== 'openai-compatible' || judge.model !== 'gpt-6.1-terra' || judge.reasoningEffort !== 'max' || !localAgentCredential(judge))
        throw Error('Benchmark requires fixed local-gateway gpt-6.1-terra / max Judge');
    const connection = langfuseConfig(repo, env); await projectPreflight(connection, deps.signal);
    const control = agentConfig(repo, env, { model: env.FLOWMATE_EVAL_CONTROL_MODEL, api: env.FLOWMATE_EVAL_CONTROL_API,
        baseUrl: env.FLOWMATE_EVAL_CONTROL_BASE_URL, reasoning: env.FLOWMATE_EVAL_CONTROL_REASONING_EFFORT });
    const plan = createBenchmarkPlan(selection, agent.configuration, control.configuration);
    const datasets = deps.loadBenchmark ? await deps.loadBenchmark(repo, 'baseline', 1) :
        ['flowmate-agent-v1', 'flowmate-research-v1'].map(dataset => findDataset(repo, { dataset }));
    const count = datasets.reduce((sum, dataset) => sum + selectCases(dataset, selection).length, 0), expected = selection === 'smoke' ? 7 : 62;
    if (count !== expected) throw Error('Benchmark member count differs from approved ' + selection + ' selection: ' + count);
    const record = await runExperiment(repo, plan, { ...deps, loadBenchmark: () => structuredClone(datasets), env: { ...env, FLOWMATE_EVAL_USER_ID: 'eval-demo-user' } });
    return finalizeBenchmark(repo, record.id, { signal: deps.signal, connection });
}
