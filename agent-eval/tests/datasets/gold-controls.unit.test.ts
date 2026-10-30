import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { expandCandidate } from '../../src/curation/expansion.ts';
import { candidateSchema } from '../../src/curation/schemas.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { expandHarness } from '../../src/dataset-loader/harness.ts';
import { createRegistry } from '../../src/scoring/registry.ts';
import type { CaseExecutionResult } from '../../src/types.ts';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';

function fixture(values:Record<string,unknown>={}) {
  const trace:TraceBundle={id:randomUUID(),revision:1,source:{kind:'product'},entry:'chats',startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z',
    input:{prompt:'Return the independent source value.'},output:{answer:'wrong'},status:'FAIL',complete:true,gaps:[],configuration:{},events:[],facts:{},
    materials:[{id:'reference',path:'references/answer.md',text:'The correct value is correct.'}]};
  const candidate=candidateSchema.parse({id:randomUUID(),revision:1,kind:'regression',traceRef:{id:trace.id,revision:1},reason:'Original source value was wrong.',sourceLabels:['independent-reference'],
    case:{name:'task_gold_control_boundary',category:'task',difficulty:'regression',purpose:'regression',source:'regression-bug',input:trace.input,
      expected:{success:['Return the correct source value.'],failure:['Return the wrong source value.'],maxToolCalls:0,mustHaveEvidence:false,expectedAnswerHint:'correct'},
      scoring:{deterministic:['fact-check'],judge:[],manual:'Pending human approval.'},risks:['Controlled Q&A only.'],tags:['business']},
    gold:{values,checks:[{metric:'fact-check',required:true,evidence:'answer',path:[],equals:'correct'}],opportunities:{'task-success':1},sources:['references/answer.md'],basis:'Independent source'},
    scenario:{requires:['agent'],materials:[],steps:[{id:'request',action:'user-message',instruction:'$input'}],selection:{enabledSkills:[],enabledExtensions:[]}}});
  return {trace,candidate};
}
const expand=(value:ReturnType<typeof fixture>)=>expandCandidate(REPO_ROOT,value.candidate,value.trace,'FM-999','gold-controls',1,REPO_ROOT);
function result():CaseExecutionResult {
  return {identity:{executionId:'controlled',trialId:'controlled',caseId:'FM-999',caseVersion:1},started:true,status:'completed',endpointReached:true,
    input:{prompt:'Return the independent source value.',materials:[]},answer:'wrong',artifacts:[],observations:[],configuration:{},usage:{},startedAt:null,endedAt:null,
    evidence:{answer:{present:true,actual:'wrong',source:'Original wrong answer'}}};
}
test('Gold values cannot replace a failing original check with a passing injected check in actual LocalCase',async()=>{
  const original=fixture(),data=expand(original),task=data.cases[0]!,execution=result(),grader=createRegistry().get('fact-check');
  const context={task,result:execution,projected:execution.input,judge:null};
  expect((await grader.evaluate(context,task.expected.checks[0]!)).status).toBe('FAIL');
  const attack=fixture();attack.candidate.gold!.values={checks:[{metric:'fact-check',required:true,evidence:'answer',path:[],equals:'wrong'}]};
  let outcome:string;
  try {
    const bypass=expand(attack).cases[0]!;
    outcome=(await grader.evaluate({...context,task:bypass},bypass.expected.checks[0]!)).status;
  } catch(error) { outcome=error instanceof Error?error.message:String(error); }
  expect(outcome).toContain('Gold must not overwrite Case constraint: checks');
});
test('raw Gold cannot override checks, formal metrics, semantic criteria, or authored success/failure declarations',()=>{
  for(const [key,value]of Object.entries({checks:[],metrics:[],semantic:{contract:'flowmate-semantic-plan/v1',criteria:[]},success:['Injected success'],failure:['Injected failure']})) {
    expect(()=>expand(fixture({[key]:value}))).toThrow('Gold must not overwrite Case constraint: '+key);
  }
});
test('shared Harness rejects raw plan injection before returning a derived execution contract',()=>{
  const raw={contract:'flowmate-eval-case/v4',id:'FM-999',version:1,name:'task_gold_controls',category:'task',purpose:'regression',source:{type:'controlled-workflow',basis:'Controlled source'},
    dataset:'synthetic',smoke:false,tags:['synthetic'],requires:['agent'],input:{prompt:'Return the source value.',materials:[]},environment:'isolated',
    expected:{success:['Correct'],failure:['Wrong'],checks:[{metric:'fact-check',required:true,evidence:'answer',path:[],equals:'correct'}]},
    scoring:{methods:['deterministic'],metrics:{'task-success':1},humanReview:'Pending'},risks:['No external effects.']};
  for(const values of [{checks:[]},{metrics:[]}])
    expect(()=>expandHarness(raw,{contract:'flowmate-eval-gold/v4',caseId:'FM-999',version:1,values,sources:[]},
      {contract:'flowmate-eval-review/v4',caseId:'FM-999',version:1,status:'agent-reviewed',humanReview:'pending'},
      {datasets:{synthetic:{}},files:{},resources:[]},REPO_ROOT)).toThrow('Gold must not overwrite Case constraint');
});
test('reference and research facts remain available while authored diagnostics and compiled metric plans survive expansion',()=>{
  const reference={status:'verified' as const,fields:{invoiceNumber:'SOURCE-1'},excerpt:'Independent reference',basis:'visible-parsed-material' as const};
  const research={status:'verified' as const,claims:[],chains:[],forbidden:[]};
  const value=fixture({reference,research});
  value.candidate.case!.expected.diagnostics=[{evaluatorId:'task-judge',required:false,reason:'Explain the original partial failure.',
    params:{metricId:'diagnostic-partial-failure-explanation',denominator:1,evidence:['answer']}}];
  const task=expand(value).cases[0]!;
  expect(task.expected.reference).toEqual(reference);expect('research'in task.expected&&task.expected.research).toEqual(research);
  expect(task.expected.checks).toEqual(value.candidate.gold!.checks);
  expect('metrics'in task.expected&&task.expected.metrics.find(m=>m.metricId==='task-success')).toMatchObject({denominator:1});
  expect(task.expected.diagnostics).toEqual(value.candidate.case!.expected.diagnostics);
  expect('semantic'in task.expected&&task.expected.semantic?.criteria.find(c=>c.metricId==='diagnostic-partial-failure-explanation')).toMatchObject({denominator:1,required:false});
});
