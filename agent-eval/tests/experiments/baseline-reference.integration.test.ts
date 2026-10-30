import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBaseline, checkGate, listBaselines, experimentPlanSchema } from '../../src/experiments/index.ts';
import { criticalMetrics } from '../../src/experiments/compare.ts';
import { saveReport, readReport, reportPath, type LocalReport } from '../../src/reports/store.ts';
import { createArchive, archiveReference, readArchivePart, writeArchivePart } from '../../src/reports/archive.ts';
import { EvaluationWorkflowResultSchema } from '../../../packages/contracts/src/evaluation-workflow.ts';
import { createWorkflowRecordReader } from '../../src/desktop/workflow-records.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(values=[1],candidateValues=values,failed=false,options:{metricId?:string;regression?:boolean;candidateFailed?:boolean;calibration?:boolean}={}){
  const repo=mkdtempSync(join(tmpdir(),'baseline-reference-'));roots.push(repo);
  const experimentId='experiment-'+randomUUID(),plan=experimentPlanSchema.parse({id:experimentId,benchmark:{id:'reference-fixture',revision:1,selection:'full'},
    repeats:values.length,axes:['model'],control:{id:'control'},candidates:[{id:'candidate'}]});
  const ids=['control-'+randomUUID(),'candidate-'+randomUUID()];
  const archive=createArchive(repo,{selection:'full',compare:true});
  for(const [index,executionId]of ids.entries()){
    const own=index?candidateValues:values;
    const trialFailed=index?(options.candidateFailed??failed):failed;
    const report:LocalReport={contract:'flowmate-agent-run/v1',executionId,executionKind:'controlled',dataset:{id:'reference-fixture',version:1,subject:'agent'},
      selection:'full',environment:'development',startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z',repeat:values.length,
      executionComplete:true,scoring:'complete',manualReview:'none',formalAcceptance:'not-assessed',scoringConfiguration:{version:1,judgeMode:'off'},export:{backend:'local',status:'disabled'},
      trials:own.map((value,i)=>({caseId:'sample',caseVersion:1,caseName:'Sample',category:'task',caseConditions:{task:{id:'sample',version:1}},purpose:options.regression?'regression':'capability',
        partition:'smoke',repetition:i+1,trialId:executionId+'-trial-'+(i+1),traceId:randomUUID().replaceAll('-',''),status:trialFailed?'FAIL':'PASS',reason:'Controlled original outcome',
        counts:{},scores:[{metricId:'task-result',name:'Task result',version:1,method:'deterministic',required:true,value:trialFailed?0:1,status:trialFailed?'FAIL':'PASS',reason:'Controlled result',evidence:['task-endpoint']},
          {metricId:options.metricId??'tool-selection',name:'Tool selection',version:1,method:'deterministic',required:false,value,status:'PASS',reason:'Controlled quality ratio',evidence:['tool-evidence'],
            statistics:{unit:'opportunity',numerator:Math.round(value*1000),denominator:1000,missing:0}}],judgeCalls:[],feedback:'none',
        execution:{identity:{executionId,trialId:executionId+'-trial-'+(i+1),caseId:'sample',caseVersion:1},started:true,status:'completed',endpointReached:!trialFailed,
          input:{prompt:'Controlled original input',materials:[]},answer:'Controlled original answer',artifacts:[],observations:[],evidence:{'task-endpoint':{present:true,actual:!trialFailed,source:'Controlled endpoint'}},
          configuration:{environment:'development'},usage:{},startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z'}}))};
    if(options.calibration)for(const trial of report.trials)for(const score of trial.scores)if(score.metricId==='tool-selection'){
      score.calibration={state:'not-provided',reason:'No real calibration supplied',metricIds:[score.metricId],reference:null,kind:null,acceptance:'not-assessed'};
    }
    saveReport(archiveReference(archive.file,'executions',executionId),report);
    writeArchivePart(archiveReference(archive.file,'snapshots',executionId),{configuration:{environment:'development'},cases:[{id:'sample'}],scoring:{version:1},
      runtimeSource:{contract:'flowmate-execution-source/v1',runtime:{node:'controlled',platform:'controlled',arch:'controlled'},dependencies:{},files:[{path:'apps/host/main.ts',text:'controlled source'}]}});
  }
  writeArchivePart(archiveReference(archive.file,'experiment'),{contract:'flowmate-experiment/v1',id:experimentId,createdAt:'2026-10-28T00:00:00Z',plan,
    attribution:'single-axis',status:'complete',arms:[{id:'control',status:'complete',executionIds:[ids[0]]},{id:'candidate',status:'complete',executionIds:[ids[1]]}]});
  return{repo,experimentId,control:ids[0]!,baselineId:'baseline-'+randomUUID()};
}

test('Baseline measurements accept Score calibration provenance without duplicating it outside the original Run',()=>{
  const input=fixture([1],[1],false,{calibration:true}),baseline=createBaseline(input.repo,{...input,armId:'control'});
  expect(baseline.reference?.measurements[0]?.scores.some(score=>score.metricId==='tool-selection')).toBe(true);
  const original=readReport(reportPath(input.repo,input.control));
  expect(original.trials[0]!.scores.find(score=>score.metricId==='tool-selection')?.calibration?.state).toBe('not-provided');
  expect(checkGate(input.repo,{...input,armId:'candidate'}).status).toBe('pass');
});
test('explicit Baseline saves measured reference metrics, required assertions, original rows and the decision thresholds',()=>{
  const input=fixture(),baseline=createBaseline(input.repo,{...input,armId:'control'});
  expect(baseline.reference?.metrics.find(metric=>metric.metricId==='tool-selection')).toMatchObject({before:1,after:1});
  expect(baseline.reference?.assertions.find(assertion=>assertion.metricId==='task-result')).toMatchObject({before:1,after:1,repeats:1});
  expect(baseline.reference?.measurements[0]).toMatchObject({executionId:input.control,status:'PASS',repetition:1});
  expect(JSON.stringify(baseline.reference?.measurements)).not.toMatch(/"(?:actual|expected|request|input|output)":/);
  expect(baseline.thresholds).toMatchObject({requiredAssertionPassDecline:0,regressionPasses:'all-applicable',actualLeakageMaximum:0,forbiddenSideEffectsMaximum:0});
  expect(baseline.thresholds?.metricDeclines.find(metric=>metric.metricId==='task-success')?.maximumAbsoluteDecline).toBe(0);
  expect(baseline.thresholds?.metricDeclines.find(metric=>metric.metricId==='tool-selection')?.maximumAbsoluteDecline).toBe(0.02);
  const result=EvaluationWorkflowResultSchema.parse({action:'baseline.create',exitCode:0,data:{baseline}});
  expect(result.action).toBe('baseline.create');
  expect(checkGate(input.repo,{...input,armId:'candidate'}).status).toBe('pass');
});
test('changed original scores block even if conditions, aggregate ratios and required passing counts still match',()=>{
  const input=fixture([1,0.9]);createBaseline(input.repo,{...input,armId:'control'});
  const file=reportPath(input.repo,input.control),raw=readArchivePart(file);
  const first=raw.trials[0].scores.find((score:{metricId:string})=>score.metricId==='tool-selection');
  const second=raw.trials[1].scores.find((score:{metricId:string})=>score.metricId==='tool-selection');
  [first.value,second.value]=[second.value,first.value];[first.statistics,second.statistics]=[second.statistics,first.statistics];
  writeArchivePart(file,raw);expect(readReport(file).trials).toHaveLength(2);
  const gate=checkGate(input.repo,{...input,armId:'candidate'});
  expect(gate.status).toBe('blocked');expect(gate.reasons.some(reason=>reason.message.includes('reference measurements changed'))).toBe(true);
});
test('saved thresholds remain authoritative when a later default classifies the metric more strictly',()=>{
  const input=fixture([1],[0.98]),baseline=createBaseline(input.repo,{...input,armId:'control'}),size=criticalMetrics.length;
  try{
    criticalMetrics.push('tool-selection');
    const gate=checkGate(input.repo,{...input,armId:'candidate'});
    expect(gate.status).toBe('pass');expect(gate.deltas.find(metric=>metric.metricId==='tool-selection')?.threshold).toBe(0.02);
    expect(listBaselines(input.repo)[0]!.thresholds).toEqual(baseline.thresholds);
  }finally{criticalMetrics.splice(size);}
});
test('old baselines missing a reference or thresholds remain readable and unchanged but cannot produce a passing Gate',()=>{
  for(const field of ['reference','thresholds']){
    const input=fixture(),baseline=createBaseline(input.repo,{...input,armId:'control'});
    const file=join(input.repo,'agent-eval/baselines.json'),raw=JSON.parse(readFileSync(file,'utf8'));delete raw.records[0][field];writeFileSync(file,JSON.stringify(raw));
    const bytes=readFileSync(file,'utf8');expect(listBaselines(input.repo)).toHaveLength(1);
    expect(EvaluationWorkflowResultSchema.parse({action:'baseline.list',exitCode:0,data:{items:listBaselines(input.repo)}}).action).toBe('baseline.list');
    const gate=checkGate(input.repo,{...input,armId:'candidate'});
    expect(gate.status).toBe('blocked');expect(gate.reasons.some(reason=>reason.message.includes('reference metrics and thresholds'))).toBe(true);
    expect(readFileSync(file,'utf8')).toBe(bytes);
  }
});
test('an incomplete saved threshold table blocks instead of falling back to current defaults',()=>{
  const input=fixture(),baseline=createBaseline(input.repo,{...input,armId:'control'});
  const file=join(input.repo,'agent-eval/baselines.json'),raw=JSON.parse(readFileSync(file,'utf8'));
  raw.records[0].thresholds.metricDeclines=[];writeFileSync(file,JSON.stringify(raw));
  const gate=checkGate(input.repo,{...input,armId:'candidate'});
  expect(gate.status).toBe('blocked');expect(gate.reasons.some(reason=>reason.code==='threshold-unavailable')).toBe(true);
});
test('a complete measured known Agent FAIL remains eligible for explicit Baseline creation',()=>{
  const input=fixture([1],[1],true),baseline=createBaseline(input.repo,{...input,armId:'control'});
  expect(baseline.reference?.measurements[0]!.status).toBe('FAIL');expect(baseline.reference?.assertions.find(a=>a.metricId==='task-result')?.before).toBe(0);
});
test('desktop Baseline projection keeps bounded counts instead of copying reference measurement arrays',async()=>{
  const input=fixture(),baseline=createBaseline(input.repo,{...input,armId:'control'});
  baseline.reference!.measurements=Array.from({length:2000},(_,i)=>({...baseline.reference!.measurements[0]!,trialId:'large-trial-'+i}));
  const original=JSON.stringify({contract:'flowmate-baselines/v1',records:[baseline]});expect(Buffer.byteLength(original)).toBeGreaterThan(512*1024);
  const file=join(input.repo,'agent-eval/baselines.json');writeFileSync(file,original);
  const reader=createWorkflowRecordReader(input.repo);
  const response=await reader.project(EvaluationWorkflowResultSchema.parse({action:'baseline.create',exitCode:0,data:{baseline}}),{action:'baseline.create',experimentId:input.experimentId,armId:'control'});
  if(response.action!=='baseline.create')throw Error('Wrong workflow result');
  expect(response.data.baseline).toMatchObject({projection:'summary',referenceSummary:{metricCount:3,assertionCount:2,measurementCount:2000}});
  expect('reference'in response.data.baseline).toBe(false);expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(512*1024);
  expect(readFileSync(file,'utf8')).toBe(original);
});
test('persisted Gate policy retains inclusive 2pp, critical zero decline, regression all-pass and safety zero guarantees',()=>{
  for(const [before,after,metricId,status]of [[1,0.98,'tool-selection','pass'],[1,0.979,'tool-selection','fail'],
    [1,0.999,'reference-fields','fail'],[0,0.001,'actual-leakage','fail']] as const){
    const input=fixture([before],[after],false,{metricId});createBaseline(input.repo,{...input,armId:'control'});
    expect(checkGate(input.repo,{...input,armId:'candidate'}).status).toBe(status);
  }
  const regression=fixture([1],[1],false,{regression:true,candidateFailed:true});createBaseline(regression.repo,{...regression,armId:'control'});
  const gate=checkGate(regression.repo,{...regression,armId:'candidate'});
  expect(gate.status).toBe('fail');expect(gate.reasons.some(reason=>reason.code==='published-regression-failed')).toBe(true);
});
