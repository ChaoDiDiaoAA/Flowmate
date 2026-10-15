import {expect,test} from 'bun:test';
import {formalRules} from '../../src/scoring/formal-rules.ts';
import {evaluateFormalMetrics} from '../../src/scoring/evaluators/formal.ts';
import {formalFixture} from '../support/formal.ts';
import type {ToolCallSnapshot} from '../../../packages/contracts/src/activity.ts';
import type {EvaluationContext,EvaluationScore} from '../../src/scoring/types.ts';
import {evaluateAll} from '../../src/scoring/evaluate.ts';
import {aggregate} from '../../src/scoring/aggregate.ts';

test('valid task endpoint with a wrong independent Gold field fails formal task success once',async()=>{
    const context=fixture('task-success');
    context.task.expected.reference={...context.task.expected.reference!,status:'verified'};
    context.result.evidence['task-endpoint']={present:true,actual:true,source:'Original task endpoint'};
    context.result.evidence['candidate-fields']={present:true,actual:{invoiceNumber:'WRONG'},source:'Actual saved original candidate'};
    const {scores}=await evaluateAll(context,[{metric:'task-result',required:true},{metric:'reference-fields',required:true}]);
    const measured=scores.filter(s=>s.metricId==='task-success');expect(measured).toHaveLength(1);
    expect(measured[0]).toMatchObject({value:0,status:'FAIL',statistics:{unit:'Trial',numerator:0,denominator:1,missing:0}});
});

const fixture=formalFixture;
for(const rule of formalRules.filter(r=>r.method==='deterministic'))test(rule.metricId+' missing original evidence never passes',()=>{
    const context=fixture(rule.metricId),score=evaluateFormalMetrics(context).find(s=>s.metricId===rule.metricId)!;
    expect(score.status).toBe('UNJUDGEABLE');expect(score.value).toBeNull();expect(score.statistics?.unit).toBe(rule.unit);
});
function originalTool(failed=false):ToolCallSnapshot{
    const at='2026-10-12T00:00:00.000Z';
    const error={code:'tool_execution_failed' as const,category:'tool' as const,message:'Original fixture execution failure',retryable:false};
    return{toolCallId:1,runId:1,sessionId:1,nativeToolCallId:'original',context:null,toolName:'read_invoice_evidence',toolVersion:'1',effect:'READ',status:failed?'failed':'succeeded',
        args:{version:1,raw:{documentId:1,page:1,kind:'parsed',blockId:'b1'},final:{documentId:1,page:1,kind:'parsed',blockId:'b1'}},
        result:failed?{version:1,status:'failed',committedCandidateId:null,error}:{version:1,status:'succeeded',committedCandidateId:null,data:{kind:'parsed',source:{documentId:1,version:'synthetic-v1',artifactId:2,page:1,blockId:'b1',quote:'Synthetic'},text:'Synthetic original',sourceType:'text'}},
        delivery:{version:1,state:'request_observed',messageObservedAt:at,includedInCallSequence:2,requestDispatchedAt:at,error:null},cleanup:{version:1,stopReason:null,stopped:true,errors:[]},
        runtimeObservation:{version:1,groupKey:'synthetic',strategyVersion:'runtime-v1',sampleSource:'test',beforeOutcome:'allowed',failureStage:failed?'execute':null,
            diagnosticCode:failed?'tool_execution_failed':null,afterStructure:failed?'unknown':'valid',afterDomain:failed?'unknown':'valid',executionDurationMs:1,timingComplete:true,
        effectiveTimeoutMs:1000,timeoutSource:'configured',runDeadlineTruncated:false,commit:'none_confirmed',commitError:null},requestedAt:at,startedAt:at,endedAt:at,stoppedAt:at};
}
function originalFacts(context:EvaluationContext,tools:ToolCallSnapshot[]){
    const at='2026-10-12T00:00:00.000Z';
    context.result.evidence.runs={present:true,actual:[{runId:1,sessionId:1,kind:'agent',status:'completed',scope:{version:2,allowedTools:['read_invoice_evidence'],allowedDocumentIds:[1],allowedArtifactIds:[2],allowedResourcePaths:[]},
        stoppedAt:at,cleanup:{stopped:true},config:{runtimeBudget:{maxToolCalls:4}}}],source:'Independent original Run'};
    context.result.evidence['tool-evidence']={present:true,actual:{calls:tools.map(tool=>({tool,bytes:Buffer.byteLength(JSON.stringify(tool))}))},source:'Independent original ToolCall'};
}
test('zero-tool negative controls retain tool and Skill opportunities locally and preserve missing evidence',()=>{
    const context:EvaluationContext=fixture('tool-selection','skill-selection','progressive-reading');
    context.task.expected.maxToolCalls=0;
    context.gradedScores=[{metricId:'fact-check/forbidden-skills',name:'No forbidden Skill read',version:1,method:'deterministic',required:true,value:1,status:'PASS',reason:'Complete original resource observations',evidence:['resources']}];
    originalFacts(context,[]);
    context.result.evidence.resources={present:true,actual:[{runId:1,sessionId:1,frozen:null,gap:null,evidence:{version:1,reads:[],expansions:[],requests:[]}}],source:'Original Run resource journal'};
    for(const id of ['tool-selection','skill-selection','progressive-reading']){
        const score=evaluateFormalMetrics(context).find(s=>s.metricId===id)!;
        expect(score).toMatchObject({method:'deterministic',status:'PASS',statistics:{numerator:1,denominator:1,missing:0}});
    }
    originalFacts(context,[originalTool()]);
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-selection')).toMatchObject({status:'FAIL',value:0});
    context.result.evidence['tool-evidence']!.present=false;
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-selection')).toMatchObject({status:'FAIL'});
    context.result.evidence['tool-evidence']!.actual=null;
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-selection')).toMatchObject({status:'UNJUDGEABLE',value:null});
});
test('zero-tool absence never passes without original root and matching resource identities',()=>{
    const context:EvaluationContext=fixture('tool-selection','skill-selection','progressive-reading');
    context.task.expected.maxToolCalls=0;
    context.gradedScores=[{metricId:'fact-check/forbidden-skills',name:'No forbidden Skill read',version:1,method:'deterministic',required:true,value:1,status:'PASS',reason:'Observation',evidence:['resources']}];
    originalFacts(context,[]);
    context.result.evidence.runs!.actual=[];
    expect(evaluateFormalMetrics(context).filter(s=>s.metricId!=='task-success').every(s=>s.status!=='PASS')).toBe(true);
    originalFacts(context,[]);
    for(const runId of [null,2]){
        context.result.evidence.resources={present:true,actual:runId===null?[]:[{runId,sessionId:1,frozen:null,gap:null,evidence:{version:1,reads:[],expansions:[],requests:[]}}],source:'Empty or foreign resource collection'};
        expect(evaluateFormalMetrics(context).filter(s=>['skill-selection','progressive-reading'].includes(s.metricId)).every(s=>s.status!=='PASS')).toBe(true);
    }
});
for(const status of ['succeeded','failed','missing'] as const)test('tool-execution original protocol '+status,()=>{
    const context=fixture('tool-execution'),tool=originalTool(status==='failed');originalFacts(context,[tool]);
    context.result.evidence['tool-evidence']={present:status!=='missing',actual:status==='missing'?null:{calls:[{tool,bytes:Buffer.byteLength(JSON.stringify(tool))}]},source:'Independent synthetic original ToolCall'};
    const score=evaluateFormalMetrics(context).find(s=>s.metricId==='tool-execution')!;
    expect(score.status).toBe(status==='succeeded'?'PASS':status==='failed'?'FAIL':'UNJUDGEABLE');
    expect(score.statistics).toMatchObject({unit:'实际调用',denominator:status==='missing'?null:1});
});

test('a hash-valid ToolCall from a foreign Session cannot establish protocol success',()=>{
    const context=fixture('tool-execution'),tool=originalTool();tool.sessionId=2;originalFacts(context,[tool]);
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-execution')!.status).toBe('UNJUDGEABLE');
});
test('duplicate original ToolCall identities cannot multiply measured opportunities',()=>{
    const context=fixture('tool-execution');originalFacts(context,[originalTool(),originalTool()]);
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-execution')).toMatchObject({status:'UNJUDGEABLE',statistics:{denominator:null}});
});
test('a delivery flag cannot establish delivery when the original Run identity is absent',()=>{
    const context=fixture('result-delivery');originalFacts(context,[originalTool()]);
    context.result.evidence.runs!.actual=[];context.result.evidence['context-requests']={present:true,actual:[],source:'Original request query'};
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='result-delivery')).toMatchObject({status:'UNJUDGEABLE',statistics:{denominator:1,missing:1}});
});
test('incomplete collection retains known execution failure without inventing its total denominator',()=>{
    const context=fixture('tool-execution');originalFacts(context,[originalTool(true)]);context.result.evidence['tool-evidence']!.present=false;
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-execution')).toMatchObject({status:'FAIL',value:null,statistics:{numerator:0,denominator:null,missing:null}});
});
test('a later provider billing failure does not erase an independently witnessed tool failure',()=>{
    const context=fixture('tool-execution');originalFacts(context,[originalTool(true)]);
    context.result.error={code:'provider_billing_failed',message:'Provider billing unavailable',infrastructure:true};
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-execution')).toMatchObject({status:'FAIL',value:0});
});
test('a later provider billing failure preserves an independently completed successful tool measurement',()=>{
    const context=fixture('tool-execution');originalFacts(context,[originalTool()]);
    context.result.error={code:'provider_billing_failed',message:'Provider billing unavailable',infrastructure:true};
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='tool-execution')).toMatchObject({status:'PASS',value:1});
});
test('observed opportunities exceeding a declared denominator are an explicit grading error with valid counts',()=>{
    const context=fixture('tool-execution');context.task.expected.metrics.find(m=>m.metricId==='tool-execution')!.denominator=1;
    const second=originalTool();second.toolCallId=2;second.nativeToolCallId='second';originalFacts(context,[originalTool(),second]);
    const score=evaluateFormalMetrics(context).find(s=>s.metricId==='tool-execution')!;
    expect(score).toMatchObject({status:'ERROR',value:null,statistics:{numerator:null,denominator:1,missing:1},actual:{observedOpportunities:2}});
});
for(const status of ['PASS','FAIL','UNJUDGEABLE'] as const)test('task success preserves independent necessary grade '+status,()=>{
    const context:EvaluationContext=fixture('task-success');context.gradedScores=[{metricId:'reference-fields',name:'Independent Gold',version:1,method:'deterministic',required:true,value:status==='PASS'?1:status==='FAIL'?0:null,status,reason:'Synthetic independent verdict',evidence:['candidate-fields']} satisfies EvaluationScore];
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='task-success')!.status).toBe(status);
});
for(const situation of ['allowed','wrong-document','missing-budget','unknown-rejection'] as const)test('admission independently checks original scope and budget '+situation,()=>{
    const context=fixture('runtime-admission'),tool=originalTool();
    if(situation==='wrong-document')tool.args.final={documentId:99,page:1,kind:'parsed',blockId:'b1'};
    if(situation==='unknown-rejection'){
        tool.status='failed';tool.startedAt=null;tool.result={version:1,status:'failed',committedCandidateId:null,error:{code:'tool_access_denied',category:'tool',message:'Unknown native admission',retryable:false}};
        tool.runtimeObservation!.beforeOutcome='rejected';
    }
    originalFacts(context,[tool]);
    if(situation==='missing-budget')(context.result.evidence.runs!.actual as Array<{config:Record<string,unknown>}>)[0]!.config={};
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='runtime-admission')!.status).toBe(situation==='allowed'?'PASS':situation==='wrong-document'?'FAIL':'UNJUDGEABLE');
});
test('a confirmed absence of completion declarations keeps the rate unknown without failing a separately verified task',()=>{
    const context:EvaluationContext=fixture('task-success','false-completion');
    context.semanticPlan={contract:'flowmate-semantic-plan/v1',criteria:[{metricId:'false-completion',version:1,unit:'完成声明',denominator:null,required:true,rule:'Inspect actual declarations.',evidence:['answer'],trigger:'started'}]};
    context.gradedScores=[{metricId:'reference-fields',name:'Independent result',version:1,method:'deterministic',required:true,value:1,status:'PASS',reason:'Independent Gold verified',evidence:['candidate-fields']},
        {metricId:'false-completion',name:'Original declarations',version:1,method:'llm-judge',required:true,value:null,status:'UNJUDGEABLE',reason:'Original query confirmed no declaration',evidence:['answer'],statistics:{unit:'完成声明',numerator:0,denominator:0,missing:0}}];
    const scores=[...context.gradedScores,...evaluateFormalMetrics(context)];
    expect(scores.find(s=>s.metricId==='task-success')!.status).toBe('PASS');
    expect(aggregate(scores,context.result).status).toBe('PASS');
    expect(scores.find(s=>s.metricId==='false-completion')!.status).toBe('UNJUDGEABLE');
});
test('admission accepts a correctly refused request after the actual product budget is exhausted',()=>{
    const context=fixture('runtime-admission');
    const calls=Array.from({length:5},(_,index)=>({...originalTool(),toolCallId:index+1,nativeToolCallId:'budget-'+index}));
    const last=calls[4]!;last.status='failed';last.startedAt=null;
    last.result={version:1,status:'failed',committedCandidateId:null,error:{code:'tool_access_denied',category:'tool',message:'Actual budget refused',retryable:false}};
    Object.assign(last.runtimeObservation!,{beforeOutcome:'rejected',executionDurationMs:null,timingComplete:false});
    originalFacts(context,calls);
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='runtime-admission')).toMatchObject({status:'PASS',statistics:{numerator:5,denominator:5,missing:0}});
});
test('retry compliance uses the declared scenario policy instead of an independent hardcoded limit',()=>{
    const context=fixture('retry-compliance'),failed=originalTool(true),next={...originalTool(),toolCallId:2,nativeToolCallId:'next'};
    originalFacts(context,[failed,next]);
    context.result.evidence['case-controller']={present:true,actual:{exposure:{verified:true},policy:{maxRecoveryAttempts:0},original:failed,recovery:{attempts:1}},source:'Declared scenario policy and original attempts'};
    expect(evaluateFormalMetrics(context).find(s=>s.metricId==='retry-compliance')).toMatchObject({status:'FAIL'});
});
