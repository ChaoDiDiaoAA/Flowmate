import { goldByCaseId } from '../../src/datasets/gold.ts';
import { reviewByCaseId } from '../../src/datasets/review.ts';
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REPO_ROOT,discoverDatasets,hash} from '../../src/dataset-loader/local.ts';
import {formalRules,formalMetricMethod} from '../../src/scoring/formal-rules.ts';
import {caseV2Schema} from '../../src/dataset-loader/schema.ts';
import {evaluateAll} from '../../src/scoring/evaluate.ts';
import {aggregate} from '../../src/scoring/aggregate.ts';
import {observed,reportFixture} from '../support/fixtures.ts';
import {exportEvents} from '../../src/langfuse/export.ts';

test('FM-028 exact answer and negative controls are locally graded without inventing a platform Judge',async()=>{
 const dataset=discoverDatasets(join(REPO_ROOT,'agent-eval/src/datasets')).find(d=>d.manifest.id==='flowmate-agent-v1')!;
 const task=dataset.cases.find(c=>c.id==='FM-028')!;
 for(const answer of ['15288019','15288018','15288019 saved']){
  const result=observed();result.answer=answer;
  const facts={answer,invoice:{candidates:[]},'tool-evidence':{calls:[]},'context-requests':[],
   runs:[{runId:1,sessionId:1,kind:'agent',status:'completed',scope:{version:2,allowedTools:[],allowedDocumentIds:[],allowedArtifactIds:[],allowedResourcePaths:[]},stoppedAt:result.endedAt,cleanup:{stopped:true},config:{runtimeBudget:{maxToolCalls:0}}}],
   resources:[{runId:1,sessionId:1,frozen:null,gap:null,evidence:{version:1,reads:[],expansions:[],requests:[]}}]};
  for(const [key,actual]of Object.entries(facts))result.evidence[key]={present:true,actual,source:'Controlled original observation'};
  const scored=await evaluateAll({task,result,projected:result.input,judge:null,fetcher:async()=>{throw Error('No Judge allowed');}},task.expected.checks);
  expect(scored.judgeCalls).toHaveLength(0);
  expect(aggregate(scored.scores,result).status).toBe(answer==='15288019'?'PASS':'FAIL');
  const report=reportFixture();report.trials[0]!.scores=scored.scores;report.trials[0]!.judgeCalls=scored.judgeCalls;
  const events=exportEvents(report);
  expect(events.some(e=>e.type==='trace-create')).toBe(true);
  expect(events.some(e=>e.type==='generation-create'&&String(e.body.name).startsWith('Judge'))).toBe(false);
 }
});

for(const[name,count]of[['flowmate-agent-v1',50],['flowmate-research-v1',12]]as const)
test(name+' records original metric applicability, specific rules and independent Gold bindings without executing it',()=>{
 const root=join(REPO_ROOT,'agent-eval/src/datasets'),dataset=discoverDatasets(root).find(d=>d.manifest.id===name)!;
 expect(dataset.cases).toHaveLength(count);
 expect(dataset.manifest.scoring.judges[0]!.required).toBe(false);
 expect(dataset.manifest.scoring.judges[0]!.requiredFor).toHaveLength(name==='flowmate-agent-v1'?49:12);
 expect(dataset.manifest.scoring.judges[0]!.requiredFor).not.toContain('FM-028');
 const tasks=dataset.cases.map(task=>caseV2Schema.parse(task));
 for(const task of tasks){
  if(!('contract'in task))throw new Error('Formal plans require Case v2');
  const gold=goldByCaseId[task.id].basis;
  const review=reviewByCaseId[task.id];
  expect(review.humanReview).toBe('pending');expect(gold).toBeDefined();
  if(task.id==='FM-028')expect(task.expected.semantic).toBeUndefined();
  else expect(task.expected.semantic?.criteria.length).toBeGreaterThan(0);
  if(task.expected.semantic)expect(task.expected.semantic).not.toHaveProperty('encoding');
  expect(task.expected.semantic?.criteria.some(c=>c.metricId.startsWith('DR'))??false).toBe(name==='flowmate-research-v1');
  for(const metric of task.expected.metrics.filter(m=>m.metricId.startsWith('DR')&&m.metricId!=='DR03'&&!m.notApplicable))
   expect(task.expected.semantic!.criteria.find(c=>c.metricId===metric.metricId)?.evidence).toContain('research-frame');
  for(const row of task.expected.metrics){
   expect(row.notApplicable??'').not.toContain('pending');
   const rule=formalRules.find(r=>r.metricId===row.metricId);if(!rule||row.notApplicable)continue;
   const criterion=task.expected.semantic?.criteria.find(c=>c.metricId===row.metricId);
   if(formalMetricMethod(task,row.metricId)==='llm-judge'){expect(criterion).toBeDefined();expect(criterion!.denominator).toBe(row.denominator??null);expect(criterion!.evidence).toContain('gold-task');}
   else expect(criterion).toBeUndefined();
  }
 }
 if(name==='flowmate-agent-v1'){
  for(const id of ['FM-035','FM-037'])expect(tasks.find(t=>t.id===id)!.expected.metrics.find(m=>m.metricId==='subtask-success')!.denominator).toBe(2);
  for(const id of ['FM-016','FM-019','FM-040','FM-042'])expect(tasks.find(t=>t.id===id)!.expected.metrics.find(m=>m.metricId==='candidate-idempotency')!.notApplicable).toBeDefined();
  const multiple=tasks.find(t=>t.id==='FM-033')!;
  expect(multiple.expected.materialReferences?.map(r=>r.sample)).toEqual(['000001','000003']);
 }
});
