import { mkdtempSync } from '../../../tests/support/resources.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { codeIdentity } from '../../src/execution/source.ts';
import * as source from '../../src/execution/source.ts';
import { hash as contentHash } from '../../src/dataset-loader/local.ts';
test('source snapshot reconstructs dirty and untracked execution code without environment files', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-source-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
        git('init');
        mkdirSync(join(root, 'packages/core/src'), { recursive: true });
        writeFileSync(join(root, 'packages/core/src/main.ts'), 'export const result = 1;\n');
        writeFileSync(join(root, '.gitignore'), '.env\n.env.*\nsource-snapshot.json\n');
        git('add', '.');
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test baseline');
        const dirty = 'export const result = 2;\n';
        writeFileSync(join(root, 'packages/core/src/main.ts'), dirty);
        writeFileSync(join(root, 'packages/core/src/new.ts'), 'export const added = true;\n');
        writeFileSync(join(root, '.env'), 'SECRET_DO_NOT_SNAPSHOT=private-value');
        writeFileSync(join(root, 'packages/core/src/.env.local'), 'NESTED_SECRET=private-value');
        const destination = join(root, 'source-snapshot.json');
        const identity = codeIdentity(root, destination);
        const snapshot = JSON.parse(readFileSync(destination, 'utf8'));
        writeFileSync(join(root, 'packages/core/src/main.ts'), 'later contents');
        const entry = snapshot.files.find((file: any) => file.path === 'packages/core/src/main.ts');
        expect(Buffer.from(entry.contentBase64, 'base64').toString('utf8')).toBe(dirty);
        expect(snapshot.files.some((file: any) => file.path.endsWith('/new.ts'))).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain('private-value');
        expect(snapshot.files.some((file: any) => file.path.includes('.env'))).toBe(false);
        expect(snapshot.workspaceHash).toBeUndefined();
        expect(snapshot.files.every((file:any)=>!('hash' in file))).toBe(true);
        expect(codeIdentity(root).workspaceHash).not.toBe(identity.workspaceHash);
        expect(identity.dirty).toBe(true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);

test('source comparison reports actual added, changed and deleted paths while Git-only commits remain valid',()=>{
    expect(source.changedSourcePaths).toBeFunction();
    const root=mkdtempSync(join(tmpdir(),'flowmate-source-diff-'));
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
    const commit=()=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','fixture');
    try{
        git('init');mkdirSync(join(root,'packages/core/src'),{recursive:true});
        const path='packages/core/src/a.ts';writeFileSync(join(root,path),'initial');git('add','.');commit();
        const before=codeIdentity(root);commit();
        expect(source.changedSourcePaths(before,codeIdentity(root))).toEqual([]);
        writeFileSync(join(root,path),'changed');writeFileSync(join(root,'packages/core/src/b.ts'),'added');
        expect(source.changedSourcePaths(before,codeIdentity(root))).toEqual([path,'packages/core/src/b.ts']);
        unlinkSync(join(root,path));const absent=codeIdentity(root);git('add','-A');commit();
        expect(codeIdentity(root).workspaceHash).toBe(absent.workspaceHash);
        expect(source.changedSourcePaths(absent,codeIdentity(root))).toEqual([]);
        expect(JSON.stringify(before)).not.toContain('contentBase64');
    }finally{rmSync(root,{recursive:true,force:true});}
},30000);

test('saved actual conditions include decimal scoring and research tool implementations for cross-run comparison',()=>{
    const root=mkdtempSync(join(tmpdir(),'flowmate-source-conditions-'));
    const paths=['agent-eval/src/scoring/evaluators/invoice-values.ts','agent-eval/src/scoring/research-frame.ts',
        'agent-eval/src/scoring/research-judgment.ts','agent-eval/src/adapters/research-integrity.ts','agent-eval/src/artifacts.ts',
        'packages/shared/src/decimal.ts','packages/core/src/research/source-text.ts'];
    try{
        for(const path of paths){mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),'original implementation');}
        expect(source.runtimeSourceConditions(root).files.map((f:{path:string})=>f.path)).toEqual(paths);
        for(const path of paths){const before=source.runtimeSourceConditions(root);writeFileSync(join(root,path),'changed scoring or source rule');
            expect(source.runtimeSourceConditions(root)).not.toEqual(before);}
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('reproduction includes desktop TSX, resource text and SDK patches but excludes quality assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-source-assets-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
        git('init');
        const sources = ['apps/desktop/renderer/App.tsx', 'apps/desktop/renderer/styles.css', 'apps/desktop/renderer/index.html',
            'packages/data/migrations/019.sql', 'resources/skills/invoice/SKILL.md',
            'resources/prompts/system.md', 'resources/roles/research.md', 'resources/templates/report.json',
            'patches/pi-sdk.patch', 'scripts/host-launch.ts', 'electron.vite.config.ts', 'bun.lock'];
        const excluded = ['agent-eval/src/datasets/secret-gold.json', 'agent-eval/src/testing/scenarios.ts',
            'agent-eval/src/testing/fixtures/private.json', 'agent-eval/runs/old/summary.json',
            'resources/.env.local', 'docs/eval/notes.md'];
        for (const path of [...sources, ...excluded]) {
            mkdirSync(join(root, path, '..'), { recursive: true });
            writeFileSync(join(root, path), 'initial');
        }
        git('add', '.');
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test baseline');
        let previous = codeIdentity(root).workspaceHash;
        for (const path of sources) {
            writeFileSync(join(root, path), 'changed');
            const current = codeIdentity(root).workspaceHash;
            expect(current, path).not.toBe(previous);
            previous = current;
        }
        for (const path of excluded) writeFileSync(join(root, path), 'quality-or-secret');
        expect(codeIdentity(root).workspaceHash).toBe(previous);
        const destination = join(root, 'snapshot.json');
        codeIdentity(root, destination);
        const snapshot = JSON.parse(readFileSync(destination, 'utf8'));
        expect(snapshot.files.map((file: { path: string }) => file.path)).toEqual([...sources].sort());
        expect(JSON.stringify(snapshot)).not.toContain('quality-or-secret');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);
