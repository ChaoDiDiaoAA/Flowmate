import {collectedResearchSchema} from '../adapters/research-evidence.ts';
import {inspectResearchEvidence} from '../adapters/research-integrity.ts';
import {hash} from '../dataset-loader/local.ts';
import type {EvaluationContext} from './types.ts';
import type {EvidenceRef} from '../../../packages/contracts/src/research.ts';
import type {EvidenceFact} from '../types.ts';

const unavailable:EvidenceFact={present:false,actual:null,source:'Original evidence unavailable'};
export type ResearchBlock={kind:'claim'|'report-answer'|'report-section';key:string;claimId:number|null;text:string};
export type ResearchLink={key:string;claimId:number|null;evidenceIndex:number|null;ref:EvidenceRef|null;relation:'supports'|'refutes'|'unbound';valid:boolean|null;display:string};

/** Quality-side numbering includes final Report prose; a controller query never proves a model read. */
export function buildResearchFrame(context:EvaluationContext){
 const{task,result}=context;if(!('contract'in task)||!task.expected.research)return;
 const evidence=result.evidence.research??unavailable,confirmedEmpty=evidence.present&&evidence.actual===null&&!!evidence.source.trim();
 const parsed=collectedResearchSchema.safeParse(confirmedEmpty?{task:null,plans:[],discoveredPlanIds:[],sources:[],claims:[],reports:[],sourceTexts:[],reportCount:0}:evidence.actual);
 if(!parsed.success)return;
 const proof={runs:result.evidence.runs??unavailable,tools:result.evidence['tool-evidence']??unavailable,
  registration:result.evidence['material-registration']??unavailable,input:context.projected};
 const inspected=inspectResearchEvidence(evidence,proof),integrity=inspected.actual as{valid:boolean|null;issues:Array<{kind:string;id:number|null;code:string;severity:string}>;
  links:Array<{claimId:number;evidenceIndex:number;valid:boolean|null}>;sourceBindings:Array<{sourceSnapshotId:number;sample:string;file:string}>};
 const data=parsed.data,report=data.reports.find(r=>r.reportId===data.task?.currentReportId);
 const requested=[...new Set(report?[...report.sections.flatMap(s=>s.claimIds),...report.coverage.flatMap(c=>c.claimIds)]:[])].sort((a,b)=>a-b);
 const claims=requested.flatMap(id=>data.claims.filter(c=>c.claimId===id));
 const blocks:ResearchBlock[]=claims.map(c=>({kind:'claim',key:'claim:'+c.claimId,claimId:c.claimId,text:c.text}));
 const links:ResearchLink[]=claims.flatMap(c=>c.evidence.map((e,i)=>({key:`claim:${c.claimId}:citation:${i}`,claimId:c.claimId,evidenceIndex:i,ref:e.ref,relation:e.relation,
  valid:integrity.links.find(l=>l.claimId===c.claimId&&l.evidenceIndex===i)?.valid??null,display:e.ref.locator.quote})));
 if(report){
  blocks.push({kind:'report-answer',key:'report:'+report.reportId+':answer',claimId:null,text:report.answer});
  blocks.push(...report.sections.map((section,i)=>({kind:'report-section' as const,key:`report:${report.reportId}:section:${i}`,claimId:null,text:section.text})));
  const inline=new Set<string>();
  for(const block of blocks.filter(b=>b.kind!=='claim'))for(const match of block.text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)){
   const address=match[1]!;if(inline.has(address))continue;inline.add(address);
   links.push({key:'inline:'+links.length,claimId:null,evidenceIndex:null,ref:null,relation:'unbound',valid:false,display:address});
  }
 }
 const complete=confirmedEmpty||evidence.present&&inspected.present&&data.task!==null&&
  (data.task.currentReportId===null||report!==undefined)&&requested.every(id=>claims.filter(c=>c.claimId===id).length===1);
 return{contract:'flowmate-research-frame/v1' as const,complete,reportId:report?.reportId??null,blocks,links,integrity,
  gold:structuredClone(task.expected.research),
  sources:data.sourceTexts.map(s=>({sourceSnapshotId:s.sourceSnapshotId,text:s.text,sha256:hash(s.text),modelRead:false as const,
   binding:integrity.sourceBindings.find(b=>b.sourceSnapshotId===s.sourceSnapshotId)??null})),
  proofHash:hash({research:evidence,proof,gold:task.expected.research}),
  rule:'Number atomic asserted facts from the ordered original blocks, including new Report facts. Deduplicate semantically equivalent facts across blocks. Split compound assertions; preserve conditions, dates and intermediate entities. Do not treat product verification/full flags or controller source acquisition as independent semantic truth. Report omissions remain missing Gold facts. Unlinked or report-external evidence cannot cover a reported fact.'};
}
export type ResearchFrame=NonNullable<ReturnType<typeof buildResearchFrame>>;
