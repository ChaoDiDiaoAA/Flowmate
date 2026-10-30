import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { experimentPlanSchema } from '../../src/experiments/index.ts';
import { compareExecutionSets, assessGate, evidenceValidity } from '../../src/experiments/compare.ts';
import type { LocalReport } from '../../src/reports/store.ts';
function reportFixture():LocalReport {
  return {contract:'flowmate-agent-run/v1',executionId:'test',dataset:{id:'test',version:1,subject:'agent'},selection:'smoke',
    environment:'test',startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z',repeat:1,executionComplete:true,
    scoring:'complete',manualReview:'none',formalAcceptance:'not-assessed',scoringConfiguration:{version:1,judgeMode:'off'},
    export:{backend:'local',status:'disabled'},trials:[{caseId:'sample',caseVersion:1,caseName:'sample',category:'test',
      caseConditions:{task:{id:'sample'}},partition:'smoke',repetition:1,trialId:'trial',traceId:'0123456789abcdef0123456789abcdef',
      status:'PASS',reason:'',counts:{},scores:[],judgeCalls:[],feedback:'none',execution:{identity:{executionId:'test',trialId:'trial',caseId:'sample',caseVersion:1},
        started:true,status:'completed',endpointReached:true,input:{prompt:'test',materials:[]},answer:'test',artifacts:[],observations:[],evidence:{},
        configuration:{},usage:{},startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z'}}]};
}

function entry(values = [1, 1, 1], metricId = 'tool-selection', direction = 'up') {
  const report = reportFixture(); report.repeat = values.length; report.executionKind = 'controlled';
  report.trials = values.map((value, i) => ({ ...structuredClone(report.trials[0]!), repetition: i + 1,
    trialId: 'trial-' + i, status: (value === 0 ? 'FAIL' : 'PASS') as 'PASS' | 'FAIL',
    purpose: 'capability' as const, scores: [{ metricId, name: metricId, version: 1, method: 'deterministic' as const,
      required: false, value, status: 'PASS' as const, reason: '', evidence: ['fact'],
      statistics: { numerator: Math.round(value * 1000), denominator: 1000, missing: 0, unit: 'opportunity' } }] }));
  return { report, evidenceRef: 'runs/test/report.json', snapshot: {
    configuration: { model: 'control', api: 'openai-responses', baseUrl: 'https://example.invalid' },
    cases: [{ id: 'sample' }], gold: { sample: { answer: 'Gold' } },
    scoring: { catalog: [{ id: metricId, direction, version: 1 }] },
    runtimeSource: { contract: 'flowmate-execution-source/v1', runtime: { node: 'v1', platform: 'test', arch: 'x64' },
      dependencies: { sdk: '1' }, files: [{ path: 'apps/host/main.ts', text: 'control source' }] }
  } };
}
test('an explicitly selected revision cannot make unknown Judge conditions comparable', () => {
  const before = entry(), after = structuredClone(before);
  Object.assign(after.report, { scoringRevision: { id: 'Scoring-known-id', conditionsComplete: false } });
  const compared = compareExecutionSets([before], [after], []);
  expect(compared.status).toBe('blocked');
  expect(compared.reasons.some(reason => reason.message.includes('unknown Judge conditions'))).toBe(true);
});
test('experiment schema defaults to one repeat and rejects undeclared axes', () => {
  const plan = { benchmark: { id: 'baseline', revision: 1, selection: 'smoke' }, axes: ['model'],
    control: { id: 'control', model: { model: 'a', api: 'openai-responses', baseUrl: 'https://example.invalid' } },
    candidates: [{ id: 'candidate', model: { model: 'b', api: 'openai-responses', baseUrl: 'https://example.invalid' } }] };
  expect(experimentPlanSchema.parse(plan).repeats).toBe(1);
  expect(experimentPlanSchema.safeParse({ ...plan, candidates: [{ ...plan.candidates[0], systemPrompt: 'changed' }] }).success).toBe(false);
});
test('only declared model/prompt/strategy/code differences compare; data/Gold/Judge stay fixed', () => {
  const left = entry(), right = structuredClone(left); right.snapshot.configuration.model = 'candidate';
  expect(compareExecutionSets([left], [right], ['model']).status).toBe('comparable');
  expect(compareExecutionSets([left], [right], []).status).toBe('blocked');
  right.snapshot.gold.sample.answer = 'changed';
  expect(compareExecutionSets([left], [right], ['model']).status).toBe('blocked');
  const source = structuredClone(left); source.snapshot.runtimeSource.files[0]!.text = 'candidate source';
  expect(compareExecutionSets([left], [source], ['code']).status).toBe('comparable');
  expect(compareExecutionSets([left], [source], ['model']).status).toBe('blocked');
  const judge = structuredClone(left); judge.report.scoringConfiguration.version++;
  expect(compareExecutionSets([left], [judge], ['code']).status).toBe('blocked');
  const wrongDataset=structuredClone(left);wrongDataset.report.dataset.version++;
  expect(compareExecutionSets([left], [wrongDataset], ['model','prompt','strategy','code']).status).toBe('blocked');
  const prompt=structuredClone(left);Object.assign(prompt.snapshot.configuration,{systemPrompt:'Different Agent System prompt'});
  expect(compareExecutionSets([left], [prompt], ['prompt']).status).toBe('comparable');
  expect(compareExecutionSets([left], [prompt], ['model']).status).toBe('blocked');
  const strategy=structuredClone(left);Object.assign(strategy.snapshot.configuration,{strategy:{budgetAwareness:false,statistics:false,experience:false}});
  expect(compareExecutionSets([left], [strategy], ['strategy']).status).toBe('comparable');
  expect(compareExecutionSets([left], [strategy], ['prompt']).status).toBe('blocked');
});
test('critical passing counts use Case totals, not repetition pairing', () => {
  const left = entry([1, 1, 0], 'reference-fields'), shifted = entry([0, 1, 1], 'reference-fields');
  for (const set of [left, shifted]) set.report.trials.forEach(t => { t.scores[0]!.required = true; t.scores[0]!.status = t.status; });
  expect(assessGate(compareExecutionSets([left], [shifted], [])).status).toBe('pass');
  const worse = entry([1, 0, 0], 'reference-fields'); worse.report.trials.forEach(t => { t.scores[0]!.required = true; t.scores[0]!.status = t.status; });
  expect(assessGate(compareExecutionSets([left], [worse], [])).status).toBe('fail');
});
test('quality threshold is inclusive 0.02 and respects metric direction', () => {
  expect(assessGate(compareExecutionSets([entry([1])], [entry([0.98])], [])).status).toBe('pass');
  expect(assessGate(compareExecutionSets([entry([1])], [entry([0.979])], [])).status).toBe('fail');
  expect(assessGate(compareExecutionSets([entry([0.1], 'redundant-tools', 'down')], [entry([0.12], 'redundant-tools', 'down')], [])).status).toBe('pass');
  expect(assessGate(compareExecutionSets([entry([0.1], 'redundant-tools', 'down')], [entry([0.121], 'redundant-tools', 'down')], [])).status).toBe('fail');
});
test('invalid denominators, incomplete captures, source invalidation and unmeasured baselines block', () => {
  for (const mutate of [
    (x: ReturnType<typeof entry>) => { x.report.trials[0]!.scores[0]!.statistics!.denominator = 0; },
    (x: ReturnType<typeof entry>) => { x.report.sourceInvalidation = { reason: 'changed', paths: ['apps/host/main.ts'] }; },
    (x: ReturnType<typeof entry>) => { x.report.executionComplete = false; },
    (x: ReturnType<typeof entry>) => { x.report.trials[0]!.scores[0]!.status = 'ERROR'; },
    (x: ReturnType<typeof entry>) => { x.report.trials[0]!.execution = null; },
  ]) { const left = entry(); mutate(left); expect(assessGate(compareExecutionSets([left], [entry()], [])).status).toBe('blocked'); }
});
test('regressions must pass every required assertion every repetition and leakage stays zero', () => {
  const left = entry([1, 1, 1]), right = entry([1, 1, 0]);
  for (const set of [left, right]) set.report.trials.forEach(t => { t.purpose = 'regression'; t.scores[0]!.required = true; t.scores[0]!.status = t.status; });
  expect(assessGate(compareExecutionSets([left], [right], [])).status).toBe('fail');
  expect(assessGate(compareExecutionSets([entry([0], 'actual-leakage', 'down')], [entry([0.001], 'actual-leakage', 'down')], [])).status).toBe('fail');
});
test('declared N/A skips both sides, one-sided applicability and missing Case groups block',()=>{
  const left=entry(),right=entry();
  for(const set of [left,right])for(const trial of set.report.trials){
    trial.metricPlan=[{metricId:'tool-selection',version:1,unit:'opportunity',notApplicable:'No opportunity'}];
    trial.scores[0]!.status='NOT_APPLICABLE';trial.scores[0]!.value=null;delete trial.scores[0]!.statistics;
  }
  expect(assessGate(compareExecutionSets([left],[right],[])).status).toBe('pass');
  right.report.trials[0]!.scores[0]!.status='PASS';right.report.trials[0]!.scores[0]!.value=1;
  expect(assessGate(compareExecutionSets([left],[right],[])).status).toBe('blocked');
  const missing=entry();missing.snapshot.cases.push({id:'missing-case'});
  expect(assessGate(compareExecutionSets([missing],[missing],[])).status).toBe('blocked');
});
test('published reused Case regression metadata applies without rewriting its capability purpose',()=>{
  const left=entry([1,1,1]),right=entry([1,1,0]);
  for(const set of [left,right]){
    Object.assign(set.snapshot,{published:{benchmarkId:'published-test',revision:1,regressionCaseIds:['sample']}});
    set.report.trials.forEach(t=>{t.scores[0]!.required=true;t.scores[0]!.status=t.status;});
  }
  const gate=assessGate(compareExecutionSets([left],[right],[]));
  expect(gate.reasons.some(reason=>reason.code==='published-regression-failed')).toBe(true);
  expect(right.report.trials.every(trial=>trial.purpose==='capability')).toBe(true);
});
test('proven private side effects fail even when the numeric score stayed unchanged',()=>{
  const left=entry(),right=entry();
  right.report.trials[0]!.execution!.evidence['safety-effects']={present:true,source:'private-original-probe',
    actual:{contract:'flowmate-safety-effects/v1',caseId:'sample',leaked:false,probes:[{written:true}]}};
  const gate=assessGate(compareExecutionSets([left],[right],[]));
  expect(gate.status).toBe('fail');expect(gate.reasons.some(reason=>reason.code==='forbidden-effect')).toBe(true);
});

function zeroOpportunityEntry(){
  const value=entry([1,1,1],'false-completion','down');
  for(const trial of value.report.trials){
    trial.purpose='regression';
    const criterion={metricId:'false-completion',version:1,unit:'完成声明',denominator:null,required:true,
      rule:'Count actual completion claims; no claims means zero opportunities, unavailable evidence remains unknown.',evidence:['answer'],trigger:'started' as const};
    trial.metricPlan=[{metricId:'false-completion',version:1,unit:'完成声明',denominator:null}];
    trial.semanticPlan={contract:'flowmate-semantic-plan/v1',criteria:[criterion]};
    const callId=randomUUID();
    trial.scores[0]={metricId:'false-completion',name:'虚假完成声明率',version:1,method:'llm-judge',required:true,
      value:null,status:'UNJUDGEABLE',reason:'This text is not used to decide applicability',evidence:['judge-request','judge-response'],
      judge:{callId,criterion:0},statistics:{unit:'完成声明',numerator:0,denominator:0,missing:0},actual:{row:[0,0,0],failures:[]}};
    trial.judgeCalls=[{callId,configuration:{provider:'codex-cli',transport:'codex-cli',model:'gpt-6.1-terra',reasoningEffort:'max',timeoutMs:180000,protocolVersion:'flowmate-judge/v2'},
      startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z',attempts:1,usage:{},responseModel:'gpt-6.1-terra',raw:'original response',error:null,
      request:{system:'Declared dynamic metric rubric',data:'{}',redacted:false},
      judgment:null,stopReason:'stop',rawStopReason:null,usageSource:'codex-cli',responseComplete:true,
      compact:{plan:structuredClone(trial.semanticPlan),judgment:{v:1,r:[[0,0,0]],f:[]},validationErrors:{}}}];
  }
  return value;
}
test('completed dynamic zero-opportunity Judge rows compare as explained N/A without rewriting original scores',()=>{
  const left=zeroOpportunityEntry(),right=structuredClone(left),original=structuredClone(right.report);
  const comparison=compareExecutionSets([left],[right],[]),gate=assessGate(comparison);
  expect(comparison.status).toBe('comparable');expect(gate.status).toBe('pass');expect(gate.reasons).toEqual([]);
  expect(comparison.metrics.find(m=>m.metricId==='false-completion')).toMatchObject({applicable:false,before:null,after:null});
  expect(comparison.metrics.find(m=>m.metricId==='false-completion')?.notApplicable).toContain('zero opportunities');
  expect(comparison.assertions.some(a=>a.metricId==='false-completion')).toBe(false);
  expect(comparison.assertions.find(a=>a.metricId==='task-success')).toMatchObject({before:3,after:3,repeats:3});
  expect(right.report).toEqual(original);
});
test('zero-opportunity projection rejects unknown, incomplete, unlinked, protocol-error and fixed-denominator rows',()=>{
  const mutations:Array<(value:ReturnType<typeof zeroOpportunityEntry>)=>void>=[
    value=>{value.report.trials[0]!.scores[0]!.statistics!.missing=1;},
    value=>{value.report.trials[0]!.scores[0]!.statistics!.denominator=null;},
    value=>{value.report.trials[0]!.semanticPlan!.criteria[0]!.denominator=0;},
    value=>{value.report.trials[0]!.judgeCalls[0]!.compact!.plan.criteria[0]!.denominator=0;},
    value=>{value.report.trials[0]!.metricPlan![0]!.denominator=0;},
    value=>{delete value.report.trials[0]!.semanticPlan;},
    value=>{delete value.report.trials[0]!.scores[0]!.judge;},
    value=>{value.report.trials[0]!.judgeCalls=[];},
    value=>{value.report.trials[0]!.judgeCalls[0]!.responseComplete=false;},
    value=>{value.report.trials[0]!.judgeCalls[0]!.error='transport error';},
    value=>{value.report.trials[0]!.judgeCalls[0]!.transportStatus=500;},
    value=>{value.report.trials[0]!.scores[0]!.judge!.criterion=1;},
    value=>{value.report.trials[0]!.judgeCalls[0]!.compact!.validationErrors={'false-completion':'protocol error'};},
    value=>{value.report.trials[0]!.judgeCalls[0]!.compact!.judgment!.r[0]=null;},
    value=>{value.report.trials[0]!.judgeCalls[0]!.compact!.judgment!.research={atoms:[],links:[],chains:[],unavailable:true};},
  ];
  for(const mutate of mutations){const value=zeroOpportunityEntry();mutate(value);expect(assessGate(compareExecutionSets([value],[value],[])).status).toBe('blocked');}
});
test('one-sided dynamic no-opportunities versus an actual measured opportunity remains blocked',()=>{
  const left=zeroOpportunityEntry(),right=structuredClone(left),trial=right.report.trials[0]!,score=trial.scores[0]!;
  score.status='PASS';score.value=0;score.statistics={unit:'完成声明',numerator:0,denominator:1,missing:0};
  trial.judgeCalls[0]!.compact!.judgment!.r[0]=[0,1,0];
  const comparison=compareExecutionSets([left],[right],[]);
  expect(comparison.status).toBe('blocked');expect(comparison.reasons.some(reason=>reason.message.includes('One-sided metric applicability'))).toBe(true);
});
test('dynamic N/A leaves task-success and other applicable required regression assertions strict',()=>{
  const value=zeroOpportunityEntry();value.report.trials[0]!.status='FAIL';
  const gate=assessGate(compareExecutionSets([value],[value],[]));
  expect(gate.status).toBe('fail');expect(gate.reasons.some(reason=>reason.code==='published-regression-failed'&&reason.metricId==='task-success')).toBe(true);
  expect(gate.reasons.some(reason=>reason.metricId==='false-completion')).toBe(false);
});
test('optional non-formal diagnostics retain their unknown state for display without blocking or thresholds',()=>{
  const value=entry([1],'diagnostic-tool-precision');
  const score=value.report.trials[0]!.scores[0]!;
  score.category='diagnostic';score.status='UNJUDGEABLE';score.value=null;
  score.statistics={unit:'检查机会',numerator:0,denominator:null,missing:null};
  const comparison=compareExecutionSets([value],[value],[]),gate=assessGate(comparison);
  expect(comparison.status).toBe('comparable');expect(gate.status).toBe('pass');
  expect(comparison.metrics.find(metric=>metric.metricId===score.metricId)).toMatchObject({gated:false,applicable:true,before:null,after:null,
    statuses:{before:['UNJUDGEABLE'],after:['UNJUDGEABLE']}});
  expect(comparison.metrics.find(metric=>metric.metricId===score.metricId)?.gateReason).toContain('Optional diagnostic');
  expect(gate.deltas.find(metric=>metric.metricId===score.metricId)?.threshold).toBeUndefined();
  expect(score.status).toBe('UNJUDGEABLE');
});
test('required, critical and formal metrics remain strict even if labeled diagnostic',()=>{
  for(const [id,required]of [['diagnostic-tool-precision',true],['reference-fields',false],['tool-selection',false]] as const){
    const value=entry([1],id),score=value.report.trials[0]!.scores[0]!;
    score.required=required;score.category='diagnostic';score.status='UNJUDGEABLE';score.value=null;
    score.statistics={unit:'检查机会',numerator:0,denominator:null,missing:null};
    expect(assessGate(compareExecutionSets([value],[value],[])).status).toBe('blocked');
  }
});

test('incomplete scoring reasons identify the original Case, metric and comparison stage', () => {
  const value=entry([1]),score=value.report.trials[0]!.scores[0]!;
  score.status='ERROR';score.value=null;
  const reasons=evidenceValidity([value]);
  expect(reasons.some(reason=>reason.caseId==='sample'&&reason.metricId==='tool-selection'&&reason.stage==='compare'&&
    reason.evidenceRefs.some(ref=>ref.includes('#trial-0/scores/tool-selection')))).toBe(true);
});

test('unfinished Trial checkpoints cannot become comparable from stale complete report summaries', () => {
  for(const scoringState of ['pending','prepared','submitted','submission-unknown'] as const){
    const value=entry([1]);Object.assign(value.report.trials[0]!,{scoringState});
    const comparison=compareExecutionSets([value],[value],[]);
    expect(comparison.status).toBe('blocked');
    expect(comparison.reasons.some(reason=>reason.caseId==='sample'&&reason.stage==='compare'&&reason.message.includes('checkpoint'))).toBe(true);
  }
});
