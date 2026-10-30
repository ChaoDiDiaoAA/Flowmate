import { expect,test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureRepo,dataset,task,observed } from '../support/fixtures.ts';
import { runLocal } from '../../src/execution/runner.ts';
import { readReport } from '../../src/reports/store.ts';
import { archiveFile, readArchive } from '../../src/reports/archive.ts';
import { exportReport } from '../../src/langfuse/export.ts';
import { addFeedback, readFeedbackRecords } from '../../src/review/local.ts';
import { registerSecrets } from '../../src/execution/evidence-safety.ts';
import { syntheticLangfuseExport } from '../support/langfuse.ts';

test('Run output keeps inline originals, cleans a stopped scene and saves action results without sidecars',async()=>{
 let working='',platformCalls=0;registerSecrets(['stage-one-fake-secret']);
 const run=await runLocal(fixtureRepo,{dataset,caseId:task.id,executionId:'v1-'+randomUUID(),backend:'local',judge:'off'},
 {env:{},fetcher:async()=>{platformCalls++;throw Error('unexpected request');},kernel:{readiness:()=>({ready:true,reason:'synthetic'}),async prepare(trial){
  working=trial.directory;expect(JSON.stringify(trial.input)).not.toContain('expected');
  const e=observed();e.identity=trial.identity;e.input=trial.input;e.artifacts=[];
  e.evidence.environment!.actual={...trial.identity,fresh:true};e.evidence['input-projection']!.actual=trial.input;
  e.observations=[{id:'tool-1',kind:'tool',name:'synthetic-read',startedAt:e.startedAt!,endedAt:e.endedAt,input:{file:'authorized'},output:'stage-one-fake-secret'}];
  return {input:trial.input,execute:async()=>e,snapshot:async()=>e,cancel:async()=>{},close:async()=>({present:true,actual:{closed:true,stopped:true},source:'synthetic-stop'})};
 }}});
 const root=dirname(archiveFile(run.file)),t=run.report.trials[0]!;
 expect(readdirSync(root).sort()).toEqual(['README.md','run.json']);
 expect(existsSync(dirname(working))).toBe(false);expect(platformCalls).toBe(0);
 const disk=readArchive(run.file).executions[run.report.executionId] as { dataset: { version: number }; trials: Array<{ execution: unknown; judgeCalls: unknown }> };
 expect(disk.dataset.version).toBe(1);
 expect(disk.trials[0]!.execution).toEqual(t.execution);expect(disk.trials[0]!.judgeCalls).toEqual(t.judgeCalls);
 expect(readReport(run.file).trials[0]!.execution!.observations).toHaveLength(1);
 const before=readReport(run.file);
 await exportReport(readReport(run.file),run.file,async()=>{throw Error('synthetic offline');},fixtureRepo,syntheticLangfuseExport);
 const after=readReport(run.file);expect(after.export.status).toBe('error');expect({...after,export:before.export}).toEqual(before);
 const feedback=addFeedback(fixtureRepo,{executionId:run.report.executionId,caseId:t.caseId,trialId:t.trialId,reviewer:'synthetic reviewer',verdict:'bad',note:'Synthetic feedback only.'});
 expect(readFeedbackRecords(fixtureRepo,run.report.executionId)).toContainEqual(feedback);
 expect(readdirSync(root).sort()).toEqual(['README.md','run.json']);
 const visit=(directory:string):string=>readdirSync(directory,{withFileTypes:true}).map(f=>f.isDirectory()?visit(join(directory,f.name)):readFileSync(join(directory,f.name),'utf8')).join('\n');
 const wire=visit(root);expect(wire).not.toMatch(/"[^"\n]*(?:hash|sha256|fingerprint|digest)[^"\n]*"\s*:|\b[a-f0-9]{64}\b/i);
 expect(wire).not.toContain('stage-one-fake-secret');
},30000);
