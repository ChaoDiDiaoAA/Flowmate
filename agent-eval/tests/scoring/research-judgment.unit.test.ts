import {test,expect} from 'bun:test';
import {deriveResearchCounts} from '../../src/scoring/research-judgment.ts';
import type {ResearchFrame} from '../../src/scoring/research-frame.ts';
import type {PackedJudgment} from '../../src/scoring/judges/packed.ts';
import {runCompactJudge} from '../../src/scoring/judges/harness.ts';
import {compactScores,parseCompactJudgment} from '../../src/scoring/judges/compact.ts';
import {judgeConfig} from '../../src/scoring/judges/client.ts';
import {formalMetric} from '../../src/scoring/catalog.ts';

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
const config=judgeConfig({FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'independent-research-fixture',FLOWMATE_JUDGE_API_KEY:'independent-research-fixture-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'})!;
const packedPlan={contract:'flowmate-semantic-plan/v1' as const,
 criteria:['tool-selection','DR01','DR02','DR04','DR05','DR06'].map(metricId=>({metricId,version:1,unit:formalMetric(metricId).unit,denominator:metricId==='tool-selection'||metricId==='DR06'?1:metricId==='DR02'?2:null,
  required:true,rule:'Independently evaluate this criterion against the declared original frame, without trusting product flags.',evidence:['research-frame','gold-research'],trigger:'started' as const}))};
function rawProof(proof:PackedJudgment){return JSON.stringify({v:1,r:packedPlan.criteria.map(c=>c.metricId==='tool-selection'?[1,1,0]:null),f:[],research:{atoms:proof.atoms,links:proof.links,chains:proof.chains}});}

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
  requests++;const body=JSON.parse(String(init.body));expect(body).not.toHaveProperty('max_tokens');expect(body).not.toHaveProperty('temperature');expect(body.messages[0].content).toContain('plain JSON');
  return new Response(JSON.stringify({choices:[{message:{content:rawProof(proof)},finish_reason:'stop'}]}));
 });
 expect(requests).toBe(1);expect(call.error).toBeNull();const scores=compactScores(call);expect(scores).toHaveLength(6);
 expect(scores.every(s=>s.status==='PASS')).toBe(true);expect(scores.find(s=>s.metricId==='DR02')!.statistics).toMatchObject({numerator:2,denominator:2,missing:0});
 expect(call.compact!.judgment!.research!.atoms).toEqual(proof.atoms);
});
test('plain research scoring retains known partial failure and original count units without invented denominators',async()=>{
 const{frame,proof}=fixture();frame.complete=false;proof.atoms[0]!.correct=0;proof.atoms[0]!.covered=0;
 const call=await runCompactJudge(config,packedPlan,{researchFrame:frame},async()=>new Response(JSON.stringify({choices:[{message:{content:rawProof(proof)},finish_reason:'stop'}]})));
 expect(call.error).toBeNull();expect(compactScores(call).find(s=>s.metricId==='DR01')).toMatchObject({status:'FAIL',value:null,statistics:{unit:'事实Claim',numerator:1,denominator:null,missing:null}});
});
test('larger structural witness bounds do not impose an artificial output budget',async()=>{
 const{frame,proof}=fixture();let requests=0;
 const call=await runCompactJudge(config,packedPlan, {researchFrame:frame},async()=>{
  requests++;return new Response(JSON.stringify({choices:[{message:{content:rawProof(proof)},finish_reason:'stop'}]}));});
 expect(requests).toBe(1);expect(call.error).toBeNull();
});
test('unavailable semantic witnesses stays unjudgeable while an independently invalid observed citation still fails',async()=>{
 const{frame}=fixture();frame.links[0]!.valid=false;
 const call=await runCompactJudge(config,packedPlan,{researchFrame:frame},async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({v:1,r:packedPlan.criteria.map(c=>c.metricId==='tool-selection'?[1,1,0]:null),f:[],research:{atoms:[],links:[],chains:[],unavailable:true}})},finish_reason:'stop'}]})));
 expect(call.error).toBeNull();const scores=compactScores(call);
 expect(scores.find(s=>s.metricId==='DR01')).toMatchObject({status:'UNJUDGEABLE',value:null});
 expect(scores.find(s=>s.metricId==='DR04')).toMatchObject({status:'FAIL',value:null,statistics:{denominator:null,missing:null}});
});
