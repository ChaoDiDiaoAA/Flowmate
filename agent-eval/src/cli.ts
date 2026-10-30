import { existsSync, readFileSync } from 'node:fs';
import { artifactJson } from './artifacts.ts';
import { publicVersions } from './reports/files.ts';
import { deriveBadcases, deriveCalibrationBadcases } from './reports/badcases.ts';
import { regressionView } from './reports/regressions.ts';
import { deriveTrialStatistics } from './reports/trial-statistics.ts';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, resolveCase, discoverDatasets } from './dataset-loader/local.ts';
import { findDataset, runLocal, runBatch, parseRunConfig, type EvaluationProgress } from './execution/runner.ts';
import { readReport, reportPath, exitCode, comparison } from './reports/store.ts';
import { addFeedback, feedbackStatus } from './review/local.ts';
import { judgeConfig, prepareJudge, publicJudgeConfig } from './scoring/judges/client.ts';
import { scanEvidence } from './execution/evidence-safety.ts';
import { createProductAgent } from './adapters/agent.ts';
import { prepareAgentConfig } from './configuration.ts';
import { EvaluationWorkflowRequestSchema, type EvaluationWorkflowRequest } from '../../packages/contracts/src/evaluation-workflow.ts';
import { dispatchWorkflow } from './desktop/workflow.ts';
import { archiveFile, isArchiveReference, readArchivePart } from './reports/archive.ts';
import { finalizeBenchmark } from './execution/benchmark.ts';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const HELP = `Flowmate local evaluation
bun --no-env-file run eval -- dataset validate --dir <local-dataset-directory>
bun --no-env-file run eval -- doctor [--backend local|langfuse]
bun run test:e2e
bun --no-env-file run eval:smoke  # 7 Cases, 2 models, 1 repeat = 14 Trials; full workflow
bun --no-env-file run eval:full   # 62 Cases, 2 models, 1 repeat = 124 Trials; full workflow
bun run eval:upload -- --run-id <Run-id>  # saved results only; no Subject rerun
bun run eval:upload -- --execution-id <id>
bun --no-env-file run eval -- run [--dataset <local-id|all>] [--benchmark-revision N] [--selection smoke|holdout|full] [--case <id>] [--trials <1..20>] [--model <name>] [--api <type>] [--base-url <url>] [--execution-id <id>] [--backend local|langfuse] [--judge auto|off|required]
bun --no-env-file run eval -- status --execution-id <id> | --dataset <id>
bun --no-env-file run eval -- compare --left <execution-id> --right <execution-id>
bun --no-env-file run eval -- score retry --run-id <RunId> --failed-only [--trial <TrialId>] [--operation-id UUID]
bun --no-env-file run eval -- score list --run-id <RunId>
bun --no-env-file run eval -- score show --run-id <RunId> --revision-id ID --execution-id ID [--trial ID]
bun --no-env-file run eval -- score upload --run-id <RunId> --revision-id ID
bun --no-env-file run eval -- judge calibrate --dir <independent-reference-directory> --execution-id <id> [--metric <metricId>]
bun --no-env-file run eval -- resend (--execution-id <id> | --report <absolute-report.json>)
bun --no-env-file run eval -- review add (--execution-id <id> | --dataset <id>) --case <id> [--trial <TrialID>] --reviewer <name> --verdict good|bad --note <text>
bun --no-env-file run eval -- review status (--execution-id <id> | --dataset <id>)
bun --no-env-file run eval -- review setup --backend langfuse
bun --no-env-file run eval -- review enqueue|import|sync --execution-id <id> --backend langfuse
bun --no-env-file run eval -- trace list | show --trace-id UUID | pull --from ISO --to ISO [--trace-id ID] [--entry chats|invoices|research|evaluation]
bun --no-env-file run eval -- trace upload --trace-id UUID --revision N --operation-id UUID | process --trace-id UUID | feedback --file feedback.json
bun --no-env-file run eval -- mine --trace-id UUID --revision N --kind gold|bad|regression --operation-id UUID
bun --no-env-file run eval -- candidate list [--kind gold|bad|regression] | show --candidate-id UUID | edit --candidate-id UUID --revision N --file patch.json
bun --no-env-file run eval -- candidate validate --candidate-id UUID --revision N [--replay] | review --file feedback.json | publish --file publication.json
bun --no-env-file run eval -- benchmark list
bun --no-env-file run eval -- experiment preview|run --file plan.json | list | show|compare --experiment-id ID
bun --no-env-file run eval -- baseline create --experiment-id ID --arm-id ID [--baseline-id ID] | list
bun --no-env-file run eval -- gate check --baseline-id ID --experiment-id ID --arm-id ID [--full-release]
bun --no-env-file run eval -- observability get | save --capture true|false --upload true|false --mining true|false
bun --no-env-file run eval -- workflow --file request.json
Retired: review apply (use review import --backend langfuse), dataset publish, sync, --version and --wait-seconds.
Defaults: backend local; judge auto (independent configuration, may incur fees); trials per Case 1. Retired --repeat: use --trials N. Benchmark Agent settings use FLOWMATE_EVAL_AGENT_BASE_URL/API_KEY/MODEL/API/REASONING_EFFORT in agent-eval/configs/.env; the configured local Luna Subject and candidate replay use max reasoning by default. CLI overrides model/API/URL. FLOWMATE_EVAL_DEEPSEEK_API_KEY is reserved for the explicit DeepSeek control of two-model experiments. Native model capacities come from the Pi SDK catalog or exact DeepSeek provider metadata, without evaluation Token limits. Each Trial starts an independent local Flowmate Host; no Docker or image is required. Judge credentials are independent. Stage one engineering acceptance does not start a real Benchmark.
Exit 0: necessary automatic scores pass; 1: failed/error/incomplete; 2: necessary scoring pending. Human acceptance and export are separate.`;
export function parseOptions(args: string[], valued: string[], flags: string[] = []): Record<string, string | true> {
    const out: Record<string, string | true> = {};
    for (let i = 0; i < args.length; i++) {
        const key = args[i]!;
        if (!valued.includes(key) && !flags.includes(key))
            throw new Error('Unknown argument; use --help for supported options');
        if (key in out)
            throw new Error(`Duplicate argument: ${key}`);
        if (flags.includes(key))
            out[key] = true;
        else {
            const value = args[++i];
            if (!value || value.startsWith('--'))
                throw new Error(`Missing value: ${key}`);
            out[key] = value;
        }
    }
    return out;
}
export function parseWorkflowCli(args: string[]): EvaluationWorkflowRequest | undefined {
    const command = args[0];
    if (!command || !['workflow', 'trace', 'mine', 'candidate', 'benchmark', 'experiment', 'baseline', 'gate', 'observability', 'score'].includes(command)) return undefined;
    const action = command === 'workflow' ? 'workflow' : command === 'mine' ? 'mine' : command === 'observability' ? 'settings.' + args[1] : command + '.' + args[1];
    const wholeFile = ['candidate.review', 'trace.feedback', 'candidate.publish', 'experiment.preview', 'experiment.run'];
    const allowed: Record<string, string[]> = {
        workflow: ['--file'], 'settings.get': [], 'settings.save': ['--capture', '--upload', '--mining'],
        'trace.list': [], 'trace.show': ['--trace-id'], 'trace.pull': ['--from', '--to', '--trace-id', '--entry'],
        'trace.upload': ['--trace-id', '--revision', '--operation-id'], 'trace.process': ['--trace-id'], 'trace.feedback': ['--file'],
        mine: ['--trace-id', '--revision', '--operation-id', '--kind'], 'candidate.list': ['--kind'], 'candidate.show': ['--candidate-id'],
        'candidate.edit': ['--candidate-id', '--revision', '--file'], 'candidate.validate': ['--candidate-id', '--revision'],
        'candidate.review': ['--file'], 'candidate.publish': ['--file'], 'benchmark.list': [],
        'experiment.preview': ['--file'], 'experiment.run': ['--file'], 'experiment.list': [], 'experiment.show': ['--experiment-id'], 'experiment.compare': ['--experiment-id','--scoring-revision'],
        'benchmark.run': ['--selection'],
        'score.retry': ['--run-id','--trial','--operation-id'], 'score.list': ['--run-id'],
        'score.show': ['--run-id','--revision-id','--execution-id','--trial'], 'score.upload': ['--run-id','--revision-id'],
        'baseline.create': ['--experiment-id', '--arm-id', '--baseline-id','--scoring-revision'], 'baseline.list': [], 'gate.check': ['--baseline-id', '--experiment-id', '--arm-id','--scoring-revision'],
    };
    if (!(action in allowed)) throw Error(HELP);
    const options = parseOptions(args.slice(command === 'mine' || command === 'workflow' ? 1 : 2), allowed[action]!,
        action === 'score.retry' ? ['--failed-only'] : action === 'candidate.validate' ? ['--replay'] : action === 'gate.check' ? ['--full-release'] : []);
    const string = (name: string) => typeof options[name] === 'string' ? options[name] as string : undefined;
    const file = () => { const path = string('--file'); if (!path) throw Error('Required --file'); return JSON.parse(readFileSync(resolve(path), 'utf8')); };
    if (command === 'workflow') return EvaluationWorkflowRequestSchema.parse(file());
    if (wholeFile.includes(action)) return EvaluationWorkflowRequestSchema.parse(action.startsWith('experiment.') ? { action, plan: file() } : { ...file(), action });
    const number = (name: string) => string(name) === undefined ? undefined : Number(string(name));
    const boolean = (name: string) => string(name) === 'true' ? true : string(name) === 'false' ? false : string(name);
    let input: Record<string, unknown> = { action };
    switch (action) {
        case 'score.retry': input = { action, runId: string('--run-id'), trialId: string('--trial'), operationId: string('--operation-id'), failedOnly: options['--failed-only'] === true }; break;
        case 'score.list': input.runId = string('--run-id'); break;
        case 'score.show': input = { action, runId: string('--run-id'), revisionId: string('--revision-id'), executionId: string('--execution-id'), trialId: string('--trial') }; break;
        case 'score.upload': input = { action, runId: string('--run-id'), revisionId: string('--revision-id') }; break;
        case 'benchmark.run': input.selection = string('--selection'); break;
        case 'settings.save': input.settings = { capture: boolean('--capture'), upload: boolean('--upload'), mining: boolean('--mining') }; break;
        case 'trace.show': case 'trace.process': input.traceId = string('--trace-id'); break;
        case 'trace.upload': case 'mine': input = { action, traceId: string('--trace-id'), expectedRevision: number('--revision'), operationId: string('--operation-id'),
            ...(action === 'mine' ? { kind: string('--kind') } : {}) }; break;
        case 'trace.pull': input = { action, from: string('--from'), to: string('--to'), traceId: string('--trace-id'), entry: string('--entry') }; break;
        case 'candidate.list': input.kind = string('--kind'); break;
        case 'candidate.show': input.candidateId = string('--candidate-id'); break;
        case 'candidate.edit': input = { action, candidateId: string('--candidate-id'), expectedRevision: number('--revision'), patch: file() }; break;
        case 'candidate.validate': input = { action, candidateId: string('--candidate-id'), expectedRevision: number('--revision'), replay: options['--replay'] === true }; break;
        case 'experiment.show': case 'experiment.compare': input.experimentId = string('--experiment-id'); if(action==='experiment.compare')input.scoringRevision=string('--scoring-revision'); break;
        case 'baseline.create': input = { action, experimentId: string('--experiment-id'), armId: string('--arm-id'), baselineId: string('--baseline-id'), scoringRevision: string('--scoring-revision') }; break;
        case 'gate.check': input = { action, baselineId: string('--baseline-id'), experimentId: string('--experiment-id'), armId: string('--arm-id'), fullRelease: options['--full-release'] === true, scoringRevision: string('--scoring-revision') }; break;
    }
    return EvaluationWorkflowRequestSchema.parse(input);
}
const shortReason = (reason: string) => {
    const text = reason.replace(/[\r\n\t]/g, ' '), anomaly = text.indexOf('评分异常：');
    return anomaly >= 0 ? text.slice(0, Math.min(anomaly, 100)) + '；' + text.slice(anomaly, anomaly + 110) : text.slice(0, 220);
};
export function createProgressReporter(write: (line: string) => void = line => { process.stderr.write(line); }) {
    const datasetName = (id: string) => id === 'flowmate-agent-v1' ? '业务' : id === 'flowmate-research-v1' ? '研究' : id;
    const phases = { restoring: '准备授权输入', preparing: '准备Host环境', executing: 'Agent执行', capturing: '采集证据', cleanup: '确认停止与清理', scoring: '评分', saving: '保存结果' };
    const agentLabels = { completed: ['✅', 'Agent执行成功'], failed: ['❌', 'Agent执行失败'], error: ['❌', 'Agent执行失败'],
        timeout: ['⚠', 'Agent执行失败（超时）'], cancelled: ['⏹', 'Agent执行已取消'], 'not-started': ['⏭', 'Agent执行未启动'] } as const;
    const scoreLabels = { PASS: ['✅', '通过（PASS）'], FAIL: ['❌', '失败（FAIL）'], ERROR: ['❌', '错误（ERROR）'],
        UNJUDGEABLE: ['⚠', '未判定（UNJUDGEABLE）'], NOT_RUN: ['⏭', '未运行（NOT_RUN）'] } as const;
    let timer: ReturnType<typeof setInterval> | undefined, current = '准备评测', reportPath: string | undefined;
    const completed = new Set<string>();
    const line = (text: string) => { try { write(scanEvidence(text).value.replace(/[\r\n\t]/g, ' ') + '\n'); } catch { /* A closed display must not interrupt evaluation. */ } };
    const stopWaiting = () => { clearInterval(timer); timer = undefined; };
    const trialLabel = (event: { index: number; total: number; caseId: string; trialIndex?: number; trialsPerCase?: number }) =>
        `[${event.index}/${event.total}] ${event.caseId} · Trial ${event.trialIndex ?? 1}/${event.trialsPerCase ?? 1}`;
    const percent = (value: number | null) => value === null ? '—' : (value * 100).toFixed(1) + '%';
    const probabilityLine = (probabilities: ReturnType<typeof deriveTrialStatistics>['dataset']['probabilities']) => {
        const first = probabilities[0], last = probabilities.at(-1);
        return !first || first.passAtK === null ? '不可计算' : `pass@1=${percent(first.passAtK)}` +
            (last && last.k > 1 ? `，pass@${last.k}=${percent(last.passAtK)}，pass^${last.k}=${percent(last.passAllK)}` : '；仅1次，不能观察重复稳定性');
    };
    const wait = (text: string) => {
        stopWaiting(); current = text; line(`▶ ${text}`); const since = performance.now(); let ticks = 0;
        timer = setInterval(() => line(`⏳ ${current}；仍在等待，已用时${Math.max(++ticks * 60, Math.floor((performance.now() - since) / 1000))}秒`), 60000);
        timer.unref?.();
    };
    return {
        onProgress(event: EvaluationProgress) {
            switch (event.type) {
                case 'preflight': wait('[评测]核对数据与模型配置'); break;
                case 'plan': {
                    const name = { smoke: 'Smoke', full: 'Full', holdout: '留出集', case: '单题' }[event.selection];
                    line(`[评测]${name}：${event.caseCount ?? event.total}个Case，每Case ${event.trialsPerCase ?? 1}个Trial，共${event.total}个Trial；${event.datasets.map(d => `${datasetName(d.id)}${d.total}个Trial`).join(' → ')}`);
                    if(event.evaluationBudgets)for(const [kind,budget]of Object.entries(event.evaluationBudgets))line('[预算]'+kind+'：Trial '+budget.trialTimeoutMs+' ms；Agent Run 默认 '+budget.runTimeoutMs+' ms；模型调用上限 '+budget.maxModelCalls+'（确认研究 Plan 优先）');
                    break;
                }
                case 'dataset-start':
                    reportPath = event.reportPath;
                    line(`[${datasetName(event.datasetId)}]Execution：${event.executionId}`);
                    line(`[结果目录]${dirname(reportPath)}`);
                    wait(`[${datasetName(event.datasetId)}]准备任务`);
                    break;
                case 'trial-phase': wait(`${trialLabel(event)}：${phases[event.phase]}`); break;
                case 'agent-end': {
                    if (completed.has(event.trialId + ':agent')) break;
                    completed.add(event.trialId + ':agent');
                    stopWaiting(); const [symbol, originalLabel] = agentLabels[event.status];
                    const label = event.infrastructure ? '执行或采证设施错误' : originalLabel;
                    const missing = event.status === 'completed' && event.endpointReached === false;
                    line(`${missing ? '⚠' : symbol} ${trialLabel(event)}：${missing ? 'Agent运行已结束，业务终点未达成' : label}${event.reason ? '；' + shortReason(event.reason) : ''}`);
                    break;
                }
                case 'scoring-end': {
                    if (completed.has(event.trialId + ':scoring')) break;
                    completed.add(event.trialId + ':scoring');
                    stopWaiting(); const [symbol, label] = scoreLabels[event.status];
                    line(`${symbol} ${trialLabel(event)}：评分结果：${label}；${shortReason(event.reason)}`);
                    break;
                }
                case 'trial-end':
                    stopWaiting();
                    line(`💾 ${trialLabel(event)}：${event.status === 'NOT_RUN' ? '未运行（NOT_RUN）' : event.status}，耗时${(event.elapsedMs / 1000).toFixed(1)}秒，结果已保存；${shortReason(event.reason)}`);
                    line(`[证据]${event.evidenceDirectory}`);
                    break;
                case 'dataset-end':
                    if (completed.has(event.executionId + ':dataset')) break;
                    completed.add(event.executionId + ':dataset');
                    stopWaiting();
                    for (const item of event.statistics?.cases ?? []) {
                        line(`📊 [${datasetName(event.datasetId)}] ${item.caseId}：指标汇总`);
                        line(`Trial：计划${item.planned}次，已启动${item.started}次；${Object.entries(item.statuses).map(([status,count])=>`${status}=${count}`).join('，')}`);
                        line('指标ID | 指标名称 | 分子/分母 | 结果 | 测量覆盖 | 缺失/异常');
                        for (const metric of item.metrics) {
                            const unknown = metric.measured === 0 || metric.unknownDenominators > 0 || metric.unknownMissing > 0;
                            const counts = metric.metricId === 'DR03' ? '派生' : unknown && !metric.zeroDenominators ? '—' : `${metric.numerator ?? '—'}/${metric.denominator ?? '—'}`;
                            line(`${metric.metricId} | ${metric.name} | ${counts} | ${percent(unknown ? null : metric.value)} | ${metric.measured}/${metric.applicable} | 缺失${metric.missing}；${metric.issues.join('、') || '已测量'}`);
                        }
                        if (!item.metrics.length) line('⚠ 无可核验的正式指标计划；详情见报告');
                        line(`[重复统计] ${probabilityLine(item.probabilities)}${item.valid ? '' : '；' + item.reasons.join('；')}`);
                    }
                    line(`[${datasetName(event.datasetId)}]${event.stopped ? '提前停止' : '本组结束'}：${Object.entries(event.counts).map(([status, count]) => `${status}=${count}`).join('，')}${event.reason ? '；' + event.reason : ''}`);
                    if (event.statistics) {
                        const stats = event.statistics.dataset;
                        line(`[指标覆盖]声明${stats.metricsPlanned}项，已取得有效观测${stats.metricsMeasured}项；完整有效Case ${stats.validCases}/${stats.plannedCases}`);
                        line(`[组重复统计] ${probabilityLine(stats.probabilities)}`);
                    }
                    line(`[报告]${event.reportPath}`);
                    break;
                case 'source-invalidated':
                    stopWaiting();
                    line(`⚠ [${datasetName(event.datasetId)}]本组执行无效：运行期间代码条件变化（${event.paths.length}个文件，详见报告）；此前逐题结果仅供诊断`);
                    break;
                case 'diagnostics-end':
                    if (event.error) line(`⚠ [分析]诊断文件写入失败；原成绩已保存；${shortReason(event.error)}`);
                    else { line(`🔎 [分析]待核验记录${event.count}条；自动确认Badcase 0条`); line(`[诊断]${event.markdown}`); }
                    break;
                case 'regression-record-error':
                    line(`⚠ [复测记录]登记失败；原成绩已保存；${shortReason(event.error)}`);
                    break;
            }
        },
        close(error?: unknown) {
            stopWaiting();
            if (error !== undefined) {
                line(`❌ [评测]运行异常；最后阶段：${current}；${shortReason(error instanceof Error ? error.message : String(error))}`);
                if (reportPath) line(`[已有报告]${reportPath}`);
            }
        }
    };
}
export async function main(args: string[], root: string = repoRoot): Promise<void> {
    const repoRoot = root;
    if (!args.length || args[0] === '--help' || args[0] === 'help') {
        console.log(HELP);
        return;
    }
    const workflow = parseWorkflowCli(args);
    if (workflow) {
        const controller = new AbortController(), stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
        const progress = createProgressReporter();
        try { const result = await dispatchWorkflow(repoRoot, workflow, { signal: controller.signal, experiments: { onProgress: progress.onProgress } }); console.log(artifactJson(scanEvidence(result).value).trimEnd()); process.exitCode = result.exitCode; }
        finally { progress.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
        return;
    }
    if (args.some(arg => arg === '--repeat' || arg.startsWith('--repeat=')))
        throw Error('参数已更名，请使用 --trials N（1–20）；未准备模型或创建Execution。');
    if (args.includes('--stage') || args.includes('--mode'))
        throw new Error('阶段评测及 Fixture/Live 已取消；使用统一 Agent Benchmark。未调用模型。');
    if (args[0] === 'review' && args[1] === 'apply')
        throw new Error('review apply retired; use review import --execution-id <id> --backend langfuse. No platform request was made.');
    if (args[0] === 'sync' || args.includes('--version') || args.includes('--wait-seconds') || (args[0] === 'dataset' && args[1] === 'publish'))
        throw new Error('Platform-first interface retired. Use dataset validate, a local dataset and local status. No model was called.');
    const command = args[0]!, action = ['dataset', 'review','judge'].includes(command) ? args[1] : undefined;
    const allowed: Record<string, string[]> = { doctor: ['--backend'], dataset: ['--dir'], run: ['--model','--api','--base-url','--dataset', '--benchmark-revision', '--selection', '--case', '--trials', '--execution-id', '--backend', '--judge'], status: ['--execution-id', '--dataset'], compare: ['--left', '--right'], judge:['--dir','--execution-id','--metric'],resend: ['--report','--execution-id','--run-id'], review: ['--execution-id', '--dataset', '--case', '--trial', '--reviewer', '--verdict', '--note', '--backend'] };
    if (!allowed[command])
        throw new Error(HELP);
    const options = parseOptions(args.slice(action ? 2 : 1), allowed[command]!);
    const opt = (key: string) => typeof options[key] === 'string' ? options[key] as string : undefined;
    const required = (key: string) => {
        const v = opt(key);
        if (!v)
            throw new Error(`Required ${key}`);
        return v;
    };
    const print = (value: unknown) => console.log(artifactJson(publicVersions(scanEvidence(value).value)).trimEnd());
    if(command==='judge'){
        if(action!=='calibrate')throw new Error(HELP);
        const directory=resolve(required('--dir')),executionId=required('--execution-id');
        const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
        try{
            const {calibrateJudge}=await import('./scoring/judges/calibration.ts');
            const result=await calibrateJudge(repoRoot,{directory,executionId,metric:opt('--metric')},{signal:controller.signal});
            print({executionId:result.report.executionId,report:result.file,kind:result.report.kind,acceptance:result.report.acceptance,criteria:result.report.criteria});
            if(!result.report.executionComplete||result.report.criteria.some(c=>c.errors||c.notRun))process.exitCode=1;
        }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
        return;
    }
    if (command === 'dataset') {
        if (action !== 'validate')
            throw new Error(HELP);
        const directory = resolve(required('--dir'));
        const data = (existsSync(resolve(directory, 'review')) || existsSync(resolve(directory,'cases.ts'))) ? discoverDatasets(directory, repoRoot) : [loadDataset(directory, repoRoot)];
        data.forEach(d => d.cases.forEach(c => resolveCase(d, c, repoRoot)));
        const records = data.map(d => ({ valid: true, contract: 'flowmate-agent-dataset/v1', dataset: d.manifest.id,
            version: 'v1', cases: d.cases.length }));
        print(records.length === 1 ? records[0] : { valid: true, cases: data.reduce((n, d) => n + d.cases.length, 0), datasets: records });
        return;
    }
    if (command === 'doctor') {
        const backend = opt('--backend') ?? process.env.FLOWMATE_EVAL_BACKEND ?? 'local';
        if (!['local', 'langfuse'].includes(backend))
            throw new Error('Invalid backend');
        const issues: string[] = [];
        let judge: ReturnType<typeof judgeConfig> = null, data: ReturnType<typeof discoverDatasets> = [];
        try { judge = judgeConfig(process.env, repoRoot); if (judge) judge = await prepareJudge(judge); if (!judge) issues.push('Required Judge is not configured'); }
        catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid Judge configuration'); }
        try { data = discoverDatasets(resolve(repoRoot, 'agent-eval/src/datasets'), repoRoot); data.forEach(d => d.cases.forEach(c => resolveCase(d, c, repoRoot))); }
        catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid evaluation data'); }
        if (backend === 'langfuse') {
            const { platformClient } = await import('./langfuse/export.ts');
            const client = await platformClient(repoRoot);
            try {
                await client.api.projects.get();
            }
            finally {
                await client.shutdown();
            }
        }
        let readiness: { ready: boolean; reason: string }, agentConfiguration: unknown = null;
        try {
            const agent = await prepareAgentConfig(repoRoot);
            agentConfiguration = agent.configuration;
            readiness = createProductAgent(repoRoot, agent.apiKey).readiness();
        } catch (error) { readiness = { ready: false, reason: error instanceof Error ? error.message : 'Invalid evaluation Agent configuration' }; }
        const ready = readiness.ready && data.length > 0 && issues.length === 0;
        print({ ok: ready, backend, datasets: data.map(d => d.manifest.id), issues,
            benchmark: { ready,
                reason: data.length ? readiness.reason : '尚未制作，等待评测工程验收；真实入口与必要采证接通、工程验证通过后，依据 01/02 制作 Benchmark。配置检查成功不代表 Benchmark 就绪。' },
            agent: { ...readiness, configuration: agentConfiguration }, judge: judge ? publicJudgeConfig(judge) : 'not configured' });
        process.exitCode = ready ? 0 : 1;
        return;
    }
    if (command === 'run') {
        const requestedRevision = opt('--benchmark-revision'), version = requestedRevision === undefined ? undefined : Number(requestedRevision);
        if (requestedRevision !== undefined && (!/^[1-9]\d*$/.test(requestedRevision) || !Number.isSafeInteger(version))) throw Error('Benchmark revision must be a positive integer');
        const trials = opt('--trials'), repeat = trials === undefined ? 1 : Number(trials);
        if (trials !== undefined && !/^\d+$/.test(trials) || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20)
            throw Error('--trials 必须是1–20的整数；未准备模型或创建Execution。');
        const backend = opt('--backend') ?? process.env.FLOWMATE_EVAL_BACKEND ?? 'local', judge = opt('--judge') ?? 'auto', selection = opt('--selection') ?? 'full';
        if ((backend !== 'local' && backend !== 'langfuse') || !['auto', 'off', 'required'].includes(judge) || !['smoke', 'holdout', 'full'].includes(selection))
            throw new Error('Invalid backend/judge/selection');
        const all = opt('--dataset') === 'all';
        if (all && (opt('--case') || opt('--execution-id'))) throw Error('Dataset all cannot use --case or --execution-id');
        const datasets = all ? ['flowmate-agent-v1','flowmate-research-v1'].map(dataset => findDataset(repoRoot,{dataset,version}))
            : [findDataset(repoRoot, { dataset: opt('--dataset'), version })];
        const config = parseRunConfig({model:opt('--model'),api:opt('--api'),baseUrl:opt('--base-url')});
        const controller = new AbortController(), stop = () => controller.abort();
        const progress = createProgressReporter();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
            const options = { selection: selection as 'smoke' | 'holdout' | 'full', backend: backend as 'local' | 'langfuse', judge: judge as 'auto' | 'off' | 'required', repeat, config };
            const results = all ? await runBatch(repoRoot, { ...options, datasets }, {signal:controller.signal,onProgress:progress.onProgress})
                : [await runLocal(repoRoot, { ...options, dataset: datasets[0]!, caseId: opt('--case'), executionId: opt('--execution-id') }, {signal:controller.signal,onProgress:progress.onProgress})];
            const codes = results.map(r=>exitCode(r.report));
            process.exitCode = results.length !== datasets.length || results.some(r=>r.stopped) || codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0;
        }
        catch (error) { progress.close(error); throw error; }
        finally {
            progress.close();
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
        }
        return;
    }
    if (command === 'status') {
        if (Boolean(opt('--execution-id')) === Boolean(opt('--dataset')))
            throw new Error('Specify execution-id or dataset');
        if (opt('--execution-id')) {
            const savedPath = reportPath(repoRoot, opt('--execution-id')!);
            const raw = isArchiveReference(savedPath) ? readArchivePart(savedPath) : JSON.parse(readFileSync(savedPath, 'utf8'));
            if (raw.contract === 'flowmate-judge-calibration-report/v1') {
                const { readCalibrationReport,calibrationCoverage } = await import('./scoring/judges/calibration.ts');
                const report = readCalibrationReport(reportPath(repoRoot, opt('--execution-id')!));
                const scopes=[...new Map(report.samples.map(s=>{const plan=s.plan??s.reference.plan;return[JSON.stringify(plan.criteria.map(c=>c.metricId).sort()),plan];})).values()];
                print({ ...report, definitionCoverage:scopes.map(plan=>calibrationCoverage(report,plan,report.configuration)), badcases: deriveCalibrationBadcases(report) });
                process.exitCode = !report.executionComplete || report.criteria.some(row => row.errors || row.notRun) ? 1 : 0;
                return;
            }
            if (!['flowmate-agent-run/v1', 'flowmate-agent-run/v2'].includes(raw.contract)) {
                print({ historical: true, readOnly: true, original: raw });
                return;
            }
            const report = readReport(reportPath(repoRoot, opt('--execution-id')!));
            const humanFeedback = feedbackStatus(repoRoot, report.executionId);
            print({ ...report, trialStatistics: report.trialStatistics ?? deriveTrialStatistics(report),
                trialStatisticsOrigin: report.trialStatistics ? 'saved' : 'derived', humanFeedback,
                badcases: deriveBadcases(report, { file: reportPath(repoRoot, report.executionId), feedback: humanFeedback.records }), regressions: regressionView(repoRoot, report) });
            process.exitCode = exitCode(report);
        }
        else
            print(findDataset(repoRoot, { dataset: opt('--dataset') }).manifest);
        return;
    }
    if (command === 'compare') {
        const left = readReport(reportPath(repoRoot, required('--left'))), right = readReport(reportPath(repoRoot, required('--right')));
        const rows = comparison(left, right), diagnostics = deriveBadcases(right, { file: reportPath(repoRoot, right.executionId), comparison: { executionId: left.executionId, trials: rows } });
        print(rows.map(row => ({ ...row, badcase: diagnostics.candidates.find(candidate => candidate.caseId === row.caseId && candidate.repetition === row.repetition) ?? null })));
        return;
    }
    if (command === 'resend') {
        if (opt('--run-id')) {
            if (opt('--execution-id') || opt('--report')) throw Error('Run retry cannot also select an Execution or report');
            const result = await finalizeBenchmark(repoRoot, opt('--run-id')!); print(result); process.exitCode = result.exitCode; return;
        }
        if (Boolean(opt('--execution-id')) === Boolean(opt('--report'))) throw Error('Exactly one --execution-id or --report required');
        const path = opt('--execution-id') ? reportPath(repoRoot, opt('--execution-id')!) : required('--report');
        if (!isAbsolute(path))
            throw new Error('Absolute report path required');
        const report = readReport(path);
        const { exportReport } = await import('./langfuse/export.ts');
        const result = await exportReport(report, path, undefined, repoRoot);
        print(result);
        if (result.status === 'error')
            process.exitCode = 1;
        return;
    }
    if (command === 'review') {
        if (['setup', 'enqueue', 'import', 'sync'].includes(action ?? '')) {
            if (opt('--backend') !== 'langfuse')
                throw new Error('Platform operation requires explicit --backend langfuse');
            const { platformReview } = await import('./langfuse/human.ts');
            print(await platformReview(repoRoot, action!, opt('--execution-id')));
            return;
        }
        if (Boolean(opt('--dataset')) === Boolean(opt('--execution-id')))
            throw new Error('Exactly one review target required');
        const dataset = opt('--dataset') ? findDataset(repoRoot, { dataset: opt('--dataset') }) : undefined;
        if (action === 'status') {
            if (opt('--execution-id'))
                readReport(reportPath(repoRoot, opt('--execution-id')!));
            print(feedbackStatus(repoRoot, opt('--execution-id'), dataset));
            return;
        }
        if (action !== 'add')
            throw new Error(HELP);
        print(addFeedback(repoRoot, { dataset, executionId: opt('--execution-id'), caseId: required('--case'), trialId: opt('--trial'), reviewer: required('--reviewer'), verdict: required('--verdict') as 'good' | 'bad', note: required('--note') }));
        return;
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2).filter(a => a !== '--')).catch(error => { console.error(scanEvidence((error as Error).message).value); process.exitCode = 1; });
}
