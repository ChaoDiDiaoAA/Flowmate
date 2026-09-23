import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from '../datasets/local.ts';
export function codeIdentity(repoRoot: string, snapshotFile?: string) {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0');
    const root = realpathSync(repoRoot);
    const source = [...new Set(files)].filter(p => /^(agent-eval\/src\/|packages\/|apps\/)/.test(p) && /\.(ts|json)$/.test(p) || ['package.json', 'bun.lock', 'tsconfig.json', 'agent-eval/package.json'].includes(p)).sort().map(path => {
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
            for (const secret of [process.env.FLOWMATE_JUDGE_API_KEY, process.env.FLOWMATE_LLM_API_KEY, process.env.LANGFUSE_SECRET_KEY, process.env.LANGFUSE_PUBLIC_KEY]) {
                if (secret && bytes.toString('utf8').includes(secret))
                    throw new Error(`Configured credential in execution source: ${path}; refusing snapshot`);
            }
        }
        const contentBase64 = bytes.toString('base64');
        return { path, hash: hash(contentBase64), contentBase64 };
    });
    const identity = { release: process.env.FLOWMATE_EVAL_RELEASE || `git:${commit}`, dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim(), commit, workspaceHash: hash(source.map(file => [file.path, file.hash])) };
    if (snapshotFile)
        writeFileSync(snapshotFile, JSON.stringify({ contract: 'flowmate-source-snapshot/v1', ...identity, runtime: { node: process.version, platform: process.platform, arch: process.arch }, files: source }, null, 2) + '\n', { flag: 'wx' });
    return identity;
}
