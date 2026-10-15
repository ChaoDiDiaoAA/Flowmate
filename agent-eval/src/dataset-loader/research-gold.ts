import {z} from 'zod';

const id=z.string().regex(/^[a-z0-9][a-z0-9-]*$/),text=z.string().trim().min(1),integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const evidence=z.object({sample:id,start:integer,end:integer,quote:z.string().min(1),
 relation:z.enum(['support','contradiction'])}).strict().refine(v=>v.end>v.start&&v.end-v.start===v.quote.length,'Gold uses exact UTF-16 offsets');
export const researchGoldSchema=z.object({status:z.enum(['pending','verified']),claims:z.array(z.object({id,text,required:z.boolean(),acceptable:z.array(text).min(1),
 conditions:z.array(text),entities:z.array(text),evidence:z.array(evidence).min(1)}).strict()),chains:z.array(z.object({id,claims:z.array(id).min(2),
 links:z.array(z.object({from:id,to:id,entity:text}).strict()).min(1)}).strict()),forbidden:z.array(text)}).strict().superRefine((v,c)=>{
 const ids=v.claims.map(claim=>claim.id);
 if(new Set(ids).size!==ids.length||new Set(v.chains.map(chain=>chain.id)).size!==v.chains.length)c.addIssue({code:'custom',message:'Duplicate research Gold identity'});
 for(const chain of v.chains)if(new Set(chain.claims).size!==chain.claims.length||chain.claims.some(id=>!ids.includes(id))||
  chain.links.length!==chain.claims.length-1||chain.links.some((link,index)=>link.from!==chain.claims[index]||link.to!==chain.claims[index+1]||
   !v.claims.find(claim=>claim.id===link.from)?.entities.includes(link.entity)||!v.claims.find(claim=>claim.id===link.to)?.entities.includes(link.entity)))
  c.addIssue({code:'custom',message:'Gold chain needs all connected hops and shared intermediate entities'});
});
