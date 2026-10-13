import { fixtureSelection } from '../dataset-loader/selection.ts';
import { atomicJson, publicVersions } from '../reports/files.ts';
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { artifactJson } from '../artifacts.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { discoverDatasets, hash, caseContentHash, caseFiles, resolveCase, restoreCaseInputs, selectCases, assertSemanticSelection, type LocalDataset, type Check } from '../dataset-loader/local.ts';
import { productAgent, createProductAgent, type AgentKernel } from '../adapters/agent.ts';
import { agentApiSchema, prepareAgentConfig, type AgentModelCapabilities } from '../configuration.ts';
export {assertModelConfiguration} from '../adapters/agent.ts';
import { executeCase } from './execute-case.ts';
import { codeIdentity, runtimeSourceConditions } from './source.ts';
import { scanEvidence } from './evidence-safety.ts';
import { evaluateAll } from '../scoring/evaluate.ts';
import { aggregate } from '../scoring/aggregate.ts';
import { judgeConfig, prepareJudge, publicJudgeConfig, type Fetcher, type JudgeConfig } from '../scoring/judges/client.ts';
import { compactRubric,compactRubricFor } from '../scoring/judges/compact.ts';
import {rubric as legacyRubric} from '../scoring/judges/answer-relevance.ts';
import {formalRules} from '../scoring/formal-rules.ts';
import {metricCatalog} from '../scoring/catalog.ts';
import { saveReport, safeId, type LocalReport } from '../reports/store.ts';
import {ResourceSelectionSchema} from '../../../packages/contracts/src/resources.ts';
import {ExtensionSelectionSchema} from '../../../packages/contracts/src/extensions.ts';
import {RuntimeBudgetOverridesSchema} from '../../../packages/contracts/src/runtime.ts';
export const runConfigSchema = z.object({
    model: z.string().min(1).optional(), baseUrl: z.string().url().optional(), api: agentApiSchema.optional(),
    repeat: z.number().int().min(1).max(20).optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional(), stopGraceMs: z.number().int().min(100).max(10000).optional(),
    environment: z.string().regex(/^[a-z0-9_-]+$/).optional(),resources:ResourceSelectionSchema.optional(),extensions:ExtensionSelectionSchema.optional(),
    budget:RuntimeBudgetOverridesSchema.optional()
}).strict();
export function parseRunConfig(value: unknown) {
    const parsed = runConfigSchema.safeParse(value);
    if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'options'))];
        throw Error('Invalid evaluation run configuration; check ' + fields.join(', '));
    }
    return parsed.data;
}
export function findDataset(repo: string, options: {
    dataset?: string;
    version?: number;
} = {}) {
    const matches = discoverDatasets(join(repo, 'agent-eval/src/datasets'), repo).filter(d => d.manifest.id === (options.dataset ?? 'flowmate-agent-v1'));
    if (matches.length === 0)
        throw new Error(`Dataset ${options.dataset ?? 'flowmate-agent-v1'} 不存在：尚未制作，等待评测工程验收；真实入口与必要采证接通、工程验证通过后，依据 01/02 制作。未调用模型、未创建执行记录。`);
    if (matches.length !== 1)
        throw new Error('Select exactly one local Dataset');
    const dataset = matches[0]!;
    if (options.version !== undefined && dataset.manifest.version !== options.version)
        throw new Error('Dataset version differs; restore the requested source revision');
    return dataset;
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
    kernel?: AgentKernel;
    env?: NodeJS.ProcessEnv;
    fetcher?: Fetcher;
    signal?: AbortSignal;
    preparedAgent?: Awaited<ReturnType<typeof prepareAgentConfig>>;
    preparedJudge?: JudgeConfig | null;
} = {}) {
    const isProductAgent = !deps.kernel || deps.kernel === productAgent;
    let kernel = deps.kernel ?? productAgent;
    let config: z.infer<typeof runConfigSchema> & { modelCapabilities?: AgentModelCapabilities } = parseRunConfig(options.config ?? {});
    if (isProductAgent) {
        const agent = deps.preparedAgent ?? await prepareAgentConfig(repo, deps.env ?? process.env, config, undefined, deps);
        config = { ...config, ...agent.configuration };
        kernel = createProductAgent(repo, agent.apiKey);
    }
    const ready = kernel.readiness();
    if (!ready.ready)
        throw new Error(ready.reason);
    const repeat = options.repeat ?? config.repeat ?? 1;
    if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20)
        throw new Error('Repeat must be 1..20');
    const dataset = structuredClone(options.dataset), selected = selectCases(dataset, options.selection, options.caseId);
    if (!selected.length) throw new Error('No Cases in selected partition');
    assertSemanticSelection({ manifest: dataset.manifest, cases: selected }, options.judge === 'required');
    if (selected.some(c => c.expected.checks.some(check => check.metric === 'answer-relevance' || dataset.manifest.scoring.required.includes(check.metric))))
        throw new Error('Case cannot override common scoring or select Judge; configure Judges once in dataset.json');
    if (options.judge === 'required' && !dataset.manifest.scoring.judges.length)
        throw new Error('Required Judge must be selected in Dataset scoring configuration');
    let judge = options.judge === 'off' ? null : deps.preparedJudge !== undefined ? deps.preparedJudge : judgeConfig(deps.env ?? process.env, repo, options.judgeConfigFile);
    const batch = dataset.manifest.scoring.judges.find(j => j.id === 'semantic-batch');
    const plans=selected.flatMap(task=>'contract'in task&&task.expected.semantic?[task.expected.semantic]:[]);
    if(new Set(plans.map(plan=>hash(compactRubricFor(plan)))).size>1)throw new Error('Selected semantic plans need one declared Rubric identity');
    const judgeRequired = options.judge === 'required' || dataset.manifest.scoring.judges.some(j => j.required || selected.some(c => j.requiredFor?.includes(c.id))) ||
        selected.some(c => 'contract' in c && c.expected.semantic?.criteria.some(criterion => criterion.required));
    if (options.judge !== 'off' && judgeRequired && !judge)
        throw new Error('Required Judge is unavailable');
    if (judge && deps.preparedJudge === undefined) judge = await prepareJudge(judge, deps.fetcher, deps.signal);
    const selectedJudge = judge ? publicJudgeConfig(judge, batch ? plans[0]?compactRubricFor(plans[0]):compactRubric : undefined) : null;
    const executionId = safeId(options.executionId ?? ('agent-' + Date.now() + '-' + randomUUID().slice(0, 8)));
    let results = realpathSync(repo);
    for (const component of ['agent-eval', 'runs']) {
        results = join(results, component);
        const stat = lstatSync(results, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Evaluation result root must be a real repository directory');
        if (!stat) mkdirSync(results);
        if (realpathSync(results) !== results) throw new Error('Evaluation result root escapes its repository path');
    }
    const root = join(results, executionId);
    mkdirSync(root);
    const code = codeIdentity(repo);
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
        materials:prepared.map(({task,resolved})=>({caseId:task.id,materials:resolved?.projected.materials??[],files:caseFiles(dataset,task)})),
        runtimeSource:runtimeSourceConditions(repo),
        scoring:{catalog:metricCatalog,rules:formalRules,rubric:batch?plans[0]?compactRubricFor(plans[0]):compactRubric:legacyRubric,
            plans:selected.map(task=>({caseId:task.id,checks:task.expected.checks,...('contract'in task?{metrics:task.expected.metrics,semantic:task.expected.semantic}:{})}))},
        fixtures:authored?Object.fromEntries(selected.flatMap(c=>{const name=authored.cases.find(d=>d.id===c.id)?.input.fixture?.name;return name?[[name,authored.fixtures[name]]]:[];})):undefined});
    if((snapshot.fact.actual as {leaked:boolean}).leaked)throw Error('Secret in declared configuration; refusing execution');
    atomicJson(join(root,'snapshot.json'),publicVersions(snapshot.value));
    const report: LocalReport = {
        contract: 'flowmate-agent-run/v2', executionId, code,
        dataset: { id: dataset.manifest.id, version: dataset.manifest.version, hash: dataset.hash, subject: 'agent' },
        selection: options.caseId ? 'case' : options.selection ?? 'full', environment: config.environment ?? deps.env?.FLOWMATE_EVAL_ENVIRONMENT ?? process.env.FLOWMATE_EVAL_ENVIRONMENT ?? 'development', userId: deps.env?.FLOWMATE_EVAL_USER_ID ?? process.env.FLOWMATE_EVAL_USER_ID,
        startedAt: new Date().toISOString(), endedAt: null, repeat, executionComplete: false, scoring: 'pending', manualReview: 'none', formalAcceptance: 'not-assessed',
        scoringConfiguration: { version: dataset.manifest.scoring.version, judgeMode: options.judge, judgeHash: selectedJudge?.configHash ?? null },
        trials: [], export: { backend: options.backend, status: options.backend === 'local' ? 'disabled' : 'pending' }
    };
    for (let repetition = 1; repetition <= repeat; repetition++)
        for (const { task } of prepared) {
            const trialId = executionId + '-' + task.id + '-trial-' + repetition;
            report.trials.push({ caseId: task.id, caseVersion: task.version, caseHash: caseContentHash(dataset, task), caseName: task.name, category: task.category, purpose: dataset.embedded?.authored?.cases.find(c=>c.id===task.id)?.purpose??'regression',
                partition: dataset.manifest.smoke.includes(task.id) ? 'smoke' : 'holdout', repetition, trialId, traceId: randomUUID().replaceAll('-',''),
                status: 'NOT_RUN', reason: 'Planned', counts: {}, execution: null, scores: [], judgeCalls: [], feedback: 'none',
                metricPlan: 'contract' in task ? structuredClone(task.expected.metrics) : [{ metricId: 'task-success', version: 1, unit: 'Trial', denominator: 1 }],
                ...('contract' in task && task.expected.semantic ? { semanticPlan: structuredClone(task.expected.semantic) } : {}) });
        }
    const file = join(root, 'report.json');
    saveReport(file, report);
    let stopReason: string | null = null;
    for (const trial of report.trials) {
        const item = prepared.find(p => p.task.id === trial.caseId)!;
        if (stopReason || deps.signal?.aborted || !item.resolved) {
            trial.reason = item.error ?? stopReason ?? 'Execution stopped before this Trial';
            saveReport(file, report);
            continue;
        }
        const identity = { executionId, trialId: trial.trialId, caseId: trial.caseId, caseVersion: trial.caseVersion };
        const scene=mkdtempSync(join(tmpdir(),'flowmate-trial-')),working=join(scene,'host');
        let inputs: ReturnType<typeof restoreCaseInputs>;
        try { inputs = restoreCaseInputs(dataset, item.task, working); }
        catch (error) { rmSync(scene,{recursive:true,force:true});trial.reason = 'Input restoration failed: ' + String(error); saveReport(file, report); continue; }
        const result = await executeCase(kernel, { identity, directory: working, input: item.resolved.projected,
            ...(item.task.input.turns ? {turns:item.task.input.turns} : {}),
            ...(inputs.resourceRoot ? { resourceRoot: inputs.resourceRoot } : {}),
            ...(item.resolved.controllerInput?{controllerInput:item.resolved.controllerInput}:{}),
            ...(item.task.requires.includes('invoice') ? { invoiceSource: { root: inputs.invoiceRoot ?? join(repo, 'data/invoices/agent-input'), localRoot: inputs.localRoot, materials: item.task.input.materials } } : {}),
            requires: item.task.requires, setup: item.task.setup, steps: item.task.steps, configuration: {...fixtureSelection(dataset,item.task,repo),...config} }, config.timeoutMs ?? 120000, config.stopGraceMs ?? 5000, deps.signal);
        if (result.stopFailed) stopReason = 'Prior Trial stopping unconfirmed: ' + (result.execution.error?.message ?? 'Stop evidence missing');
        if(!result.stopFailed)rmSync(scene,{recursive:true,force:true});
        else result.execution.evidence['retained-scene']={present:true,actual:{directory:scene},source:'Controller retains scene until stopping is confirmed'};
        trial.execution = result.execution;
        const checks: Check[] = [...dataset.manifest.scoring.required.map(metric => ({ metric, required: true })), ...item.task.expected.checks,
            ...dataset.manifest.scoring.judges.flatMap(j => j.id === 'answer-relevance'
                ? [{ metric: j.id, required: j.required || !!j.requiredFor?.includes(item.task.id) || options.judge === 'required' }] : [])];
        const scored = await evaluateAll({ task: item.task, result: result.execution, projected: result.projected, judge, fetcher: deps.fetcher, signal: deps.signal,
            semanticPlan: trial.semanticPlan }, checks);
        trial.scores = scored.scores;
        trial.judgeCalls = scored.judgeCalls;
        Object.assign(trial, aggregate(trial.scores, result.execution));
        saveReport(file, report);
    }
    report.endedAt = new Date().toISOString();
    report.scoring = 'complete';
    report.executionComplete = report.trials.every(t => t.execution && !['not-started', 'cancelled'].includes(t.execution.status));
    const after = codeIdentity(repo);
    if (after.workspaceHash !== code.workspaceHash) {
        report.executionComplete = false;
        for (const t of report.trials) {
            t.status = 'ERROR';
            t.reason = 'Execution source changed during the experiment';
        }
    }
    saveReport(file, report);
    if (options.backend === 'langfuse') {
        const { exportReport } = await import('../langfuse/export.ts');
        await exportReport(report, file, undefined, repo);
    }
    return { report, file, stopped: !!stopReason || !!deps.signal?.aborted };
}

export async function runBatch(repo: string,
    options: Omit<Parameters<typeof runLocal>[1], 'dataset' | 'caseId' | 'executionId'> & { datasets: LocalDataset[] },
    deps: NonNullable<Parameters<typeof runLocal>[2]> & { run?: typeof runLocal } = {}) {
    if (deps.signal?.aborted) return [];
    for (const data of options.datasets) {
        const selected = selectCases(data, options.selection);
        if (!selected.length) throw Error('No Cases in selected partition');
        assertSemanticSelection({ manifest: data.manifest, cases: selected }, options.judge === 'required');
        if (options.judge === 'required' && !data.manifest.scoring.judges.length) throw Error('Required Judge must be selected in Dataset');
        for (const task of selected) resolveCase(data, task, repo);
    }
    let preparedJudge = options.judge === 'off' ? null : judgeConfig(deps.env ?? process.env, repo);
    if (options.judge === 'required' && !preparedJudge) throw Error('Required Judge is unavailable');
    const preparedAgent = !deps.kernel || deps.kernel === productAgent
        ? await prepareAgentConfig(repo, deps.env ?? process.env, options.config, undefined, deps) : undefined;
    const ready = (deps.kernel ?? createProductAgent(repo, preparedAgent!.apiKey)).readiness();
    if (!ready.ready) throw Error(ready.reason);
    if (preparedJudge) preparedJudge = await prepareJudge(preparedJudge, deps.fetcher, deps.signal);
    const results: Awaited<ReturnType<typeof runLocal>>[] = [];
    const { datasets, ...runOptions } = options;
    for (const dataset of datasets) {
        if (deps.signal?.aborted) break;
        const result = await (deps.run ?? runLocal)(repo, { ...runOptions, dataset }, { ...deps, preparedAgent, preparedJudge });
        results.push(result);
        if (result.stopped) break;
    }
    return results;
}
