import {z} from 'zod';
import {createHash} from 'node:crypto';
import {EvidenceRefSchema} from '../../../packages/contracts/src/research.ts';
import {researchGoldSchema} from '../dataset-loader/research-gold.ts';
import {formalMetric} from './catalog.ts';
import type {MetricStatistics} from './types.ts';
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), state = z.number().int().min(0).max(2);
export const researchProofSchema = z.object({
 atoms: z.array(z.object({block:index,start:index,length:index.positive(),correct:state,needsCitation:z.boolean(),covered:state,gold:index,matchUncertain:z.boolean()}).strict()),
 links: z.array(z.object({atom:z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),state}).strict()),
 chains: z.array(state), unavailable:z.literal(true).optional()
}).strict().superRefine((proof,ctx)=>{
 if(proof.unavailable && (proof.atoms.length || proof.links.length || proof.chains.length)) ctx.addIssue({code:'custom',message:'Unavailable research proof must not contain partial witnesses'});
});
export type ResearchProof = z.infer<typeof researchProofSchema>;

const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const researchFrameSchema=z.object({contract:z.literal('flowmate-research-frame/v1'),complete:z.boolean(),reportId:id.nullable(),
 blocks:z.array(z.object({kind:z.enum(['claim','report-answer','report-section']),key:z.string().min(1),claimId:id.nullable(),text:z.string()}).strict()),
 links:z.array(z.object({key:z.string().min(1),claimId:id.nullable(),evidenceIndex:z.number().int().nonnegative().nullable(),ref:EvidenceRefSchema.nullable(),
  relation:z.enum(['supports','refutes','unbound']),valid:z.boolean().nullable(),display:z.string()}).strict()),
 integrity:z.object({valid:z.boolean().nullable(),issues:z.array(z.object({kind:z.string(),id:id.nullable(),code:z.string(),severity:z.enum(['invalid','unknown'])}).passthrough()),
  links:z.array(z.object({claimId:id,evidenceIndex:z.number().int().nonnegative(),sourceSnapshotId:id.optional(),valid:z.boolean().nullable()}).strict()),
  sourceBindings:z.array(z.object({sourceSnapshotId:id,sample:z.string(),file:z.string()}).strict())}).passthrough(),
 gold:researchGoldSchema,sources:z.array(z.object({sourceSnapshotId:id,text:z.string(),sha256:sha.optional(),modelRead:z.literal(false),
  binding:z.object({sourceSnapshotId:id,sample:z.string(),file:z.string()}).strict().nullable()}).strict()),proofHash:sha.optional(),rule:z.string().min(1)
}).strict();
const splitPair=(text:string,offset:number)=>offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1]!)&&/[\uDC00-\uDFFF]/.test(text[offset]!);
export type ResearchCount={row:[number,number,number]|null;knownFailure:boolean;statistics:MetricStatistics;opportunities:unknown[]};

export function unavailableResearchCounts(input:unknown):Record<string,ResearchCount>{
 const frame=researchFrameSchema.parse(input);
 if(frame.complete&&frame.blocks.length===0&&frame.links.length===0)return deriveResearchCounts(frame,{atoms:[],links:[],chains:frame.gold.chains.map(()=>0)});
 return Object.fromEntries(['DR01','DR02','DR04','DR05','DR06'].map(metricId=>[metricId,{row:null,
  knownFailure:metricId==='DR04'&&frame.links.some(l=>l.valid===false),
  statistics:{unit:formalMetric(metricId).unit,numerator:null,denominator:metricId==='DR02'?frame.gold.claims.filter(c=>c.required).length:metricId==='DR06'?frame.gold.chains.length:null,
   missing:metricId==='DR02'?frame.gold.claims.filter(c=>c.required).length:metricId==='DR06'?frame.gold.chains.length:null},opportunities:[]} satisfies ResearchCount]));
}

/** Research ratios are derived from independent atom/match/link witnesses, never copied from generic relevance. */
export function deriveResearchCounts(input:unknown,proof:Pick<ResearchProof,'atoms'|'links'|'chains'>):Record<string,ResearchCount>{
 const frame=researchFrameSchema.parse(input),required=frame.gold.claims.filter(c=>c.required);
 if(frame.gold.status!=='verified')throw Error('Independent research Gold is not verified');
 if(new Set(frame.blocks.map(b=>b.key)).size!==frame.blocks.length||new Set(frame.links.map(l=>l.key)).size!==frame.links.length)throw Error('Duplicate original research identity');
 if(proof.links.length!==frame.links.length||proof.chains.length!==frame.gold.chains.length)throw Error('Research citation or chain enumeration differs');
 const matched=new Map<number,number>(),spans=new Map<number,Array<[number,number]>>();let previousBlock=-1,previousStart=-1;
 for(const[atomIndex,atom]of proof.atoms.entries()){
  const block=frame.blocks[atom.block],end=atom.start+atom.length;
  if(!block||!Number.isSafeInteger(atom.start)||atom.start<0||!Number.isSafeInteger(atom.length)||atom.length<1||end>block.text.length||
   !block.text.slice(atom.start,end).trim()||splitPair(block.text,atom.start)||splitPair(block.text,end))throw Error('Research atomic span does not bind original Report or Claim');
  if(atom.block<previousBlock||atom.block===previousBlock&&atom.start<=previousStart)throw Error('Atomic facts must retain original block/span order');previousBlock=atom.block;previousStart=atom.start;
  const previous=spans.get(atom.block)??[];if(previous.some(([start,stop])=>atom.start<stop&&end>start))throw Error('Overlapping or duplicate atomic spans');
  previous.push([atom.start,end]);spans.set(atom.block,previous);
  if(atom.gold<0||atom.gold>required.length||!Number.isInteger(atom.gold)||atom.matchUncertain&&atom.gold===0)throw Error('Research Gold match index is invalid');
  if(atom.gold){if(matched.has(atom.gold))throw Error('Duplicate Gold match; matching must be one-to-one');matched.set(atom.gold,atomIndex);}
 }
 const effectiveLinks=proof.links.map((link,i)=>{
  if(![0,1,2].includes(link.state)||link.atom< -1||link.atom>=proof.atoms.length||!Number.isInteger(link.atom)||link.atom===-1&&link.state===1)throw Error('Research citation target is invalid');
  const original=frame.links[i]!,state=original.valid===false||original.relation==='unbound'?0:original.valid===null?link.state===0?0:2:link.state;
  return{...link,state,original};
 });
 const uniqueLinks=[...new Map(effectiveLinks.map(link=>[JSON.stringify([link.atom,createHash('sha256').update(JSON.stringify(link.original.ref??link.original.display)).digest('hex')]),link])).values()];
 const coverage=proof.atoms.map((atom,index)=>{
  const links=effectiveLinks.filter(l=>l.atom===index);
  return atom.covered===1&&!links.some(l=>l.state===1)?frame.complete&&!links.some(l=>l.state===2)?0:2:atom.covered;
 });
 const goldStates=required.map((_,index)=>{
  const atom=proof.atoms[matched.get(index+1)??-1];return atom?atom.correct===0?0:atom.correct===2||atom.matchUncertain?2:1:frame.complete?0:2;
 });
 const chainStates=frame.gold.chains.map((chain,index)=>{
  const states=chain.claims.map(claimId=>{
   const goldIndex=required.findIndex(c=>c.id===claimId),atomIndex=matched.get(goldIndex+1),atom=atomIndex===undefined?undefined:proof.atoms[atomIndex];
   if(!atom)return frame.complete?0:2;
   if(goldStates[goldIndex]===0||coverage[atomIndex!]===0)return 0;
   if(goldStates[goldIndex]===2||coverage[atomIndex!]===2)return 2;
   if(frame.integrity.issues.some(issue=>issue.severity==='invalid'&&issue.kind==='claim'&&issue.id===frame.blocks[atom.block]!.claimId&&issue.code.startsWith('claim-dependency')))return 0;
   return 1;
  });
  const state=proof.chains[index];if(![0,1,2].includes(state!))throw Error('Research chain state is invalid');
  return states.includes(0)?0:states.includes(2)?2:state!;
 });
 const measured=(metricId:string,states:number[],complete:boolean,opportunities:unknown[]):ResearchCount=>{
  if(states.some(s=>![0,1,2].includes(s)))throw Error('Research witness state is invalid');
  const numerator=states.filter(s=>s===1).length,missing=complete?states.filter(s=>s===2).length:null,denominator=complete?states.length:null;
  return{row:denominator===null?null:[numerator,denominator,missing!],knownFailure:states.includes(0),statistics:{unit:formalMetric(metricId).unit,numerator,denominator,missing},opportunities};
 };
 return{
  DR01:measured('DR01',proof.atoms.map(a=>a.correct),frame.complete,proof.atoms),
  DR02:measured('DR02',goldStates,true,required.map((g,i)=>({id:g.id,atom:matched.get(i+1)??null,state:goldStates[i]}))),
  DR04:measured('DR04',uniqueLinks.map(l=>l.state),frame.complete,uniqueLinks),
  DR05:measured('DR05',proof.atoms.flatMap((a,i)=>a.needsCitation||a.gold>0?[coverage[i]!]:[]),frame.complete,proof.atoms.flatMap((a,i)=>a.needsCitation||a.gold>0?[{atom:i,state:coverage[i]}]:[])),
  DR06:measured('DR06',chainStates,true,frame.gold.chains.map((chain,i)=>({id:chain.id,state:chainStates[i]})))
 };
}
