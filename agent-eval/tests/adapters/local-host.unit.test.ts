import { expect, test } from 'bun:test';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareLocalHost } from '../../src/adapters/local-host.ts';

function fixture() {
    const root=mkdtempSync(join(tmpdir(),'flowmate-local-host-')),repo=join(root,'repo'),trial=join(root,'trial');
    for(const dir of ['apps/host','resources/skills/example','agent-eval/src/datasets','packages/core/src/storage/migrations',
        'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme'])mkdirSync(join(repo,dir),{recursive:true});
    mkdirSync(trial);
    writeFileSync(join(repo,'apps/host/main.ts'),"console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,kind:'synthetic-local-process'}));");
    writeFileSync(join(repo,'resources/skills/example/SKILL.md'),'Public product guidance.');
    writeFileSync(join(repo,'agent-eval/src/datasets/gold.ts'),'FORBIDDEN_QUALITY_DATA');
    writeFileSync(join(repo,'node_modules/@earendil-works/pi-coding-agent/package.json'),'{"name":"synthetic-sdk"}');
    return {root,repo,trial};
}

test('local Host launches with its own runtime and product data without copying evaluation sources',()=>{
    const f=fixture(),local=prepareLocalHost(f.repo,f.trial);
    expect(local.launch.args[local.launch.args.indexOf('--evaluation-trial-root') + 1]).toBe(f.trial);
    expect(local.launch.executable.toLowerCase()).not.toContain('docker');
    expect(local.manifest).toMatchObject({kind:'local-process',filesystemSandbox:false});
    expect(existsSync(join(local.runtimeRoot,'agent-eval'))).toBe(false);
    expect(readFileSync(join(local.runtimeRoot,'apps/host.js'),'utf8')).not.toContain('FORBIDDEN_QUALITY_DATA');
    const actual=JSON.parse(execFileSync(local.launch.executable,local.launch.args,{cwd:local.runtimeRoot,encoding:'utf8',windowsHide:true}));
    expect(actual).toEqual({cwd:local.runtimeRoot,home:join(local.productRoot,'runtime'),kind:'synthetic-local-process'});
},15000);

test('local product resource copying rejects a junction and does not include its contents',()=>{
    const f=fixture(),outside=join(f.root,'private');mkdirSync(outside);writeFileSync(join(outside,'gold.json'),'FORBIDDEN_LINK_DATA');
    symlinkSync(outside,join(f.repo,'resources','private-link'),'junction');
    expect(()=>prepareLocalHost(f.repo,f.trial)).toThrow('links');
    expect(existsSync(join(f.trial,'runtime/resources/private-link/gold.json'))).toBe(false);
});

test('evaluation Host does not inherit unrelated provider, cloud or evaluation credentials',()=>{
    const f=fixture();
    const names=['OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','LANGFUSE_SECRET_KEY','FLOWMATE_EVAL_AGENT_API_KEY','CLOUD_CREDENTIALS_FILE'];
    writeFileSync(join(f.repo,'apps/host/main.ts'),`console.log(JSON.stringify(${JSON.stringify(names)}.map(name=>process.env[name]!==undefined)));`);
    const local=prepareLocalHost(f.repo,f.trial);
    const env={...process.env,...Object.fromEntries(names.map(name=>[name,'synthetic-evaluation-sentinel']))};
    const actual=JSON.parse(execFileSync(local.launch.executable,local.launch.args,{cwd:local.runtimeRoot,env,encoding:'utf8',windowsHide:true}));
    expect(actual).toEqual(names.map(()=>false));
},15000);

test('trusted evaluation overrides arrive at the actual Host startup as a separate validated argument', () => {
    const f = fixture(), overrides = { systemPrompt: 'Trusted experiment prompt', reasoning: 'max' as const,
        strategy: { budgetAwareness: false, statistics: false, experience: true } };
    writeFileSync(join(f.repo, 'apps/host/main.ts'), 'const i=process.argv.indexOf("--eval-agent-overrides");console.log(process.argv[i+1]);');
    const local = prepareLocalHost(f.repo, f.trial, [], undefined, undefined, [], undefined, overrides);
    const actual = JSON.parse(execFileSync(local.launch.executable, local.launch.args, { cwd: local.runtimeRoot, encoding: 'utf8', windowsHide: true }));
    expect(actual).toEqual(overrides);
}, 15000);
