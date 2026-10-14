import { expect, it } from 'bun:test';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';
import type { EvidenceRef } from '@flowmate/contracts';

it('explains rejected full report unresolvedQuestions and saves explicit partial within the same budget', async () => {
    let receipt: any, feedback = '', reportBeforeCorrection: number | null | undefined, f!: Awaited<ReturnType<typeof researchFixture>>;
    f = await researchFixture(async (request, index) => {
        if (index === 1) return {tool:'save_research_plan',id:'plan',args:{...researchPlan,sourcePolicy:f.task.sourcePolicy}};
        if (index === 3) return {tool:'read_research_local',id:'read',args:{artifactId:f.task.sourcePolicy.artifactIds[0],documentId:null}};
        if (index === 4) {
            receipt = JSON.parse(String(request.messages.filter(m=>m.role==='tool').at(-1)!.content));
            return {tool:'save_research_claim',id:'claim',args:{questionId:'cost-1',text:'Usage is metered.',dependencies:[],
                evidence:[{relation:'supports',ref:receipt.evidenceRef}],verification:{status:'supported',reasons:['The source explicitly states usage is metered.']}}};
        }
        if (index === 5 || index === 6) {
            const task=need(await f.app.queryResearchTask(f.task.researchId));
            const claimIds=need(await f.app.listResearchClaims({researchId:task.researchId,planId:task.currentPlanId!})).items.map(c=>c.claimId);
            if (index === 6) {
                feedback=String(request.messages.filter(m=>m.role==='tool').at(-1)!.content);
                reportBeforeCorrection=task.currentReportId;
            }
            return {tool:'save_research_report',id:index===5?'invalid-full':'explicit-partial',args:{answer:'Usage is metered.',
                sections:[{title:'Cost',text:'Usage is metered.',claimIds}],completeness:index===5?'full':'partial',conflicts:[],limitations:['Version-specific limits are unknown.'],
                unresolvedQuestions:['What version-specific limits apply?'],coverage:[{questionId:'cost-1',claimIds,status:index===5?'covered':'gap',reason:'Version-specific limits are unknown.'}]}};
        }
        return {text:'Inspect saved report facts.'};
    },undefined,{material:'Usage is metered.'});
    await f.run(f.request(1));
    const task=need(await f.app.queryResearchTask(f.task.researchId)),plan=need(await f.app.queryResearchPlan({researchId:task.researchId,planId:task.currentPlanId!}));
    const investigation=await f.run(f.request(2,{researchId:task.researchId,phase:'researching',plan:{planId:plan.planId,revision:plan.revision}}));
    const saved=need(await f.app.queryResearchTask(task.researchId));
    expect(feedback).toContain('unresolvedQuestions'); expect(feedback).toContain('[]'); expect(reportBeforeCorrection).toBeNull();
    expect(saved.status).toBe('partial');
    const report=need(await f.app.queryResearchReport({researchId:task.researchId,reportId:saved.currentReportId!}));
    expect(report.completeness).toBe('partial'); expect(report.runId).toBe(investigation.accepted.runId);
    const calls=need(await f.app.listRunToolCalls({runId:investigation.accepted.runId,sessionId:f.session.sessionId})).items;
    expect(calls).toHaveLength(4); expect(calls.filter(c=>c.status==='failed')).toHaveLength(1);
    expect(plan.body.execution.budget).toEqual(researchPlan.execution.budget);
    expect(investigation.terminal.result).toMatchObject({ok:true,data:{status:'completed',stopped:true}});
});

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
