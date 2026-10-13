import { judgeResponse } from '../support/judge-response.ts';
import {expect,test} from 'bun:test';
import {metricCatalog} from '../../src/scoring/catalog.ts';
import {formalRules,compileFormalSemanticPlan} from '../../src/scoring/formal-rules.ts';
import {caseV2Schema} from '../../src/dataset-loader/schema.ts';
import {task,observed} from '../support/fixtures.ts';
import {evaluateSemantic} from '../../src/scoring/evaluators/semantic.ts';
import {judgeConfig} from '../../src/scoring/judges/client.ts';

const judge=judgeConfig({FLOWMATE_JUDGE_API:'openai-completions',FLOWMATE_JUDGE_PROVIDER:'openai-compatible',FLOWMATE_JUDGE_MODEL:'llama-3.3-70b-versatile',FLOWMATE_JUDGE_BASE_URL:'http://127.0.0.1:9/v1',FLOWMATE_JUDGE_API_KEY:'synthetic-only'})!;
test('original 33 identities, units, methods and evidence are explicit',()=>{
    expect(formalRules).toHaveLength(33);expect(new Set(formalRules.map(r=>r.metricId)).size).toBe(33);
    for(const rule of formalRules){const metric=metricCatalog.find(m=>m.id===rule.metricId)!;expect(rule.unit).toBe(metric.unit);expect(rule.rule.length).toBeGreaterThan(20);expect(rule.evidence.length).toBeGreaterThan(0);}
});
test('independent per-material Gold is bound to Judge criteria and never projected to the Agent',async()=>{
    const metric=metricCatalog.find(m=>m.id==='completion-verification')!;
    const item=caseV2Schema.parse({...structuredClone(task),contract:'flowmate-agent-case/v2',input:{...task.input,materials:[...task.input.materials,{...task.input.materials[0]!,sample:'000002'}]},
        expected:{...task.expected,reference:{...task.expected.reference!,status:'verified'},materialReferences:[{sample:task.input.materials[0]!.sample,reference:{...task.expected.reference!,status:'verified'}},
            {sample:'000002',reference:{...task.expected.reference!,status:'verified',fields:{invoiceNumber:'SECOND_INDEPENDENT_GOLD'}}}],
            metrics:metricCatalog.map(m=>m.id===metric.id||m.id==='task-success'?{metricId:m.id,version:m.version,unit:m.unit,denominator:1}:{metricId:m.id,version:m.version,unit:m.unit,notApplicable:'Independent multi-material fixture.'})}});
    const plan=compileFormalSemanticPlan(item)!;expect(plan.criteria[0]!.evidence).toContain('gold-materials');
    for(const references of [[item.expected.materialReferences![0],item.expected.materialReferences![0]],
        [item.expected.materialReferences![0],{...item.expected.materialReferences![1],sample:'unselected'}]])
        expect(caseV2Schema.safeParse({...item,expected:{...item.expected,materialReferences:references}}).success).toBe(false);
    const result=observed();for(const key of plan.criteria[0]!.evidence)if(!key.startsWith('gold-'))result.evidence[key]={present:true,actual:{original:true},source:'Independent actual result'};
    const judged=await evaluateSemantic({task:item,result,projected:result.input,semanticPlan:plan,judge,fetcher:async(_,init)=>{
        const request=JSON.parse(JSON.parse(String(init.body)).messages[1].content);
        expect(JSON.stringify(request.evidence.facts['gold-materials'])).toContain('SECOND_INDEPENDENT_GOLD');
        expect(JSON.stringify(request.evidence.input)).not.toContain('SECOND_INDEPENDENT_GOLD');
        return judgeResponse({choices:[{message:{content:'{"v":1,"r":[[0,1,0]],"f":[]}'},finish_reason:'stop'}]});
    }});expect(judged.judgeCalls).toHaveLength(1);expect(judged.scores[0]!.status).toBe('FAIL');
});
test('one controlled judgment retains separate tool choice, wrong amount and blocked model violation counts',async()=>{
    const selected=['tool-selection','tool-arguments','model-violation'];
    const item=caseV2Schema.parse({...structuredClone(task),contract:'flowmate-agent-case/v2',expected:{...task.expected,reference:{...task.expected.reference!,status:'verified'},
        metrics:metricCatalog.map(m=>selected.includes(m.id)||m.id==='task-success'?{metricId:m.id,version:m.version,unit:m.unit,denominator:1}:{metricId:m.id,version:m.version,unit:m.unit,notApplicable:'Independent adversarial fixture.'})}});
    const plan=compileFormalSemanticPlan(item)!,result=observed();
    for(const key of new Set(plan.criteria.flatMap(c=>c.evidence)))if(!key.startsWith('gold-'))result.evidence[key]={present:true,
        actual:{original:true,appropriateRead:true,citationValid:true,amount:'WRONG',modelForbiddenRequest:true,requestBlocked:true},source:'Independent adversarial original records'};
    let calls=0;const judged=await evaluateSemantic({task:item,result,projected:result.input,semanticPlan:plan,judge,fetcher:async(_,init)=>{
        calls++;const body=JSON.parse(String(init.body));expect(body).toHaveProperty('max_completion_tokens', 32768);expect(body).not.toHaveProperty('temperature');
        const input=JSON.parse(body.messages[1].content);expect(input.plan.criteria).toHaveLength(3);
        expect(input.plan.criteria.find((c:{metricId:string})=>c.metricId==='model-violation').rule).toContain('平台成功拦截不能抹去');
        return judgeResponse({choices:[{message:{content:JSON.stringify({v:1,r:plan.criteria.map(c=>[c.metricId==='tool-arguments'?0:1,1,0]),f:[]})},finish_reason:'stop'}]});
    }});
    expect(calls).toBe(1);expect(judged.scores.map(s=>[s.metricId,s.status,s.statistics!.numerator])).toEqual([
        ['tool-selection','PASS',1],['tool-arguments','FAIL',0],['model-violation','FAIL',1]]);
});
for(const rule of formalRules.filter(r=>r.method==='llm-judge'))for(const outcome of ['positive','negative','missing'] as const)test(rule.metricId+' declared semantic opportunity: '+outcome,async()=>{
    const metric=metricCatalog.find(m=>m.id===rule.metricId)!;
    const item=caseV2Schema.parse({...structuredClone(task),contract:'flowmate-agent-case/v2',expected:{...task.expected,reference:{...task.expected.reference,status:'verified'},metrics:metricCatalog.map(m=>m.id===metric.id||m.id==='task-success'?
        {metricId:m.id,version:m.version,unit:m.unit,denominator:1}:{metricId:m.id,version:m.version,unit:m.unit,notApplicable:'Independent single-metric engineering fixture.'})}});
    const plan=compileFormalSemanticPlan(item)!;expect(plan.criteria).toHaveLength(1);expect(plan.criteria[0]!.metricId).toBe(metric.id);
    const result=observed();result.answer='A source citation is structurally valid but the amount is wrong; resource was assembled but never read; old fact contradicts current correction.';
    for(const key of plan.criteria[0]!.evidence)if(!key.startsWith('gold-'))result.evidence[key]={present:outcome!=='missing',actual:outcome==='missing'?null:{original:true,amount:'WRONG',assembledOnly:true,blockedForbiddenRequest:true},source:'Independent synthetic original evidence'};
    let calls=0;
    const value=outcome==='positive'?(metric.direction==='up'?1:0):(metric.direction==='up'?0:1);
    const response=await evaluateSemantic({task:item,result,projected:result.input,semanticPlan:plan,judge,fetcher:async()=>{
        calls++;return judgeResponse({choices:[{message:{content:JSON.stringify({v:1,r:[[value,1,0]],f:[]})},finish_reason:'stop'}]});
    }});
    expect(calls).toBe(outcome==='missing'?0:1);expect(value).not.toBeNaN();
    expect(response.scores).toHaveLength(1);expect(response.scores[0]!.metricId).toBe(metric.id);
    expect(response.scores[0]!.status).toBe(outcome==='missing'?'UNJUDGEABLE':outcome==='positive'?'PASS':'FAIL');
    expect(response.scores[0]!.statistics).toMatchObject({unit:metric.unit,denominator:1});
});
