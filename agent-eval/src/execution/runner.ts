import { fixtureSelection } from '../dataset-loader/selection.ts';
import { atomicJson, publicVersions } from '../reports/files.ts';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { artifactJson } from '../artifacts.ts';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { discoverDatasets, REPO_ROOT, caseConditions, caseFiles, resolveCase, restoreCaseInputs, selectCases, assertSemanticSelection, judgeSelection, type LocalDataset, type Check } from '../dataset-loader/local.ts';
import { productAgent, createProductAgent, type AgentKernel } from '../adapters/agent.ts';
import { prepareAgentConfig, type AgentModelCapabilities } from '../configuration.ts';
import { runConfigSchema, parseRunConfig, evaluationRunDefaults } from './plan.ts';
export { runConfigSchema, parseRunConfig, findDataset, createEvaluationPlan, sameEvaluationPlan } from './plan.ts';
export {assertModelConfiguration} from '../adapters/agent.ts';
import { executeCase, type ExecutionPhase } from './execute-case.ts';
import { prepareSafetyProbes } from './safety-probes.ts';
import { codeIdentity, changedSourcePaths, runtimeSourceConditions, type EvaluationRuntime } from './source.ts';
import { scanEvidence } from './evidence-safety.ts';
import { evaluateAll } from '../scoring/evaluate.ts';
import { aggregate } from '../scoring/aggregate.ts';
import { judgeConfig, prepareJudge, publicJudgeConfig, type Fetcher, type JudgeConfig } from '../scoring/judges/client.ts';
import { rubricsFor } from '../scoring/judges/compact.ts';
import {rubric as legacyRubric} from '../scoring/judges/answer-relevance.ts';
import {formalRules} from '../scoring/formal-rules.ts';
import {metricCatalog} from '../scoring/catalog.ts';
import {compileEvaluatorPlan} from '../scoring/evaluator-plan.ts';
import {createRegistry} from '../scoring/registry.ts';
import { saveReport, safeId, type LocalReport } from '../reports/store.ts';
import { createArchive, archiveReference, archiveFile, readArchive, snapshotReference, writeArchivePart, finishArchive } from '../reports/archive.ts';
import { discoverSavedExecutions } from '../reports/paths.ts';
import { writeRunReadme } from '../reports/readme.ts';
import { deriveBadcases, saveBadcases } from '../reports/badcases.ts';
import { recordRegressions } from '../reports/regressions.ts';
import { deriveTrialStatistics, type TrialStatistics } from '../reports/trial-statistics.ts';
import type { ExecutionStatus } from '../types.ts';
import { reportTraces } from './trace.ts';
type TrialProgress = { index: number; total: number; caseId: string; trialId: string; trialIndex?: number; trialsPerCase?: number };
export type EvaluationProgress =
    | { type: 'preflight' }
    | { type: 'plan'; selection: 'smoke' | 'holdout' | 'full' | 'case'; total: number; caseCount?: number; trialsPerCase?: number; datasets: Array<{ id: string; total: number; caseCount?: number }> }
    | { type: 'dataset-start'; datasetId: string; executionId: string; reportPath: string }
    | TrialProgress & { type: 'trial-phase'; phase: ExecutionPhase | 'restoring' | 'scoring' | 'saving' }
    | TrialProgress & { type: 'trial-cleanup'; executionId: string; stopConfirmed: boolean }
    | TrialProgress & { type: 'agent-end'; status: ExecutionStatus; endpointReached?: boolean; reason?: string }
    | TrialProgress & { type: 'scoring-end'; status: LocalReport['trials'][number]['status']; reason: string }
    | TrialProgress & { type: 'trial-end'; status: LocalReport['trials'][number]['status']; reason: string; elapsedMs: number; evidenceDirectory: string }
    | {type:'source-invalidated';datasetId:string;executionId:string;reason:string;paths:string[]}
    | {type:'diagnostics-end';executionId:string;count?:number;json?:string;markdown?:string;error?:string}
    | {type:'regression-record-error';executionId:string;error:string}
    | { type: 'dataset-end'; datasetId: string; executionId: string; reportPath: string; stopped: boolean; reason?: string; counts: Record<string, number>; statistics?: TrialStatistics };
type ProgressObserver = (event: EvaluationProgress) => void;
function scoringProgressReason(trial: LocalReport['trials'][number]) {
    const errors=trial.scores.filter(score=>score.status==='ERROR');
    if(!errors.length)return trial.reason;
    const semantic=errors.filter(score=>score.method==='llm-judge');
    const call=trial.judgeCalls.find(call=>semantic.some(score=>score.judge?.callId===call.callId))??trial.judgeCalls[0];
    let summary='评分设施异常';
    if(semantic.length) {
        if(!call) summary=trial.execution?.error?.infrastructure?'执行设施异常，语义评分未运行':'必要语义评分未运行';
        else if(call.error) summary=call.transportStatus===402?'Judge 计费不可用':[401,403].includes(call.transportStatus??0)?'Judge 认证失败':
            /timeout/i.test(call.error)?'Judge 调用超时':/cancel|abort/i.test(call.error)?'Judge 调用已取消':
            call.stopReason==='length'?'Judge 返回被截断':call.responseComplete?'Judge 返回格式或指标身份不合法':'Judge 调用失败或返回未完成';
        else {
            const reasons=semantic.map(score=>score.reason).join(' ');
            summary=/omitted/i.test(reasons)?'Judge 返回指标缺失':/duplicate metric/i.test(reasons)?'Judge 返回重复指标':
                /Research witness/i.test(reasons)?'Judge 研究见证校验失败':/counts|denominator|opportunity/i.test(reasons)?'Judge 返回计数或机会索引不合法':'Judge 返回指标结构不合法';
        }
    } else if(errors.some(score=>score.reason.includes('采集失败')))summary='必要证据采集失败';
    return `${trial.reason}；评分异常：${summary}（${errors.length}项，详见报告）`;
}
function notifyProgress(observer: ProgressObserver | undefined, event: EvaluationProgress) {
    try { observer?.(structuredClone(event)); } catch { /* Progress must not change evaluation results or cleanup. */ }
}
export async function runLocal(repo: string, options: {
    dataset: LocalDataset;
    selection?: 'smoke' | 'holdout' | 'full';
    caseId?: string;
    repeat?: number;
    executionId?: string;
    backend: 'local' | 'langfuse';
    judge: 'auto' | 'off' | 'required';
    judgeConfigFile?: string;
    config?: z.infer<typeof runConfigSchema>;
}, deps: {
    runFile?: string;
    runtime?: EvaluationRuntime;
    kernel?: AgentKernel;
    env?: NodeJS.ProcessEnv;
    fetcher?: Fetcher;
    signal?: AbortSignal;
    preparedAgent?: Awaited<ReturnType<typeof prepareAgentConfig>>;
    preparedJudge?: JudgeConfig | null;
    onProgress?: ProgressObserver;
} = {}) {
    const notify = (event: EvaluationProgress) => notifyProgress(deps.onProgress, event);
    notify({ type: 'preflight' });
    const dataset = structuredClone(options.dataset), selected = selectCases(dataset, options.selection, options.caseId);
    if (!selected.length) throw new Error(dataset.manifest.suite === 'badcase' ? '暂无可运行成员' : 'No Cases in selected partition');
    const executionId = safeId(options.executionId ?? ('agent-' + Date.now() + '-' + randomUUID().slice(0, 8)));
    if (discoverSavedExecutions(repo).some(saved => saved.executionId === executionId)) throw Error('Conflicting duplicate execution ID: ' + executionId);
    const isProductAgent = !deps.kernel || deps.kernel === productAgent;
    let kernel = deps.kernel ?? productAgent;
    let config: z.infer<typeof runConfigSchema> & { modelCapabilities?: AgentModelCapabilities } = parseRunConfig(options.config ?? {});
    const repeat = options.repeat ?? config.repeat ?? 1;
    if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20)
        throw new Error('Trials must be 1–20');
    if (isProductAgent) {
        const agent = deps.preparedAgent ?? await prepareAgentConfig(repo, deps.env ?? process.env, config, undefined, deps);
        config = { ...config, ...agent.configuration, ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }) };
        kernel = createProductAgent(repo, agent.apiKey, deps.runtime);
    }
    const ready = kernel.readiness();
    if (!ready.ready)
        throw new Error(ready.reason);
    notify({ type: 'plan', selection: options.caseId ? 'case' : options.selection ?? 'full', total: selected.length * repeat,
        caseCount: selected.length, trialsPerCase: repeat, datasets: [{ id: dataset.manifest.id, total: selected.length * repeat, caseCount: selected.length }] });
    assertSemanticSelection({ manifest: dataset.manifest, cases: selected }, options.judge === 'required');
    if (selected.some(c => c.expected.checks.some(check => check.metric === 'answer-relevance' || dataset.manifest.scoring.required.includes(check.metric))))
        throw new Error('Case cannot override common scoring or select Judge; configure Judges once in dataset.json');
    const selection=judgeSelection({manifest:dataset.manifest,cases:selected},options.judge==='required');
    let judge = options.judge === 'off' || !selection.needed ? null : deps.preparedJudge !== undefined ? deps.preparedJudge : judgeConfig(deps.env ?? process.env, repo, options.judgeConfigFile);
    const batch = dataset.manifest.scoring.judges.find(j => j.id === 'semantic-batch');
    const plans=selected.flatMap(task=>'contract'in task&&task.expected.semantic?[task.expected.semantic]:[]);
    const rubrics = rubricsFor(plans,judge?.provider==='codex-cli');
    const judgeRequired = selection.required;
    if (options.judge !== 'off' && judgeRequired && !judge)
        throw new Error('Required Judge is unavailable');
    if (judge && deps.preparedJudge === undefined) judge = await prepareJudge(judge, deps.fetcher, deps.signal);
    const selectedJudge = judge ? publicJudgeConfig(judge) : null;
    const runFile = deps.runFile ?? createArchive(repo, { selection: options.caseId ? 'case' : options.selection ?? 'full' }).file;
    const root = dirname(archiveFile(runFile)), file = archiveReference(runFile, 'executions', executionId);
    const sourceRoot=deps.runtime ? deps.runtime.mode === 'installed' ? deps.runtime.layout.runtimeRoot : deps.runtime.repository
        : isProductAgent&&!existsSync(join(repo,'apps/host/main.ts'))?REPO_ROOT:repo;
    const code = codeIdentity(sourceRoot, undefined, deps.runtime);
    const runtimeSource=runtimeSourceConditions(sourceRoot,code,deps.runtime);
    const prepared = selected.map(task => {
        try {
            return { task, resolved: resolveCase(dataset, task, repo), error: null };
        }
        catch (error) {
            return { task, resolved: null, error: String(error) };
        }
    });
    const authored=dataset.embedded?.authored;
    const snapshot=scanEvidence({version:'v1',dataset:dataset.manifest.id,repeat,selection:options.selection??'full',configuration:config,judge:selectedJudge,
        cases:authored?authored.cases.filter(c=>selected.some(t=>t.id===c.id)):selected,
        gold:authored?Object.fromEntries(selected.map(c=>[c.id,authored.gold[c.id]])):undefined,
        materials:prepared.map(({task,resolved})=>({caseId:task.id,materials:resolved?.projected.materials??[],files:resolved?caseFiles(dataset,task):[]})),
        ...(dataset.regressionOrigins ? { regressionOrigins: dataset.regressionOrigins } : {}),
        ...(dataset.published ? { published: dataset.published } : {}),
        scoring:{scoringVersion:2,catalog:metricCatalog,rules:formalRules,evaluators:createRegistry().list().map(({id,name,kind,version,outputs,rubric})=>({id,name,kind,version,outputs,rubric})),...(batch?{rubrics}:{rubric:legacyRubric}),
            plans:selected.map(task=>({caseId:task.id,checks:task.expected.checks,...('contract'in task?{metrics:task.expected.metrics,semantic:task.expected.semantic}:{})}))},
        fixtures:authored?Object.fromEntries(selected.flatMap(c=>{const name=authored.cases.find(d=>d.id===c.id)?.input.fixture?.name;return name?[[name,authored.fixtures[name]]]:[];})):undefined});
    if((snapshot.fact.actual as {leaked:boolean}).leaked)throw Error('Secret in declared configuration; refusing execution');
    writeArchivePart(snapshotReference(file), { ...snapshot.value, runtimeSource });
    const report: LocalReport = {
        contract: 'flowmate-agent-run/v2', executionId, runId: readArchive(runFile).id, code,
        executionKind: isProductAgent && !deps.fetcher ? 'model' : 'controlled',
        dataset: { id: dataset.manifest.id, version: dataset.manifest.version,  subject: 'agent' },
        selection: options.caseId ? 'case' : options.selection ?? 'full', environment: config.environment ?? deps.env?.FLOWMATE_EVAL_ENVIRONMENT ?? process.env.FLOWMATE_EVAL_ENVIRONMENT ?? evaluationRunDefaults.environment, userId: deps.env?.FLOWMATE_EVAL_USER_ID ?? process.env.FLOWMATE_EVAL_USER_ID,
        startedAt: new Date().toISOString(), endedAt: null, repeat, executionComplete: false, scoring: 'pending', manualReview: 'none', formalAcceptance: 'not-assessed',
        scoringConfiguration: { version: dataset.manifest.scoring.version, scoringVersion:2, judgeMode: options.judge,
            judge:selectedJudge,...(batch?{rubrics}:{}) },
        trials: [], export: { backend: options.backend, status: options.backend === 'local' ? 'disabled' : 'pending' }
    };
    for (let repetition = 1; repetition <= repeat; repetition++)
        for (const { task,resolved } of prepared) {
            const trialId = executionId + '-' + task.id + '-trial-' + repetition;
            report.trials.push({ caseId: task.id, caseVersion: task.version, caseConditions: resolved?caseConditions(dataset, task):{task,unavailable:true}, caseName: task.name, category: task.category, purpose: dataset.embedded?.authored?.cases.find(c=>c.id===task.id)?.purpose??'regression',
                partition: dataset.manifest.suite === 'badcase' ? 'badcase' : dataset.manifest.smoke.includes(task.id) ? 'smoke' :
                    dataset.manifest.holdout && !dataset.manifest.holdout.includes(task.id) ? 'full' : 'holdout', repetition, trialId, traceId: randomUUID().replaceAll('-',''),
                ...(dataset.regressionOrigins?.[task.id] ? { regressionOrigins: structuredClone(dataset.regressionOrigins[task.id]) } : {}),
                sessionId: 'Eval-' + trialId, status: 'NOT_RUN', reason: 'Planned', counts: {}, execution: null, scores: [], judgeCalls: [], feedback: 'none',
                metricPlan: 'contract' in task ? structuredClone(task.expected.metrics) : [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }],
                evaluatorPlan:compileEvaluatorPlan(task,[...dataset.manifest.scoring.required.map(metric=>({metric,required:true})),...task.expected.checks]),
                ...('contract' in task && task.expected.semantic ? { semanticPlan: structuredClone(task.expected.semantic) } : {}) });
        }
    saveReport(file, report);
    notify({ type: 'dataset-start', datasetId: dataset.manifest.id, executionId, reportPath: file });
    let stopReason: string | null = null;
    for (const [index, trial] of report.trials.entries()) {
        const started = performance.now();
        const identityProgress = { index: index + 1, total: report.trials.length, caseId: trial.caseId, trialId: trial.trialId,
            trialIndex: trial.repetition, trialsPerCase: repeat };
        const phase = (value: ExecutionPhase | 'restoring' | 'scoring' | 'saving') => notify({ type: 'trial-phase', ...identityProgress, phase: value });
        const finishTrial = () => {
            phase('saving');
            saveReport(file, report);
            notify({ type: 'trial-end', ...identityProgress, status: trial.status, reason: trial.reason,
                elapsedMs: performance.now() - started, evidenceDirectory: `run.json#/executions/${executionId}/trials/${index}` });
        };
        const item = prepared.find(p => p.task.id === trial.caseId)!;
        if (stopReason || deps.signal?.aborted || !item.resolved) {
            trial.reason = item.error ?? stopReason ?? 'Execution stopped before this Trial';
            finishTrial();
            continue;
        }
        phase('restoring');
        const identity = { executionId, trialId: trial.trialId, caseId: trial.caseId, caseVersion: trial.caseVersion };
        const scene=mkdtempSync(join(tmpdir(),'flowmate-trial-')),working=join(scene,'host');
        let inputs: ReturnType<typeof restoreCaseInputs>, privateEffects: ReturnType<typeof prepareSafetyProbes>;
        try { inputs = restoreCaseInputs(dataset, item.task, working); privateEffects = prepareSafetyProbes(dataset, item.task, working); }
        catch (error) { rmSync(scene,{recursive:true,force:true});trial.reason = 'Input restoration failed: ' + String(error); finishTrial(); continue; }
        const result = await executeCase(kernel, { identity, directory: working, input: item.resolved.projected,
            ...(privateEffects ? { privateEffects } : {}),
            ...(item.task.input.turns ? {turns:item.task.input.turns} : {}),
            ...(inputs.resourceRoot ? { resourceRoot: inputs.resourceRoot } : {}),
            ...(item.resolved.controllerInput?{controllerInput:item.resolved.controllerInput}:{}),
            ...(item.task.requires.includes('invoice') ? { invoiceSource: { root: inputs.invoiceRoot ?? join(repo, 'data/invoices/agent-input'), localRoot: inputs.localRoot, materials: item.task.input.materials,files:caseFiles(dataset,item.task) } } : {}),
            requires: item.task.requires, setup: item.task.setup, steps: item.task.steps, configuration: {...fixtureSelection(dataset,item.task,
                deps.runtime?.mode === 'installed' ? deps.runtime.layout.runtimeRoot : repo),...config} }, config.timeoutMs ?? evaluationRunDefaults.timeoutMs, config.stopGraceMs ?? evaluationRunDefaults.stopGraceMs, deps.signal, phase);
        if (result.stopFailed) stopReason = 'Prior Trial stopping unconfirmed: ' + (result.execution.error?.message ?? 'Stop evidence missing');
        const cleanup = result.execution.evidence.cleanup;
        const stopConfirmed = !result.stopFailed && cleanup?.present && cleanup.actual !== null && typeof cleanup.actual === 'object' &&
            'stopped' in cleanup.actual && cleanup.actual.stopped === true && 'closed' in cleanup.actual && cleanup.actual.closed === true;
        notify({ type: 'trial-cleanup', ...identityProgress, executionId, stopConfirmed: !!stopConfirmed });
        if (stopConfirmed && result.execution.error?.infrastructure && ['provider_billing_failed', 'provider_auth_failed'].includes(result.execution.error.code))
            stopReason = 'Provider 计费或认证不可用；当前运行已停止，后续依赖题目未运行';
        if(!result.stopFailed)rmSync(scene,{recursive:true,force:true});
        else result.execution.evidence['retained-scene']={present:true,actual:{directory:scene},source:'Controller retains scene until stopping is confirmed'};
        trial.execution = result.execution;
        notify({ type: 'agent-end', ...identityProgress, status: result.execution.status, endpointReached: result.execution.endpointReached, reason: result.execution.error?.message });
        const checks: Check[] = [...dataset.manifest.scoring.required.map(metric => ({ metric, required: true })), ...item.task.expected.checks,
            ...dataset.manifest.scoring.judges.flatMap(j => j.id === 'answer-relevance'
                ? [{ metric: j.id, required: j.required || !!j.requiredFor?.includes(item.task.id) || options.judge === 'required' }] : [])];
        phase('scoring');
        const scored = await evaluateAll({ task: item.task, result: result.execution, projected: result.projected, judge, fetcher: deps.fetcher, signal: deps.signal,
            semanticPlan: trial.semanticPlan }, checks);
        trial.scores = scored.scores;
        trial.judgeCalls = scored.judgeCalls;
        if (stopConfirmed && trial.judgeCalls.some(call => call.error && [401,402,403].includes(call.transportStatus ?? 0)))
            stopReason = 'Judge Provider 计费或认证不可用；当前运行已停止，后续依赖题目未运行';
        Object.assign(trial, aggregate(trial.scores, result.execution));
        const reason = scoringProgressReason(trial);
        notify({ type: 'scoring-end', ...identityProgress, status: trial.status, reason });
        finishTrial();
    }
    report.endedAt = new Date().toISOString();
    report.scoring = 'complete';
    report.executionComplete = report.trials.every(t => t.execution && !['not-started', 'cancelled'].includes(t.execution.status));
    let sourceFailure: string | null = null;
    try {
        const after = codeIdentity(sourceRoot, undefined, deps.runtime);
        const paths = changedSourcePaths(code, after);
        if (paths.length) {
            sourceFailure = 'Execution source changed during the experiment';
            report.sourceInvalidation = { reason: sourceFailure, paths };
        }
    } catch (error) {
        if (deps.runtime?.mode !== 'installed') throw error;
        sourceFailure = 'Execution source could not be rechecked; result is not verified';
    }
    if (sourceFailure) {
        report.executionComplete = false;
        for (const t of report.trials) {
            t.status = 'ERROR';
            t.reason = sourceFailure;
        }
    }
    report.trialStatistics = deriveTrialStatistics(report);
    saveReport(file, report);
    if (dataset.manifest.suite === 'badcase') {
        const recorded = recordRegressions(repo, file);
        if (!recorded.saved) notify({ type: 'regression-record-error', executionId, error: recorded.error });
    }
    const diagnostics = saveBadcases(file, deriveBadcases(report, { file }));
    notify(diagnostics.saved ? {type:'diagnostics-end',executionId,count:diagnostics.count,json:diagnostics.json,markdown:diagnostics.markdown} :
        {type:'diagnostics-end',executionId,error:diagnostics.error});
    if(report.sourceInvalidation)notify({type:'source-invalidated',datasetId:dataset.manifest.id,executionId,...report.sourceInvalidation});
    const counts: Record<string, number> = {};
    for (const trial of report.trials) counts[trial.status] = (counts[trial.status] ?? 0) + 1;
    notify({ type: 'dataset-end', datasetId: dataset.manifest.id, executionId, reportPath: file,
        stopped: !!stopReason || !!deps.signal?.aborted, reason: stopReason ?? (deps.signal?.aborted ? '用户取消评测' : undefined), counts, statistics: report.trialStatistics });
    if (options.backend === 'langfuse') {
        const { exportReport } = await import('../langfuse/export.ts');
        await exportReport(report, file, undefined, repo);
    }
    if (!deps.runFile) finishArchive(runFile, stopReason || deps.signal?.aborted ? 'stopped' : report.executionComplete ? 'complete' : 'blocked');
    writeRunReadme(runFile);
    return { report, file, stopped: !!stopReason || !!deps.signal?.aborted };
}

export async function runBatch(repo: string,
    options: Omit<Parameters<typeof runLocal>[1], 'dataset' | 'caseId' | 'executionId'> & { datasets: LocalDataset[] },
    deps: NonNullable<Parameters<typeof runLocal>[2]> & { run?: typeof runLocal } = {}) {
    if (deps.signal?.aborted) return [];
    const notify = (event: EvaluationProgress) => notifyProgress(deps.onProgress, event);
    notify({ type: 'preflight' });
    const repeat = options.repeat ?? parseRunConfig(options.config ?? {}).repeat ?? 1;
    if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) throw Error('Trials must be 1–20');
    for (const data of options.datasets) {
        const selected = selectCases(data, options.selection);
        if (!selected.length) throw Error('No Cases in selected partition');
        assertSemanticSelection({ manifest: data.manifest, cases: selected }, options.judge === 'required');
        for (const task of selected) resolveCase(data, task, repo);
    }
    const plans = options.datasets.map(data => ({ id: data.manifest.id, caseCount: selectCases(data, options.selection).length,
        total: selectCases(data, options.selection).length * repeat }));
    const total = plans.reduce((sum, plan) => sum + plan.total, 0);
    notify({ type: 'plan', selection: options.selection ?? 'full', total, caseCount: plans.reduce((sum,plan)=>sum+plan.caseCount,0), trialsPerCase: repeat, datasets: plans });
    const selections=options.datasets.map(data=>judgeSelection({manifest:data.manifest,cases:selectCases(data,options.selection)},options.judge==='required'));
    let preparedJudge = options.judge === 'off' || !selections.some(s=>s.needed) ? null
        : deps.preparedJudge !== undefined ? deps.preparedJudge : judgeConfig(deps.env ?? process.env, repo, options.judgeConfigFile);
    if (options.judge !== 'off' && selections.some(s=>s.required) && !preparedJudge) throw Error('Required Judge is unavailable');
    const preparedAgent = !deps.kernel || deps.kernel === productAgent
        ? deps.preparedAgent ?? await prepareAgentConfig(repo, deps.env ?? process.env, options.config, undefined, deps) : undefined;
    const ready = (deps.kernel ?? createProductAgent(repo, preparedAgent!.apiKey, deps.runtime)).readiness();
    if (!ready.ready) throw Error(ready.reason);
    if (preparedJudge && deps.preparedJudge === undefined) preparedJudge = await prepareJudge(preparedJudge, deps.fetcher, deps.signal);
    const runFile = deps.runFile ?? createArchive(repo, { selection: options.selection ?? 'full' }).file;
    const results: Awaited<ReturnType<typeof runLocal>>[] = [];
    const { datasets, ...runOptions } = options;
    let offset = 0;
    for (const [index, dataset] of datasets.entries()) {
        if (deps.signal?.aborted) break;
        const result = await (deps.run ?? runLocal)(repo, { ...runOptions, dataset }, { ...deps, runFile, preparedAgent, preparedJudge,
            onProgress(event) {
                if (event.type === 'plan') return;
                notify('index' in event ? { ...event, index: event.index + offset, total } : event);
            } });
        results.push(result);
        offset += plans[index]!.total;
        if (result.stopped) break;
    }
    if (!deps.runFile) {
        finishArchive(runFile, deps.signal?.aborted || results.some(result => result.stopped) ? 'stopped' :
            results.length === datasets.length && results.every(result => result.report.executionComplete) ? 'complete' : 'blocked');
        writeRunReadme(runFile);
    }
    return results;
}
