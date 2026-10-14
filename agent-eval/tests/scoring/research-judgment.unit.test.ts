import { judgeResponse, namedJudgment } from '../support/judge-response.ts';
import {test,expect} from 'bun:test';
import {deriveResearchCounts} from '../../src/scoring/research-judgment.ts';
import type {ResearchFrame} from '../../src/scoring/research-frame.ts';
import type {PackedJudgment} from '../../src/scoring/judges/packed.ts';
import {runCompactJudge} from '../../src/scoring/judges/harness.ts';
import {compactScores,parseCompactJudgment} from '../../src/scoring/judges/compact.ts';
import {judgeConfig} from '../../src/scoring/judges/client.ts';
import {formalMetric} from '../../src/scoring/catalog.ts';
import {evaluateSemantic} from '../../src/scoring/evaluators/semantic.ts';
import {task,observed,reportFixture} from '../support/fixtures.ts';
import {saveReport,readReport,comparison} from '../../src/reports/store.ts';
import {aggregate} from '../../src/scoring/aggregate.ts';
import {mkdtempSync} from '../../../tests/support/resources.ts';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../../src/dataset-loader/local.ts';

function fixture(){
 const texts=['Alpha owns Beta.','Beta follows Gamma.'],gold=texts.map((text,i)=>({id:'hop-'+i,text,required:true,acceptable:[text],conditions:[],entities:['Beta'],
  evidence:[{sample:'synthetic',sha256:'a'.repeat(64),start:0,end:text.length,quote:text,relation:'support' as const}]}));
 const frame:ResearchFrame={contract:'flowmate-research-frame/v1',complete:true,reportId:1,
  blocks:texts.map((text,i)=>({kind:'claim',key:'claim:'+(i+1),claimId:i+1,text})),
  links:texts.map((text,i)=>({key:'link:'+i,claimId:i+1,evidenceIndex:0,relation:'supports',valid:true,display:text,
   ref:{researchId:1,planId:1,revision:1,runId:1,toolCallId:i+1,sourceSnapshotId:i+1,locator:{start:0,end:text.length,quote:text}}})),
  integrity:{valid:true,issues:[],links:[],sourceBindings:[]},gold:{status:'verified',claims:gold,chains:[{id:'chain',claims:['hop-0','hop-1'],links:[{from:'hop-0',to:'hop-1',entity:'Beta'}]}],forbidden:[]},
  sources:[],proofHash:'b'.repeat(64),rule:'Independent synthetic source and Report frame.'};
 const proof:PackedJudgment={rows:[],failures:[],atoms:texts.map((text,i)=>({block:i,start:0,length:text.length,correct:1,needsCitation:true,covered:1,gold:i+1,matchUncertain:false})),
  links:texts.map((_,i)=>({atom:i,state:1})),chains:[1]};return{frame,proof};
}
test('research counts preserve independent fact, one-to-one Gold, citation, coverage and complete-chain denominators',()=>{
 const{frame,proof}=fixture(),counts=deriveResearchCounts(frame,proof);
 for(const id of ['DR01','DR02','DR04','DR05'])expect(counts[id]!.row).toEqual([2,2,0]);expect(counts.DR06!.row).toEqual([1,1,0]);
});
test('new final Report facts are counted even when the Agent never registered them as Claims',()=>{
 const{frame,proof}=fixture();frame.blocks.push({kind:'report-section',key:'new-report-fact',claimId:null,text:'An unsupported new assertion.'});
 proof.atoms.push({block:2,start:0,length:frame.blocks[2]!.text.length,correct:0,needsCitation:true,covered:0,gold:0,matchUncertain:false});
 const counts=deriveResearchCounts(frame,proof);expect(counts.DR01!.row).toEqual([2,3,0]);expect(counts.DR05!.row).toEqual([2,3,0]);expect(counts.DR02!.row).toEqual([2,2,0]);
});
test('an empty Report cannot erase required Gold facts or required chains and has unknown zero-denominator rates',()=>{
 const{frame,proof}=fixture();frame.blocks=[];frame.links=[];proof.atoms=[];proof.links=[];proof.chains=[1];
 const counts=deriveResearchCounts(frame,proof);expect(counts.DR01!.row).toEqual([0,0,0]);expect(counts.DR02!.row).toEqual([0,2,0]);expect(counts.DR04!.row).toEqual([0,0,0]);expect(counts.DR06!.row).toEqual([0,1,0]);
});
test('one atomic fact cannot cover multiple required Gold facts and duplicate Gold matches are rejected',()=>{
 const{frame,proof}=fixture();proof.atoms[1]!.gold=1;expect(()=>deriveResearchCounts(frame,proof)).toThrow('Gold');
});
test('a structurally invalid or unlinked citation cannot be rescued by a Judge support flag',()=>{
 for(const mode of ['invalid','unlinked']as const){const{frame,proof}=fixture();frame.links[0]!.valid=false;
  if(mode==='unlinked'){frame.links[0]!.ref=null;frame.links[0]!.claimId=null;frame.links[0]!.relation='unbound';}
  const counts=deriveResearchCounts(frame,proof);expect(counts.DR04!.row).toEqual([1,2,0]);expect(counts.DR05!.row).toEqual([1,2,0]);expect(counts.DR06!.row).toEqual([0,1,0]);
 }
});
test('partial collections preserve known wrong assertions while refusing an invented precision denominator',()=>{
 const{frame,proof}=fixture();frame.complete=false;proof.atoms[0]!.correct=0;proof.atoms[0]!.covered=0;
 const counts=deriveResearchCounts(frame,proof);expect(counts.DR01).toMatchObject({row:null,knownFailure:true,statistics:{numerator:1,denominator:null,missing:null}});
});
test('missing citation support and uncertain matches stay unknown and cannot become a complete chain',()=>{
 const{frame,proof}=fixture();proof.atoms[0]!.correct=2;proof.atoms[0]!.covered=2;proof.atoms[0]!.matchUncertain=true;proof.links[0]!.state=2;proof.chains[0]=2;
 const counts=deriveResearchCounts(frame,proof);expect(counts.DR01!.row).toEqual([1,2,1]);expect(counts.DR02!.row).toEqual([1,2,1]);expect(counts.DR04!.row).toEqual([1,2,1]);expect(counts.DR06!.row).toEqual([0,1,1]);
});
test('atomic selectors, Gold versions, references and chain counts must bind the original frame',()=>{
 for(const mode of ['span','overlap','gold','link','chain','pending']as const){const{frame,proof}=fixture();
  if(mode==='span')proof.atoms[0]!.length=1000;if(mode==='overlap')proof.atoms.push({...proof.atoms[0]!,gold:0});
  if(mode==='gold')proof.atoms[0]!.gold=99;if(mode==='link')proof.links=[];if(mode==='chain')proof.chains=[];if(mode==='pending')frame.gold.status='pending';
  expect(()=>deriveResearchCounts(frame,proof)).toThrow();
 }
});
const config=judgeConfig({FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_API_KEY:'independent-research-fixture-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'})!;
const packedPlan={contract:'flowmate-semantic-plan/v1' as const,
 criteria:['tool-selection','DR01','DR02','DR04','DR05','DR06'].map(metricId=>({metricId,version:1,unit:formalMetric(metricId).unit,denominator:metricId==='tool-selection'||metricId==='DR06'?1:metricId==='DR02'?2:null,
  required:true,rule:'Independently evaluate this criterion against the declared original frame, without trusting product flags.',evidence:['research-frame','gold-research'],trigger:'started' as const}))};
function rawProof(proof:PackedJudgment){return namedJudgment(packedPlan,{v:1,r:packedPlan.criteria.map(c=>c.metricId==='tool-selection'?[1,1,0]:null),f:[],research:{atoms:proof.atoms,links:proof.links,chains:proof.chains}});}

test('plain research witnesses exceed legacy fact, block, citation and span limits without copying Judge ratios',async()=>{
 const {frame,proof}=fixture();
 frame.blocks=Array.from({length:40},(_,i)=>({...frame.blocks[0]!,key:'block-'+i,text:'x'.repeat(i===0?52000:2000)}));
 proof.atoms=frame.blocks.map((_,i)=>({...proof.atoms[0]!,block:i,start:i===0?50000:0,length:2000,gold:i<2?i+1:0}));
 frame.links=Array.from({length:1400},(_,i)=>({...frame.links[0]!,key:'link-'+i}));
 proof.links=frame.links.map((_,i)=>({atom:i%40,state:1}));
 const plan=packedPlan;
 const result=parseCompactJudgment(JSON.stringify({v:1,r:plan.criteria.map(c=>c.metricId==='tool-selection'?[1,1,0]:null),f:[],research:{atoms:proof.atoms,links:proof.links,chains:proof.chains}}),plan,frame);
 expect(result.research!.atoms).toHaveLength(40);expect(result.research!.links).toHaveLength(1400);
 expect(result.r[1]).toEqual([40,40,0]);expect(result.r[2]).toEqual([2,2,0]);
});

test('one plain JSON Judge request derives five independent research ratios and original semantic scores from original-index witnesses',async()=>{
 const{frame,proof}=fixture();let requests=0;
 const call=await runCompactJudge(config,packedPlan,{researchFrame:frame},async(_,init)=>{
  requests++;const body=JSON.parse(String(init.body));expect(body).toHaveProperty('max_completion_tokens', 32768);expect(body).not.toHaveProperty('temperature');expect(body.messages[0].content).toContain('plain JSON');
  return judgeResponse({choices:[{message:{content:rawProof(proof)},finish_reason:'stop'}]});
 });
 expect(requests).toBe(1);expect(call.error).toBeNull();const scores=compactScores(call);expect(scores).toHaveLength(6);
 expect(scores.every(s=>s.status==='PASS')).toBe(true);expect(scores.find(s=>s.metricId==='DR02')!.statistics).toMatchObject({numerator:2,denominator:2,missing:0});
 expect(call.compact!.judgment!.research!.atoms).toEqual(proof.atoms);
});
test('plain research scoring retains known partial failure and original count units without invented denominators',async()=>{
 const{frame,proof}=fixture();frame.complete=false;proof.atoms[0]!.correct=0;proof.atoms[0]!.covered=0;
 const call=await runCompactJudge(config,packedPlan,{researchFrame:frame},async()=>judgeResponse({choices:[{message:{content:rawProof(proof)},finish_reason:'stop'}]}));
 expect(call.error).toBeNull();expect(compactScores(call).find(s=>s.metricId==='DR01')).toMatchObject({status:'FAIL',value:null,statistics:{unit:'事实Claim',numerator:1,denominator:null,missing:null}});
});
test('larger structural witness bounds do not impose an artificial output budget',async()=>{
 const{frame,proof}=fixture();let requests=0;
 const call=await runCompactJudge(config,packedPlan, {researchFrame:frame},async()=>{
  requests++;return judgeResponse({choices:[{message:{content:rawProof(proof)},finish_reason:'stop'}]});});
 expect(requests).toBe(1);expect(call.error).toBeNull();
});
test('unavailable semantic witnesses stays unjudgeable while an independently invalid observed citation still fails',async()=>{
 const{frame}=fixture();frame.links[0]!.valid=false;
 const call=await runCompactJudge(config,packedPlan,{researchFrame:frame},async()=>judgeResponse({choices:[{message:{content:namedJudgment(packedPlan,{v:1,r:packedPlan.criteria.map(c=>c.metricId==='tool-selection'?[1,1,0]:null),f:[],research:{atoms:[],links:[],chains:[],unavailable:true}})},finish_reason:'stop'}]}));
 expect(call.error).toBeNull();const scores=compactScores(call);
 expect(scores.find(s=>s.metricId==='DR01')).toMatchObject({status:'UNJUDGEABLE',value:null});
 expect(scores.find(s=>s.metricId==='DR04')).toMatchObject({status:'FAIL',value:null,statistics:{denominator:null,missing:null}});
});

test('malformed research witnesses affect research metrics while a valid ordinary metric remains measured', async()=>{
 const {frame,proof}=fixture();proof.chains=[];
 const call=await runCompactJudge(config,packedPlan,{researchFrame:frame},async()=>judgeResponse({choices:[{message:{content:rawProof(proof)},finish_reason:'stop'}]}));
 expect(call.error).toBeNull();
 expect(compactScores(call)[0]).toMatchObject({status:'PASS',value:1});
 expect(compactScores(call).slice(1).every(s=>s.status==='ERROR'&&s.value===null)).toBe(true);
});

test('complete evidence of no Report yields local known omissions without a Judge generation', async()=>{
 const {frame}=fixture(),result=observed();
 result.status='failed';result.endpointReached=false;
 result.evidence.research={present:true,actual:null,source:'Original query confirms no research task or Report'};
 const item={...task,contract:'flowmate-agent-case/v2' as const,expected:{...task.expected,metrics:[],research:frame.gold}};
 const plan={...packedPlan,criteria:packedPlan.criteria.filter(c=>c.metricId.startsWith('DR'))};let requests=0;
 const measured=await evaluateSemantic({task:item,result,projected:result.input,semanticPlan:plan,judge:config,
  fetcher:async()=>{requests++;throw Error('must derive empty Report locally');}});
 expect(requests).toBe(0);expect(measured.judgeCalls).toHaveLength(0);
 expect(measured.scores.find(s=>s.metricId==='DR02')).toMatchObject({method:'deterministic',status:'FAIL',statistics:{numerator:0,denominator:2,missing:0}});
 expect(measured.scores.find(s=>s.metricId==='DR06')).toMatchObject({method:'deterministic',status:'FAIL',statistics:{numerator:0,denominator:1,missing:0}});
 expect(measured.scores.find(s=>s.metricId==='DR01')).toMatchObject({status:'UNJUDGEABLE',value:null});
 result.evidence.research={present:false,actual:null,source:'Collection unavailable'};
 const unknown=await evaluateSemantic({task:item,result,projected:result.input,semanticPlan:plan,judge:null});
 expect(unknown.scores.every(s=>s.status!=='PASS'&&s.status!=='FAIL')).toBe(true);
});

test('saved local no-Report scores reject forged counts and keep semantic-plan comparison independent of derivation method',async()=>{
 const {frame}=fixture(),report=reportFixture();report.contract='flowmate-agent-run/v2';
 const trial=report.trials[0]!,result=trial.execution!;
 result.evidence.research={present:true,actual:null,source:'Original query confirms no Report'};
 const item={...task,contract:'flowmate-agent-case/v2' as const,expected:{...task.expected,metrics:[],research:frame.gold}};
 const plan={...packedPlan,criteria:packedPlan.criteria.filter(c=>['DR02','DR06'].includes(c.metricId))};
 const scored=await evaluateSemantic({task:item,result,projected:result.input,semanticPlan:plan,judge:null});
 trial.semanticPlan=plan;trial.scores.push(...scored.scores);trial.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1},
  ...plan.criteria.map(({metricId,version,unit,denominator})=>({metricId,version,unit,denominator}))];
 Object.assign(trial,aggregate(trial.scores,result));
 const file=join(mkdtempSync(join(tmpdir(),'local-research-score-')),'report.json');saveReport(file,report);
 expect(readReport(file).trials[0]!.scores.find(s=>s.metricId==='DR02')).toMatchObject({status:'FAIL',value:0});
 const forged=structuredClone(report),score=forged.trials[0]!.scores.find(s=>s.metricId==='DR02')!;
 score.statistics!.numerator=1;score.value=0.5;
 expect(()=>saveReport(join(mkdtempSync(join(tmpdir(),'forged-local-research-')),'report.json'),forged)).toThrow();
 for(const mutate of [
  (r:typeof report)=>{r.trials[0]!.scores.find(s=>s.metricId==='DR02')!.required=false;},
  (r:typeof report)=>{r.trials[0]!.scores.find(s=>s.metricId==='DR02')!.version=2;},
  (r:typeof report)=>{r.trials[0]!.semanticPlan!.criteria[0]!.denominator=3;r.trials[0]!.metricPlan!.find(m=>m.metricId==='DR02')!.denominator=3;},
  (r:typeof report)=>{r.trials[0]!.semanticPlan!.criteria[0]!.trigger='completed-endpoint';r.trials[0]!.execution!.status='failed';}
 ]){const changed=structuredClone(report);mutate(changed);
  expect(()=>{saveReport(join(mkdtempSync(join(tmpdir(),'forged-local-plan-')),'report.json'),changed);}).toThrow();}
 const alternate=structuredClone(report);alternate.trials[0]!.scores.find(s=>s.metricId==='DR02')!.method='llm-judge';
 expect(()=>comparison(report,alternate)).not.toThrow();
});

test('saved no-Report proof remains readable when collected sources lose private digests on disk',async()=>{
 const {frame}=fixture(),report=reportFixture();report.contract='flowmate-agent-run/v2';
 const trial=report.trials[0]!,result=trial.execution!,at=report.startedAt,text='Independent synthetic source.';
 const policy={web:false,domains:[],artifactIds:[3],documentIds:[]};
 result.evidence.research={present:true,source:'Complete original research pagination',actual:{
  task:{researchId:1,sessionId:2,title:'Synthetic',sourcePolicy:policy,status:'failed',currentPlanId:null,
   planConfirmed:false,currentRunId:4,currentReportId:null,createdAt:at,updatedAt:at},
  plans:[],discoveredPlanIds:[],claims:[],reports:[],reportCount:0,
  sources:[{sourceSnapshotId:7,researchId:1,runId:4,toolCallId:21,createdAt:at,kind:'local',address:'artifact:3',title:'Synthetic',
   artifactId:3,documentId:null,fetchedAt:at,publishedAt:null,contentHash:hash(text),relativePath:'artifacts/research/1/'+hash(text)+'.txt',
   bytes:Buffer.byteLength(text),characters:text.length,truncated:false}],
  sourceTexts:[{sourceSnapshotId:7,runId:4,toolCallId:21,text,acquisition:'controller-query',modelUse:'requires-original-tool-and-context-evidence'}]}};
 for(const [key,actual]of Object.entries({runs:[],'tool-evidence':{calls:[]},'material-registration':[]}))
  result.evidence[key]={present:true,actual,source:'Complete original collection'};
 const item={...task,contract:'flowmate-agent-case/v2' as const,expected:{...task.expected,metrics:[],research:frame.gold}};
 const plan={...packedPlan,criteria:packedPlan.criteria.filter(c=>c.metricId==='DR02')};
 const measured=await evaluateSemantic({task:item,result,projected:result.input,semanticPlan:plan,judge:null});
 expect(measured.scores[0]).toMatchObject({method:'deterministic',status:'FAIL'});
 trial.semanticPlan=plan;trial.scores.push(...measured.scores);trial.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1},
  ...plan.criteria.map(({metricId,version,unit,denominator})=>({metricId,version,unit,denominator}))];
 Object.assign(trial,aggregate(trial.scores,result));
 const file=join(mkdtempSync(join(tmpdir(),'local-research-sources-')),'report.json');saveReport(file,report);
 expect(readReport(file).trials[0]!.scores.find(s=>s.metricId==='DR02')).toMatchObject({status:'FAIL',value:0});
});
