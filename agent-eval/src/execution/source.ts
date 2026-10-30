import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { resolveRuntimeLayout, type RuntimeLayout, type PackagedRelease } from '@flowmate/shared';
import { artifactJson } from '../artifacts.ts';
import { protectedSecrets, scanEvidence } from './evidence-safety.ts';
const manifests = new WeakMap<object, Map<string,string>>();
export type EvaluationRuntime = { mode: 'development'; repository: string }
    | { mode: 'installed'; layout: RuntimeLayout; release: PackagedRelease };

export function captureInstalledSource(runtime: Extract<EvaluationRuntime, { mode: 'installed' }>, snapshotFile?: string) {
    const root = runtime.layout.runtimeRoot;
    const checked = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(root), 'app.asar'),
        resourcesPath: dirname(root), userDataRoot: dirname(runtime.layout.evaluationRoot) });
    if (!checked.ok || !isDeepStrictEqual(checked.data.release, runtime.release)) throw Error('Installed evaluation runtime changed or is unavailable');
    const source = ['release.json', ...runtime.release.files.filter(path => /\.(?:[cm]?js|json|sql|md|html|css)$/.test(path))].sort().map(path => {
        const bytes = readFileSync(join(root, path));
        // The scanner's public fixture literal is part of the released Worker itself.
        if (protectedSecrets().some(secret => secret !== 'fixture-synthetic-key' && bytes.toString('utf8').includes(secret)))
            throw Error('Configured credential in execution source; refusing snapshot');
        return { path, contentBase64: bytes.toString('base64') };
    });
    const identity = { release: `${runtime.release.productVersion}:${runtime.release.releaseId}`, dirty: false };
    manifests.set(identity, new Map(source.map(file => [file.path, file.contentBase64])));
    if (snapshotFile) writeFileSync(snapshotFile, artifactJson({ contract: 'flowmate-source-snapshot/v1', ...identity,
        runtime: { node: process.version, platform: process.platform, arch: process.arch }, files: source }), { flag: 'wx' });
    return identity;
}

export function codeIdentity(repoRoot: string, snapshotFile?: string, runtime?: EvaluationRuntime) {
    if (runtime?.mode === 'installed') return captureInstalledSource(runtime, snapshotFile);
    if (runtime?.mode === 'development') repoRoot = runtime.repository;
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).split('\0');
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
                return { path,  contentBase64: null };
            throw error;
        }
        if (snapshotFile) {
            for (const secret of protectedSecrets()) {
                if (secret && bytes.toString('utf8').includes(secret))
                    throw new Error(`Configured credential in execution source: ${path}; refusing snapshot`);
            }
        }
        const contentBase64 = bytes.toString('base64');
        return { path,  contentBase64 };
    }).filter(file=>file.contentBase64!==null);
    const identity = { release: process.env.FLOWMATE_EVAL_RELEASE || `git:${commit}`, dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim(), commit };
    manifests.set(identity,new Map(source.map(file=>[file.path,file.contentBase64!])));
    if (snapshotFile)
        writeFileSync(snapshotFile, artifactJson({ contract: 'flowmate-source-snapshot/v1', ...identity, runtime: { node: process.version, platform: process.platform, arch: process.arch }, files: source }), { flag: 'wx' });
    return identity;
}
export function changedSourcePaths(before: object, after: object) {
    const first=manifests.get(before), last=manifests.get(after);
    if(!first || !last)throw Error('Source comparison requires original in-memory conditions');
    return [...new Set([...first.keys(),...last.keys()])].filter(path=>first.get(path)!==last.get(path)).sort();
}
/** Reuse the complete captured source bodies only in the local execution declaration. */
export function runtimeSourceConditions(repo:string,identity:object=codeIdentity(repo),runtime?:EvaluationRuntime) {
    const original=manifests.get(identity);
    if(!original)throw Error('Source declaration requires original in-memory conditions');
    const files=[...original].map(([path,content])=>{
        const bytes=Buffer.from(content,'base64'),text=bytes.toString('utf8');
        if(!Buffer.from(text).equals(bytes))throw Error(`Execution source is not valid UTF-8: ${path}`);
        return {path,text};
    });
    const conditions={contract:'flowmate-execution-source/v1' as const,runtime:{node:process.version,platform:process.platform,arch:process.arch},
        dependencies:runtime?.mode === 'installed' ? { '@earendil-works/pi-ai': runtime.release.sdkVersion,
            '@earendil-works/pi-coding-agent': runtime.release.sdkVersion, '@tintinweb/pi-subagents': runtime.release.pluginVersion,
            bun: runtime.release.bunVersion, electron: runtime.release.electronVersion } : Object.fromEntries(['@earendil-works/pi-ai','@earendil-works/pi-coding-agent'].map(id=>{
            const file=join(repo,'node_modules',id,'package.json');return [id,existsSync(file)?JSON.parse(readFileSync(file,'utf8')).version??null:null];
        })),files};
    // This public test value occurs in the scanner's own source; actual configured credentials still reject the declaration.
    const scanned=scanEvidence(conditions,protectedSecrets().filter(secret=>secret!=='fixture-synthetic-key'));
    if((scanned.fact.actual as {leaked:boolean}).leaked)throw Error('Configured credential in execution source; refusing snapshot');
    return conditions;
}
