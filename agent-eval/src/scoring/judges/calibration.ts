import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {inside,hash} from '../../dataset-loader/local.ts';
import {artifactJson} from '../../artifacts.ts';
import {publicVersions,executionVersions} from '../../reports/files.ts';
import {safeId,judgeCallSchema,sdkJudgeConfigurationSchema,legacyJudgeConfigurationSchema} from '../../reports/store.ts';
import {scanEvidence} from '../../execution/evidence-safety.ts';
import {formalMetric} from '../catalog.ts';
import {compactPlanSchema,parseCompactJudgment,parseLegacyCompactJudgment,parseMetricJudgment,parseStrictMetricJudgment,metricParsePolicy,metricRubrics,metricPolicyFor,normalizeMetricJson,compactRubric,compactScores,rubricsFor} from './compact.ts';
import {legacyCompactRubric,legacyPlainRubric,legacyPackedRubric} from './packed.ts';
import {isJsonData} from '../../../../packages/contracts/src/tools.ts';
import {runCompactJudge} from './harness.ts';
import {judgeConfig,prepareJudge,publicJudgeConfig,type Fetcher} from './client.ts';
import type {JudgeCall} from '../types.ts';
import {createRunDirectory} from '../../reports/paths.ts';
import {deriveCalibrationBadcases,saveBadcases} from '../../reports/badcases.ts';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),text=z.string().trim().min(1).max(4000);
const documentSchema=z.object({contract:z.literal('flowmate-judge-reference/v1'),id:text,instanceId:text,sourceGroup:text,partition:z.enum(['tune','validation']),
 authority:z.object({kind:z.enum(['agent-authored','human-reference']),author:text,basis:text}).strict(),plan:compactPlanSchema,evidence:z.unknown(),referenceWire:z.string().min(1).optional(),
 parsePolicy:z.literal(metricParsePolicy).optional(),
 references:z.array(z.object({metricId:text,counts:z.tuple([count,count,count]).nullable(),severeError:z.boolean(),citationSupport:z.boolean().nullable(),reason:text}).strict()).min(1)
}).strict().superRefine((document,context)=>{
 if(document.references.length!==document.plan.criteria.length||document.references.some((r,i)=>r.metricId!==document.plan.criteria[i]!.metricId))
  context.addIssue({code:'custom',message:'References must bind every criterion in its original order'});
 try{
  if(document.plan.criteria.some(c=>c.metricId.startsWith('DR'))&&!document.referenceWire)throw Error('Research reference needs independent original-index witnesses');
  const raw=document.referenceWire??JSON.stringify({v:1,r:document.references.map(r=>r.counts),f:[]}), frame=(document.evidence as{researchFrame?:unknown})?.researchFrame;
  if(document.parsePolicy&&!document.referenceWire)throw Error('Strict reference requires explicit original opportunity witnesses');
  const named=document.parsePolicy?parseStrictMetricJudgment(raw,document.plan,frame):
   JSON.parse(raw).results!==undefined?parseMetricJudgment(raw,document.plan,frame):undefined;
  if(named&&Object.keys(named.validationErrors).length)throw Error('Reference contains invalid metrics');
  const parsed=named?.judgment??parseCompactJudgment(raw,document.plan,frame);
  if(!isDeepStrictEqual(parsed.r,document.references.map(r=>r.counts)))throw Error('Reference witness counts differ');
 }
 catch{context.addIssue({code:'custom',message:'Reference counts contradict the declared plan'});}
});
const manifestSchema=z.object({contract:z.literal('flowmate-judge-calibration/v1'),version:z.literal(1),
 samples:z.array(z.object({id:text,file:z.string().regex(/^[a-z0-9-]+\.json$/)}).strict()).min(2)
}).strict();
export function loadCalibration(directory:string){
 const root=resolve(directory),manifest=manifestSchema.parse(executionVersions(JSON.parse(readFileSync(inside(root,'calibration.json'),'utf8'))));
 const samples=manifest.samples.map(sample=>{
  const bytes=readFileSync(inside(root,sample.file),'utf8');
  const document=documentSchema.parse(executionVersions(JSON.parse(bytes)));if(document.id!==sample.id)throw Error('Calibration reference identity differs');
  return{...sample,document};
 });
 for(const field of ['id','file']as const)if(new Set(samples.map(s=>s[field])).size!==samples.length)throw Error('Duplicate calibration '+field);
 if(new Set(samples.map(s=>s.document.instanceId)).size!==samples.length)throw Error('Calibration instances may not be reused');
 const evidencePartitions=new Map<string,string>(),seenQuestions=new Set<string>();
 for(const{document}of samples){
  const identity=hash(document.evidence),partition=evidencePartitions.get(identity);
  if(partition&&partition!==document.partition)throw Error('Calibration evidence crosses tune/validation');evidencePartitions.set(identity,document.partition);
  for(const criterion of document.plan.criteria){const key=identity+':'+criterion.metricId;if(seenQuestions.has(key))throw Error('Duplicate criterion reference evidence');seenQuestions.add(key);}
 }
 const groups=new Map<string,string>();for(const {document}of samples){const prior=groups.get(document.sourceGroup);if(prior&&prior!==document.partition)throw Error('Source group crosses tune/validation');groups.set(document.sourceGroup,document.partition);}
 const metrics=new Set(samples.flatMap(s=>s.document.plan.criteria.map(c=>c.metricId)));
 for(const metricId of metrics)for(const partition of ['tune','validation'])if(!samples.some(s=>s.document.partition===partition&&s.document.references.some(r=>r.metricId===metricId)))throw Error('Every criterion needs independent tune and validation references');
 return{manifest,samples,hash:hash({manifest,samples})};
}
type CriterionSummary={partition:'tune'|'validation';metricId:string;samples:number;measured:number;countsCorrect:number;falseAccepts:number;falseRejects:number;severeErrorMisses:number;unjudgeable:number;errors:number;notRun:number;citationSamples:number;citationCorrect:number};
type SampleResult={id:string;instanceId:string;partition:'tune'|'validation';reference:z.infer<typeof documentSchema>;call:JudgeCall|null};
export type CalibrationReport={contract:'flowmate-judge-calibration-report/v1';executionId:string;kind:'engineering-fixture'|'actual-judge-calibration';acceptance:'not-assessed';
 referenceHash?:string;configuration:JudgeCall['configuration'];rubrics:ReturnType<typeof rubricsFor>;startedAt:string;endedAt:string|null;executionComplete:boolean;samples:SampleResult[];criteria:CriterionSummary[]};

function summaries(samples:SampleResult[]):CriterionSummary[]{
 const groups=new Map<string,CriterionSummary>();
 for(const sample of samples){
  const scores=sample.call?compactScores(sample.call):[];
  sample.reference.references.forEach((reference,index)=>{
   const key=sample.partition+':'+reference.metricId;
   const row=groups.get(key)??{partition:sample.partition,metricId:reference.metricId,samples:0,measured:0,countsCorrect:0,falseAccepts:0,falseRejects:0,severeErrorMisses:0,unjudgeable:0,errors:0,notRun:0,citationSamples:0,citationCorrect:0};
   groups.set(key,row);row.samples++;
   const score=scores[index];if(!score){row.notRun++;return;}
   if(isDeepStrictEqual([score.statistics?.numerator,score.statistics?.denominator,score.statistics?.missing],reference.counts))row.countsCorrect++;
   if(score.status==='ERROR'){row.errors++;return;}
   if(score.status==='UNJUDGEABLE'){row.unjudgeable++;return;}if(!['PASS','FAIL'].includes(score.status)){row.notRun++;return;}
   row.measured++;
   const expected=reference.counts,up=formalMetric(reference.metricId).direction==='up';
   const expectedFailure=expected!==null&&(up?expected[1]-expected[0]-expected[2]>0:expected[0]>0),expectedPass=expected!==null&&expected[1]>0&&expected[2]===0&&!expectedFailure;
   if(expectedFailure&&score.status==='PASS')row.falseAccepts++;
   if(expectedPass&&score.status==='FAIL')row.falseRejects++;
   if(reference.severeError&&expectedFailure&&score.status==='PASS')row.severeErrorMisses++;
   if(reference.citationSupport!==null){row.citationSamples++;if((score.status==='PASS')===reference.citationSupport)row.citationCorrect++;}
  });
 }
 return[...groups.values()];
}

const criterionSummarySchema=z.object({partition:z.enum(['tune','validation']),metricId:text,samples:count,measured:count,countsCorrect:count,
 falseAccepts:count,falseRejects:count,severeErrorMisses:count,unjudgeable:count,errors:count,notRun:count,citationSamples:count,citationCorrect:count}).strict();
const calibrationReportSchema=z.object({contract:z.literal('flowmate-judge-calibration-report/v1'),executionId:text,
 kind:z.enum(['engineering-fixture','actual-judge-calibration']),acceptance:z.literal('not-assessed'),referenceHash:text.optional(),
 configuration:z.union([sdkJudgeConfigurationSchema,legacyJudgeConfigurationSchema]),
 rubrics:z.array(z.object({id:text,version:count.positive(),prompt:z.string().min(1)}).strict()).refine(r=>new Set(r.map(x=>x.id)).size===r.length),
 startedAt:z.string().datetime(),endedAt:z.string().datetime().nullable(),executionComplete:z.boolean(),
 samples:z.array(z.object({id:text,instanceId:text,partition:z.enum(['tune','validation']),reference:documentSchema,call:judgeCallSchema.nullable()}).strict()),
 criteria:z.array(criterionSummarySchema)}).strict();

/** Validate saved references and original calls; status never regenerates, rescores or writes files. */
export function readCalibrationReport(path:string):CalibrationReport {
 const value=executionVersions(JSON.parse(readFileSync(path,'utf8')));
 if(!isJsonData(value))throw Error('Calibration report must contain finite JSON data');
 calibrationReportSchema.parse(value);const report=value as CalibrationReport;
 safeId(report.executionId);
 const templates=[legacyCompactRubric,legacyPlainRubric,legacyPackedRubric,compactRubric,...metricRubrics];
 if(report.rubrics.some(r=>!templates.some(t=>t.id===r.id&&t.version===r.version&&t.prompt===r.prompt)))throw Error('Unknown original calibration template');
 const ids=new Set<string>(),instances=new Set<string>(),calls=new Set<string>();
 for(const sample of report.samples){
  if(ids.has(sample.id)||instances.has(sample.instanceId)||sample.id!==sample.reference.id||sample.instanceId!==sample.reference.instanceId||sample.partition!==sample.reference.partition)
   throw Error('Calibration sample identity differs from its original reference');
  ids.add(sample.id);instances.add(sample.instanceId);
  const call=sample.call;if(!call)continue;
  if(calls.has(call.callId))throw Error('Duplicate calibration call');calls.add(call.callId);
  const {configHash,...parameters}=call.configuration,{rubric,...connection}=parameters,{configHash:_,...declared}=report.configuration;
  if(configHash&&configHash!==hash(parameters)||!isDeepStrictEqual(connection,declared))throw Error('Calibration Judge differs from its original connection');
  const template=report.rubrics.find(r=>r.id===rubric?.id&&r.version===rubric.version&&r.prompt===call.request?.system);
  if(!template||!call.request||!call.compact||call.judgment!==null||!isDeepStrictEqual(call.compact.plan,sample.reference.plan))throw Error('Calibration call lacks its original template and plan');
  if(call.request.hash&&call.request.hash!==hash([call.request.system,call.request.data])||call.request.redacted&&call.compact.judgment!==null)throw Error('Calibration request identity or redaction contradicts its judgment');
  const input=JSON.parse(call.request.data);
  if(!isDeepStrictEqual(input.plan,sample.reference.plan)||!isDeepStrictEqual(input.evidence,sample.reference.evidence))throw Error('Calibration request differs from its original reference');
  const policy=metricPolicyFor(template),named=template.id.startsWith('semantic-metrics-');
  if(call.compact.parsePolicy!==policy||(policy?call.compact.normalization!==(call.raw!==null&&call.responseComplete?normalizeMetricJson(call.raw).normalization:'none')||call.transportStatus===undefined:call.compact.normalization!==undefined)||
   named!==(call.compact.format==='metric-id/v1')||(named?!call.compact.validationErrors:call.compact.validationErrors!==undefined))throw Error('Calibration parsing policy differs from its original template');
  const sdk=call.configuration.sdk!==undefined,completed=sdk?call.stopReason==='stop':call.configuration.provider==='anthropic'?['end_turn','stop_sequence'].includes(call.finishReason??''):call.finishReason==='stop';
  if(call.responseComplete&&!completed||sdk&&call.attempts===1&&!call.configuration.modelCapabilities||call.transportStatus!==undefined&&
   (call.attempts===0&&call.transportStatus!==null||call.transportStatus!==null&&call.transportStatus>=400&&(call.responseComplete||call.error===null)))throw Error('Calibration completion contradicts original transport');
  if(call.compact.judgment===null){if(call.error===null)throw Error('Calibration missing judgment has no original error');continue;}
  if(call.attempts!==1||call.error!==null||call.raw===null||call.responseComplete===false)throw Error('Calibration judgment contradicts original completion');
  const frame=(sample.reference.evidence as{researchFrame?:unknown})?.researchFrame;
  const parsed=named?(policy?parseStrictMetricJudgment:parseMetricJudgment)(call.raw,call.compact.plan,frame):
   {judgment:template.prompt===legacyCompactRubric.prompt?parseLegacyCompactJudgment(call.raw,call.compact.plan):parseCompactJudgment(call.raw,call.compact.plan,frame),validationErrors:undefined};
  if(!isDeepStrictEqual(parsed.judgment,call.compact.judgment)||!isDeepStrictEqual(parsed.validationErrors,call.compact.validationErrors))throw Error('Calibration judgment contradicts original response');
 }
 if(report.endedAt!==null&&report.executionComplete!==report.samples.every(s=>s.call!==null)||!isDeepStrictEqual(report.criteria,summaries(report.samples)))throw Error('Calibration summary contradicts original sample calls');
 return report;
}
function save(path:string,report:CalibrationReport){
 const temporary=path+'.'+randomUUID()+'.tmp';let descriptor:number|undefined;
 try{descriptor=openSync(temporary,'wx');writeFileSync(descriptor,artifactJson(publicVersions(report)));fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;renameSync(temporary,path);}
 finally{if(descriptor!==undefined)closeSync(descriptor);try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
export async function calibrateJudge(repo:string,options:{directory:string;executionId:string;judgeConfigFile?:string},deps:{env?:NodeJS.ProcessEnv;fetcher?:Fetcher;signal?:AbortSignal}={}){
 const kit=loadCalibration(options.directory),configured=judgeConfig(deps.env??process.env,repo,options.judgeConfigFile);
 if(!configured)throw Error('Independent Judge configuration required; no Agent fallback');
 if(deps.signal?.aborted)throw Error('Calibration cancelled before dispatch');
 const rubrics=rubricsFor(kit.samples.map(s=>s.document.plan));
 if((scanEvidence(kit,[configured.apiKey]).fact.actual as{leaked:boolean}).leaked)throw Error('Configured secret in calibration references');
 const executionId=safeId(options.executionId),config=await prepareJudge(configured,deps.fetcher,deps.signal);
 const directory=createRunDirectory(repo,executionId,'calibration'),file=join(directory,'summary.json');
 const report:CalibrationReport={contract:'flowmate-judge-calibration-report/v1',executionId,kind:deps.fetcher?'engineering-fixture':'actual-judge-calibration',acceptance:'not-assessed',referenceHash:kit.hash,
  configuration:publicJudgeConfig(config),rubrics,startedAt:new Date().toISOString(),endedAt:null,executionComplete:false,
  samples:kit.samples.map(s=>({id:s.id,instanceId:s.document.instanceId,partition:s.document.partition,reference:s.document,call:null})),criteria:[]};
 report.criteria=summaries(report.samples);save(file,report);
 for(const sample of report.samples){
  if(deps.signal?.aborted)break;
  sample.call=await runCompactJudge(config,sample.reference.plan,sample.reference.evidence,deps.fetcher,deps.signal);
  report.criteria=summaries(report.samples);save(file,report);
 }
 report.executionComplete=report.samples.every(s=>s.call!==null);report.endedAt=new Date().toISOString();save(file,report);
 const diagnostics=saveBadcases(file,deriveCalibrationBadcases(report,file));
 if(!diagnostics.saved)process.stderr.write('⚠ 校准诊断文件写入失败；原始校准结果已保存。\n');
 return{report,file,diagnostics};
}
