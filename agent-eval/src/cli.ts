import { existsSync, readFileSync } from 'node:fs';
import { artifactJson } from './artifacts.ts';
import { publicVersions } from './reports/files.ts';
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
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const HELP = `Flowmate local evaluation
bun --no-env-file run eval -- dataset validate --dir <local-dataset-directory>
bun --no-env-file run eval -- doctor [--backend local|langfuse]
bun run test:e2e
bun run eval:smoke  # 10 business + 4 research; local Agent and Judge
bun run eval:full   # 50 business + 12 research; local Agent and Judge
bun run eval:upload -- --execution-id <id>  # saved results only, repeat to resend
bun --no-env-file run eval -- run [--dataset <local-id|all>] [--selection smoke|holdout|full] [--case <id>] [--repeat <1..20>] [--model <name>] [--api <type>] [--base-url <url>] [--execution-id <id>] [--backend local|langfuse] [--judge auto|off|required]
bun --no-env-file run eval -- status --execution-id <id> | --dataset <id>
bun --no-env-file run eval -- compare --left <execution-id> --right <execution-id>
bun --no-env-file run eval -- judge calibrate --dir <independent-reference-directory> --execution-id <id>
bun --no-env-file run eval -- resend (--execution-id <id> | --report <absolute-report.json>)
bun --no-env-file run eval -- review add (--execution-id <id> | --dataset <id>) --case <id> [--trial <TrialID>] --reviewer <name> --verdict good|bad --note <text>
bun --no-env-file run eval -- review status (--execution-id <id> | --dataset <id>)
bun --no-env-file run eval -- review setup --backend langfuse
bun --no-env-file run eval -- review enqueue|import|sync --execution-id <id> --backend langfuse
Retired: review apply (use review import --backend langfuse), dataset publish, sync, --version and --wait-seconds.
Defaults: backend local; judge auto (independent configuration, may incur fees); repeat 1. Benchmark Agent settings use FLOWMATE_EVAL_AGENT_BASE_URL/API_KEY/MODEL/API in agent-eval/configs/.env; CLI overrides model/API/URL. Native model capacities come from the Pi SDK catalog or exact DeepSeek provider metadata, without evaluation Token limits. Each Trial starts an independent local Flowmate Host; no Docker or image is required. Judge credentials are independent. Stage one engineering acceptance does not start a real Benchmark.
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
export function createProgressReporter(write: (line: string) => void = line => { process.stderr.write(line); }) {
    const datasetName = (id: string) => id === 'flowmate-agent-v1' ? '业务' : id === 'flowmate-research-v1' ? '研究' : id;
    const phases = { restoring: '准备授权输入', preparing: '准备Host环境', executing: 'Agent执行', cleanup: '确认停止与清理', scoring: '评分', saving: '保存结果' };
    const agentLabels = { completed: ['✅', 'Agent执行成功'], failed: ['❌', 'Agent执行失败'], error: ['❌', 'Agent执行失败'],
        timeout: ['⚠', 'Agent执行失败（超时）'], cancelled: ['⏹', 'Agent执行已取消'], 'not-started': ['⏭', 'Agent执行未启动'] } as const;
    const scoreLabels = { PASS: ['✅', '通过（PASS）'], FAIL: ['❌', '失败（FAIL）'], ERROR: ['❌', '错误（ERROR）'],
        UNJUDGEABLE: ['⚠', '未判定（UNJUDGEABLE）'], NOT_RUN: ['⏭', '未运行（NOT_RUN）'] } as const;
    let timer: ReturnType<typeof setInterval> | undefined, current = '准备评测', reportPath: string | undefined;
    const line = (text: string) => { try { write(scanEvidence(text).value.replace(/[\r\n\t]/g, ' ') + '\n'); } catch { /* A closed display must not interrupt evaluation. */ } };
    const stopWaiting = () => { clearInterval(timer); timer = undefined; };
    const wait = (text: string) => {
        stopWaiting(); current = text; line(`▶ ${text}`); const since = Date.now();
        timer = setInterval(() => line(`⏳ ${current}；仍在等待，已用时${Math.floor((Date.now() - since) / 1000)}秒`), 60000);
        timer.unref?.();
    };
    return {
        onProgress(event: EvaluationProgress) {
            switch (event.type) {
                case 'preflight': wait('[评测]核对数据与模型配置'); break;
                case 'plan': {
                    const name = { smoke: 'Smoke', full: 'Full', holdout: '留出集', case: '单题' }[event.selection];
                    line(`[评测]${name}：共${event.total}题；${event.datasets.map(d => `${datasetName(d.id)}${d.total}题`).join(' → ')}`);
                    break;
                }
                case 'dataset-start':
                    reportPath = event.reportPath;
                    line(`[${datasetName(event.datasetId)}]Execution：${event.executionId}`);
                    line(`[结果目录]${dirname(reportPath)}`);
                    wait(`[${datasetName(event.datasetId)}]准备任务`);
                    break;
                case 'trial-phase': wait(`[${event.index}/${event.total}] ${event.caseId}：${phases[event.phase]}`); break;
                case 'agent-end': {
                    stopWaiting(); const [symbol, label] = agentLabels[event.status];
                    line(`${symbol} [${event.index}/${event.total}] ${event.caseId}：${label}${event.reason ? '；' + event.reason : ''}`);
                    break;
                }
                case 'scoring-end': {
                    stopWaiting(); const [symbol, label] = scoreLabels[event.status];
                    line(`${symbol} [${event.index}/${event.total}] ${event.caseId}：评分结果：${label}；${event.reason}`);
                    break;
                }
                case 'trial-end':
                    stopWaiting();
                    line(`💾 [${event.index}/${event.total}] ${event.caseId}：${event.status === 'NOT_RUN' ? '未运行（NOT_RUN）' : event.status}，耗时${(event.elapsedMs / 1000).toFixed(1)}秒，结果已保存；${event.reason}`);
                    line(`[证据]${event.evidenceDirectory}`);
                    break;
                case 'dataset-end':
                    stopWaiting();
                    line(`[${datasetName(event.datasetId)}]${event.stopped ? '提前停止' : '本组结束'}：${Object.entries(event.counts).map(([status, count]) => `${status}=${count}`).join('，')}${event.reason ? '；' + event.reason : ''}`);
                    line(`[报告]${event.reportPath}`);
                    break;
            }
        },
        close(error?: unknown) {
            stopWaiting();
            if (error !== undefined) {
                line(`❌ [评测]运行异常；最后阶段：${current}；${error instanceof Error ? error.message : String(error)}`);
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
    if (args.includes('--stage') || args.includes('--mode'))
        throw new Error('阶段评测及 Fixture/Live 已取消；使用统一 Agent Benchmark。未调用模型。');
    if (args[0] === 'review' && args[1] === 'apply')
        throw new Error('review apply retired; use review import --execution-id <id> --backend langfuse. No platform request was made.');
    if (args[0] === 'sync' || args.includes('--version') || args.includes('--wait-seconds') || (args[0] === 'dataset' && args[1] === 'publish'))
        throw new Error('Platform-first interface retired. Use dataset validate, a local dataset and local status. No model was called.');
    const command = args[0]!, action = ['dataset', 'review','judge'].includes(command) ? args[1] : undefined;
    const allowed: Record<string, string[]> = { doctor: ['--backend'], dataset: ['--dir'], run: ['--model','--api','--base-url','--dataset', '--selection', '--case', '--repeat', '--execution-id', '--backend', '--judge'], status: ['--execution-id', '--dataset'], compare: ['--left', '--right'], judge:['--dir','--execution-id'],resend: ['--report','--execution-id'], review: ['--execution-id', '--dataset', '--case', '--trial', '--reviewer', '--verdict', '--note', '--backend'] };
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
            const result=await calibrateJudge(repoRoot,{directory,executionId},{signal:controller.signal});
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
        const backend = opt('--backend') ?? process.env.FLOWMATE_EVAL_BACKEND ?? 'local', judge = opt('--judge') ?? 'auto', selection = opt('--selection') ?? 'full';
        if ((backend !== 'local' && backend !== 'langfuse') || !['auto', 'off', 'required'].includes(judge) || !['smoke', 'holdout', 'full'].includes(selection))
            throw new Error('Invalid backend/judge/selection');
        const all = opt('--dataset') === 'all';
        if (all && (opt('--case') || opt('--execution-id'))) throw Error('Dataset all cannot use --case or --execution-id');
        const datasets = all ? ['flowmate-agent-v1','flowmate-research-v1'].map(dataset => findDataset(repoRoot,{dataset}))
            : [findDataset(repoRoot, { dataset: opt('--dataset') })];
        const config = parseRunConfig({model:opt('--model'),api:opt('--api'),baseUrl:opt('--base-url')});
        const controller = new AbortController(), stop = () => controller.abort();
        const progress = createProgressReporter();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
            const options = { selection: selection as 'smoke' | 'holdout' | 'full', backend: backend as 'local' | 'langfuse', judge: judge as 'auto' | 'off' | 'required', repeat: opt('--repeat') ? Number(opt('--repeat')) : undefined, config };
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
            const raw = JSON.parse(readFileSync(reportPath(repoRoot, opt('--execution-id')!), 'utf8'));
            if (!['flowmate-agent-run/v1', 'flowmate-agent-run/v2'].includes(raw.contract)) {
                print({ historical: true, readOnly: true, original: raw });
                return;
            }
            const report = readReport(reportPath(repoRoot, opt('--execution-id')!));
            print({ ...report, humanFeedback: feedbackStatus(repoRoot, report.executionId) });
            process.exitCode = exitCode(report);
        }
        else
            print(findDataset(repoRoot, { dataset: opt('--dataset') }).manifest);
        return;
    }
    if (command === 'compare') {
        print(comparison(readReport(reportPath(repoRoot, required('--left'))), readReport(reportPath(repoRoot, required('--right')))));
        return;
    }
    if (command === 'resend') {
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
