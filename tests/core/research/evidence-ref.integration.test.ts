import { expect, it } from 'bun:test';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';
import type { EvidenceRef } from '@flowmate/contracts';

it('reuses exact emoji evidence from a planning Run, corrects one invalid Claim and saves partial within the confirmed budget', async()=>{
    const text='Usage is metered. 📚 Version-specific limits remain unknown.';
    let planningReceipt: any, receipt: any, f!: Awaited<ReturnType<typeof researchFixture>>;
    f=await researchFixture(async(request,index)=>{
        const last=()=>JSON.parse(String(request.messages.filter(m=>m.role==='tool').at(-1)!.content));
        if(index===1)return{tool:'read_research_local',args:{artifactId:f.task.sourcePolicy.artifactIds[0],documentId:null},id:'planning-read'};
        if(index===2){planningReceipt=last();return{tool:'save_research_plan',args:{...researchPlan,sourcePolicy:f.task.sourcePolicy},id:'plan'};}
        if(index===4)return{tool:'query_research_evidence',args:{sourceSnapshotId:planningReceipt.source.sourceSnapshotId,offset:0,limit:4000},id:'query'};
        if(index===5||index===6){
            if(index===5)receipt=last();
            else expect(String(request.messages.filter(m=>m.role==='tool').at(-1)!.content)).toContain('UTF-16');
            const ref:EvidenceRef=structuredClone(receipt.evidenceRef);
            if(index===5)ref.locator.end--;
            return{tool:'save_research_claim',id:index===5?'invalid-claim':'corrected-claim',args:{questionId:'cost-1',text:'Usage is metered.',dependencies:[],
                evidence:[{relation:'supports',ref}],verification:{status:'insufficient',reasons:['Version-specific conditions remain unknown.']}}};
        }
        if(index===7){
            const task=need(await f.app.queryResearchTask(f.task.researchId));
            const ids=need(await f.app.listResearchClaims({researchId:task.researchId,planId:task.currentPlanId!})).items.map(c=>c.claimId);
            return{tool:'save_research_report',id:'partial',args:{answer:'Usage is metered; limits need further evidence.',sections:[{title:'Cost',text:'Usage is metered.',claimIds:ids}],
                completeness:'partial',conflicts:[],limitations:['Version-specific limits are unavailable.'],unresolvedQuestions:['What version-specific limits apply?'],
                coverage:[{questionId:'cost-1',claimIds:ids,status:'gap',reason:'Version-specific conditions remain unknown.'}]}};
        }
        return{text:'Inspect the saved plan or partial report.'};
    },undefined,{material:text});
    const planning=await f.run(f.request(1));
    expect(planningReceipt.evidenceRef).toBeNull();
    const task=need(await f.app.queryResearchTask(f.task.researchId)),plan=need(await f.app.queryResearchPlan({researchId:task.researchId,planId:task.currentPlanId!}));
    const investigation=await f.run(f.request(2,{researchId:task.researchId,phase:'researching',plan:{planId:plan.planId,revision:plan.revision}}));
    expect(receipt.evidenceRef).toMatchObject({planId:plan.planId,revision:plan.revision,runId:planning.accepted.runId,locator:{start:0,end:text.length,quote:text}});
    expect(receipt.evidenceRef.runId).not.toBe(investigation.accepted.runId);
    const claims=need(await f.app.listResearchClaims({researchId:task.researchId,planId:plan.planId})).items;
    expect(claims).toHaveLength(1);expect(claims[0]!.evidence[0]!.ref).toEqual(receipt.evidenceRef);
    expect(need(await f.app.queryResearchTask(task.researchId)).status).toBe('partial');
    expect(need(await f.app.listRunToolCalls({runId:investigation.accepted.runId,sessionId:f.session.sessionId})).items).toHaveLength(4);
    expect(plan.body.execution.budget).toEqual(researchPlan.execution.budget);
    expect(investigation.terminal.result).toMatchObject({ok:true,data:{status:'completed',stopped:true}});
});
