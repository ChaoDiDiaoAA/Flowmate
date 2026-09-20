import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runP0, executeCommand, type P0Command } from '../../agent-eval/tools/p0/run_p0.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'p0-command-')); roots.push(root);
  for (const p of ['data/invoices/voxel51', 'agent-eval/stage-evals/P0']) await mkdir(join(root, p), { recursive: true });
  await writeFile(join(root, 'data/invoices/voxel51/manifest.json'), '{"samples":[]}');
  await writeFile(join(root, 'agent-eval/stage-evals/P0/cases.json'), JSON.stringify({ schemaVersion: 'p0-stage-cases/v1', stage: 'P0', version: 2, cases: [{id:'P0-F01',scope:'asset',required:true,oracle:{manual:'synthetic'}}] }));
  return root;
}
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
const json = async (path: string, data: unknown) => writeFile(path, JSON.stringify(data));
function fake(root: string, change?: (c: P0Command) => Promise<number | undefined>) {
  const calls: string[] = [];
  const runRoot = join(root, 'agent-eval/runs/synthetic');
  const execute = async (c: P0Command) => {
    calls.push(c.name);
    expect(c.env.FLOWMATE_SOURCE_ROOT).toBe(join(root, 'data/invoices/voxel51'));
    const override = await change?.(c);
    if (override !== undefined) return override;
    await writeFile(c.stdoutPath, '{}'); await writeFile(c.stderrPath, '');
    if (c.name === 'bun-version') await writeFile(c.stdoutPath, '1.4.0');
    if (c.name === 'node-version') await writeFile(c.stdoutPath, 'v24.0.0');
    if (c.name === 'init') await mkdir(join(root, 'FlowmateData/p0-evals/synthetic'), { recursive: true });
    if (c.name === 'freeze') {
      await json(join(runRoot, 'expected-binding.json'), { test: true });
      await json(join(runRoot, 'cases.frozen.json'), { test: true });
    }
    if (c.name === 'source-audit') await json(join(runRoot, 'source-closure-audit.json'), {status:'PASS_STRUCTURAL_ONLY',errorCount:0});
    if (c.name === 'inspect') await json(c.stdoutPath, {issues:[]});
    if (c.name === 'publish') await json(c.stdoutPath, {documentRefs:[{documentId:'d1'}],manifest:{artifactId:'a1'}});
    if (c.name === 'capture') await json(c.stdoutPath, {projection:{artifactId:'a2'}});
    if (c.name === 'tests') await json(join(runRoot, 'vitest-product.json'), {startTime:Date.now()});
    if (c.name === 'facility') await json(join(runRoot, 'vitest-facility.json'), {startTime:Date.now()});
    if (c.name === 'fault') await json(join(runRoot, 'fault-summary.json'), {allPass:true});
    if (c.name === 'review') await json(join(runRoot, 'stage-review.json'), {status:'PASS',cases:[{id:'P0-F01',status:'PASS',observations:[]}],blockers:[],problems:[]});
    return 0;
  };
  return {execute,calls,runRoot};
}
test('one command sequences existing tools, freezes support hashes and explains the authoritative review', async () => {
  const root=await fixture(), f=fake(root);
  const result=await runP0({projectRoot:root,executionId:'synthetic',execute:f.execute,log:()=>{}});
  expect(result.exitCode).toBe(0);
  expect(f.calls).toEqual(['bun-version','node-version','python-environment','git-version','init','freeze','typecheck','tests','facility','source-audit','inspect','publish','read','capture','read-captured','fault','verify','review']);
  const steps=JSON.parse(await readFile(join(f.runRoot,'execution-steps.json'),'utf8'));
  expect(steps.outputs['vitest-product.json']).toMatch(/^[a-f0-9]{64}$/);
  expect(steps.steps.verify).toBeUndefined();
  expect(await readFile(join(f.runRoot,'summary.md'),'utf8')).toContain('通过');
  expect(await exists(join(root,'FlowmateData/p0-evals/synthetic/publication.json'))).toBe(true);
});
test.each(['source-audit','publish','verify'])('prerequisite %s failure stops dependent execution and never invents a review', async name => {
  const root=await fixture(), f=fake(root,async c=>c.name===name?2:undefined);
  const result=await runP0({projectRoot:root,executionId:'synthetic',execute:f.execute,log:()=>{}});
  expect(result.exitCode).toBe(2); expect(f.calls.at(-1)).toBe(name);
  expect(await exists(join(f.runRoot,'stage-review.json'))).toBe(false);
  expect(await readFile(join(f.runRoot,'summary.md'),'utf8')).toContain('未完成');
});
test('a failed independent test still collects probes and uses the failed Case verdict', async () => {
  const root=await fixture();const f=fake(root,async c=>{
    if(c.name==='tests')return 1;
    if(c.name==='review'){await json(join(root,'agent-eval/runs/synthetic/stage-review.json'),{status:'FAIL',cases:[{id:'P0-F09',status:'FAIL',observations:[{status:'FAIL',reason:'denial missing'}]}]});return 1;}
  });
  const r=await runP0({projectRoot:root,executionId:'synthetic',execute:f.execute,log:()=>{}});
  expect(r.exitCode).toBe(1);expect(f.calls).toContain('fault');expect(await readFile(join(f.runRoot,'summary.md'),'utf8')).toContain('P0-F09');
});
test.each(['UNJUDGEABLE','ERROR','NOT_RUN','BLOCKED'])('review %s remains incomplete, never passes', async status=>{
  const root=await fixture();const f=fake(root,async c=>{
    if(c.name==='review'){await json(join(root,'agent-eval/runs/synthetic/stage-review.json'),{status,cases:[],problems:['synthetic missing evidence / version drift']});return 2;}
  });
  expect((await runP0({projectRoot:root,executionId:'synthetic',execute:f.execute,log:()=>{}})).exitCode).toBe(2);
});
test('closed or unavailable stdin never blocks orchestration or creates a use declaration',async()=>{
  const root=await fixture(),f=fake(root);
  const stdin=vi.spyOn(process,'stdin','get').mockImplementation(()=>{throw new Error('stdin must not be read');});
  try {
    expect((await runP0({projectRoot:root,executionId:'synthetic',execute:f.execute,log:()=>{}})).exitCode).toBe(0);
    expect(f.calls).toContain('init');
    expect(await exists(join(f.runRoot,'source-use.json'))).toBe(false);
  } finally { stdin.mockRestore(); }
});

test('existing output is never overwritten',async()=>{
  const root=await fixture(),f=fake(root);await mkdir(f.runRoot,{recursive:true});await writeFile(join(f.runRoot,'summary.md'),'keep');
  expect((await runP0({projectRoot:root,executionId:'synthetic',execute:f.execute,log:()=>{}})).exitCode).toBe(2);
  expect(f.calls).toEqual([]);expect(await readFile(join(f.runRoot,'summary.md'),'utf8')).toBe('keep');
});
test('cancellation waits for the active command, records interruption and starts no next step',async()=>{
  const root=await fixture();const control=new AbortController();let stopped=false;
  const f=fake(root,async c=>{if(c.name==='tests'){control.abort();await new Promise(r=>setTimeout(r,10));stopped=true;return 130;}});
  const r=await runP0({projectRoot:root,executionId:'synthetic',execute:f.execute,signal:control.signal,log:()=>{}});
  expect(r.exitCode).toBe(130);expect(stopped).toBe(true);expect(f.calls.at(-1)).toBe('tests');
  expect(await readFile(join(f.runRoot,'summary.md'),'utf8')).toContain('中断');
});
test('native transport writes synthetic child output and handles a missing executable',async()=>{
  const root=await fixture();const c:P0Command={name:'synthetic',exe:process.execPath,args:['-e','console.log("hello")'],cwd:root,env:process.env,stdoutPath:join(root,'out'),stderrPath:join(root,'err'),signal:new AbortController().signal};
  expect(await executeCommand(c)).toBe(0);expect(await readFile(c.stdoutPath,'utf8')).toContain('hello');
  await expect(executeCommand({...c,exe:'missing-flowmate-test-command',args:[],stdoutPath:join(root,'out2'),stderrPath:join(root,'err2')})).rejects.toThrow();
});
