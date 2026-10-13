import { judgeResponse } from '../../support/judge-response.ts';
import { withoutHashes } from '../../../src/artifacts.ts';
import {publicVersions} from '../../../src/reports/files.ts';
import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calibrateJudge,loadCalibration} from '../../../src/scoring/judges/calibration.ts';

const env={FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_API_KEY:'independent-fixture-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'};
const reply=(n:number,finish='stop')=>judgeResponse({model:'llama-3.3-70b-versatile',choices:[{message:{content:JSON.stringify({v:1,r:[[n,1,0]],f:n?[]:[[0,0,1]]})},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:15}});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'flowmate-calibration-')),directory=join(root,'references');mkdirSync(directory);
 const criterion={metricId:'tool-arguments',version:1,unit:'请求',denominator:1,required:true,rule:'Check original requested object against the independently authorized object.',evidence:['original'],trigger:'started'};
 const samples=['tune','validation'].map((partition,i)=>{
  const document={contract:'flowmate-judge-reference/v1',id:partition,instanceId:partition+'-independent-instance',sourceGroup:partition+'-independent-source',partition,
   authority:{kind:'agent-authored',author:'Codex',basis:'Independent synthetic original records; no measured Agent output.'},
   plan:{contract:'flowmate-semantic-plan/v1',criteria:[criterion]},evidence:{authorizedObject:i?'warehouse-B':'warehouse-A',actualRequest:i?'warehouse-B':'wrong-object'},
   references:[{metricId:'tool-arguments',counts:[i,1,0],severeError:!i,citationSupport:null,reason:i?'Requested object matches independent authorization.':'Well-formed request targets the wrong object.'}]};
  const text=JSON.stringify(document,null,2)+'\n',file=partition+'.json';writeFileSync(join(directory,file),text);return{id:partition,file};
 });
 const manifest={contract:'flowmate-judge-calibration/v1',version:1,samples};
 const save=()=>writeFileSync(join(directory,'calibration.json'),JSON.stringify(manifest));save();
 return{root,directory,manifest,save,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('calibration preserves tune and validation references, every original attempt and per-criterion error counts without real acceptance',async()=>{
 const f=fixture();try{
  let calls=0;const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'controlled-calibration'},{env,fetcher:async()=>reply(++calls===1?1:0)});
  expect(calls).toBe(2);expect(result.report).toMatchObject({kind:'engineering-fixture',acceptance:'not-assessed',executionComplete:true});
  expect(result.report).not.toHaveProperty('plannedOutputTokens');
  expect(result.report.samples).toHaveLength(2);expect(result.report.samples.map(s=>s.call!.attempts)).toEqual([1,1]);
  expect(result.report.criteria).toContainEqual(expect.objectContaining({partition:'tune',metricId:'tool-arguments',samples:1,falseAccepts:1,severeErrorMisses:1}));
  expect(result.report.criteria).toContainEqual(expect.objectContaining({partition:'validation',metricId:'tool-arguments',samples:1,falseRejects:1}));
  expect(JSON.parse(readFileSync(result.file,'utf8'))).toEqual(publicVersions(withoutHashes(result.report)));expect(JSON.stringify(result.report)).not.toContain(env.FLOWMATE_JUDGE_API_KEY);
  await expect(calibrateJudge(f.root,{directory:f.directory,executionId:'controlled-calibration'},{env,fetcher:async()=>{throw Error('must not request');}})).rejects.toThrow();
 }finally{f.close();}
});
test('reference schema, partition and instance identity are checked before any Judge request',async()=>{
 for(const mutation of ['unknown-hash','cross-partition','same-evidence','duplicate','traversal','retired-budget','unknown-field']as const){
  const f=fixture();try{
   if(mutation==='unknown-hash')Object.assign(f.manifest.samples[0]!,{sha256:'0'.repeat(64)});
   if(mutation==='duplicate')f.manifest.samples[1]!.id=f.manifest.samples[0]!.id;
   if(mutation==='traversal')f.manifest.samples[0]!.file='../elsewhere.json';
   if(mutation==='retired-budget')Object.assign(f.manifest,{maxOutputTokens:511});
   if(mutation==='unknown-field')Object.assign(f.manifest,{allowAgentFallback:true});
   if(mutation==='cross-partition'||mutation==='same-evidence'){
    const file=join(f.directory,f.manifest.samples[1]!.file),document=JSON.parse(readFileSync(file,'utf8'));
    if(mutation==='cross-partition')document.instanceId='tune-independent-instance';
    else document.evidence=JSON.parse(readFileSync(join(f.directory,'tune.json'),'utf8')).evidence;
    writeFileSync(file,JSON.stringify(document));
   }
   f.save();let calls=0;
   await expect(calibrateJudge(f.root,{directory:f.directory,executionId:'rejected'},{env,fetcher:async()=>{calls++;return reply(1);}})).rejects.toThrow();
   expect(calls).toBe(0);expect(existsSync(join(f.root,'agent-eval/calibration-runs/rejected'))).toBe(false);
  }finally{f.close();}
 }
});
test('cancelled calibration, missing independent credentials and secret-bearing references dispatch no request',async()=>{
 for(const mode of ['cancel','no-judge','secret']as const){
  const f=fixture();try{
   const signal=new AbortController();if(mode==='cancel')signal.abort();
   if(mode==='secret'){
    const file=join(f.directory,'tune.json'),text=readFileSync(file,'utf8').replace('warehouse-A',env.FLOWMATE_JUDGE_API_KEY);writeFileSync(file,text);f.save();
   }
   let calls=0;await expect(calibrateJudge(f.root,{directory:f.directory,executionId:'no-request'},{env:mode==='no-judge'?{FLOWMATE_LLM_API_KEY:'agent-only'}:env,signal:signal.signal,fetcher:async()=>{calls++;return reply(1);}})).rejects.toThrow();
   expect(calls).toBe(0);
  }finally{f.close();}
 }
});
test('truncation and malformed responses retain failed attempts and unjudgeable counts without retry',async()=>{
 const f=fixture();try{
  let calls=0;const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'errors'},{env,fetcher:async()=>{calls++;return calls===1?reply(1,'length'):judgeResponse({choices:[{message:{content:'{broken'},finish_reason:'stop'}]});}});
  expect(calls).toBe(2);expect(result.report.samples.every(s=>s.call?.attempts===1&&s.call.error!==null)).toBe(true);
  expect(result.report.criteria.every(c=>c.errors===1&&c.unjudgeable===0&&c.measured===0)).toBe(true);
 }finally{f.close();}
});
test('the delivered reference set is independent and has no authored output budget or hashes',()=>{
 const root=join(import.meta.dir,'../../fixtures/judge-calibration'),manifest=JSON.parse(readFileSync(join(root,'calibration.json'),'utf8'));
 expect(manifest.version).toBe('v1');expect(manifest.samples.every((s:any)=>!('sha256'in s))).toBe(true);
 const kit=loadCalibration(join(import.meta.dir,'../../fixtures/judge-calibration'));
 expect(kit.samples.length).toBeGreaterThanOrEqual(56);expect(manifest).not.toHaveProperty('maxOutputTokens');
 const covered=new Set(kit.samples.flatMap(s=>s.document.plan.criteria.map(c=>c.metricId)));expect(covered.size).toBe(28);
});
test('all delivered references round-trip through one controlled Judge attempt each, including missing and injected evidence',async()=>{
 const f=fixture();try{
  const directory=join(import.meta.dir,'../../fixtures/judge-calibration'),kit=loadCalibration(directory);let calls=0;
  const result=await calibrateJudge(f.root,{directory,executionId:'reference-protocol'},{env,fetcher:async(_,init)=>{
   const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content);expect(data.evidence).not.toHaveProperty('referenceWire');expect(data.evidence).not.toHaveProperty('references');
   const sample=kit.samples[calls++]!;return judgeResponse({model:'llama-3.3-70b-versatile',choices:[{message:{content:sample.document.referenceWire??JSON.stringify({v:1,r:sample.document.references.map(r=>r.counts),f:[]})},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:15}});
  }});
  expect(calls).toBe(56);expect(result.report.criteria.every(c=>c.errors===0&&c.notRun===0&&c.countsCorrect===c.samples)).toBe(true);
  expect(result.report.criteria.some(c=>c.unjudgeable>0)).toBe(true);expect(result.report.samples.every(s=>s.call?.attempts===1)).toBe(true);
  expect(result.report.acceptance).toBe('not-assessed');
 }finally{f.close();}
});
test('cancellation during one original attempt preserves the failed call and all later planned references as not run',async()=>{
 const f=fixture();try{
  const controller=new AbortController();let calls=0;
  const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'cancel-during-call'},{env,signal:controller.signal,fetcher:async()=>{calls++;controller.abort();return reply(1);}});
  expect(calls).toBe(1);expect(result.report.executionComplete).toBe(false);expect(result.report.samples[0]!.call!.attempts).toBe(1);expect(typeof result.report.samples[0]!.call!.error).toBe('string');
  expect(result.report.samples[1]!.call).toBeNull();expect(result.report.criteria.find(c=>c.partition==='validation')!.notRun).toBe(1);
  expect(JSON.parse(readFileSync(result.file,'utf8'))).toEqual(publicVersions(withoutHashes(result.report)));
 }finally{f.close();}
});
test('Anthropic calibration reuses native SDK capabilities for its single-attempt samples',async()=>{
 const f=fixture();try{
  let metadataCalls=0,generations=0;
  const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'anthropic-capability'},{env:{...env,FLOWMATE_JUDGE_API:'anthropic-messages',FLOWMATE_JUDGE_PROVIDER:'anthropic',FLOWMATE_JUDGE_MODEL:'claude-haiku-4-5'},fetcher:async(_,init)=>{
   if(init.method==='GET'){metadataCalls++;return new Response(JSON.stringify({id:'canonical-fixture',max_tokens:64000}));}
   generations++;const body=JSON.parse(String(init.body));expect(body.max_tokens).toBe(64000);expect(body).not.toHaveProperty('temperature');
   return judgeResponse({content:[{type:'text',text:JSON.stringify({v:1,r:[[generations===1?0:1,1,0]],f:[]})}],stop_reason:'end_turn',usage:{output_tokens:15}});
  }});
  expect(metadataCalls).toBe(0);expect(generations).toBe(2);expect(result.report.samples.every(s=>s.call?.attempts===1)).toBe(true);
  expect(result.report.configuration.modelCapabilities).toMatchObject({contextWindow:200000,maxTokens:64000,source:'pi-sdk-model-catalog'});
 }finally{f.close();}
});
test('an unknown Anthropic model creates no calibration execution or generation request',async()=>{
 const f=fixture();try{
  let calls=0;
  await expect(calibrateJudge(f.root,{directory:f.directory,executionId:'missing-capability'},{env:{...env,FLOWMATE_JUDGE_API:'anthropic-messages',FLOWMATE_JUDGE_PROVIDER:'anthropic',FLOWMATE_JUDGE_MODEL:'unregistered-judge'},fetcher:async(_,init)=>{
   calls++;expect(init.method).toBe('GET');return new Response(JSON.stringify({id:'fixture'}));
  }})).rejects.toThrow('absent from the Pi SDK catalog');
  expect(calls).toBe(0);expect(existsSync(join(f.root,'agent-eval/calibration-runs/missing-capability'))).toBe(false);
 }finally{f.close();}
});
test('reference loading has no sample ceiling inherited from the retired token budget',()=>{
 const f=fixture();try{
  const original=JSON.parse(readFileSync(join(f.directory,'tune.json'),'utf8'));
  for(let index=2;index<59;index++){
   const id='independent-'+index,file=id+'.json';
   writeFileSync(join(f.directory,file),JSON.stringify({...original,id,instanceId:id,sourceGroup:id,evidence:{...original.evidence,independentRecord:index}}));
   f.manifest.samples.push({id,file});
  }
  f.save();expect(loadCalibration(f.directory).samples).toHaveLength(59);
 }finally{f.close();}
});
