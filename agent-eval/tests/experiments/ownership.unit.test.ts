import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runExperiment, listExperiments } from '../../src/experiments/index.ts';
import { acquireEvaluationWrite } from '../../src/reports/files.ts';
import { createArchive, archiveReference, readArchivePart } from '../../src/reports/archive.ts';
import type { LocalDataset } from '../../src/dataset-loader/local.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function root(){const value=mkdtempSync(join(tmpdir(),'experiment-owner-'));roots.push(value);return value;}
const plan={id:'same-experiment',benchmark:{id:'baseline',revision:1,selection:'smoke'},repeats:1,axes:['model'],control:{id:'control'},candidates:[{id:'candidate'}]};
test('an occupied experiment identity rejects before benchmark, metadata or Runner work',async()=>{
  const repo=root(),archive=createArchive(repo,{selection:'smoke',id:'Run-occupied-experiment'}),reference=archiveReference(archive.file,'experiment');
  const release=acquireEvaluationWrite(reference);let preflights=0,runs=0;
  try{
    await expect(runExperiment(repo,{...plan,id:archive.id},{loadBenchmark:()=>{preflights++;throw Error('Must not preflight');},
      run:async()=>{runs++;return[];}})).rejects.toThrow('already exists');
    expect(preflights).toBe(0);expect(runs).toBe(0);expect(()=>readArchivePart(reference)).toThrow('unavailable');
  }finally{release();}
},15000);
test('a gated first experiment owns the identity for its whole run while read-only status remains available',async()=>{
  const repo=root();execFileSync('git',['init','-q',repo]);
  execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','synthetic']);
  let unblock!:()=>void,started!:()=>void,preflights=0,runs=0;
  const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{unblock=resolve;});
  const dataset:LocalDataset={root:repo,repo,cases:[],manifest:{contract:'flowmate-agent-dataset/v1',id:'ownership-fixture',version:1,name:'Controlled ownership',members:[],smoke:[],
    environment:{profile:'isolated-agent/v1',source:'voxel51',risks:['Synthetic ownership gate']},scoring:{version:1,required:[],judges:[]}}};
  const first=runExperiment(repo,plan,{kernel:{readiness:()=>({ready:true,reason:'Controlled ownership'}),prepare:async()=>{throw Error('Unused');}},
    loadBenchmark:()=>{preflights++;return[dataset];},run:async()=>{runs++;started();await gate;return[];}});
  await entered;
  try{
    await expect(runExperiment(repo,plan,{loadBenchmark:()=>{preflights++;return[];}})).rejects.toThrow('already exists');
    expect(listExperiments(repo)[0]!.status).toBe('running');expect(preflights).toBe(1);expect(runs).toBe(1);
  }finally{unblock();await first;}
  expect(listExperiments(repo)).toHaveLength(1);
  await expect(runExperiment(repo,plan,{loadBenchmark:()=>{preflights++;return[];}})).rejects.toThrow('already exists');
  expect(preflights).toBe(1);expect(runs).toBe(1);
},15000);
