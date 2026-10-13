import { expect, test } from 'bun:test';
import { readdirSync, mkdirSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverDatasets, resolveCase, restoreCaseInputs, REPO_ROOT, inside, caseFiles } from '../../src/dataset-loader/local.ts';
import {byteHash} from '../../src/dataset-loader/flat.ts';
import {addFeedback,feedbackStatus} from '../../src/review/local.ts';
import { fixtureSelection } from '../../src/dataset-loader/selection.ts';
import { readInvoiceInputs } from '../../src/adapters/invoice-materials.ts';
import { readPreparedInvoices } from '../../src/adapters/prepared-invoice-materials.ts';
import { readSelectedResources } from '../../src/adapters/selected-resources.ts';
import type { AgentTrial } from '../../src/adapters/agent.ts';
import { artifactJson } from '../../src/artifacts.ts';
import { publicVersions } from '../../src/reports/files.ts';
const root=join(REPO_ROOT,'agent-eval/src/datasets');

test('saved resource conditions preserve authored bytes without encoded generated digests',()=>{
 const dataset=discoverDatasets(root)[0]!;
 const resources=dataset.cases.flatMap(task=>caseFiles(dataset,task)).filter(file=>/^resources\/[^/]+\/resource\.json$/.test(file.path));
 const files=JSON.parse(artifactJson(publicVersions(resources)));expect(files.length).toBeGreaterThan(0);
 for(const manifest of files){
  const saved=Buffer.from(manifest.content,manifest.encoding==='utf8'?'utf8':'base64');
  const authored=readFileSync(join(root,'../testing/fixtures',manifest.path.replaceAll('/','--')));
  expect(saved.toString('utf8')).not.toMatch(/"(?:sha256|hash)"\s*:|\b[a-f0-9]{64}\b/i);
  expect(saved).toEqual(authored);expect(manifest.bytes).toBe(authored.length);
 }
});
test('declared conditions retain actual original and resource contents without digests, and stale feedback cannot survive a changed image',()=>{
 const dataset=discoverDatasets(root)[0]!,task=dataset.cases.find(c=>c.id==='FM-001')!,prior=caseFiles(dataset,task);
 expect(prior.some(f=>f.path.endsWith('original.jpg')&&f.content.length>100)).toBe(true);
 const skill=dataset.cases.find(c=>c.id==='FM-029')!;expect(caseFiles(dataset,skill).some(f=>f.path.startsWith('resources/'))).toBe(true);
 expect(JSON.stringify(prior)).not.toMatch(/"(?:sha256|hash)"\s*:/);
 const temporary=mkdtempSync(join(tmpdir(),'eval-file-conditions-'));try{
  addFeedback(temporary,{dataset,caseId:task.id,reviewer:'synthetic',verdict:'good',note:'Synthetic freshness check only.'});
  const file=dataset.embedded!.inputs[task.id]!.find(f=>f.path.endsWith('original.jpg'))!,bytes=Buffer.concat([Buffer.from(file.content,'base64'),Buffer.from('changed original')]);
  Object.assign(file,{content:bytes.toString('base64'),bytes:bytes.length,sha256:byteHash(bytes)});
  expect(caseFiles(dataset,task)).not.toEqual(prior);expect(feedbackStatus(temporary,undefined,dataset).stale).toBe(1);
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
test('three TS declarations load 62 cases with the original partitions',()=>{
 const data=discoverDatasets(root);expect(data.map(d=>d.cases.length)).toEqual([50,12]);expect(data.map(d=>d.manifest.smoke.length)).toEqual([10,4]);
 for(const d of data)for(const c of d.cases)expect(resolveCase(d,c).projected.materials).toHaveLength(c.input.materials.length);
 for(const d of data)expect(d.cases.map(c=>c.id)).toEqual(d.cases.map(c=>c.id).sort());
});

test('only scenario-selected Skill bundles are restored from their own manifests',()=>{
 const data=discoverDatasets(root),dataset=data.find(d=>d.manifest.id==='flowmate-agent-v1')!;
 const ordinary=dataset.cases.find(c=>c.id==='FM-001')!;
 expect(caseFiles(dataset,ordinary).some(f=>f.path.startsWith('resources/'))).toBe(false);
 const skill=dataset.cases.find(c=>c.id==='FM-029')!,files=caseFiles(dataset,skill).filter(f=>f.path.startsWith('resources/'));
 expect(files.length).toBeGreaterThan(0);
 expect(files.every(f=>f.path.startsWith('resources/eval-date-guide-long/'))).toBe(true);
});
test('all initial inputs restore with necessary resources, excluding Gold, Review and later controls',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'eval-restore-'));try{
  for(const d of discoverDatasets(root))for(const c of d.cases){
   const directory=join(temporary,c.id);mkdirSync(directory);const inputs=restoreCaseInputs(d,c,directory);
   expect(()=>restoreCaseInputs(d,c,directory)).toThrow();expect(readdirSync(inputs.localRoot)).not.toContain('quality-controls');
   expect(readdirSync(inputs.localRoot)).not.toContain('gold.ts');expect(readdirSync(inputs.localRoot)).not.toContain('review.ts');
   if(c.requires.includes('invoice')){const trial:AgentTrial={identity:{executionId:'synthetic',trialId:c.id,caseId:c.id,caseVersion:1},directory,
    input:resolveCase(d,c).projected,requires:c.requires,configuration:{},invoiceSource:{root:inputs.invoiceRoot!,localRoot:inputs.localRoot,materials:c.input.materials}};
    expect(readInvoiceInputs(trial).length+readPreparedInvoices(trial).invoices.length).toBeGreaterThan(0);}
   const selection=fixtureSelection(d,c,REPO_ROOT);if(selection.resources?.enabledSkills.length)expect(readSelectedResources(inputs.resourceRoot,selection.resources)).toHaveLength(selection.resources.enabledSkills.length);
  }
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
test('duplicate IDs, missing material and unsafe fixture names are rejected',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'eval-invalid-'));try{
  const dataRoot=join(temporary,'datasets');cpSync(root,dataRoot,{recursive:true});cpSync(join(root,'../testing'),join(temporary,'testing'),{recursive:true});
  const file=join(dataRoot,'cases.ts'),original=readFileSync(file,'utf8');
  writeFileSync(file,original.replace('id: "FM-002"','id: "FM-001"'));expect(()=>discoverDatasets(dataRoot)).toThrow(/pairing|Duplicate Case/);
  writeFileSync(file,original.replace('"task-complete-invoice"','"../escape"'));expect(()=>discoverDatasets(dataRoot)).toThrow('fixture');
  writeFileSync(file,original);const scenarioFile=join(temporary,'testing/scenarios.ts'),scenario=readFileSync(scenarioFile,'utf8');
  writeFileSync(scenarioFile,scenario.replace('"file": "content.json"','"file": "missing.md"'));expect(()=>discoverDatasets(dataRoot)).toThrow(/material/i);
  expect(()=>inside(temporary,'../escape')).toThrow();expect(()=>inside(temporary,REPO_ROOT)).toThrow();
  symlinkSync(REPO_ROOT,join(temporary,'link'),'junction');expect(()=>inside(temporary,'link/package.json')).toThrow('links');
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
