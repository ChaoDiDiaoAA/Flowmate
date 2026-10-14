import {expect,test} from 'bun:test';
import {formalFixture} from '../support/formal.ts';
import {compileFormalSemanticPlan} from '../../src/scoring/formal-rules.ts';
import {evaluateAll} from '../../src/scoring/evaluate.ts';
import {judgeConfig} from '../../src/scoring/judges/client.ts';
import {judgeResponse,namedJudgment} from '../support/judge-response.ts';
import {caseV2Schema} from '../../src/dataset-loader/schema.ts';
import {semanticEvaluatorDefinitions} from '../../src/scoring/judges/evaluators.ts';

test('independent task and tool rubrics share one generation and unselected judges never enter the request',async()=>{
    const context=formalFixture('clarification-decision','tool-selection');
    context.task.expected.reference!.status='verified';
    context.task.expected.semantic=compileFormalSemanticPlan(context.task);
    const evidenceKeys=context.task.expected.semantic!.criteria.flatMap(c=>c.evidence).filter(k=>!k.startsWith('gold-'));
    for(const key of evidenceKeys)context.result.evidence[key]={present:true,actual:[],source:'Independent original observation'};
    const config=judgeConfig({FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_API_KEY:'unit-independent-key',FLOWMATE_JUDGE_BASE_URL:'https://unused.invalid/v1'})!;
    let requests=0;
    const scored=await evaluateAll({...context,judge:config,fetcher:async(_url,init)=>{
        requests++;
        const request=JSON.parse(JSON.parse(String(init.body)).messages[1].content);
        expect(request.evidence.evaluatorRubrics.map((r:{id:string})=>r.id)).toEqual(['task-judge','tool-use-judge']);
        expect(request.evidence.evaluatorRubrics.every((r:{instructions:string})=>r.instructions.length>30)).toBe(true);
        const plan=request.plan;
        return judgeResponse({choices:[{message:{content:namedJudgment(plan,{v:1,r:plan.criteria.map(()=>[1,1,0]),f:[]})},finish_reason:'stop'}]});
    }},[]);
    expect(requests).toBe(1);
    expect(scored.judgeCalls).toHaveLength(1);
    expect(scored.scores.find(s=>s.metricId==='clarification-decision')).toMatchObject({evaluatorId:'task-judge',category:'formal',value:1});
    expect(scored.scores.find(s=>s.metricId==='tool-selection')).toMatchObject({evaluatorId:'tool-use-judge',category:'formal',value:1});
    for(const def of semanticEvaluatorDefinitions){
        const own=def.prepare!({...context,judge:config});
        expect(own.every(c=>def.outputs!.includes(c.metricId))).toBe(true);
        expect(def.parse!(scored.scores).every(s=>s.evaluatorId===def.id)).toBe(true);
    }
});

test('disabled necessary explanation diagnostic cannot pass the business task',async()=>{
    const context=formalFixture();
    const expected={...context.task.expected,diagnostics:[{evaluatorId:'task-judge' as const,required:true,reason:'Disclose the original partial failure',
        params:{metricId:'diagnostic-partial-failure-explanation' as const,denominator:1,evidence:['answer','tool-evidence']}}]};
    context.task=caseV2Schema.parse({...context.task,expected:{...expected,semantic:compileFormalSemanticPlan({...context.task,expected})}});
    const scored=await evaluateAll(context,[]);
    expect(scored.judgeCalls).toHaveLength(0);
    expect(scored.scores.find(s=>s.metricId==='diagnostic-partial-failure-explanation')).toMatchObject({status:'NOT_RUN',required:true});
    expect(scored.scores.find(s=>s.metricId==='task-success')?.status).not.toBe('PASS');
});

test('a missing specialist plan retains the required not-run score at the scoring boundary',async()=>{
    const context=formalFixture();
    context.task.expected.diagnostics=[{evaluatorId:'task-judge',required:true,reason:'Disclose the independently observed failure',
        params:{metricId:'diagnostic-partial-failure-explanation',denominator:1,evidence:['answer']}}];
    const scored=await evaluateAll(context,[]);
    expect(scored.scores.find(s=>s.metricId==='diagnostic-partial-failure-explanation')).toMatchObject({status:'NOT_RUN',required:true,statistics:{denominator:1,missing:1}});
    expect(scored.scores.find(s=>s.metricId==='task-success')?.status).not.toBe('PASS');
});
