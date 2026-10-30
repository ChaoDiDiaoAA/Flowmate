import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCurationService } from '../../src/curation/index.ts';
import { runExperiment, createBaseline, compareExperiment } from '../../src/experiments/index.ts';
import { readReport, reportPath, saveReport, inspectReport, readReportMetadata } from '../../src/reports/store.ts';
import { readArchive, readSnapshot } from '../../src/reports/archive.ts';
import { publicVersions, executionVersions, acquireEvaluationWrite } from '../../src/reports/files.ts';
import { addFeedback, readFeedbackRecords } from '../../src/review/local.ts';
import { exportEvents } from '../../src/langfuse/export.ts';
import type { AgentKernel } from '../../src/adapters/agent.ts';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function publishedV2(){
  const root=mkdtempSync(join(tmpdir(),'eval-data-version-'));roots.push(root);
  mkdirSync(join(root,'apps/host'),{recursive:true});writeFileSync(join(root,'apps/host/main.ts'),'export const fixture = "versioned-source";');
  execFileSync('git',['init','-q',root]);
  execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','synthetic']);
  const service=createCurationService(root),id=randomUUID();
  const trace:TraceBundle={id,revision:1,source:{kind:'product'},entry:'chats',startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z',
    input:{prompt:'Return the independent source value.'},output:{answer:'wrong'},status:'FAIL',complete:true,gaps:[],events:[],facts:{},configuration:{},
    materials:[{id:'source',path:'references/answer.md',text:'Independent source: correct-v1 correct-v2.'}]};
  service.saveTrace(trace);
  for(const version of [1,2]){
    const answer='correct-v'+version;
    const candidate=service.saveCandidate({id:randomUUID(),revision:1,kind:'regression',traceRef:{id,revision:1},reason:'Correct an independently verified source value.',sourceLabels:['independent-source'],
      ...(version===2?{reviseCase:{id:'FM-063',version:1}}:{}),
      case:{name:'task_versioned_source_value',category:'task',difficulty:'regression',purpose:'regression',source:'regression-bug',input:trace.input,
        expected:{success:['Return the source value.'],failure:['Return an incorrect value.'],maxToolCalls:0,mustHaveEvidence:false,expectedAnswerHint:answer},
        scoring:{deterministic:['fact-check'],judge:[],manual:'Human approval'},risks:['Controlled Q&A'],tags:['business']},
      gold:{values:{},checks:[{metric:'fact-check',required:true,evidence:'answer',path:[],equals:answer}],opportunities:{'task-success':1},sources:['references/answer.md'],basis:'Independent source'},
      scenario:{requires:['agent'],materials:[],steps:[{id:'request',action:'user-message',instruction:'$input'}],selection:{enabledSkills:[],enabledExtensions:[]}},
      bindings:[{materialId:'source',quote:answer,label:'Requirement',target:{kind:'success',text:'Return the source value.'}},
        {materialId:'source',quote:answer,label:'Answer',target:{kind:'answer',text:answer}}],
      controls:{negative:{label:'Original wrong answer',evidence:{answer:{present:true,actual:'wrong',source:'Original Trace'}}},
        positive:{label:'Independent answer',evidence:{answer:{present:true,actual:answer,source:'Independent source'}}}},
      controlBindings:[{control:'negative',evidence:'answer',path:[],source:{kind:'trace',path:['output','answer']}},
        {control:'positive',evidence:'answer',path:[],source:{kind:'material',materialId:'source',quote:answer}}]});
    expect((await service.validateCandidate(candidate.id,{expectedRevision:1})).status).toBe('PASS');
    const approval=service.addFeedback({operationId:randomUUID(),target:{kind:'candidate-review',id:candidate.id,revision:1},reviewer:'Human',source:'human',verdict:'approve',note:'Verified this source version.'});
    service.publish({operationId:randomUUID(),benchmarkId:'versioned-benchmark',candidateIds:[candidate.id],approvals:[approval.id]});
  }
  return root;
}
const kernel:AgentKernel={readiness:()=>({ready:true,reason:'Controlled version roundtrip'}),async prepare(trial){
  const answer='correct-v2';const result={identity:trial.identity,started:true,status:'completed' as const,endpointReached:true,input:trial.input,answer,artifacts:[],observations:[],configuration:trial.configuration,
    usage:{},startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z',evidence:{
      answer:{present:true,actual:answer,source:'Controlled provider'},'task-endpoint':{present:true,actual:true,source:'Controlled endpoint'},
      'input-projection':{present:true,actual:trial.input,source:'Original input boundary'},environment:{present:true,actual:{...trial.identity,fresh:true},source:'Owned environment'},
      runs:{present:true,actual:[{runId:1,sessionId:1,kind:'agent'}],source:'Original controlled root Run'},
      'tool-evidence':{present:true,actual:{calls:[]},source:'Complete original controlled tool journal'},
      'redaction-scan':{present:true,actual:{leaked:false},source:'Scanner'}}};
  return{input:trial.input,async execute(){return result;},async snapshot(){return result;},async cancel(){},
    async close(){return{present:true,actual:{closed:true,stopped:true},source:'Controlled process cleanup'};}};
}};
test('published Case v2 and Benchmark revision 2 survive actual Runner persistence, feedback, export and explicit baseline comparison',async()=>{
  const root=await publishedV2(),record=await runExperiment(root,{benchmark:{id:'versioned-benchmark',revision:2,selection:'full'},
    repeats:1,axes:['model'],control:{id:'control'},candidates:[{id:'candidate'}]},{kernel,env:{}});
  expect(record.status).toBe('complete');
  const file=reportPath(root,record.arms[0]!.executionIds[0]!),stored=readArchive(file).executions[record.arms[0]!.executionIds[0]!] as { dataset: { version: number }; trials: Array<{ caseVersion: number }> };
  expect(stored.dataset.version).toBe(2);expect(stored.trials[0]!.caseVersion).toBe(2);
  const report=readReport(file),trial=report.trials[0]!;
  expect(report.dataset.version).toBe(2);expect(trial.caseVersion).toBe(2);expect(trial.execution!.identity.caseVersion).toBe(2);
  expect(readReportMetadata(file).metadata.dataset.version).toBe(2);expect(inspectReport(file).gaps).toEqual([]);
  const snapshot=readSnapshot(file);
  expect(snapshot.published.revision).toBe(2);expect(snapshot.gold['FM-063'].version).toBe(2);
  const baselineId='baseline-'+randomUUID(),baselineFile=join(root,'agent-eval/baselines.json');
  const release=acquireEvaluationWrite(baselineFile);
  try{expect(()=>createBaseline(root,{experimentId:record.id,armId:'control',baselineId})).toThrow('write conflict');}
  finally{release();}
  const baseline=createBaseline(root,{experimentId:record.id,armId:'control',baselineId});
  const baselineBytes=readFileSync(baselineFile,'utf8');
  expect(()=>createBaseline(root,{experimentId:record.id,armId:'control',baselineId})).toThrow('already exists');
  expect(readFileSync(baselineFile,'utf8')).toBe(baselineBytes);
  expect(baseline.conditions[0]).toMatchObject({dataset:{version:2}});expect(compareExperiment(root,record.id)[0]!.status).toBe('comparable');
  addFeedback(root,{executionId:report.executionId,caseId:trial.caseId,trialId:trial.trialId,reviewer:'Human',verdict:'good',note:'Verified v2.'});
  expect(readFeedbackRecords(root,report.executionId)[0]!.caseVersion).toBe(2);
  const trace=exportEvents(report).find(event=>event.type==='trace-create')!;
  expect(trace.body.metadata).toMatchObject({dataset:{version:'v2'},caseVersion:'v2'});
  const pending=structuredClone(report),directory=join(root,'pending');mkdirSync(directory);
  pending.executionId='pending-'+randomUUID();pending.executionComplete=false;pending.scoring='pending';pending.endedAt=null;
  delete pending.trialStatistics;
  pending.trials[0]!.execution=null;pending.trials[0]!.scores=[];pending.trials[0]!.status='NOT_RUN';pending.trials[0]!.counts={};
  const pendingFile=join(directory,'report.json');saveReport(pendingFile,pending);
  expect(JSON.parse(readFileSync(join(directory,'evidence',trial.trialId,'trial.json'),'utf8')).identity.caseVersion).toBe('v2');
  expect(readReport(pendingFile).trials[0]!.caseVersion).toBe(2);
},30000);
test('data version encoding preserves explicit safe positive versions and leaves protocols and opaque product facts compatible',()=>{
  const product={version:7,caseVersion:8,contract:'product/v9',input:{caseVersion:10}};
  const source={dataset:{id:'published',version:2},caseVersion:3,scoringVersion:4,rubricVersion:5,protocolVersion:'flowmate-judge/v2',
    contract:'flowmate-agent-run/v2',actual:product,configuration:product};
  const wire=publicVersions(source);expect(wire).toMatchObject({dataset:{version:'v2'},caseVersion:'v3',scoringVersion:'v4',rubricVersion:'v5',protocolVersion:'flowmate-judge/v1',contract:'flowmate-agent-run/v1'});
  expect(wire.actual).toEqual(product);expect(wire.configuration).toEqual(product);
  const decoded=executionVersions(wire);expect(decoded).toMatchObject({dataset:{version:2},caseVersion:3,scoringVersion:4,rubricVersion:5,protocolVersion:'flowmate-judge/v2'});
  for(const version of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])expect(()=>publicVersions({caseVersion:version})).toThrow();
  for(const version of ['v0','v01','v-1','v1.2','v1e2','v9007199254740992'])expect(()=>executionVersions({caseVersion:version})).toThrow();
  expect(executionVersions({caseVersion:'v1'})).toEqual({caseVersion:1});
});
