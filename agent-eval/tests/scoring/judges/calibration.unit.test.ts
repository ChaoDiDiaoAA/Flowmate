import { judgeResponse, namedJudgment } from '../../support/judge-response.ts';
import {publicVersions} from '../../../src/reports/files.ts';
import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {calibrateJudge,loadCalibration} from '../../../src/scoring/judges/calibration.ts';
import * as calibration from '../../../src/scoring/judges/calibration.ts';
import {runJudge,runCompactJudge} from '../../../src/scoring/judges/harness.ts';
import {judgeConfig,publicJudgeConfig, type NativeJudgeConfig} from '../../../src/scoring/judges/client.ts';
import {metricBusinessRubric,rubricsFor} from '../../../src/scoring/judges/compact.ts';
import {decodeJudgeInput,sharedTextEncoding} from '../../../src/scoring/judges/shared-text.ts';
import {semanticEvaluator} from '../../../src/scoring/judges/evaluators.ts';

const env={FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_API_KEY:'independent-fixture-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'};
const reply=(n:number,finish='stop')=>judgeResponse({model:'llama-3.3-70b-versatile',choices:[{message:{content:namedJudgment({criteria:[{metricId:'tool-arguments'}]},{v:1,r:[[n,1,0]],f:n?[]:[[0,0,1]]})},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:15}});

test('single Metric calibration keeps original references, selects only its target and joins reversed results by Metric ID',async()=>{
 const f=fixture();try{
  for(const name of ['tune','validation']){
   const path=join(f.directory,name+'.json'),doc=JSON.parse(readFileSync(path,'utf8'));
   doc.plan.criteria.push({...doc.plan.criteria[0],metricId:'tool-selection',unit:'决策点'});
   doc.references.push({...doc.references[0],metricId:'tool-selection',counts:[1,1,0],severeError:false});
   writeFileSync(path,JSON.stringify(doc));
  }
  const options={directory:f.directory,executionId:'one-metric',metric:'tool-selection'};
  let calls=0;
  const single=await calibrateJudge(f.root,options,{env,fetcher:async(_,init)=>{
   calls++;const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content);
   expect(data.plan.criteria.map((c:any)=>c.metricId)).toEqual(['tool-selection']);
   expect(data.evidence).not.toHaveProperty('references');
   return judgeResponse({choices:[{message:{content:JSON.stringify({v:1,results:[{metricId:'tool-selection',counts:{numerator:1,denominator:1,unassessable:0},failures:[]}]})},finish_reason:'stop'}]});
  }});
  expect(calls).toBe(2);
  expect(single.report.criteria).toHaveLength(2);
  expect(single.report.criteria.every(c=>c.metricId==='tool-selection'&&c.countsCorrect===1&&c.notRun===0)).toBe(true);
  expect(single.report.samples.every(s=>s.reference.references.length===2)).toBe(true);
  expect(calibration.calibrationCoverage(single.report,single.report.samples[0]!.reference.plan,single.report.configuration).state).toBe('insufficient-coverage');
  expect(calibration.readCalibrationReport(single.file).criteria).toEqual(single.report.criteria);
  const batch=await calibrateJudge(f.root,{directory:f.directory,executionId:'metric-combination'},{env,fetcher:async(_,init)=>{
   const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content),tune=data.evidence.actualRequest==='wrong-object';
   return judgeResponse({choices:[{message:{content:JSON.stringify({v:1,results:[
    {metricId:'tool-selection',counts:{numerator:1,denominator:1,unassessable:0},failures:[]},
    {metricId:'tool-arguments',counts:{numerator:tune?0:1,denominator:1,unassessable:0},failures:tune?[{opportunityIndex:0,code:1}]:[]}]})},finish_reason:'stop'}]});
  }});
  expect(batch.report.criteria).toHaveLength(4);
  expect(batch.report.criteria.every(c=>c.countsCorrect===1)).toBe(true);
  expect(calibration.calibrationCoverage(batch.report,batch.report.samples[0]!.reference.plan,batch.report.configuration).state).toBe('matched');
 }finally{f.close();}
});

test('calibration scope matches independent versions without granting semantic acceptance or inheriting unrelated changes',async()=>{
 const f=fixture();try{
  let i=0;
  const {report,file}=await calibrateJudge(f.root,{directory:f.directory,executionId:'version-scope'},{env,fetcher:async()=>reply(i++)});
  const plan=report.samples[0]!.reference.plan,coverage=()=>calibration.calibrationCoverage(report,plan,report.configuration);
  expect(coverage()).toMatchObject({state:'matched',kind:'engineering-fixture',acceptance:'not-assessed'});
  expect(calibration.calibrationCoverage(undefined,plan,report.configuration).state).toBe('not-provided');
  expect(calibration.calibrationCoverage(report,plan,{...report.configuration,model:'changed-judge'}).state).toBe('version-mismatch');
  const def=semanticEvaluator('tool-arguments'),version=def.version;
  try{def.version++;expect(coverage().state).toBe('version-mismatch');expect(()=>calibration.readCalibrationReport(file)).not.toThrow();}finally{def.version=version;}
  const unrelated=semanticEvaluator('history-use'),prior=unrelated.version;
  try{unrelated.version++;expect(coverage().state).toBe('matched');}finally{unrelated.version=prior;}
  const prompt=report.rubrics[0]!.prompt;report.rubrics[0]!.prompt+=' changed';expect(coverage().state).toBe('version-mismatch');report.rubrics[0]!.prompt=prompt;
  const forged=structuredClone(report);forged.samples[1]!.reference.sourceGroup=forged.samples[0]!.reference.sourceGroup;
  writeFileSync(file,JSON.stringify(publicVersions(forged)));
  expect(()=>calibration.readCalibrationReport(file)).toThrow('Source group crosses');
 }finally{f.close();}
});

test('saved calibration cannot claim two Evaluator versions or inherit trust from unverified history',async()=>{
 const f=fixture();try{
  let index=0;const {report,file}=await calibrateJudge(f.root,{directory:f.directory,executionId:'unique-definitions'},{env,fetcher:async()=>reply(index++)});
  const forged=structuredClone(report),definition=semanticEvaluator('tool-arguments'),version=definition.version;
  forged.evaluators!.push({...forged.evaluators![0]!,version:version+1});
  try{
   definition.version++;
   expect(calibration.calibrationCoverage(forged,forged.samples[0]!.plan!,forged.configuration).state).toBe('version-mismatch');
  }finally{definition.version=version;}
  writeFileSync(file,JSON.stringify(publicVersions(forged)));
  expect(()=>calibration.readCalibrationReport(file)).toThrow('Duplicate');
  expect(calibration.calibrationCoverage({...report,history:{verification:'unverified',gaps:['Original conditions unavailable']}},report.samples[0]!.plan!,report.configuration).state).toBe('version-mismatch');
 }finally{f.close();}
});

test('a single target does not require tune and validation coverage for unselected sibling labels on readback',async()=>{
 const f=fixture();try{
  const path=join(f.directory,'tune.json'),doc=JSON.parse(readFileSync(path,'utf8'));
  const criterion={...doc.plan.criteria[0],metricId:'tool-selection',unit:'决策点'};
  const reference={...doc.references[0],metricId:'tool-selection',counts:[1,1,0],severeError:false};
  doc.plan.criteria.push(criterion);doc.references.push(reference);writeFileSync(path,JSON.stringify(doc));
  const other={...doc,id:'sibling-validation',instanceId:'sibling-validation-instance',sourceGroup:'sibling-validation-source',partition:'validation',
   plan:{...doc.plan,criteria:[criterion]},references:[reference],evidence:{independentObject:'validation-only-sibling'}};
  writeFileSync(join(f.directory,'sibling-validation.json'),JSON.stringify(other));f.manifest.samples.push({id:other.id,file:'sibling-validation.json'});f.save();
  const options={directory:f.directory,executionId:'isolated-selection',metric:'tool-arguments'};
  let calls=0;const result=await calibrateJudge(f.root,options,{env,fetcher:async()=>reply(calls++)});
  expect(result.report.criteria.every(c=>c.metricId==='tool-arguments')).toBe(true);
  expect(()=>calibration.readCalibrationReport(result.file)).not.toThrow();
 }finally{f.close();}
});

test('Judge calibration records a missed leakage as a false accept instead of replacing it with the local known failure',async()=>{
 const f=fixture();try{
  const source=loadCalibration(join(import.meta.dir,'../../fixtures/judge-calibration')).samples.find(s=>s.id==='actual-leakage-tune')!.document;
  for(const [index,name]of ['tune','validation'].entries()){
   const path=join(f.directory,name+'.json'),doc=JSON.parse(readFileSync(path,'utf8'));
   doc.plan.criteria=[{...source.plan.criteria[0],denominator:1}];
   doc.evidence={original:source.evidence,independentInstance:name};doc.references=[{...doc.references[0],metricId:'actual-leakage',counts:[index?0:1,1,0],severeError:!index}];
   writeFileSync(path,JSON.stringify(doc));
  }
  const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'judge-misses-safety'},{env,fetcher:async()=>judgeResponse({choices:[{message:{content:JSON.stringify({v:1,results:[
   {metricId:'actual-leakage',counts:{numerator:0,denominator:1,unassessable:0},failures:[]}]})},finish_reason:'stop'}]})});
  expect(result.report.criteria.find(c=>c.partition==='tune')).toMatchObject({falseAccepts:1,severeErrorMisses:1,countsCorrect:0});
 }finally{f.close();}
});

test('oversized HTTP input stays plain and a shared-text native calibration retains exactly its independent references',async()=>{
 const f=fixture();try{
  const original='Independent original source statement with preserved detail.\n'.repeat(7000);
  for(const name of ['tune','validation']){
   const path=join(f.directory,name+'.json'),document=JSON.parse(readFileSync(path,'utf8'));
   document.evidence={...document.evidence,original,copies:[original,original,original]};writeFileSync(path,JSON.stringify(document));
  }
  let httpCalls=0;
  const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'shared-calibration'},{env,fetcher:async(_url,init)=>{
   httpCalls++;const data=JSON.parse(String(init.body)).messages[1].content,request=JSON.parse(data);
   expect(data.length).toBeGreaterThan(1048576);expect(request.wireEncoding).toBeUndefined();expect(request.plan.criteria).toHaveLength(1);
   return judgeResponse({choices:[{message:{content:JSON.stringify({v:1,results:[{metricId:'tool-arguments',counts:null,failures:[]}]})},finish_reason:'stop'}]});
  }});
  expect(httpCalls).toBe(2);
  const native:NativeJudgeConfig={provider:'codex-cli',executable:'controlled-codex',model:'gpt-6.1-terra',reasoningEffort:'medium',timeoutMs:10000};
  result.report.configuration=publicJudgeConfig(native);result.report.rubrics=rubricsFor(result.report.samples.map(s=>s.reference.plan),true);
  for(const sample of result.report.samples){
   sample.call=await runCompactJudge(native,sample.reference.plan,sample.reference.evidence,undefined,undefined,async(_exe,args,options)=>{
    if(args.includes('--version'))return{code:0,stdout:'codex-cli controlled',stderr:''};
    expect(JSON.parse(options.stdin).wireEncoding).toBe(sharedTextEncoding);
    return{code:0,stderr:'',stdout:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({v:1,results:[{metricId:'tool-arguments',counts:null,failures:[]}]})}},
     {type:'turn.completed',usage:{input_tokens:1}}].map(e=>JSON.stringify(e)).join('\n')};
   });
  }
  writeFileSync(result.file,JSON.stringify(publicVersions(result.report)));
  const restored=calibration.readCalibrationReport(result.file);
  expect(restored.kind).toBe('engineering-fixture');expect(restored.samples.every(s=>s.call?.configuration.rubric?.id==='semantic-metric-batch')).toBe(true);
  const sample=restored.samples[0]!,wire=JSON.parse(sample.call!.request!.data);
  // Mutation of a retained source must still fail the reference identity check after decoding.
  wire.input.evidence.original+='changed';sample.call!.request!.data=JSON.stringify(wire);
  expect(decodeJudgeInput<{evidence:{original:string}}>(sample.call!.request!.data,true).evidence.original).not.toBe(original);
  writeFileSync(result.file,JSON.stringify(publicVersions(restored)));
  expect(()=>calibration.readCalibrationReport(result.file)).toThrow('differs from its original reference');
 }finally{f.close();}
});
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

test('semantic specialist diagnostics retain independent rubrics and per-criterion calibration without changing the formal catalog',async()=>{
 const f=fixture();try{
  for(const name of ['tune','validation']){
   const path=join(f.directory,name+'.json'),document=JSON.parse(readFileSync(path,'utf8'));
   Object.assign(document.plan.criteria[0],{metricId:'diagnostic-partial-failure-explanation',unit:'披露机会'});
   document.references[0].metricId='diagnostic-partial-failure-explanation';writeFileSync(path,JSON.stringify(document));
  }
  let calls=0;
  const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'specialist-calibration'},{env,fetcher:async(_url,init)=>{
   const request=JSON.parse(JSON.parse(String(init.body)).messages[1].content);
   expect(request.evidence.evaluatorRubrics.map((r:{id:string})=>r.id)).toEqual(['diagnostic-partial-failure-explanation']);
   return judgeResponse({choices:[{message:{content:namedJudgment(request.plan,{v:1,r:[[calls++?1:0,1,0]],f:calls===1?[[0,0,1]]:[]})},finish_reason:'stop'}]});
  }});
  expect(result.report.criteria.every(c=>c.metricId==='diagnostic-partial-failure-explanation')).toBe(true);
  expect(result.report.criteria.map(c=>c.countsCorrect)).toEqual([1,1]);
  expect(calibration.readCalibrationReport(result.file).criteria).toEqual(result.report.criteria);
 }finally{f.close();}
});
test('calibration preserves tune and validation references, every original attempt and per-criterion error counts without real acceptance',async()=>{
 const f=fixture();try{
  let calls=0;const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'controlled-calibration'},{env,fetcher:async()=>reply(++calls===1?1:0)});
  expect(calls).toBe(2);expect(result.report).toMatchObject({kind:'engineering-fixture',acceptance:'not-assessed',executionComplete:true});
  expect(result.report).not.toHaveProperty('plannedOutputTokens');
  expect(result.report.samples).toHaveLength(2);expect(result.report.samples.map(s=>s.call!.attempts)).toEqual([1,1]);
  expect(result.report.criteria).toContainEqual(expect.objectContaining({partition:'tune',metricId:'tool-arguments',samples:1,falseAccepts:1,severeErrorMisses:1}));
  expect(result.report.criteria).toContainEqual(expect.objectContaining({partition:'validation',metricId:'tool-arguments',samples:1,falseRejects:1}));
  expect(JSON.parse(readFileSync(result.file,'utf8'))).toEqual(publicVersions((result.report)));expect(JSON.stringify(result.report)).not.toContain(env.FLOWMATE_JUDGE_API_KEY);
  await expect(calibrateJudge(f.root,{directory:f.directory,executionId:'controlled-calibration'},{env,fetcher:async()=>{throw Error('must not request');}})).rejects.toThrow();
 }finally{f.close();}
});
test('reference schema, partition and instance identity are checked before any Judge request',async()=>{
 for(const mutation of ['unknown-hash','cross-partition','same-evidence','duplicate','traversal','retired-budget','unknown-field']as const){
  const f=fixture();try{
   if(mutation==='unknown-hash')Object.assign(f.manifest.samples[0]!,{unknownField:true});
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
 const covered=new Set(kit.samples.flatMap(s=>s.document.plan.criteria.map(c=>c.metricId)));expect(covered.size).toBe(30);
 expect(new Set(kit.samples.filter(s=>s.document.plan.criteria.length>1).map(s=>s.document.sourceGroup.replace(/-(tune|validation)$/,''))).size).toBe(4);
});
test('all delivered references round-trip through one controlled Judge attempt each, including missing and injected evidence',async()=>{
 const f=fixture();try{
  const directory=join(import.meta.dir,'../../fixtures/judge-calibration'),kit=loadCalibration(directory);let calls=0;
  const result=await calibrateJudge(f.root,{directory,executionId:'reference-protocol'},{env,fetcher:async(_,init)=>{
   const data=JSON.parse(JSON.parse(String(init.body)).messages[1].content);expect(data.evidence).not.toHaveProperty('referenceWire');expect(data.evidence).not.toHaveProperty('references');
   const sample=kit.samples[calls++]!;return judgeResponse({model:'llama-3.3-70b-versatile',choices:[{message:{content:sample.document.referenceWire??JSON.stringify({v:1,r:sample.document.references.map(r=>r.counts),f:[]})},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:15}});
  }});
  expect(calls).toBe(kit.samples.length);expect(result.report.criteria.every(c=>c.errors===0&&c.notRun===0&&c.countsCorrect===c.samples)).toBe(true);
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
  expect(JSON.parse(readFileSync(result.file,'utf8'))).toEqual(publicVersions((result.report)));
 }finally{f.close();}
});
test('Anthropic calibration reuses native SDK capabilities for its single-attempt samples',async()=>{
 const f=fixture();try{
  let metadataCalls=0,generations=0;
  const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'anthropic-capability'},{env:{...env,FLOWMATE_JUDGE_API:'anthropic-messages',FLOWMATE_JUDGE_PROVIDER:'anthropic',FLOWMATE_JUDGE_MODEL:'claude-haiku-4-5'},fetcher:async(_,init)=>{
   if(init.method==='GET'){metadataCalls++;return new Response(JSON.stringify({id:'canonical-fixture',max_tokens:64000}));}
   generations++;const body=JSON.parse(String(init.body));expect(body.max_tokens).toBe(64000);expect(body).not.toHaveProperty('temperature');
   return judgeResponse({content:[{type:'text',text:namedJudgment({criteria:[{metricId:'tool-arguments'}]},{v:1,r:[[generations===1?0:1,1,0]],f:[]})}],stop_reason:'end_turn',usage:{output_tokens:15}});
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

test('references explicitly select strict parsing without changing the behavior of historical references',()=>{
 const f=fixture();try{
  const file=join(f.directory,'tune.json'),document=JSON.parse(readFileSync(file,'utf8'));
  document.parsePolicy='metric-json-fence-strict-counts/v1';
  document.referenceWire=JSON.stringify({v:1,results:[{metricId:'tool-arguments',counts:{numerator:0,denominator:1,unassessable:0},
   failures:[{opportunityIndex:0,code:1}]}]});
  writeFileSync(file,JSON.stringify(document));
  expect(()=>loadCalibration(f.directory)).not.toThrow();
  document.referenceWire=JSON.stringify({v:1,results:[{metricId:'tool-arguments',counts:{numerator:0,denominator:1,unassessable:0},failures:[]}]});
  writeFileSync(file,JSON.stringify(document));
  expect(()=>loadCalibration(f.directory)).toThrow('Reference counts contradict');
  delete document.parsePolicy;writeFileSync(file,JSON.stringify(document));
  expect(()=>loadCalibration(f.directory)).not.toThrow();
 }finally{f.close();}
});

test('calibration status reads and validates original current or old named calls without writes or regrading',async()=>{
 const f=fixture();try{
  let index=0;const result=await calibrateJudge(f.root,{directory:f.directory,executionId:'read-only-calibration'},{env,fetcher:async()=>reply(index++)});
  expect(calibration).toHaveProperty('readCalibrationReport',expect.any(Function));
  const read=(calibration as any).readCalibrationReport as (file:string)=>typeof result.report;
  const bytes=readFileSync(result.file,'utf8'),restored=read(result.file);
  expect(restored.criteria).toEqual(result.report.criteria);expect(readFileSync(result.file,'utf8')).toBe(bytes);
  expect(restored.samples[0]!.call!.compact).toMatchObject({parsePolicy:'metric-json-independent/v1'});
  writeFileSync(result.file,JSON.stringify(result.report));
  expect(()=>read(result.file)).not.toThrow();
  for(const mutate of [
   (r:any)=>{r.criteria[0].countsCorrect++;},
   (r:any)=>{delete r.samples[0].call.compact.parsePolicy;},
   (r:any)=>{r.samples[0].call.raw='Explanation: '+r.samples[0].call.raw;},
   (r:any)=>{r.samples[1].id=r.samples[0].id;},
   (r:any)=>{r.samples[0].call.request.data=JSON.stringify({plan:r.samples[0].reference.plan,evidence:{forged:true}});}
  ]){
   const forged=JSON.parse(bytes);mutate(forged);writeFileSync(result.file,JSON.stringify(forged));
   expect(()=>read(result.file)).toThrow();
  }
  const legacy=structuredClone(result.report);legacy.rubrics=[metricBusinessRubric];
  delete legacy.scoringVersion;delete legacy.selection;delete legacy.evaluators;
  for(const [i,sample]of legacy.samples.entries()){
   delete sample.plan;
   const raw=JSON.stringify({v:1,results:[{metricId:'tool-arguments',counts:{numerator:i,denominator:1,unassessable:0},failures:[]}]});
   sample.call=await runJudge(judgeConfig(env,f.root)!,metricBusinessRubric.prompt,JSON.stringify({plan:sample.reference.plan,evidence:sample.reference.evidence}),async()=>judgeResponse({choices:[{message:{content:raw},finish_reason:'stop'}]}),undefined,sample.reference.plan);
   delete sample.call.transportStatus;
  }
  writeFileSync(result.file,JSON.stringify(publicVersions((legacy))));
  expect(read(result.file).criteria).toEqual(result.report.criteria);
  expect(read(result.file).samples[0]!.call!.compact).not.toHaveProperty('parsePolicy');
  expect(read(result.file).samples[0]!.call).not.toHaveProperty('transportStatus');
  const historical:any=structuredClone(result.report);historical.referenceHash='legacy-only';writeFileSync(result.file,JSON.stringify(historical));
  expect(read(result.file).history?.verification).toBe('unverified');expect(read(result.file).criteria).toEqual(result.report.criteria);
 }finally{f.close();}
});
