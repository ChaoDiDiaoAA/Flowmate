import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, resolveCase, discoverDatasets } from './datasets/local.ts';
import { findDataset, runLocal, runConfigSchema } from './execution/runner.ts';
import { readReport, reportPath, exitCode, comparison, summary } from './reports/store.ts';
import { addFeedback, feedbackStatus } from './review/local.ts';
import { judgeConfig, publicJudgeConfig } from './scoring/judges/client.ts';
import { scanEvidence } from './execution/evidence-safety.ts';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const HELP = `Flowmate local evaluation
bun run eval -- dataset validate --dir <local-dataset-directory>
bun run eval -- doctor [--backend local|langfuse]
bun run eval -- run [--dataset <local-id>] [--dataset-version <integer>] [--selection smoke|full] [--case <id>] [--repeat <1..20>] [--config <file>] [--execution-id <id>] [--backend local|langfuse] [--judge auto|off|required]
bun run eval -- status --execution-id <id> | --dataset <id>
bun run eval -- compare --left <execution-id> --right <execution-id>
bun run eval -- resend --report <absolute-summary.json>
bun run eval -- review add (--execution-id <id> | --dataset <id>) --case <id> [--trial <TrialID>] --reviewer <name> --verdict good|bad --note <text>
bun run eval -- review status (--execution-id <id> | --dataset <id>)
bun run eval -- review setup --backend langfuse
bun run eval -- review enqueue|import|sync --execution-id <id> --backend langfuse
Retired: review apply (use review import --backend langfuse), dataset publish, sync, --version and --wait-seconds.
Defaults: backend local; judge auto (independent configuration, may incur fees); repeat 1. All Benchmark runs use the real Agent and incur model fees; unavailable until Agent implementation is complete.
Exit 0: necessary automatic scores pass; 1: failed/error/incomplete; 2: necessary scoring pending. Human acceptance and export are separate.`;
export function parseOptions(args: string[], valued: string[], flags: string[] = []): Record<string, string | true> {
    const out: Record<string, string | true> = {};
    for (let i = 0; i < args.length; i++) {
        const key = args[i]!;
        if (!valued.includes(key) && !flags.includes(key))
            throw new Error(`Unknown argument: ${key}`);
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
        throw new Error('Platform-first interface retired. Use dataset validate, local --dataset-version and local status. No model was called.');
    const command = args[0]!, action = ['dataset', 'review'].includes(command) ? args[1] : undefined;
    const allowed: Record<string, string[]> = { doctor: ['--backend'], dataset: ['--dir'], run: ['--dataset', '--dataset-version', '--selection', '--case', '--repeat', '--config', '--execution-id', '--backend', '--judge'], status: ['--execution-id', '--dataset'], compare: ['--left', '--right'], resend: ['--report'], review: ['--execution-id', '--dataset', '--case', '--trial', '--reviewer', '--verdict', '--note', '--backend'] };
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
    const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
    if (command === 'dataset') {
        if (action !== 'validate')
            throw new Error(HELP);
        const d = loadDataset(resolve(required('--dir')));
        d.cases.forEach(c => resolveCase(d, c, repoRoot));
        print({ valid: true, dataset: d.manifest.id, version: d.manifest.version, hash: d.hash, cases: d.cases.length });
        return;
    }
    if (command === 'doctor') {
        const backend = opt('--backend') ?? process.env.FLOWMATE_EVAL_BACKEND ?? 'local';
        if (!['local', 'langfuse'].includes(backend))
            throw new Error('Invalid backend');
        const judge = judgeConfig(process.env);
        const data = discoverDatasets(resolve(repoRoot, 'agent-eval/datasets'));
        data.forEach(d => d.cases.forEach(c => resolveCase(d, c, repoRoot)));
        if (backend === 'langfuse') {
            const { platformClient } = await import('./langfuse/export.ts');
            const client = await platformClient();
            try {
                await client.api.projects.get();
            }
            finally {
                await client.shutdown();
            }
        }
        print({ ok: true, backend, datasets: data.map(d => d.manifest.id),
            benchmark: { ready: false, reason: data.length ? '完整 Agent 尚未实现；配置检查成功不代表 Benchmark 就绪。' : '尚未制作，等待完整 Agent；真实入口与必要采证接通、工程验证通过后，依据 01/02 制作 Benchmark。配置检查成功不代表 Benchmark 就绪。' },
            agent: 'not implemented; Benchmark disabled', judge: judge ? publicJudgeConfig(judge) : 'not configured' });
        return;
    }
    if (command === 'run') {
        const backend = opt('--backend') ?? process.env.FLOWMATE_EVAL_BACKEND ?? 'local', judge = opt('--judge') ?? 'auto', selection = opt('--selection') ?? 'full';
        if ((backend !== 'local' && backend !== 'langfuse') || !['auto', 'off', 'required'].includes(judge) || !['smoke', 'full'].includes(selection))
            throw new Error('Invalid backend/judge/selection');
        const version = opt('--dataset-version') === undefined ? undefined : Number(opt('--dataset-version'));
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
            throw new Error('Dataset version must be a positive integer');
        const dataset = findDataset(repoRoot, { dataset: opt('--dataset'), version });
        const config = runConfigSchema.parse(opt('--config') ? JSON.parse(readFileSync(resolve(opt('--config')!), 'utf8')) : {});
        const controller = new AbortController(), stop = () => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
            const result = await runLocal(repoRoot, { dataset, selection: selection as 'smoke' | 'full', backend, judge: judge as 'auto' | 'off' | 'required', caseId: opt('--case'), executionId: opt('--execution-id'), repeat: opt('--repeat') ? Number(opt('--repeat')) : undefined, config }, { signal: controller.signal });
            print({ executionId: result.report.executionId, report: result.file, summary: summary(result.report), trials: result.report.trials.map(t => ({ caseId: t.caseId, repetition: t.repetition, status: t.status, reason: t.reason, counts: t.counts })), manualReview: result.report.manualReview, export: result.report.export });
            process.exitCode = exitCode(result.report);
        }
        finally {
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
            if (raw.contract !== 'flowmate-agent-run/v1') {
                print({ historical: true, readOnly: true, original: raw });
                return;
            }
            print({ ...raw, humanFeedback: feedbackStatus(repoRoot, raw.executionId) });
            process.exitCode = exitCode(raw);
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
        const path = required('--report');
        if (!isAbsolute(path))
            throw new Error('Absolute report path required');
        const report = readReport(path);
        const { exportReport } = await import('./langfuse/export.ts');
        const result = await exportReport(report, path);
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
    const env = resolve(repoRoot, '.env');
    if (existsSync(env))
        process.loadEnvFile(env);
    main(process.argv.slice(2).filter(a => a !== '--')).catch(error => { console.error(scanEvidence((error as Error).message).value); process.exitCode = 1; });
}
