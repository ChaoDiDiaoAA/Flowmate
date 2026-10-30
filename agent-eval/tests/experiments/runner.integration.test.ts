import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dataset, fixtureRepo, observed } from '../support/fixtures.ts';
import { runExperiment, compareExperiment, listExperiments, listBaselines, createBaseline, checkGate } from '../../src/experiments/index.ts';
import { findArchive, archiveReference, readArchivePart } from '../../src/reports/archive.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';
import { reportFixture } from '../support/fixtures.ts';

function input() { return {id:'experiment-'+randomUUID(),benchmark:{id:'baseline',revision:1,selection:'smoke'},
  repeats:3,axes:['model'],control:{id:'control'},candidates:[{id:'candidate'}]}; }
function pureDataset() {
  const data=structuredClone(dataset);data.manifest.scoring.judges=[];
  data.cases=data.cases.slice(0,1);data.manifest.smoke=data.cases.map(c=>c.id);
  data.cases[0]!.expected.checks=[{metric:'fact-check',required:true,evidence:'task-facts',path:['saved'],equals:true}];
  return data;
}
test('model arms receive their exact explicit connection credentials without persisting keys', async () => {
  const first = { model: 'llama-3.3-70b-versatile', api: 'openai-completions' as const, baseUrl: 'https://one.invalid/v1' };
  const second = { ...first, baseUrl: 'https://two.invalid/v1' }, seen: string[] = [];
  const request = { ...input(), repeats: 1, control: { id: 'one', model: first }, candidates: [{ id: 'two', model: second }] };
  const record = await runExperiment(fixtureRepo, request, { env: {}, loadBenchmark: () => [pureDataset()],
    agentCredentials: [{ connection: first, apiKey: 'synthetic-one-key' }, { connection: second, apiKey: 'synthetic-two-key' }],
    run: async (_repo, options, deps) => {
      expect(deps?.preparedAgent?.configuration.baseUrl).toBe(options.config?.baseUrl);
      seen.push(deps!.preparedAgent!.apiKey); const report = reportFixture(); report.executionId = 'arm-' + seen.length;
      return [{ report, file: 'controlled-report.json', stopped: false }];
    } });
  expect(record.status).toBe('complete'); expect(seen).toEqual(['synthetic-one-key', 'synthetic-two-key']);
  expect(JSON.stringify(record)).not.toContain('synthetic-one-key'); expect(JSON.stringify(record)).not.toContain('synthetic-two-key');
});
test('an arm changing provider endpoint cannot forward the default secret or start a runner without its own credential', async () => {
  let runs = 0, metadata = 0;
  const target = { model: 'llama-3.3-70b-versatile', api: 'openai-completions' as const, baseUrl: 'https://missing-credential.invalid/v1' };
  const request = { ...input(), repeats: 1, control: { id: 'missing', model: target }, candidates: [{ id: 'later', model: target }] };
  const record = await runExperiment(fixtureRepo, request, { env: { FLOWMATE_EVAL_AGENT_MODEL: target.model,
    FLOWMATE_EVAL_AGENT_API: target.api, FLOWMATE_EVAL_AGENT_BASE_URL: 'https://default-provider.invalid/v1', FLOWMATE_EVAL_AGENT_API_KEY: 'synthetic-default-private-key' },
    loadBenchmark: () => [pureDataset()], agentCredentials: [], fetcher: async () => { metadata++; throw Error('Must not send the default secret'); },
    run: async () => { runs++; return []; } });
  expect(record.status).toBe('blocked'); expect(record.arms[0]?.reason).toContain('credential');
  expect(runs).toBe(0); expect(metadata).toBe(0); expect(JSON.stringify(record)).not.toContain('synthetic-default-private-key');
});

test('the explicit DeepSeek control uses its own dotenv credential while Luna remains the default Subject', async () => {
  const configs = join(fixtureRepo, 'agent-eval/configs'); mkdirSync(configs, { recursive: true });
  const envFile = join(configs, '.env'), previous = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const control = { model: 'deepseek-flash', api: 'anthropic-messages' as const, baseUrl: 'https://api.deepseek.com/anthropic' };
  const luna = { model: 'gpt-6-luna', api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:8767/v1', reasoning: 'max' as const };
  const keys: string[] = [], metadataKeys: string[] = [];
  try {
    writeFileSync(envFile, ['FLOWMATE_EVAL_AGENT_MODEL=gpt-6-luna', 'FLOWMATE_EVAL_AGENT_API=openai-completions',
      'FLOWMATE_EVAL_AGENT_BASE_URL=http://127.0.0.1:8767/v1', 'FLOWMATE_EVAL_AGENT_REASONING_EFFORT=max',
      'FLOWMATE_EVAL_DEEPSEEK_API_KEY=synthetic-dedicated-deepseek-key'].join('\n'));
    const record = await runExperiment(fixtureRepo, { ...input(), repeats: 1, control: { id: 'deepseek', model: control },
      candidates: [{ id: 'luna', model: luna }] }, { env: {}, loadBenchmark: () => [pureDataset()],
      fetcher: async (url, init) => {
        expect(url).toBe('https://api.deepseek.com/models');
        metadataKeys.push(new Headers(init.headers).get('authorization')!);
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', owned_by: 'deepseek', context_window: 1048576,
          max_output_tokens: 32768, effort: { supported_levels: ['high'] } }] }), { status: 200 });
      }, run: async (_repo, options, deps) => {
        keys.push(deps!.preparedAgent!.apiKey);
        expect(options.config?.model).toBe(deps!.preparedAgent!.configuration.model);
        const report = reportFixture(); report.executionId = 'control-role-' + keys.length;
        return [{ report, file: 'controlled-report.json', stopped: false }];
      } });
    expect(record.status).toBe('complete');
    expect(keys).toEqual(['synthetic-dedicated-deepseek-key', 'flowmate-local-no-auth']);
    expect(metadataKeys).toEqual(['Bearer synthetic-dedicated-deepseek-key']);
    expect(JSON.stringify(record)).not.toContain('synthetic-dedicated-deepseek-key');
  } finally { writeFileSync(envFile, previous); }
}, 60000);

test('the DeepSeek control credential cannot be forwarded to a different endpoint or candidate arm', async () => {
  for (const candidate of [false, true]) {
    let calls = 0;
    const endpoint = { model: 'deepseek-flash', api: 'anthropic-messages' as const,
      baseUrl: candidate ? 'https://api.deepseek.com/anthropic' : 'https://unverified.invalid/anthropic' };
    const model = { model: 'gpt-6-luna', api: 'openai-completions' as const, baseUrl: 'http://127.0.0.1:8767/v1', reasoning: 'max' as const };
    const record = await runExperiment(fixtureRepo, { ...input(), repeats: 1,
      control: { id: 'control', model: candidate ? model : endpoint }, candidates: [{ id: 'candidate', model: endpoint }] }, {
      env: { FLOWMATE_EVAL_AGENT_MODEL: model.model, FLOWMATE_EVAL_AGENT_API: model.api, FLOWMATE_EVAL_AGENT_BASE_URL: model.baseUrl,
        FLOWMATE_EVAL_DEEPSEEK_API_KEY: 'synthetic-control-only-key' }, loadBenchmark: () => [pureDataset()],
      fetcher: async () => { throw Error('A control-only key must not be sent'); },
      run: async () => { calls++; return [{ report: reportFixture(), file: 'controlled.json', stopped: false }]; },
    });
    expect(record.status).toBe('blocked'); expect(calls).toBe(candidate ? 1 : 0);
    expect(record.arms[candidate ? 1 : 0]?.reason).toContain('FLOWMATE_EVAL_AGENT_API_KEY');
  }
}, 30000);
test('default runExperiment uses real Runner and persists both arms and three original repetitions',async()=>{
  let calls=0;const prompts:string[]=[];
  const kernel:AgentKernel={readiness:()=>({ready:true,reason:'synthetic provider only'}),async prepare(trial){
    calls++;prompts.push(trial.input.prompt);const result=observed();result.identity=trial.identity;result.input=trial.input;
    result.evidence.environment!.actual={...trial.identity,fresh:true};result.evidence['input-projection']!.actual=trial.input;
    return {input:trial.input,async execute(){return result;},async snapshot(){return result;},async cancel(){},
      async close(){return {present:true,actual:{closed:true,stopped:true},source:'synthetic-provider'};}};
  }};
  const request=input();const record=await runExperiment(fixtureRepo,request,{kernel,env:{},loadBenchmark:()=>[pureDataset()]});
  expect(record.status).toBe('complete');expect(calls).toBe(6);expect(new Set(prompts).size).toBe(1);
  expect(record.arms.every(arm=>arm.executionIds.length===1)).toBe(true);
  expect(listExperiments(fixtureRepo).some(item=>item.id===record.id)).toBe(true);
  expect(readArchivePart(archiveReference(findArchive(fixtureRepo,record.id),'experiment'))).toEqual(record);
  // This fixture repository has no captured product source: execution facts are preserved, but cannot form a baseline.
  expect(compareExperiment(fixtureRepo,record.id)[0]!.status).toBe('blocked');
  expect(()=>createBaseline(fixtureRepo,{experimentId:record.id,armId:'control'})).toThrow('Baseline requires');
  const gate=checkGate(fixtureRepo,{baselineId:'missing',experimentId:record.id,armId:'candidate',fullRelease:true});
  expect(gate.status).toBe('blocked');expect(gate.exitCode).toBe(2);expect(gate.fullRelease).toBe(false);
},30000);
test('cancelled experiments preserve started execution identities and block pending arms',async()=>{
  const controller=new AbortController(),request=input();let calls=0;
  const record=await runExperiment(fixtureRepo,request,{env:{},signal:controller.signal,loadBenchmark:()=>[pureDataset()],
    run:async(_repo,_options,deps)=>{calls++;deps?.onProgress?.({type:'dataset-start',datasetId:'facility-test',executionId:'captured-before-cancel',reportPath:'report.json'});
      controller.abort();return [];}});
  expect(calls).toBe(1);expect(record.status).toBe('stopped');expect(record.arms[0]!.executionIds).toEqual(['captured-before-cancel']);
  expect(record.arms[1]!.status).toBe('pending');expect(compareExperiment(fixtureRepo,record.id)[0]!.status).toBe('blocked');
});
test('unsupported code refs block before any Runner call and never silently run the current source',async()=>{
  const request={...input(),axes:['code'],control:{id:'control',codeRef:'definitely-missing-ref'},candidates:[{id:'candidate',codeRef:'HEAD'}]};let calls=0;
  const record=await runExperiment(fixtureRepo,request,{env:{},loadBenchmark:()=>[pureDataset()],run:async()=>{calls++;return [];}});
  expect(record.status).toBe('blocked');expect(calls).toBe(0);expect(record.arms[0]!.reason).toContain('rev-parse');
});
test('supplied Git refs execute their isolated runtime snapshots and an explicit baseline survives readback',async()=>{
  const git=(args:string[])=>execFileSync('git',['-C',fixtureRepo,...args],{encoding:'utf8',windowsHide:true}).trim();
  mkdirSync(join(fixtureRepo,'apps/host'),{recursive:true});
  const source=join(fixtureRepo,'apps/host/main.ts');
  const commit=(text:string)=>{
    writeFileSync(source,text);git(['add','--','apps/host/main.ts']);
    git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','synthetic runtime']);
    return git(['rev-parse','HEAD']);
  };
  const control=commit('export const runtime = "control";'),candidate=commit('export const runtime = "candidate";');
  const data=pureDataset(),request={...input(),repeats:1,axes:['code'],
    control:{id:'control',codeRef:control},candidates:[{id:'candidate',codeRef:candidate}]};
  let activeRuntime='',builds=0;const observedSources:string[]=[];
  const kernel:AgentKernel={readiness:()=>({ready:true,reason:'synthetic provider'}),async prepare(trial){
    observedSources.push(readFileSync(join(activeRuntime,'apps/host/main.ts'),'utf8'));
    const result=observed();result.identity=trial.identity;result.input=trial.input;
    result.evidence.environment!.actual={...trial.identity,fresh:true};result.evidence['input-projection']!.actual=trial.input;
    return{input:trial.input,async execute(){return result;},async snapshot(){return result;},async cancel(){},
      async close(){return{present:true,actual:{closed:true,stopped:true},source:'synthetic-provider'};}};
  }};
  const record=await runExperiment(fixtureRepo,request,{env:{},kernel,loadBenchmark:()=>[data],prepareRuntime:async(repo,ref,output)=>{
    builds++;execFileSync('git',['-C',repo,'worktree','add','--detach',output,ref],{windowsHide:true,stdio:'pipe'});activeRuntime=output;
    return{runtime:{mode:'development',repository:output},cleanup(){execFileSync('git',['-C',repo,'worktree','remove','--force',output],{windowsHide:true,stdio:'pipe'});}};
  }});
  expect(record.status).toBe('complete');expect(builds).toBe(2);
  expect(observedSources).toEqual(['export const runtime = "control";','export const runtime = "candidate";']);
  expect(readFileSync(source,'utf8')).toBe('export const runtime = "candidate";');
  expect(record.arms.every(arm=>!existsSync(arm.runtimeRepository!))).toBe(true);
  expect(compareExperiment(fixtureRepo,record.id)[0]!.status).toBe('comparable');
  const baseline=createBaseline(fixtureRepo,{experimentId:record.id,armId:'control',baselineId:'measured-'+randomUUID()});
  expect(listBaselines(fixtureRepo).find(item=>item.id===baseline.id)?.executionIds).toEqual(record.arms[0]!.executionIds);
  expect(()=>createBaseline(fixtureRepo,{experimentId:record.id,armId:'control',baselineId:baseline.id})).toThrow('already exists');
  expect(checkGate(fixtureRepo,{baselineId:baseline.id,experimentId:record.id,armId:'candidate'}).status).toBe('pass');
  const worktreesBefore=git(['worktree','list','--porcelain']);let providerCalls=0;
  const blocked=await runExperiment(fixtureRepo,{...request,id:'experiment-'+randomUUID()},
    {env:{},loadBenchmark:()=>[data],run:async()=>{providerCalls++;return[];}});
  expect(blocked.status).toBe('blocked');expect(blocked.arms[0]!.reason).toContain('pinned dependencies');
  expect(providerCalls).toBe(0);expect(git(['worktree','list','--porcelain'])).toBe(worktreesBefore);
},60000);
test('a fully measured known Agent failure can be explicitly selected as a baseline',async()=>{
  const data=pureDataset();data.cases[0]!.expected.checks=[{metric:'fact-check',required:true,evidence:'task-facts',path:['saved'],equals:false}];
  const kernel:AgentKernel={readiness:()=>({ready:true,reason:'synthetic provider'}),async prepare(trial){
    const result=observed();result.identity=trial.identity;result.input=trial.input;
    result.evidence.environment!.actual={...trial.identity,fresh:true};result.evidence['input-projection']!.actual=trial.input;
    return{input:trial.input,async execute(){return result;},async snapshot(){return result;},async cancel(){},
      async close(){return{present:true,actual:{closed:true,stopped:true},source:'synthetic-provider'};}};
  }};
  const record=await runExperiment(fixtureRepo,{...input(),repeats:1},{env:{},kernel,loadBenchmark:()=>[data]});
  expect(record.status).toBe('complete');
  const baseline=createBaseline(fixtureRepo,{experimentId:record.id,armId:'control'});
  expect(baseline.executionIds).toEqual(record.arms[0]!.executionIds);
  // The known failure is a valid reference; regression acceptance still requires every required assertion to pass.
  expect(checkGate(fixtureRepo,{baselineId:baseline.id,experimentId:record.id,armId:'candidate'}).status).toBe('fail');
},30000);
