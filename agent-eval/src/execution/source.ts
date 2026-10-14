import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from '../dataset-loader/local.ts';
import { artifactJson, withoutHashes } from '../artifacts.ts';
import { protectedSecrets } from './evidence-safety.ts';
const manifests = new WeakMap<object, Map<string,string>>();
export function codeIdentity(repoRoot: string, snapshotFile?: string) {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0');
    const root = realpathSync(repoRoot);
    const source = [...new Set(files)].filter(p =>
        !/^agent-eval\/src\/(datasets|testing)\//.test(p) && /^(agent-eval\/src\/|packages\/|apps\/|scripts\/)/.test(p) && /\.(tsx?|[cm]?js|json|css|html|sql)$/.test(p) ||
        /^resources\//.test(p) && /\.(md|json)$/.test(p) ||
        /^patches\//.test(p) && p.endsWith('.patch') ||
        ['package.json', 'bun.lock', 'tsconfig.json', 'electron.vite.config.ts', 'agent-eval/package.json'].includes(p)
    ).sort().map(path => {
        let bytes: Buffer;
        try {
            const file = realpathSync(join(root, path));
            const local = relative(root, file);
            if (local.startsWith('..') || isAbsolute(local))
                throw new Error(`Source file escapes repository: ${path}`);
            bytes = readFileSync(file);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return { path, hash: 'deleted', contentBase64: null };
            throw error;
        }
        if (snapshotFile) {
            for (const secret of protectedSecrets()) {
                if (secret && bytes.toString('utf8').includes(secret))
                    throw new Error(`Configured credential in execution source: ${path}; refusing snapshot`);
            }
        }
        const contentBase64 = bytes.toString('base64');
        return { path, hash: hash(contentBase64), contentBase64 };
    }).filter(file=>file.contentBase64!==null);
    const identity = { release: process.env.FLOWMATE_EVAL_RELEASE || `git:${commit}`, dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim(), commit, workspaceHash: hash(source.map(file => [file.path, file.hash])) };
    manifests.set(identity,new Map(source.map(file=>[file.path,file.hash])));
    if (snapshotFile)
        writeFileSync(snapshotFile, artifactJson({ contract: 'flowmate-source-snapshot/v1', ...identity, runtime: { node: process.version, platform: process.platform, arch: process.arch }, files: source }), { flag: 'wx' });
    return identity;
}
export function changedSourcePaths(before: object, after: object) {
    const first=manifests.get(before), last=manifests.get(after);
    if(!first || !last)throw Error('Source comparison requires original in-memory conditions');
    return [...new Set([...first.keys(),...last.keys()])].filter(path=>first.get(path)!==last.get(path)).sort();
}
/** Save actual runtime code conditions instead of a persistent source fingerprint. */
export function runtimeSourceConditions(repo:string) {
    const files=['packages/core/src/tools/executor.ts','packages/core/src/tools/evaluation-fault.ts',
        'packages/contracts/src/ports.ts','packages/contracts/src/runtime.ts','packages/contracts/src/tool-evidence.ts',
        'packages/runtime-pi/src/session.ts','packages/runtime-pi/src/schema.ts','packages/employee-invoice/src/tools/calculate_invoice_amounts.ts',
        'agent-eval/src/scoring/evaluators/invoice-values.ts','agent-eval/src/scoring/evaluators/reference-fields.ts',
        'agent-eval/src/scoring/evaluators/line-items.ts','agent-eval/src/scoring/evaluators/semantic.ts','agent-eval/src/scoring/safety.ts',
        'agent-eval/src/scoring/types.ts','agent-eval/src/scoring/evaluate.ts','agent-eval/src/scoring/registry.ts',
        'agent-eval/src/scoring/evaluator-plan.ts','agent-eval/src/scoring/evaluators/registered.ts',
        'agent-eval/src/scoring/evaluators/formal.ts','agent-eval/src/scoring/case-constraints.ts','agent-eval/src/scoring/research-f1.ts',
        'agent-eval/src/scoring/diagnostics.ts','agent-eval/src/scoring/diagnostic-plans.ts','agent-eval/src/scoring/judges/evaluators.ts',
        'agent-eval/src/scoring/judges/compact.ts','agent-eval/src/scoring/judges/harness.ts',
        'agent-eval/src/scoring/research-frame.ts','agent-eval/src/scoring/research-judgment.ts',
        'agent-eval/src/adapters/research-integrity.ts','agent-eval/src/artifacts.ts','packages/shared/src/decimal.ts',
        'packages/contracts/src/research.ts','packages/core/src/research/source-text.ts',
        'packages/core/src/research/read-tools.ts','packages/core/src/research/synthesis-tools.ts','packages/runtime-pi/src/tools.ts',
        'resources/prompts/research/prompt.md','resources/skills/deep-research/SKILL.md'];
    const dependencies=existsSync(join(repo,'package.json'))?JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).dependencies:{};
    return withoutHashes({dependencies:Object.fromEntries(['@earendil-works/pi-ai','@earendil-works/pi-coding-agent'].map(id=>[id,dependencies?.[id]??null])),
        files:files.filter(path=>existsSync(join(repo,path))).map(path=>({path,text:readFileSync(join(repo,path),'utf8')}))});
}
