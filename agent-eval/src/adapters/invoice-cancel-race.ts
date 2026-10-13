import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { RuntimeToolPageSchema } from '../../../packages/contracts/src/events.ts';
import { SubagentDetailSchema } from '../../../packages/contracts/src/subagents.ts';
import { ToolCallSnapshotSchema } from '../../../packages/contracts/src/tool-evidence.ts';
import { DocumentRefSchema } from '../../../packages/contracts/src/invoice.ts';
import { candidateSchema, candidateSummarySchema } from './invoice-evidence.ts';
import { collectToolEvidence } from './tool-evidence.ts';
import { collectSubagentEvidence } from './subagent-evidence.ts';
import type { EvidenceFact } from '../types.ts';

type Run={status:string;stoppedAt:string|null;cleanup:Record<string,unknown>};
/** Observe the original race. Only independent engineering fixtures hold a transaction boundary. */
export async function cancelOriginalSave(client:HostClient,owner:{runId:number;sessionId:number},signal:AbortSignal,readRun:(runId:number)=>Promise<Run>){
    const actual:Record<string,unknown>={profile:{id:'invoice-save-cancel-race',version:1},exposure:{verified:false},cancelRequests:0,resends:0,linearization:'commit-unknown',candidateCount:null,stopConfirmed:false};
    const evidence:EvidenceFact={present:true,actual,source:'Original in-flight save, one public cancellation, hash-bound commit and every descendant stop'};
    async function query<T>(command:Parameters<HostClient['request']>[0],schema:z.ZodType<T>):Promise<T>{
        const result=z.object({ok:z.boolean(),data:z.unknown().optional(),error:z.unknown().optional()}).strict().parse(await client.request(command));
        if(!result.ok)throw new Error(command.type+': original query unavailable');return schema.parse(result.data);
    }
    const deadline=performance.now()+30000;
    while(performance.now()<deadline){
        signal.throwIfAborted();const run=await readRun(owner.runId);
        let beforeId:number|undefined,original:z.infer<typeof RuntimeToolPageSchema>['items'][number]|undefined;
        for(let n=0;n<10000;n++){
            const page=await query({type:'list_run_tool_calls',input:{...owner,beforeId,limit:100}},RuntimeToolPageSchema);
            if(page.items.some(c=>c.runId!==owner.runId||c.sessionId!==owner.sessionId||beforeId!==undefined&&c.toolCallId>=beforeId))throw new Error('Foreign or repeated cancel trigger');
            original=page.items.find(c=>c.toolName==='save_invoice_candidate'&&c.status==='running'&&c.startedAt!==null);
            if(original||page.nextBeforeId===null)break;
            if(!page.items.length||page.nextBeforeId!==page.items.at(-1)!.toolCallId)throw new Error('Cancel trigger cursor did not advance');
            beforeId=page.nextBeforeId;
            if(n===9999)throw new Error('Cancel trigger page bound exceeded');
        }
        if(original&&run.status==='running'){
            actual.trigger=original;actual.exposure={verified:true};actual.cancelRequests=1;
            actual.receipt=await query({type:'cancel_run',runId:owner.runId},z.object({runId:z.literal(owner.runId),accepted:z.boolean()}).strict());
            const stoppingDeadline=performance.now()+10000;
            try{
                while(performance.now()<stoppingDeadline){
                    signal.throwIfAborted();const root=await readRun(owner.runId),children:z.infer<typeof SubagentDetailSchema>[]=[];
                    const queue=[owner],seen=new Set<number>([owner.runId]);
                    for(let i=0;i<queue.length;i++){
                        if(queue.length>1000)throw new Error('Descendant stop bound exceeded');
                        const fact=await collectSubagentEvidence(client,[queue[i]!]);
                        if(!fact.present)throw new Error('Descendant stop evidence unavailable');
                        const items=z.object({children:z.array(SubagentDetailSchema)}).passthrough().parse(fact.actual).children;
                        for(const child of items){
                            if(seen.has(child.childRunId))throw new Error('Repeated descendant stop identity');
                            seen.add(child.childRunId);children.push(child);queue.push({runId:child.childRunId,sessionId:child.childSessionId});
                        }
                    }
                    actual.root=root;actual.descendants=children;
                    actual.stopConfirmed=!['created','running'].includes(root.status)&&root.stoppedAt!==null&&root.cleanup.stopped===true&&root.cleanup.lateObservationRequired!==true&&
                        children.every(c=>!['created','running'].includes(c.status)&&c.stopConfirmed&&c.cleanup.lateObservationRequired!==true);
                    if(actual.stopConfirmed)break;
                    await delay(50,undefined,{signal});
                }
                if(!actual.stopConfirmed){actual.stopError='Original save or descendant stopping is unconfirmed';return{cancelled:true,evidence};}
                const fact=await collectToolEvidence(client,[original]);actual.original=fact;
                if(!fact.present)throw new Error('Original commit query unavailable');
                const call=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough()).length(1)}).passthrough().parse(fact.actual).calls[0]!.tool;
                if(!call.cleanup.stopped||call.stoppedAt===null||!call.result)throw new Error('Original commit stopping is unknown');
                const rootRecord=await client.request({type:'query_run',runId:owner.runId});
                const job=z.object({ok:z.literal(true),data:z.object({jobId:z.number().int().positive()}).passthrough()}).strict().parse(rootRecord).data.jobId;
                const history:z.infer<typeof candidateSummarySchema>[]=[];let beforeSequence:number|undefined;
                for(let page=0;page<10000;page++){
                    const value=await query({type:'list_job_candidates',input:{jobId:job,beforeSequence,limit:100}},z.object({items:z.array(candidateSummarySchema),nextBeforeSequence:z.number().int().positive().nullable()}).strict());
                    if(value.items.some(c=>c.jobId!==job||beforeSequence!==undefined&&c.sequence>=beforeSequence))throw new Error('Foreign or repeated commit history');
                    history.push(...value.items);if(value.nextBeforeSequence===null)break;
                    if(!value.items.length||value.nextBeforeSequence!==value.items.at(-1)!.sequence||page===9999)throw new Error('Commit history cursor did not advance');
                    beforeSequence=value.nextBeforeSequence;
                }
                actual.history=history;
                if(call.result.committedCandidateId!==null){
                    const detail=await query({type:'query_job_candidate',input:{jobId:job,candidateId:call.result.committedCandidateId}},z.object({documentRef:DocumentRefSchema,candidate:candidateSchema}).strict());
                    if(detail.candidate.toolCallId!==call.toolCallId||detail.candidate.runId!==owner.runId||!history.some(c=>c.candidateId===detail.candidate.candidateId))throw new Error('Original committed candidate differs');
                    actual.candidate=detail;actual.linearization='commit-before-cancel';actual.candidateCount=history.length;
                }else if(call.runtimeObservation?.commit==='none_confirmed'&&history.length===0){actual.linearization='cancel-before-commit';actual.candidateCount=0;}
                actual.resends=0;
            }catch(error){actual.observationError=String(error);}
            return{cancelled:true,evidence};
        }
        if(!['created','running'].includes(run.status))break;
        await delay(50,undefined,{signal});
    }
    return{cancelled:false,evidence};
}
