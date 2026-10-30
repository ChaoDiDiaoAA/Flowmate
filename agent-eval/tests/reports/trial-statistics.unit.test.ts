import { expect, test } from 'bun:test';
import type { LocalReport } from '../../src/reports/store.ts';
import { reportFixture } from '../support/fixtures.ts';
import { deriveResearchF1 } from '../../src/scoring/research-f1.ts';
import { aggregate } from '../../src/scoring/aggregate.ts';

async function derive(report: LocalReport) {
    const implementation = await import('../../src/reports/trial-statistics.ts').catch(() => null);
    expect(implementation, 'Pure Trial statistics implementation').not.toBeNull();
    return implementation!.deriveTrialStatistics(report);
}
function sample(states: Array<'PASS'|'FAIL'|'ERROR'|'NOT_RUN'|'UNJUDGEABLE'>): LocalReport {
    const r=reportFixture(), first=r.trials[0]!;
    r.contract='flowmate-agent-run/v2';r.repeat=states.length;
    r.trials=states.map((status,index)=>{
        const trial=structuredClone(first);trial.status=status;trial.repetition=index+1;trial.trialId='trial-'+(index+1);
        trial.traceId=(index+1).toString(16).padStart(32,'0');
        trial.metricPlan=[{metricId:'task-success',version:1,unit:'Trial',denominator:1}];
        if(trial.execution)trial.execution.identity.trialId=trial.trialId;
        if(status==='NOT_RUN')trial.execution=null;
        trial.scores=[];return trial;
    });
    return r;
}

test('Case statistics preserve all Trial identities and estimate all k without changing scores',async()=>{
    const r=sample(['PASS','FAIL','PASS','FAIL','PASS']),before=JSON.stringify(r);
    const result=await derive(r),c=result.cases[0]!;
    expect(c).toMatchObject({caseId:'sample',planned:5,started:5,complete:true,valid:true,statuses:{PASS:3,FAIL:2}});
    expect(c.trials.map(t=>t.trialIndex)).toEqual([1,2,3,4,5]);
    expect(c.probabilities).toHaveLength(5);
    expect(c.probabilities[0]).toMatchObject({k:1,passAtK:0.6,passAllK:0.6});
    expect(c.probabilities[1]!.passAtK).toBeCloseTo(0.9);
    expect(c.probabilities[1]!.passAllK).toBeCloseTo(0.3);
    expect(c.probabilities[2]!.passAllK).toBeCloseTo(0.1);
    expect(c.probabilities[4]).toEqual({k:5,passAtK:1,passAllK:0});
    expect(c.metrics.map(m=>m.metricId)).toEqual(['task-success']);
    expect(result.dataset).toMatchObject({plannedCases:1,validCases:1});
    expect(JSON.stringify(r)).toBe(before);
});

test('metric distributions use effective values and sample variance, not opportunity pooled ratios',async()=>{
    const r=sample(['PASS','FAIL','PASS']);
    for(const [index,trial] of r.trials.entries()){
        trial.metricPlan!.push({metricId:'tool-arguments',version:1,unit:'请求',denominator:2});
        trial.scores.push({metricId:'tool-arguments',version:1,name:'参数正确率',method:'deterministic',required:false,
            status:index===2?'PASS':'FAIL',value:index/2,reason:'observed',evidence:['call'],statistics:{unit:'请求',numerator:index,denominator:2,missing:0}});
    }
    const m=(await derive(r)).cases[0]!.metrics.find(m=>m.metricId==='tool-arguments')!;
    expect(m).toMatchObject({value:0.5,numerator:3,denominator:6,measured:3,applicable:3,mean:0.5,variance:0.25,standardDeviation:0.5});
    r.trials[1]!.scores[0]!.status='ERROR';r.trials[1]!.scores[0]!.value=null;r.trials[1]!.scores[0]!.statistics!.numerator=0;r.trials[1]!.scores[0]!.statistics!.missing=2;
    const partial=(await derive(r)).cases[0]!;
    expect(partial.valid).toBe(false);expect(partial.probabilities.every(p=>p.passAtK===null)).toBe(true);
    expect(partial.metrics.find(m=>m.metricId==='tool-arguments')).toMatchObject({measured:2,mean:0.5,variance:0.5});
});

test('incomplete, mixed Judge errors, invalidated and legacy facts cannot establish probability samples',async()=>{
    for(const states of [['PASS','ERROR'],['FAIL','UNJUDGEABLE'],['PASS','NOT_RUN']] as const){
        const c=(await derive(sample([...states]))).cases[0]!;
        expect(c.valid).toBe(false);expect(c.probabilities.every(p=>p.passAtK===null&&p.passAllK===null)).toBe(true);
    }
    const r=sample(['PASS','FAIL']);
    r.trials[1]!.scores.push({metricId:'diagnostic',version:1,name:'Judge fault',method:'llm-judge',required:false,status:'ERROR',value:null,reason:'failed',evidence:[]});
    expect((await derive(r)).cases[0]!.valid).toBe(false);
    r.trials[1]!.scores=[];r.sourceInvalidation={reason:'changed',paths:['source.ts']};
    const invalid=(await derive(r)).cases[0]!;expect(invalid.valid).toBe(false);expect(invalid.metrics[0]!.mean).toBeNull();
    delete r.sourceInvalidation;r.trials.pop();expect((await derive(r)).cases[0]!.complete).toBe(false);
    const legacy=await derive(reportFixture());expect(legacy.cases[0]!.valid).toBe(false);expect(legacy.cases[0]!.metrics).toEqual([]);
});

test('single, all-success, all-failure, missing and non-applicable observations remain distinct',async()=>{
    for(const status of ['PASS','FAIL'] as const){
        const r=sample([status,status,status]),c=(await derive(r)).cases[0]!;
        expect(c.probabilities.every(p=>p.passAtK===(status==='PASS'?1:0)&&p.passAllK===(status==='PASS'?1:0))).toBe(true);
    }
    const r=sample(['PASS']);
    r.trials[0]!.metricPlan!.push({metricId:'tool-arguments',version:1,unit:'请求',denominator:0},
        {metricId:'DR06',version:1,unit:'必需链',notApplicable:'No required chain'});
    const c=(await derive(r)).cases[0]!;
    expect(c.metrics.map(m=>m.metricId)).toEqual(['task-success','tool-arguments']);
    expect(c.metrics[0]).toMatchObject({variance:null,standardDeviation:null});
    expect(c.metrics[1]).toMatchObject({measured:0,mean:null,zeroDenominators:1});
    r.trials.push(structuredClone(r.trials[0]!));await expect(derive(r)).rejects.toThrow('Duplicate');
});

test('dataset probabilities macro-average only complete cases and report the actual coverage',async()=>{
    const r=sample(['PASS','PASS']);
    const other=structuredClone(r.trials[1]!);other.caseId='other';other.trialId='other-1';other.repetition=1;
    if(other.execution)Object.assign(other.execution.identity,{caseId:other.caseId,trialId:other.trialId});
    r.trials.push(other);
    const result=await derive(r);expect(result.dataset).toMatchObject({plannedCases:2,validCases:1});
    expect(result.dataset.probabilities[0]!.passAtK).toBe(1);
    r.trials.reverse();expect((await derive(r)).cases.find(c=>c.caseId==='sample')!.trials.map(t=>t.trialIndex)).toEqual([1,2]);
});

test('research F1 keeps the formal pooled value separate from the Trial distribution',async()=>{
    const r=sample(['PASS','PASS']);
    for(const [index,trial] of r.trials.entries()){
        for(const [metricId,numerator,denominator,unit] of [
            ['DR01',1,index?3:1,'事实Claim'],['DR02',1,2,'Gold Claim']] as const){
            trial.metricPlan!.push({metricId,version:1,unit,denominator:metricId==='DR01'?null:denominator});
            trial.scores.push({metricId,version:1,name:metricId,method:'llm-judge',required:false,status:'PASS',
                value:numerator/denominator,reason:'Independent match',evidence:['original'],statistics:{unit,numerator,denominator,missing:0}});
        }
        trial.metricPlan!.push({metricId:'DR03',version:1,unit:'派生F1',denominator:null});
        trial.scores.push(deriveResearchF1(trial.metricPlan!,trial.scores,trial.execution)!);
    }
    const metric=(await derive(r)).cases[0]!.metrics.find(m=>m.metricId==='DR03')!;
    expect(metric).toMatchObject({value:0.5,numerator:null,denominator:null,measured:2});
    expect(metric.mean).toBeCloseTo((2/3+0.4)/2);
});

test('an empty original metric plan cannot establish a valid probability sample',async()=>{
    const r=sample(['PASS']);r.trials[0]!.metricPlan=[];
    const c=(await derive(r)).cases[0]!;
    expect(c.valid).toBe(false);expect(c.reasons).toContain('缺少原始正式指标计划');
});

test('missing or partial required semantic measurements exclude a preserved FAIL from probabilities',async()=>{
    for(const measurement of ['missing','partial','unknown'] as const){
        const r=sample(['FAIL']),trial=r.trials[0]!;
        const denominator=measurement==='unknown'?null:2;
        trial.metricPlan!.push({metricId:'tool-arguments',version:1,unit:'请求',denominator});
        trial.semanticPlan={contract:'flowmate-semantic-plan/v1',criteria:[{metricId:'tool-arguments',version:1,unit:'请求',
            denominator,required:true,rule:'Check every original argument',evidence:['tool-calls'],trigger:'started'}]};
        if(measurement!=='missing')trial.scores.push({metricId:'tool-arguments',version:1,name:'参数正确率',method:'llm-judge',
            required:true,status:'FAIL',value:null,reason:'Known failure with incomplete evidence',evidence:['tool-calls'],
            statistics:{unit:'请求',numerator:measurement==='partial'?0:null,denominator,missing:measurement==='partial'?1:null}});
        const before=JSON.stringify(r),statistics=await derive(r),c=statistics.cases[0]!;
        expect(c.valid).toBe(false);expect(c.reasons).toContain('包含评分或设施故障');
        expect(c.statuses.FAIL).toBe(1);expect(c.probabilities.every(p=>p.passAtK===null&&p.passAllK===null)).toBe(true);
        expect(statistics.dataset.validCases).toBe(0);expect(JSON.stringify(r)).toBe(before);
    }
});

test('required semantic eligibility respects actual zero opportunities and declared triggers',async()=>{
    for(const triggered of [true,false]){
        const r=sample(['FAIL']),trial=r.trials[0]!;
        const denominator=triggered?null:2;
        trial.metricPlan!.push({metricId:'tool-arguments',version:1,unit:'请求',denominator});
        trial.semanticPlan={contract:'flowmate-semantic-plan/v1',criteria:[{metricId:'tool-arguments',version:1,unit:'请求',
            denominator,required:true,rule:'Check original arguments when triggered',evidence:['tool-calls'],
            trigger:triggered?'started':'completed-endpoint'}]};
        if(!triggered)Object.assign(trial.execution!,{status:'failed',endpointReached:false});
        trial.scores.push({metricId:'tool-arguments',version:1,name:'参数正确率',method:'llm-judge',required:true,
            status:triggered?'UNJUDGEABLE':'NOT_RUN',value:null,reason:triggered?'Observed zero opportunities':'Trigger not reached',
            evidence:['tool-calls'],statistics:{unit:'请求',numerator:triggered?0:null,denominator:triggered?0:denominator,missing:triggered?0:denominator}});
        if(triggered){
            expect((await derive(r)).cases[0]!.valid).toBe(false);
            trial.scores[0]!.required=false;
            expect((await derive(r)).cases[0]!.valid).toBe(false);
            trial.scores[0]!.required=true;
            trial.scores[0]!.judge={callId:'10000000-0000-4000-8000-000000000001',criterion:0};
            trial.judgeCalls=[{callId:'10000000-0000-4000-8000-000000000001',configuration:{provider:'codex-cli',transport:'codex-cli',model:'synthetic',
                reasoningEffort:'max',timeoutMs:180000,protocolVersion:'flowmate-judge/v2'},startedAt:'2026-10-30T00:00:00Z',endedAt:'2026-10-30T00:00:01Z',
                attempts:1,usage:{},responseModel:'synthetic',raw:'original response',error:null,judgment:null,request:{system:'Declared rubric',data:'{}',redacted:false},
                stopReason:'stop',rawStopReason:null,usageSource:'codex-cli',responseComplete:true,
                compact:{plan:structuredClone(trial.semanticPlan),judgment:{v:1,r:[[0,0,0]],f:[]},validationErrors:{}}}];
        }
        const c=(await derive(r)).cases[0]!;
        expect(c.valid).toBe(true);expect(c.probabilities[0]!.passAtK).toBe(0);
        expect(c.metrics.find(m=>m.metricId==='tool-arguments')!.measured).toBe(0);
    }
});

test('cancelled Trials preserve hard FAIL facts but cannot become completed probability samples',async()=>{
    for(const executionComplete of [false,true]){
        const r=sample(['FAIL']),trial=r.trials[0]!;
        r.executionComplete=executionComplete;trial.execution!.status='cancelled';trial.execution!.endpointReached=false;
        trial.scores.push({metricId:'task-result',version:1,name:'Required task result',method:'deterministic',required:true,
            status:'FAIL',value:0,reason:'Known failure before cancellation',evidence:['task-endpoint']});
        expect(aggregate(trial.scores,trial.execution!).status).toBe('FAIL');
        const before=JSON.stringify(r),statistics=await derive(r),c=statistics.cases[0]!;
        expect(c).toMatchObject({complete:false,valid:false,statuses:{FAIL:1}});
        expect(c.probabilities.every(p=>p.passAtK===null&&p.passAllK===null)).toBe(true);
        expect(c.metrics[0]!.measured).toBe(0);expect(statistics.dataset.validCases).toBe(0);
        expect(JSON.stringify(r)).toBe(before);
    }
});

test('an incomplete Execution cannot establish eligible Case probability summaries',async()=>{
    const r=sample(['PASS']);r.executionComplete=false;
    const statistics=await derive(r),c=statistics.cases[0]!;
    expect(c.complete).toBe(true);expect(c.valid).toBe(false);
    expect(c.reasons).toContain('Execution未完整结束');expect(statistics.dataset.validCases).toBe(0);
    expect(statistics.dataset.probabilities[0]!.passAtK).toBeNull();
});
