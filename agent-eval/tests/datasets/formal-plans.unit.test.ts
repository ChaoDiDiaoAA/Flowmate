import { goldByCaseId } from '../../src/datasets/gold.ts';
import { reviewByCaseId } from '../../src/datasets/review.ts';
import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REPO_ROOT,discoverDatasets,hash} from '../../src/dataset-loader/local.ts';
import {formalRules} from '../../src/scoring/formal-rules.ts';
import {caseV2Schema} from '../../src/dataset-loader/schema.ts';

for(const[name,count]of[['flowmate-agent-v1',50],['flowmate-research-v1',12]]as const)
test(name+' records original metric applicability, specific rules and independent Gold bindings without executing it',()=>{
 const root=join(REPO_ROOT,'agent-eval/src/datasets'),dataset=discoverDatasets(root).find(d=>d.manifest.id===name)!;
 expect(dataset.cases).toHaveLength(count);expect(dataset.manifest.scoring.judges).toEqual([{id:'semantic-batch',required:true}]);
 const tasks=dataset.cases.map(task=>caseV2Schema.parse(task));
 for(const task of tasks){
  if(!('contract'in task))throw new Error('Formal plans require Case v2');
  const gold=goldByCaseId[task.id].basis;
  const review=reviewByCaseId[task.id];
  expect(review.humanReview).toBe('pending');expect(gold).toBeDefined();
  expect(task.expected.semantic?.criteria.length).toBeGreaterThan(0);
  expect(task.expected.semantic).not.toHaveProperty('encoding');
  expect(task.expected.semantic!.criteria.some(c=>c.metricId.startsWith('DR'))).toBe(name==='flowmate-research-v1');
  for(const metric of task.expected.metrics.filter(m=>m.metricId.startsWith('DR')&&m.metricId!=='DR03'&&!m.notApplicable))
   expect(task.expected.semantic!.criteria.find(c=>c.metricId===metric.metricId)?.evidence).toContain('research-frame');
  for(const row of task.expected.metrics){
   expect(row.notApplicable??'').not.toContain('pending');
   const rule=formalRules.find(r=>r.metricId===row.metricId);if(!rule||row.notApplicable)continue;
   const criterion=task.expected.semantic!.criteria.find(c=>c.metricId===row.metricId);
   if(rule.method==='llm-judge'){expect(criterion).toBeDefined();expect(criterion!.denominator).toBe(row.denominator??null);expect(criterion!.evidence).toContain('gold-task');}
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
