import { expect,test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureRepo,dataset,task,observed } from '../support/fixtures.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { readReport } from '../../src/reports/store.ts';
import { exportReport } from '../../src/langfuse/export.ts';
import { addFeedback } from '../../src/review/local.ts';
import { registerSecrets } from '../../src/execution/evidence-safety.ts';

test('v1 output uses references, cleans a stopped scene and saves optional receipts only on actual actions',async()=>{
 let working='',platformCalls=0;registerSecrets(['stage-one-fake-secret']);
 const run=await runLocal(fixtureRepo,{dataset,caseId:task.id,executionId:'v1-'+randomUUID(),backend:'local',judge:'off'},
 {env:{},fetcher:async()=>{platformCalls++;throw Error('unexpected request');},kernel:{readiness:()=>({ready:true,reason:'synthetic'}),async prepare(trial){
  working=trial.directory;expect(JSON.stringify(trial.input)).not.toContain('expected');
  const e=observed();e.identity=trial.identity;e.input=trial.input;e.artifacts=[];
  e.evidence.environment!.actual={...trial.identity,fresh:true};e.evidence['input-projection']!.actual=trial.input;
  e.observations=[{id:'tool-1',kind:'tool',name:'synthetic-read',startedAt:e.startedAt!,endedAt:e.endedAt,input:{file:'authorized'},output:'stage-one-fake-secret'}];
  return {input:trial.input,execute:async()=>e,snapshot:async()=>e,cancel:async()=>{},close:async()=>({present:true,actual:{closed:true,stopped:true},source:'synthetic-stop'})};
 }}});
 const root=dirname(run.file),t=run.report.trials[0]!,evidence=join(root,'evidence',t.trialId);
 expect(readdirSync(root).sort()).toEqual(['badcases.json','badcases.md','evidence','report.json','snapshot.json']);
 expect(readdirSync(evidence).sort()).toEqual(['events.jsonl','observation.json','trial.json']);
 expect(existsSync(dirname(working))).toBe(false);expect(platformCalls).toBe(0);
 const disk=JSON.parse(readFileSync(run.file,'utf8'));expect(disk.dataset.version).toBe('v1');
 expect(disk.trials[0]).not.toHaveProperty('execution');expect(disk.trials[0]).not.toHaveProperty('judgeCalls');
 expect(disk.trials[0].evidence.trial).toBe(`evidence/${t.trialId}/trial.json`);
 expect(readReport(run.file).trials[0]!.execution!.observations).toHaveLength(1);
 const before=readFileSync(run.file,'utf8');
 await exportReport(readReport(run.file),run.file,async()=>{throw Error('synthetic offline');});
 expect(readReport(run.file).export.status).toBe('error');expect(readFileSync(run.file,'utf8')).toBe(before);
 addFeedback(fixtureRepo,{executionId:run.report.executionId,caseId:t.caseId,trialId:t.trialId,reviewer:'synthetic reviewer',verdict:'bad',note:'Synthetic feedback only.'});
 expect(existsSync(join(root,'review.json'))).toBe(true);
 const visit=(directory:string):string=>readdirSync(directory,{withFileTypes:true}).map(f=>f.isDirectory()?visit(join(directory,f.name)):readFileSync(join(directory,f.name),'utf8')).join('\n');
 const wire=visit(root);expect(wire).not.toMatch(/"[^"\n]*(?:hash|sha256|fingerprint|digest)[^"\n]*"\s*:|\b[a-f0-9]{64}\b/i);
 expect(wire).not.toContain('stage-one-fake-secret');
},30000);
