import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { discoverDatasets, hash, caseContentHash, resolveCase, selectCases, type LocalDataset, type Check } from '../datasets/local.ts';
import { productAgent, type AgentKernel } from '../adapters/agent.ts';
import { executeCase } from './execute-case.ts';
import { codeIdentity } from './source.ts';
import { scanEvidence } from './evidence-safety.ts';
import { evaluateAll } from '../scoring/evaluate.ts';
import { aggregate } from '../scoring/aggregate.ts';
import { judgeConfig, publicJudgeConfig, type Fetcher } from '../scoring/judges/client.ts';
import { saveReport, safeId, type LocalReport } from '../reports/store.ts';
export const runConfigSchema = z.object({
    model: z.string().min(1).optional(), baseUrl: z.string().url().optional(), api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']).optional(),
    maxTokens: z.number().int().positive().optional(), repeat: z.number().int().min(1).max(20).optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional(), stopGraceMs: z.number().int().min(100).max(10000).optional(),
    environment: z.string().regex(/^[a-z0-9_-]+$/).optional()
}).strict();
export function findDataset(repo: string, options: {
    dataset?: string;
    version?: number;
} = {}) {
    const matches = discoverDatasets(join(repo, 'agent-eval/datasets')).filter(d => d.manifest.id === (options.dataset ?? 'flowmate-agent-v1'));
    if (matches.length === 0)
        throw new Error(`Dataset ${options.dataset ?? 'flowmate-agent-v1'} 不存在：尚未制作，等待完整 Agent；真实入口与必要采证接通、工程验证通过后，依据 01/02 制作。未调用模型、未创建执行记录。`);
    if (matches.length !== 1)
        throw new Error('Select exactly one local Dataset');
    const dataset = matches[0]!;
    if (options.version !== undefined && dataset.manifest.version !== options.version)
        throw new Error('Dataset version differs; restore the requested source revision');
    return dataset;
}
export async function runLocal(repo: string, options: {
    dataset: LocalDataset;
    selection?: 'smoke' | 'full';
    caseId?: string;
    repeat?: number;
    executionId?: string;
    backend: 'local' | 'langfuse';
    judge: 'auto' | 'off' | 'required';
    config?: z.infer<typeof runConfigSchema>;
}, deps: {
    kernel?: AgentKernel;
    env?: NodeJS.ProcessEnv;
    fetcher?: Fetcher;
    signal?: AbortSignal;
} = {}) {
    const kernel = deps.kernel ?? productAgent, ready = kernel.readiness();
    if (!ready.ready)
        throw new Error(ready.reason);
    const config = runConfigSchema.parse(options.config ?? {}), repeat = options.repeat ?? config.repeat ?? 1;
    if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20)
        throw new Error('Repeat must be 1..20');
    const dataset = options.dataset, selected = selectCases(dataset, options.selection, options.caseId);
    if (selected.some(c => c.expected.checks.some(check => check.metric === 'answer-relevance' || dataset.manifest.scoring.required.includes(check.metric))))
        throw new Error('Case cannot override common scoring or select Judge; configure Judges once in dataset.json');
    if (options.judge === 'required' && !dataset.manifest.scoring.judges.length)
        throw new Error('Required Judge must be selected in Dataset scoring configuration');
    const judge = options.judge === 'off' ? null : judgeConfig(deps.env ?? process.env);
    const judgeRequired = options.judge === 'required' || dataset.manifest.scoring.judges.some(j => j.required || selected.some(c => j.requiredFor?.includes(c.id)));
    if (options.judge !== 'off' && judgeRequired && !judge)
        throw new Error('Required Judge is unavailable');
    if (judge && selected.length * repeat * dataset.manifest.scoring.judges.length * judge.maxTokens > 15000)
        throw new Error('Frozen cumulative Judge output budget (15000) exceeded');
    const executionId = safeId(options.executionId ?? ('agent-' + Date.now() + '-' + randomUUID().slice(0, 8)));
    const root = join(repo, 'agent-eval/runs', executionId);
    mkdirSync(join(repo, 'agent-eval/runs'), { recursive: true });
    mkdirSync(root);
    const code = codeIdentity(repo, join(root, 'source.json'));
    const prepared = selected.map(task => {
        try {
            return { task, resolved: resolveCase(dataset, task, repo), error: null };
        }
        catch (error) {
            return { task, resolved: null, error: String(error) };
        }
    });
    const snapshot = scanEvidence({ dataset: dataset.manifest, hash: dataset.hash, repeat, selection: options.selection ?? 'full', configuration: config,
        judge: judge ? publicJudgeConfig(judge) : null, members: prepared });
    if ((snapshot.fact.actual as {
        leaked: boolean;
    }).leaked)
        throw new Error('Secret in frozen input/configuration; refusing execution');
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify(snapshot.value, null, 2) + '\n', { flag: 'wx' });
    const report: LocalReport = {
        contract: 'flowmate-agent-run/v1', executionId, code, dataset: { id: dataset.manifest.id, version: dataset.manifest.version, hash: dataset.hash, subject: 'agent' },
        selection: options.caseId ? 'case' : options.selection ?? 'full', environment: config.environment ?? deps.env?.FLOWMATE_EVAL_ENVIRONMENT ?? process.env.FLOWMATE_EVAL_ENVIRONMENT ?? 'development', userId: deps.env?.FLOWMATE_EVAL_USER_ID ?? process.env.FLOWMATE_EVAL_USER_ID,
        startedAt: new Date().toISOString(), endedAt: null, repeat, executionComplete: false, scoring: 'pending', manualReview: 'none', formalAcceptance: 'not-assessed',
        scoringConfiguration: { version: dataset.manifest.scoring.version, judgeMode: options.judge, judgeHash: judge ? publicJudgeConfig(judge).configHash : null },
        trials: [], export: { backend: options.backend, status: options.backend === 'local' ? 'disabled' : 'pending' }
    };
    for (let repetition = 1; repetition <= repeat; repetition++)
        for (const { task } of prepared) {
            const trialId = task.id + '-trial-' + repetition;
            report.trials.push({ caseId: task.id, caseVersion: task.version, caseHash: caseContentHash(dataset, task), caseName: task.name, category: task.category,
                partition: dataset.manifest.smoke.includes(task.id) ? 'smoke' : 'holdout', repetition, trialId, traceId: hash([executionId, trialId]).slice(0, 32),
                status: 'NOT_RUN', reason: 'Planned', counts: {}, execution: null, scores: [], judgeCalls: [], feedback: 'none' });
        }
    const file = join(root, 'summary.json');
    saveReport(file, report);
    let stop = false;
    for (const trial of report.trials) {
        const item = prepared.find(p => p.task.id === trial.caseId)!;
        if (stop || deps.signal?.aborted || !item.resolved) {
            trial.reason = item.error ?? 'Execution stopped before this Trial';
            saveReport(file, report);
            continue;
        }
        const identity = { executionId, trialId: trial.trialId, caseId: trial.caseId, caseVersion: trial.caseVersion };
        const result = await executeCase(kernel, { identity, directory: join(root, trial.trialId), input: item.resolved.projected,
            requires: item.task.requires, setup: item.task.setup, steps: item.task.steps, configuration: config }, config.timeoutMs ?? 120000, config.stopGraceMs ?? 5000, deps.signal);
        stop = result.stopFailed;
        trial.execution = result.execution;
        const checks: Check[] = [...dataset.manifest.scoring.required.map(metric => ({ metric, required: true })), ...item.task.expected.checks,
            ...dataset.manifest.scoring.judges.map(j => ({ metric: j.id, required: j.required || !!j.requiredFor?.includes(item.task.id) || options.judge === 'required' }))];
        const scored = await evaluateAll({ task: item.task, result: result.execution, projected: result.projected, judge, fetcher: deps.fetcher }, checks);
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
        await exportReport(report, file);
    }
    return { report, file };
}
