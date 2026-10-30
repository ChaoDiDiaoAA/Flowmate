import { mkdtempSync } from '../../../tests/support/resources.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { codeIdentity } from '../../src/execution/source.ts';
import * as source from '../../src/execution/source.ts';
import { PACKAGED_REQUIRED_FILES, resolveRuntimeLayout, type PackagedRelease } from '@flowmate/shared';

test('installed source compares actual released bodies without Git and rejects missing assets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'flowmate-installed-source-')), root = join(directory, 'flowmate-runtime');
    const release: PackagedRelease = { version: 1, releaseId: crypto.randomUUID(), productVersion: '0.1.0',
        platform: 'win32', arch: 'x64', bunVersion: '1.4.0', electronVersion: '44.4.5', sdkVersion: '1.4.0', pluginVersion: '0.19.0',
        schemaVersion: 22, settingsVersion: 7, files: [...PACKAGED_REQUIRED_FILES, 'resources/prompts/test.md'] };
    for (const file of release.files) { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), 'one'); }
    writeFileSync(join(root, 'sdk/package.json'), JSON.stringify({ version: release.sdkVersion }));
    writeFileSync(join(root, 'release.json'), JSON.stringify(release));
    const layout = resolveRuntimeLayout({ isPackaged: true, appPath: join(directory, 'app.asar'), resourcesPath: directory, userDataRoot: join(tmpdir(), 'flowmate-source-user') });
    expect(layout.ok).toBe(true); if (!layout.ok) throw Error(layout.error.code);
    const runtime: source.EvaluationRuntime = { mode: 'installed', layout: layout.data, release };
    const before = codeIdentity(directory, undefined, runtime);
    expect(before).toEqual({ release: `0.1.0:${release.releaseId}`, dirty: false });
    const conditions = source.runtimeSourceConditions(directory, before, runtime);
    expect(conditions.dependencies).toMatchObject({ bun: '1.4.0', '@earendil-works/pi-ai': '1.4.0' });
    expect(conditions.files.some(file => file.path === 'bin/bun.exe')).toBe(false);
    writeFileSync(join(root, 'apps/host.js'), 'two');
    expect(source.changedSourcePaths(before, codeIdentity(directory, undefined, runtime))).toEqual(['apps/host.js']);
    unlinkSync(join(root, 'apps/host.js'));
    expect(() => codeIdentity(directory, undefined, runtime)).toThrow('unavailable');
});
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
        const conditions=source.runtimeSourceConditions(root,identity);
        expect(conditions.files).toContainEqual({path:'packages/core/src/main.ts',text:dirty});
        expect(conditions.files).toContainEqual({path:'packages/core/src/new.ts',text:'export const added = true;\n'});
        const snapshot = JSON.parse(readFileSync(destination, 'utf8'));
        writeFileSync(join(root, 'packages/core/src/main.ts'), 'later contents');
        const entry = snapshot.files.find((file: any) => file.path === 'packages/core/src/main.ts');
        expect(Buffer.from(entry.contentBase64, 'base64').toString('utf8')).toBe(dirty);
        expect(snapshot.files.some((file: any) => file.path.endsWith('/new.ts'))).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain('private-value');
        expect(snapshot.files.some((file: any) => file.path.includes('.env'))).toBe(false);
        expect(snapshot.workspaceHash).toBeUndefined();
        expect(snapshot.files.every((file:any)=>!('hash' in file))).toBe(true);
        expect(source.changedSourcePaths(identity,codeIdentity(root))).toContain('packages/core/src/main.ts');
        expect(identity.dirty).toBe(true);
        writeFileSync(join(root, 'packages/core/src/main.ts'), Buffer.from([0xc0, 0x80]));
        expect(() => source.runtimeSourceConditions(root)).toThrow('not valid UTF-8');
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
        expect(source.changedSourcePaths(absent,codeIdentity(root))).toEqual([]);
        expect(source.changedSourcePaths(absent,codeIdentity(root))).toEqual([]);
        expect(JSON.stringify(before)).not.toContain('contentBase64');
    }finally{rmSync(root,{recursive:true,force:true});}
},30000);

test('saved actual conditions include decimal scoring and research tool implementations for cross-run comparison',()=>{
    const root=mkdtempSync(join(tmpdir(),'flowmate-source-conditions-'));
    const paths=['agent-eval/src/scoring/evaluators/invoice-values.ts','agent-eval/src/scoring/research-frame.ts',
        'agent-eval/src/scoring/research-judgment.ts','agent-eval/src/adapters/research-integrity.ts','agent-eval/src/artifacts.ts',
        'packages/shared/src/decimal.ts','packages/core/src/research/source-text.ts','apps/host/main.ts',
        'packages/core/src/resources/loader.ts','resources/prompts/system/prompt.md'];
    try{
        execFileSync('git',['init','-q'],{cwd:root});
        execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','fixture'],{cwd:root});
        for(const path of paths){mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),'original implementation');}
        expect(source.runtimeSourceConditions(root).files.map((f:{path:string})=>f.path)).toEqual([...paths].sort());
        for(const path of paths){const before=source.runtimeSourceConditions(root);writeFileSync(join(root,path),'changed scoring or source rule');
            expect(source.runtimeSourceConditions(root)).not.toEqual(before);}
    }finally{rmSync(root,{recursive:true,force:true});}
});

test('local runtime source declarations refuse configured credentials in actual file bodies',()=>{
    const root=mkdtempSync(join(tmpdir(),'flowmate-source-secret-'));
    const prior=process.env.FLOWMATE_EVAL_AGENT_API_KEY;
    try{
        execFileSync('git',['init','-q'],{cwd:root});
        execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','fixture'],{cwd:root});
        mkdirSync(join(root,'apps/host'),{recursive:true});
        process.env.FLOWMATE_EVAL_AGENT_API_KEY='synthetic-source-private-key';
        for(const key of ['synthetic-source-private-key','sk-lf-private-source-example']){
            writeFileSync(join(root,'apps/host/main.ts'),`export const credential = "${key}";`);
            expect(()=>source.runtimeSourceConditions(root)).toThrow('credential in execution source');
        }
    }finally{if(prior===undefined)delete process.env.FLOWMATE_EVAL_AGENT_API_KEY;else process.env.FLOWMATE_EVAL_AGENT_API_KEY=prior;rmSync(root,{recursive:true,force:true});}
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
        let previous = codeIdentity(root);
        for (const path of sources) {
            writeFileSync(join(root, path), 'changed');
            const current = codeIdentity(root);
            expect(source.changedSourcePaths(previous,current)).toEqual([path]);
            previous = current;
        }
        for (const path of excluded) writeFileSync(join(root, path), 'quality-or-secret');
        expect(source.changedSourcePaths(previous,codeIdentity(root))).toEqual([]);
        const destination = join(root, 'snapshot.json');
        codeIdentity(root, destination);
        const snapshot = JSON.parse(readFileSync(destination, 'utf8'));
        expect(snapshot.files.map((file: { path: string }) => file.path)).toEqual([...sources].sort());
        expect(JSON.stringify(snapshot)).not.toContain('quality-or-secret');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);
