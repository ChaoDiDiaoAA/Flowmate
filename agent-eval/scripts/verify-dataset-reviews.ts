import { goldByCaseId } from '../src/datasets/gold.ts';
import { reviewByCaseId } from '../src/datasets/review.ts';
/** Verify self-contained sources without external data, models or platform calls. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverDatasets, resolveCase, REPO_ROOT } from '../src/dataset-loader/local.ts';
import { decodeFile } from '../src/dataset-loader/flat.ts';
import { metricCatalog } from '../src/scoring/catalog.ts';
import { flowmateAgentV1Dataset } from '../src/datasets/cases.ts';
import { authorDatasetSchema } from '../src/dataset-loader/authoring.ts';
const root=join(REPO_ROOT,'agent-eval/src/datasets'),data=discoverDatasets(root);
const counts=new Map([['flowmate-agent-v1',50],['flowmate-research-v1',12]]);
authorDatasetSchema.parse(flowmateAgentV1Dataset);
let claims=0,chains=0,sourceSpans=0,materialBindings=0,userTurns=0;
const hints=new Set<string>();
const sourceGroups=new Map<string,Set<string>>();
for(const dataset of data){
 assert.equal(dataset.cases.length,counts.get(dataset.manifest.id));
 for(const task of dataset.cases){
  assert.equal(task.review.status,'pending');assert.equal(reviewByCaseId[task.id].humanReview,'pending');assert.deepEqual(Object.keys(resolveCase(dataset,task,'no-external-data').projected).sort(),['materials','prompt']);
  const authored=flowmateAgentV1Dataset.cases.find(c=>c.id===task.id)!;
  for(const[key,value]of Object.entries(authored.expected))assert.deepEqual((task.expected as any)[key],value,task.id+'/'+key);
  assert.equal(reviewByCaseId[task.id].toolCallLimit.value,task.expected.maxToolCalls);assert.equal(reviewByCaseId[task.id].toolCallLimit.calibration,'not-run');
  assert.equal(task.purpose,authored.purpose);assert.equal(task.difficulty,authored.difficulty);assert.equal(task.source,authored.source);
  userTurns+=task.input.turns?.length??0;hints.add(task.expected.expectedAnswerHint!);
  if(!('contract'in task))throw Error('Current cases require versioned checks');
  assert.deepEqual(task.expected.metrics.map(m=>m.metricId).sort(),metricCatalog.map(m=>m.id).sort());
  const gold=goldByCaseId[task.id].basis;
  claims+=task.expected.research?.claims.length??0;chains+=task.expected.research?.chains.length??0;
  for(const material of task.input.materials){materialBindings++;const partitions=sourceGroups.get(material.originalSha256)??new Set();partitions.add(dataset.manifest.smoke.includes(task.id)?'smoke':'holdout');sourceGroups.set(material.originalSha256,partitions);}
  for(const key of ['sourceChecks','localSourceChecks','lineSourceChecks','nonItemSourceChecks','parsedPageChecks'])for(const span of gold[key]??[]){
   if(typeof span.startUtf16!=='number'||typeof span.raw!=='string')continue;
   const sample=span.sample??gold.sample??gold.referenceSource,file=span.file??(/^\d{6}$/.test(sample)?'content.md':'source.md');
   const path=(/^\d{6}$/.test(sample)?'voxel51/':'materials/')+sample+'/'+file,embedded=dataset.embedded!.files[path];assert.ok(embedded,task.id+': missing source '+path);
   let text=decodeFile(embedded).bytes.toString('utf8');if(key==='parsedPageChecks')text=JSON.parse(text).find((page:any)=>page.pageNumber===span.pageNumber).text;
   assert.equal(text.slice(span.startUtf16,span.endUtf16),span.raw,task.id+'/'+key);sourceSpans++;
  }
 }
}
assert.equal(data.length,2);assert.equal(claims,123);assert.equal(chains,2);assert.equal(hints.size,62);
for(const partitions of sourceGroups.values())assert.equal(partitions.size,1,'Cross-partition original source');
console.log(JSON.stringify({cases:62,version:'v1',declarations:3,datasets:data.map(d=>({id:d.manifest.id,cases:d.cases.length,smoke:d.manifest.smoke.length})),sourceSpans,materialBindings,researchClaims:claims,researchChains:chains,userTurns,uniqueJudgeHints:hints.size,paidCalls:0,uploads:0,limits:'Content and layout checks only; actual Agent/Judge quality and tool-call limits were not calibrated.'},null,2));
